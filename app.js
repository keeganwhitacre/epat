"use strict";

// ============================================================
// PPG BEAT DETECTOR — replaces BioBeats' HeartDetectorEngine
// ============================================================
const BeatDetector = (function () {
  const SAMPLE_RATE = 30;
  const IMAGE_SIZE = 40;
  const MIN_BPM = 40;
  const MAX_BPM = 200;
  const REFRACTORY_MS = (60 / MAX_BPM) * 1000;
  const BUFFER_SECONDS = 8;
  const BUFFER_SIZE = SAMPLE_RATE * BUFFER_SECONDS;
  const BASELINE_SECONDS = 2;

  // Relaxed finger detection thresholds
  const FINGER_BRIGHTNESS_MIN = 0.15;
  const FINGER_BRIGHTNESS_MAX = 0.98;
  const FINGER_RED_DOMINANCE = 0.38;

  let videoEl, canvasEl, ctx;
  let rawBuffer = [];
  let timeBuffer = [];
  let filteredBuffer = [];
  let lastBeatTime = 0;
  let startTime = 0;
  let running = false;
  let stream = null;
  let animFrameId = null;
  let fingerPresent = false;

  // Debounce: require N consecutive agreeing frames before changing state
  let fingerDebounceCount = 0;
  const FINGER_DEBOUNCE_FRAMES = 8;

  let instantBPM = 0, averageBPM = 0;
  let instantPeriod = 0, averagePeriod = 0;
  let recentPeriods = [];
  const MAX_RECENT_PERIODS = 10;

  let onBeat = null, onFingerChange = null, onPPGSample = null;

  // IIR bandpass: HP @ 0.67 Hz + LP @ 3.33 Hz
  let hpState = { x1: 0, y1: 0 };
  let lpState = { y1: 0 };
  const HP_ALPHA = 1 / (1 + (2 * Math.PI * 0.67) / SAMPLE_RATE);
  const LP_ALPHA = (2 * Math.PI * 3.33 / SAMPLE_RATE) / (1 + (2 * Math.PI * 3.33) / SAMPLE_RATE);

  function highpass(x) {
    const y = HP_ALPHA * (hpState.y1 + x - hpState.x1);
    hpState.x1 = x; hpState.y1 = y; return y;
  }
  function lowpass(x) {
    const y = lpState.y1 + LP_ALPHA * (x - lpState.y1);
    lpState.y1 = y; return y;
  }
  function bandpass(x) { return lowpass(highpass(x)); }
  function resetFilters() {
    hpState = { x1: 0, y1: 0 }; lpState = { y1: 0 };
  }

  function extractRedMean() {
    ctx.drawImage(videoEl, 0, 0, IMAGE_SIZE, IMAGE_SIZE);
    const pixels = ctx.getImageData(0, 0, IMAGE_SIZE, IMAGE_SIZE).data;
    let rS = 0, gS = 0, bS = 0;
    const count = pixels.length / 4;
    for (let i = 0; i < pixels.length; i += 4) {
      rS += pixels[i]; gS += pixels[i + 1]; bS += pixels[i + 2];
    }
    const rM = rS / count / 255, gM = gS / count / 255, bM = bS / count / 255;
    const brightness = (rM + gM + bM) / 3;
    const redRatio = rM / (rM + gM + bM + 0.001);

    const looksLikeFinger =
      brightness > FINGER_BRIGHTNESS_MIN &&
      brightness < FINGER_BRIGHTNESS_MAX &&
      redRatio > FINGER_RED_DOMINANCE;

    if (looksLikeFinger !== fingerPresent) {
      fingerDebounceCount++;
      if (fingerDebounceCount >= FINGER_DEBOUNCE_FRAMES) {
        fingerPresent = looksLikeFinger;
        fingerDebounceCount = 0;
        if (onFingerChange) onFingerChange(fingerPresent);
      }
    } else {
      fingerDebounceCount = 0;
    }

    return rM;
  }

  function detectPeak() {
    if (filteredBuffer.length < 5) return false;
    const now = Date.now();
    if (now - lastBeatTime < REFRACTORY_MS) return false;
    if (now - startTime < BASELINE_SECONDS * 1000) return false;

    const len = filteredBuffer.length;
    const prev2 = filteredBuffer[len - 3] || 0;
    const prev1 = filteredBuffer[len - 2];
    const curr = filteredBuffer[len - 1];

    if (prev1 > prev2 && prev1 > curr) {
      const slice = filteredBuffer.slice(-SAMPLE_RATE * 3);
      const sMax = Math.max(...slice), sMin = Math.min(...slice);
      const amplitude = sMax - sMin;
      if (prev1 > sMin + amplitude * 0.4 && amplitude > 0.0005) return true;
    }
    return false;
  }

  function processFrame() {
    if (!running) return;
    const now = Date.now();
    const rawValue = extractRedMean();
    const filtered = bandpass(rawValue);

    rawBuffer.push(rawValue); timeBuffer.push(now); filteredBuffer.push(filtered);
    if (rawBuffer.length > BUFFER_SIZE) {
      rawBuffer.shift(); timeBuffer.shift(); filteredBuffer.shift();
    }

    if (onPPGSample) onPPGSample(filtered);

    if (fingerPresent && detectPeak()) {
      const beatTime = now - (1000 / SAMPLE_RATE);
      const interval = beatTime - lastBeatTime;
      lastBeatTime = beatTime;

      if (interval > 0 && interval < (60000 / MIN_BPM)) {
        instantPeriod = interval / 1000;
        instantBPM = 60 / instantPeriod;
        recentPeriods.push(instantPeriod);
        if (recentPeriods.length > MAX_RECENT_PERIODS) recentPeriods.shift();
        averagePeriod = recentPeriods.reduce((a, b) => a + b, 0) / recentPeriods.length;
        averageBPM = 60 / averagePeriod;
        if (onBeat) onBeat({ instantBPM, averageBPM, instantPeriod, averagePeriod, time: beatTime });
      }
    }
    animFrameId = requestAnimationFrame(processFrame);
  }

  async function startCamera() {
    // Strategy: enumerate rear cameras, try each one until we find one
    // that supports torch. The torch-capable camera is the primary wide lens
    // (physically adjacent to the LED), which gives the best PPG signal.
    // This avoids accidentally using the macro, ultrawide, or telephoto lens.

    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((d) => d.kind === "videoinput");
    console.log(`[PAT] Found ${cameras.length} cameras:`, cameras.map((c, i) => `${i}: ${c.label || 'unlabeled'} (${c.deviceId.slice(0,8)}...)`));

    let torchWorking = false;

    // Try rear cameras in reverse order (most likely to hit primary rear first on iOS)
    // If torch works, we keep that camera. If not, try the next.
    for (let i = cameras.length - 1; i >= 0; i--) {
      const cam = cameras[i];
      try {
        // Stop any previous attempt
        if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }

        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: cam.deviceId },
            width: { ideal: IMAGE_SIZE },
            height: { ideal: IMAGE_SIZE },
          },
        });

        const track = stream.getVideoTracks()[0];
        console.log(`[PAT] Trying camera ${i}: ${track.label}`);

        // Test if torch works on this camera
        try {
          await track.applyConstraints({ advanced: [{ torch: true }] });
          torchWorking = true;
          console.log(`[PAT] ✓ Torch works on camera ${i}: ${track.label}`);
          break; // Found our camera
        } catch (torchErr) {
          console.log(`[PAT] ✗ No torch on camera ${i}: ${track.label}`);
          // Continue to next camera
        }
      } catch (camErr) {
        console.log(`[PAT] ✗ Failed to open camera ${i}:`, camErr.message);
      }
    }

    // Fallback: if no torch-capable camera found, just use environment-facing
    if (!torchWorking) {
      console.warn("[PAT] No torch-capable camera found, falling back to environment facingMode");
      if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: IMAGE_SIZE }, height: { ideal: IMAGE_SIZE } },
      });
      try {
        const track = stream.getVideoTracks()[0];
        await track.applyConstraints({ advanced: [{ torch: true }] });
      } catch (e) { console.warn("[PAT] Torch unavailable on fallback camera"); }
    }

    videoEl.srcObject = stream;
    await videoEl.play();
    console.log(`[PAT] Camera active: ${stream.getVideoTracks()[0].label}`);
  }

  async function stopCamera() {
    if (stream) {
      try { const t = stream.getVideoTracks()[0]; await t.applyConstraints({ advanced: [{ torch: false }] }); } catch (e) {}
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (videoEl) videoEl.srcObject = null;
  }

  return {
    async start({ video, canvas, onBeatCb, onFingerChangeCb, onPPGSampleCb }) {
      videoEl = video; canvasEl = canvas; ctx = canvas.getContext("2d");
      canvasEl.width = IMAGE_SIZE; canvasEl.height = IMAGE_SIZE;
      onBeat = onBeatCb; onFingerChange = onFingerChangeCb; onPPGSample = onPPGSampleCb || null;
      rawBuffer = []; timeBuffer = []; filteredBuffer = []; recentPeriods = [];
      lastBeatTime = 0; instantBPM = 0; averageBPM = 0;
      fingerPresent = false; fingerDebounceCount = 0; resetFilters();
      await startCamera();
      startTime = Date.now(); running = true; processFrame();
    },
    async stop() { running = false; if (animFrameId) cancelAnimationFrame(animFrameId); await stopCamera(); },
    isRunning() { return running; },
    isFingerPresent() { return fingerPresent; },
  };
})();

// ============================================================
// AUDIO ENGINE
// ============================================================
const AudioEngine = (function () {
  let audioCtx, lowBuf, highBuf;
  function createBeep(freq, dur) {
    const sr = 44100, len = sr * dur, buf = audioCtx.createBuffer(1, len, sr), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) { const t = i / sr; d[i] = Math.sin(2 * Math.PI * freq * t) * Math.min(1, t * 50) * Math.min(1, (dur - t) * 50) * 0.5; }
    return buf;
  }
  function play(buf) { if (!audioCtx) return; const s = audioCtx.createBufferSource(); s.buffer = buf; s.connect(audioCtx.destination); s.start(); }
  return {
    init() { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); lowBuf = createBeep(440, 0.08); highBuf = createBeep(880, 0.06); },
    playLow() { play(lowBuf); },
    playHigh() { play(highBuf); },
    resume() { if (audioCtx?.state === "suspended") audioCtx.resume(); },
  };
})();

// ============================================================
// PHASE ADJUSTMENT TASK
// ============================================================
const PAT = (function () {
  const NUM_TRIALS = 20, NUM_PRACTICES = 2, BODY_MAP_EVERY = 4;
  const KNOB_VALUE_RANGE = 1.0, SHORTEST_DELAY = 60 / 140, BASELINE_DURATION_S = 120;

  let participantId = "", currentTrialIndex = -NUM_PRACTICES, currentKnobValue = 0, trialRunning = false;
  let trialIP = [], trialAP = [], trialKS = [], trialCD = [], trialIE = [];
  let sessionData = { participantID: "", startDate: null, endDate: null, baselines: [], syncroTraining: [] };
  let currentInstantPeriod = 0, currentAveragePeriod = 0;

  function currentDelay() {
    if (currentAveragePeriod === 0) return SHORTEST_DELAY;
    return (currentAveragePeriod / 2) * currentKnobValue;
  }

  function handleTrialBeat(beat) {
    const prev = currentInstantPeriod;
    currentInstantPeriod = beat.instantPeriod;
    currentAveragePeriod = beat.averagePeriod;
    trialIP.push(currentInstantPeriod); trialAP.push(currentAveragePeriod);
    trialKS.push(currentKnobValue); trialIE.push(prev - currentInstantPeriod);
    trialCD.push(currentDelay());

    const delay = currentDelay();
    const delayFromNow = delay < 0 ? currentInstantPeriod + delay : delay;
    if (delayFromNow > 0 && delayFromNow < 3) {
      setTimeout(() => { if (trialRunning) AudioEngine.playLow(); }, delayFromNow * 1000);
    }
  }

  function collectTrialData() {
    return { date: new Date().toISOString(), instantPeriods: [...trialIP], averagePeriods: [...trialAP], knobScales: [...trialKS], currentDelays: [...trialCD], instantErrs: [...trialIE], confidence: -1, bodyPos: -1 };
  }

  function resetTrialBuffers() {
    trialIP = []; trialAP = []; trialKS = []; trialCD = []; trialIE = [];
    currentInstantPeriod = 0; currentAveragePeriod = 0;
  }

  return {
    NUM_TRIALS, NUM_PRACTICES, BODY_MAP_EVERY, KNOB_VALUE_RANGE, BASELINE_DURATION_S,
    get currentTrialIndex() { return currentTrialIndex; },
    set currentTrialIndex(v) { currentTrialIndex = v; },
    get currentKnobValue() { return currentKnobValue; },
    set currentKnobValue(v) { currentKnobValue = Math.max(-KNOB_VALUE_RANGE, Math.min(KNOB_VALUE_RANGE, v)); },
    get trialRunning() { return trialRunning; },
    set trialRunning(v) { trialRunning = v; },
    get participantId() { return participantId; },
    set participantId(v) { participantId = v; },
    get sessionData() { return sessionData; },
    currentDelay, handleTrialBeat, collectTrialData, resetTrialBuffers,
    randomKnobStart() { return (Math.random() * 2 - 1) * KNOB_VALUE_RANGE; },
    initSession() { sessionData = { participantID: participantId, startDate: new Date().toISOString(), endDate: null, baselines: [], syncroTraining: [] }; currentTrialIndex = -NUM_PRACTICES; },
    isPractice() { return currentTrialIndex < 0; },
    displayTrialLabel() { return currentTrialIndex < 0 ? `PRACTICE TRIAL ${NUM_PRACTICES + currentTrialIndex + 1}` : `TRIAL ${currentTrialIndex + 1} of ${NUM_TRIALS}`; },
    showBodyMapThisTrial() { return currentTrialIndex >= 0 && (currentTrialIndex + 1) % BODY_MAP_EVERY === 0; },
    isLastTrial() { return currentTrialIndex === NUM_TRIALS - 1; },
    advanceTrial() { currentTrialIndex++; },
    addTrialResult(d) { sessionData.syncroTraining.push(d); },
    addBaseline(d) { sessionData.baselines.push(d); },
    finalizeSession() { sessionData.endDate = new Date().toISOString(); },
    exportJSON() { return JSON.stringify(sessionData, null, 2); },
  };
})();

// ============================================================
// UI CONTROLLER
// ============================================================
const UI = (function () {
  const screens = {};
  let currentScreen = null, knobInteracted = false;
  let knobEl, knobAngle = 0, knobDragging = false, knobCenterX = 0, knobCenterY = 0, lastAngle = 0;
  let baselineBPMs = [], baselineTimer = null, baselineStartTime = 0;
  let videoEl, canvasEl;
  let waveCanvas, waveCtx, waveBuffer = [];
  const WAVE_MAX = 180;

  function hideAllOverlays() {
    document.querySelectorAll(".finger-overlay").forEach((el) => el.classList.remove("visible"));
  }

  function show(id) {
    hideAllOverlays();
    if (currentScreen) currentScreen.classList.remove("active");
    currentScreen = screens[id];
    currentScreen.classList.add("active");
  }

  // ---- Knob ----
  function initKnob() {
    knobEl = document.getElementById("knob");
    knobEl.addEventListener("pointerdown", knobStart, { passive: false });
    window.addEventListener("pointermove", knobMove, { passive: false });
    window.addEventListener("pointerup", () => { knobDragging = false; });
  }
  function setKnobAngle(v) {
    const n = (v + PAT.KNOB_VALUE_RANGE) / (2 * PAT.KNOB_VALUE_RANGE);
    knobAngle = n * 2 * Math.PI - Math.PI;
    updateKnobVisual();
  }
  function knobStart(e) {
    e.preventDefault(); knobDragging = true;
    const r = knobEl.getBoundingClientRect();
    knobCenterX = r.left + r.width / 2; knobCenterY = r.top + r.height / 2;
    lastAngle = Math.atan2(e.clientY - knobCenterY, e.clientX - knobCenterX);
    knobEl.setPointerCapture(e.pointerId);
  }
  function knobMove(e) {
    if (!knobDragging) return;
    e.preventDefault(); knobInteracted = true;
    const a = Math.atan2(e.clientY - knobCenterY, e.clientX - knobCenterX);
    let d = a - lastAngle;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    knobAngle = Math.max(-Math.PI, Math.min(Math.PI, knobAngle + d));
    lastAngle = a;
    PAT.currentKnobValue = ((knobAngle + Math.PI) / (2 * Math.PI) * 2 - 1) * PAT.KNOB_VALUE_RANGE;
    updateKnobVisual();
    document.getElementById("confirm-trial-btn").disabled = false;
  }
  function updateKnobVisual() {
    const d = document.getElementById("knob-dial");
    if (d) d.style.transform = `rotate(${knobAngle}rad)`;
  }

  // ---- PPG waveform ----
  function drawWaveform() {
    if (!waveCanvas || !waveCtx) return;
    const w = waveCanvas.clientWidth, h = waveCanvas.clientHeight;
    waveCtx.clearRect(0, 0, waveCanvas.width, waveCanvas.height);
    if (waveBuffer.length < 2) return;
    let min = waveBuffer[0], max = waveBuffer[0];
    for (const v of waveBuffer) { if (v < min) min = v; if (v > max) max = v; }
    const range = max - min || 0.001, pad = 6;
    const dpr = window.devicePixelRatio || 1;

    waveCtx.beginPath();
    waveCtx.strokeStyle = "#e05545";
    waveCtx.lineWidth = 2 * dpr;
    waveCtx.lineJoin = "round";
    waveCtx.lineCap = "round";

    const xStep = (w * dpr) / WAVE_MAX;
    const xOff = (WAVE_MAX - waveBuffer.length) * xStep;
    for (let i = 0; i < waveBuffer.length; i++) {
      const x = xOff + i * xStep;
      const y = pad * dpr + ((max - waveBuffer[i]) / range) * (h * dpr - pad * 2 * dpr);
      i === 0 ? waveCtx.moveTo(x, y) : waveCtx.lineTo(x, y);
    }
    waveCtx.stroke();
  }

  function triggerPulse(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("pulse");
    void el.offsetWidth;
    el.classList.add("pulse");
  }

  // ---- Screens ----
  function showParticipantId() { show("screen-participant"); document.getElementById("participant-input").focus(); }

  function showOnboarding(step) {
    show("screen-onboarding");
    document.querySelectorAll(".onboarding-step").forEach((s) => s.classList.remove("active"));
    const t = document.querySelector(`.onboarding-step[data-step="${step}"]`);
    if (t) t.classList.add("active");
  }

  async function showBaseline() {
    show("screen-baseline");
    baselineBPMs = []; waveBuffer = [];
    baselineStartTime = Date.now();

    const progEl = document.getElementById("baseline-progress");
    const secsEl = document.getElementById("baseline-secs");
    const bpmEl = document.getElementById("baseline-bpm");
    const beatEl = document.getElementById("baseline-beat-count");
    const statusEl = document.getElementById("baseline-status");

    waveCanvas = document.getElementById("wave-canvas");
    waveCtx = waveCanvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    waveCanvas.width = waveCanvas.clientWidth * dpr;
    waveCanvas.height = waveCanvas.clientHeight * dpr;

    videoEl = document.getElementById("video-feed");
    canvasEl = document.getElementById("sampling-canvas");
    let beatCount = 0;

    await BeatDetector.start({
      video: videoEl, canvas: canvasEl,
      onBeatCb: (beat) => {
        baselineBPMs.push(beat.instantBPM);
        bpmEl.textContent = Math.round(beat.averageBPM);
        beatCount++;
        beatEl.textContent = beatCount;
        triggerPulse("baseline-heart");
        if (beatCount < 5) statusEl.textContent = "Detecting heartbeat...";
        else if (beatCount < 15) statusEl.textContent = "Signal acquired — keep still";
        else statusEl.textContent = "Good signal — recording baseline";
      },
      onFingerChangeCb: (present) => {
        document.getElementById("baseline-finger-overlay").classList.toggle("visible", !present);
        statusEl.textContent = present ? "Finger detected — warming up..." : "Waiting for finger...";
      },
      onPPGSampleCb: (sample) => {
        waveBuffer.push(sample);
        if (waveBuffer.length > WAVE_MAX) waveBuffer.shift();
        drawWaveform();
      },
    });

    const circ = 2 * Math.PI * 72;
    baselineTimer = setInterval(() => {
      const elapsed = (Date.now() - baselineStartTime) / 1000;
      const remaining = Math.max(0, PAT.BASELINE_DURATION_S - elapsed);
      const pct = Math.min(1, elapsed / PAT.BASELINE_DURATION_S);
      progEl.textContent = Math.round(pct * 100) + "%";
      secsEl.textContent = Math.ceil(remaining);
      const circle = document.getElementById("baseline-progress-circle");
      if (circle) circle.style.strokeDashoffset = circ * (1 - pct);
      if (remaining <= 0) { clearInterval(baselineTimer); finishBaseline(); }
    }, 1000);
  }

  async function finishBaseline() {
    await BeatDetector.stop();
    hideAllOverlays();
    PAT.addBaseline({ date: new Date().toISOString(), recordedHR: baselineBPMs.map((b) => Math.round(b)), instantBpms: [...baselineBPMs] });
    showOnboarding("post-baseline");
  }

  async function startTrial() {
    show("screen-trial");
    PAT.resetTrialBuffers();
    PAT.currentKnobValue = PAT.randomKnobStart();
    knobInteracted = false;
    setKnobAngle(PAT.currentKnobValue);
    PAT.trialRunning = true;
    document.getElementById("trial-label").textContent = PAT.displayTrialLabel();
    document.getElementById("confirm-trial-btn").disabled = true;

    videoEl = document.getElementById("video-feed");
    canvasEl = document.getElementById("sampling-canvas");
    await BeatDetector.start({
      video: videoEl, canvas: canvasEl,
      onBeatCb: (beat) => {
        PAT.handleTrialBeat(beat);
        document.getElementById("trial-bpm").textContent = Math.round(beat.averageBPM);
        triggerPulse("trial-heart");
      },
      onFingerChangeCb: (present) => {
        document.getElementById("trial-finger-overlay").classList.toggle("visible", !present);
      },
    });
  }

  async function confirmTrial() {
    PAT.trialRunning = false;
    await BeatDetector.stop();
    hideAllOverlays();
    showConfidence(PAT.collectTrialData());
  }

  function showConfidence(td) {
    show("screen-confidence");
    const sl = document.getElementById("confidence-slider");
    const vd = document.getElementById("confidence-value");
    sl.value = Math.floor(Math.random() * 10);
    vd.textContent = sl.value;
    sl.oninput = () => { vd.textContent = sl.value; document.getElementById("confirm-confidence-btn").disabled = false; };
    document.getElementById("confirm-confidence-btn").disabled = true;
    document.getElementById("confirm-confidence-btn").onclick = () => {
      td.confidence = parseInt(sl.value);
      PAT.showBodyMapThisTrial() ? showBodyMap(td) : finalizeTrial(td);
    };
  }

  function showBodyMap(td) {
    show("screen-bodymap");
    const parts = document.querySelectorAll(".body-part");
    const nb = document.getElementById("nowhere-btn");
    const cb = document.getElementById("confirm-bodymap-btn");
    const lb = document.getElementById("bodymap-selected");
    let sel = -1;
    cb.disabled = true; lb.textContent = "";
    parts.forEach((p) => { p.classList.remove("selected"); p.onclick = () => {
      parts.forEach((pp) => pp.classList.remove("selected")); nb.classList.remove("selected");
      p.classList.add("selected"); sel = parseInt(p.dataset.value);
      lb.textContent = `You selected: ${p.dataset.name}`; cb.disabled = false;
    }; });
    nb.classList.remove("selected"); nb.onclick = () => {
      parts.forEach((pp) => pp.classList.remove("selected")); nb.classList.add("selected");
      sel = 8; lb.textContent = "You selected: nowhere"; cb.disabled = false;
    };
    cb.onclick = () => { td.bodyPos = sel; finalizeTrial(td); };
  }

  function finalizeTrial(td) {
    PAT.addTrialResult(td); PAT.advanceTrial();
    PAT.currentTrialIndex >= PAT.NUM_TRIALS ? showEnd() : startTrial();
  }

  function showEnd() {
    PAT.finalizeSession(); show("screen-end");
    document.getElementById("data-preview").textContent = `Session complete. ${PAT.sessionData.syncroTraining.length} trials recorded.`;
  }

  function downloadData() {
    const b = new Blob([PAT.exportJSON()], { type: "application/json" });
    const u = URL.createObjectURL(b);
    const a = document.createElement("a"); a.href = u;
    a.download = `PAT_${PAT.participantId}_${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(u);
  }

  function init() {
    document.querySelectorAll(".screen").forEach((s) => { screens[s.id] = s; });
    initKnob(); AudioEngine.init();

    document.getElementById("start-btn").onclick = () => {
      const pid = document.getElementById("participant-input").value.trim();
      if (!pid) return;
      PAT.participantId = pid; PAT.initSession(); AudioEngine.resume(); showOnboarding("1");
    };

    document.querySelectorAll("[data-next-step]").forEach((btn) => {
      btn.onclick = () => {
        AudioEngine.resume();
        const next = btn.dataset.nextStep;
        if (next === "baseline") showBaseline();
        else if (next === "start-trials") startTrial();
        else showOnboarding(next);
      };
    });

    document.getElementById("confirm-trial-btn").onclick = () => { AudioEngine.resume(); confirmTrial(); };
    document.getElementById("download-btn").onclick = downloadData;
    showParticipantId();
  }

  return { init };
})();

document.addEventListener("DOMContentLoaded", () => {
  UI.init();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
});
