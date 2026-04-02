"use strict";

// ============================================================
// PPG BEAT DETECTOR — replaces BioBeats' HeartDetectorEngine
// Pipeline: camera frame → red channel mean → bandpass filter → peak detection → beat event
// ============================================================
const BeatDetector = (function () {
  const SAMPLE_RATE = 30; // Target camera FPS
  const IMAGE_SIZE = 40;
  const MIN_BPM = 40;
  const MAX_BPM = 200;
  const REFRACTORY_MS = (60 / MAX_BPM) * 1000; // ~300ms
  const BUFFER_SECONDS = 8;
  const BUFFER_SIZE = SAMPLE_RATE * BUFFER_SECONDS;
  const BASELINE_SECONDS = 3; // seconds before first beat can fire
  const FINGER_BRIGHTNESS_MIN = 0.35;
  const FINGER_BRIGHTNESS_MAX = 0.95;
  const FINGER_RED_DOMINANCE = 0.5; // red channel should dominate when finger+torch

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
  let lastFingerState = null;

  // Running BPM stats
  let instantBPM = 0;
  let averageBPM = 0;
  let instantPeriod = 0;
  let averagePeriod = 0;
  let recentPeriods = [];
  const MAX_RECENT_PERIODS = 10;

  // Callbacks
  let onBeat = null;
  let onFingerChange = null;
  let onPPGSample = null;

  // ---- Simple bandpass via cascaded single-pole filters ----
  // Butterworth-style IIR bandpass: 0.67–3.33 Hz at 30 Hz sample rate
  // Implemented as high-pass (0.67 Hz) + low-pass (3.33 Hz)

  // High-pass filter state (removes DC drift and respiration)
  let hpState = { x1: 0, y1: 0 };
  // Low-pass filter state (removes high-freq noise)
  let lpState = { y1: 0 };

  // High-pass: fc = 0.67 Hz, fs = 30 Hz
  // alpha = 1 / (1 + 2*pi*fc/fs)
  const HP_ALPHA = 1 / (1 + (2 * Math.PI * 0.67) / SAMPLE_RATE); // ~0.966

  // Low-pass: fc = 3.33 Hz, fs = 30 Hz
  // alpha = (2*pi*fc/fs) / (1 + 2*pi*fc/fs)
  const LP_ALPHA = (2 * Math.PI * 3.33 / SAMPLE_RATE) / (1 + (2 * Math.PI * 3.33) / SAMPLE_RATE); // ~0.411

  function highpass(x) {
    const y = HP_ALPHA * (hpState.y1 + x - hpState.x1);
    hpState.x1 = x;
    hpState.y1 = y;
    return y;
  }

  function lowpass(x) {
    const y = lpState.y1 + LP_ALPHA * (x - lpState.y1);
    lpState.y1 = y;
    return y;
  }

  function bandpass(x) {
    return lowpass(highpass(x));
  }

  function resetFilters() {
    hpState = { x1: 0, y1: 0 };
    lpState = { y1: 0 };
  }

  // ---- Red channel extraction ----
  function extractRedMean() {
    ctx.drawImage(videoEl, 0, 0, IMAGE_SIZE, IMAGE_SIZE);
    const pixels = ctx.getImageData(0, 0, IMAGE_SIZE, IMAGE_SIZE).data;
    let redSum = 0, greenSum = 0, blueSum = 0;
    const count = pixels.length / 4;
    for (let i = 0; i < pixels.length; i += 4) {
      redSum += pixels[i];
      greenSum += pixels[i + 1];
      blueSum += pixels[i + 2];
    }
    const redMean = redSum / count / 255;
    const greenMean = greenSum / count / 255;
    const blueMean = blueSum / count / 255;
    const brightness = (redMean + greenMean + blueMean) / 3;
    const redRatio = redMean / (redMean + greenMean + blueMean + 0.001);

    // Finger detection: with torch on and finger covering camera,
    // image should be bright-ish and red-dominant
    const isFingerNow =
      brightness > FINGER_BRIGHTNESS_MIN &&
      brightness < FINGER_BRIGHTNESS_MAX &&
      redRatio > FINGER_RED_DOMINANCE;

    if (isFingerNow !== lastFingerState) {
      fingerPresent = isFingerNow;
      lastFingerState = isFingerNow;
      if (onFingerChange) onFingerChange(fingerPresent);
    }

    return redMean;
  }

  // ---- Adaptive peak detection ----
  function detectPeak() {
    if (filteredBuffer.length < 5) return false;

    const now = Date.now();
    if (now - lastBeatTime < REFRACTORY_MS) return false;
    if (now - startTime < BASELINE_SECONDS * 1000) return false;

    const len = filteredBuffer.length;
    // Look at the sample 2 frames ago (to confirm it's a peak, not still rising)
    const prev2 = filteredBuffer[len - 3] || 0;
    const prev1 = filteredBuffer[len - 2];
    const curr = filteredBuffer[len - 1];

    // Peak: prev1 > prev2 AND prev1 > curr (prev1 was a local max)
    if (prev1 > prev2 && prev1 > curr) {
      // Adaptive threshold: peak must be above a fraction of recent max amplitude
      const recentSlice = filteredBuffer.slice(-SAMPLE_RATE * 3); // last 3 seconds
      const recentMax = Math.max(...recentSlice);
      const recentMin = Math.min(...recentSlice);
      const amplitude = recentMax - recentMin;
      const threshold = recentMin + amplitude * 0.4;

      if (prev1 > threshold && amplitude > 0.001) {
        return true;
      }
    }
    return false;
  }

  // ---- Main processing loop ----
  function processFrame() {
    if (!running) return;

    const now = Date.now();
    const rawValue = extractRedMean();
    const filtered = bandpass(rawValue);

    rawBuffer.push(rawValue);
    timeBuffer.push(now);
    filteredBuffer.push(filtered);

    if (rawBuffer.length > BUFFER_SIZE) {
      rawBuffer.shift();
      timeBuffer.shift();
      filteredBuffer.shift();
    }

    if (onPPGSample) onPPGSample(filtered);

    if (fingerPresent && detectPeak()) {
      const beatTime = now - (1000 / SAMPLE_RATE); // beat was at prev1, one frame ago
      const interval = beatTime - lastBeatTime;
      lastBeatTime = beatTime;

      if (interval > 0 && interval < (60000 / MIN_BPM)) {
        instantPeriod = interval / 1000;
        instantBPM = 60 / instantPeriod;

        recentPeriods.push(instantPeriod);
        if (recentPeriods.length > MAX_RECENT_PERIODS) recentPeriods.shift();

        averagePeriod = recentPeriods.reduce((a, b) => a + b, 0) / recentPeriods.length;
        averageBPM = 60 / averagePeriod;

        if (onBeat) {
          onBeat({
            instantBPM,
            averageBPM,
            instantPeriod,
            averagePeriod,
            time: beatTime,
          });
        }
      }
    }

    animFrameId = requestAnimationFrame(processFrame);
  }

  // ---- Camera + torch ----
  async function startCamera() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((d) => d.kind === "videoinput");
    // Prefer rear camera
    const camera = cameras[cameras.length - 1];

    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: camera?.deviceId,
        facingMode: "environment",
        width: { ideal: IMAGE_SIZE },
        height: { ideal: IMAGE_SIZE },
      },
    });

    videoEl.srcObject = stream;
    await videoEl.play();

    // Try enabling torch
    try {
      const track = stream.getVideoTracks()[0];
      await track.applyConstraints({ advanced: [{ torch: true }] });
    } catch (e) {
      console.warn("Torch not available:", e);
    }
  }

  async function stopCamera() {
    if (stream) {
      // Turn off torch
      try {
        const track = stream.getVideoTracks()[0];
        await track.applyConstraints({ advanced: [{ torch: false }] });
      } catch (e) { /* ignore */ }
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    videoEl.srcObject = null;
  }

  // ---- Public API ----
  return {
    async start({ video, canvas, onBeatCb, onFingerChangeCb, onPPGSampleCb }) {
      videoEl = video;
      canvasEl = canvas;
      ctx = canvas.getContext("2d");
      canvasEl.width = IMAGE_SIZE;
      canvasEl.height = IMAGE_SIZE;
      onBeat = onBeatCb;
      onFingerChange = onFingerChangeCb;
      onPPGSample = onPPGSampleCb || null;

      rawBuffer = [];
      timeBuffer = [];
      filteredBuffer = [];
      recentPeriods = [];
      lastBeatTime = 0;
      instantBPM = 0;
      averageBPM = 0;
      fingerPresent = false;
      lastFingerState = null;
      resetFilters();

      await startCamera();
      startTime = Date.now();
      running = true;
      processFrame();
    },

    async stop() {
      running = false;
      if (animFrameId) cancelAnimationFrame(animFrameId);
      await stopCamera();
    },

    isRunning() { return running; },
    isFingerPresent() { return fingerPresent; },
    getInstantBPM() { return instantBPM; },
    getAverageBPM() { return averageBPM; },
  };
})();


// ============================================================
// AUDIO ENGINE — pre-loaded beep tones for low-latency playback
// ============================================================
const AudioEngine = (function () {
  let audioCtx;
  let lowBeepBuffer, highBeepBuffer;

  function createBeep(freq, duration) {
    const sampleRate = 44100;
    const length = sampleRate * duration;
    const buffer = audioCtx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      // Sine wave with fade-in/out envelope
      const envelope = Math.min(1, t * 50) * Math.min(1, (duration - t) * 50);
      data[i] = Math.sin(2 * Math.PI * freq * t) * envelope * 0.5;
    }
    return buffer;
  }

  return {
    init() {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // Low beep: delayed tone played to participant (matches lowBeep.mp3 ~440Hz)
      lowBeepBuffer = createBeep(440, 0.08);
      // High beep: heartbeat indicator (matches highBeep.mp3 ~880Hz)
      highBeepBuffer = createBeep(880, 0.06);
    },

    playLow() {
      if (!audioCtx) return;
      const src = audioCtx.createBufferSource();
      src.buffer = lowBeepBuffer;
      src.connect(audioCtx.destination);
      src.start();
    },

    playHigh() {
      if (!audioCtx) return;
      const src = audioCtx.createBufferSource();
      src.buffer = highBeepBuffer;
      src.connect(audioCtx.destination);
      src.start();
    },

    resume() {
      if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    },
  };
})();


// ============================================================
// PHASE ADJUSTMENT TASK — ports TrialScreen.swift logic
// ============================================================
const PAT = (function () {
  // ---- Configuration matching the Swift app ----
  const NUM_TRIALS = 20;
  const NUM_PRACTICES = 2;
  const BODY_MAP_EVERY = 4; // show body map every N trials
  const CONFIDENCE_RANGE = [0, 9];
  const KNOB_VALUE_RANGE = 1.0; // maps to [-1, 1]
  const SHORTEST_DELAY = 60 / 140; // ~0.429s fallback when no period yet
  const BASELINE_DURATION_S = 120; // 2 minutes baseline

  // ---- State ----
  let participantId = "";
  let currentTrialIndex = -NUM_PRACTICES; // negative = practice
  let currentKnobValue = 0;
  let trialRunning = false;

  // Per-trial data arrays (matching SyncroTrialDataset)
  let trialInstantPeriods = [];
  let trialAveragePeriods = [];
  let trialKnobScales = [];
  let trialCurrentDelays = [];
  let trialInstantErrs = [];

  // Full session dataset (matching InteroceptionDataset)
  let sessionData = {
    participantID: "",
    startDate: null,
    endDate: null,
    baselines: [],
    syncroTraining: [],
  };

  // Current beat state
  let currentInstantPeriod = 0;
  let currentAveragePeriod = 0;

  // ---- Core delay calculation (from TrialScreenViewModel.currentDelay) ----
  function currentDelay() {
    if (currentAveragePeriod === 0) return SHORTEST_DELAY;
    return (currentAveragePeriod / 2) * currentKnobValue;
  }

  // ---- Beat handler during trial (from beatDetected in TrialScreenViewModel) ----
  function handleTrialBeat(beat) {
    const prevInstantPeriod = currentInstantPeriod;
    currentInstantPeriod = beat.instantPeriod;
    currentAveragePeriod = beat.averagePeriod;
    const instantErr = prevInstantPeriod - currentInstantPeriod;

    // Record data
    trialInstantPeriods.push(currentInstantPeriod);
    trialAveragePeriods.push(currentAveragePeriod);
    trialKnobScales.push(currentKnobValue);
    trialInstantErrs.push(instantErr);
    trialCurrentDelays.push(currentDelay());

    // Schedule delayed tone
    const delay = currentDelay();
    const delayFromNow = delay < 0 ? currentInstantPeriod + delay : delay;

    if (delayFromNow > 0 && delayFromNow < 3) {
      setTimeout(() => {
        if (trialRunning) AudioEngine.playLow();
      }, delayFromNow * 1000);
    }
  }

  // ---- Collect trial data (from getTaskData) ----
  function collectTrialData() {
    return {
      date: new Date().toISOString(),
      instantPeriods: [...trialInstantPeriods],
      averagePeriods: [...trialAveragePeriods],
      knobScales: [...trialKnobScales],
      currentDelays: [...trialCurrentDelays],
      instantErrs: [...trialInstantErrs],
      confidence: -1,
      bodyPos: -1,
    };
  }

  function resetTrialBuffers() {
    trialInstantPeriods = [];
    trialAveragePeriods = [];
    trialKnobScales = [];
    trialCurrentDelays = [];
    trialInstantErrs = [];
    currentInstantPeriod = 0;
    currentAveragePeriod = 0;
  }

  function randomKnobStart() {
    return (Math.random() * 2 - 1) * KNOB_VALUE_RANGE;
  }

  return {
    NUM_TRIALS,
    NUM_PRACTICES,
    BODY_MAP_EVERY,
    CONFIDENCE_RANGE,
    KNOB_VALUE_RANGE,
    BASELINE_DURATION_S,

    get currentTrialIndex() { return currentTrialIndex; },
    set currentTrialIndex(v) { currentTrialIndex = v; },
    get currentKnobValue() { return currentKnobValue; },
    set currentKnobValue(v) { currentKnobValue = Math.max(-KNOB_VALUE_RANGE, Math.min(KNOB_VALUE_RANGE, v)); },
    get trialRunning() { return trialRunning; },
    set trialRunning(v) { trialRunning = v; },
    get participantId() { return participantId; },
    set participantId(v) { participantId = v; },
    get sessionData() { return sessionData; },

    currentDelay,
    handleTrialBeat,
    collectTrialData,
    resetTrialBuffers,
    randomKnobStart,

    initSession() {
      sessionData = {
        participantID: participantId,
        startDate: new Date().toISOString(),
        endDate: null,
        baselines: [],
        syncroTraining: [],
      };
      currentTrialIndex = -NUM_PRACTICES;
    },

    isPractice() {
      return currentTrialIndex < 0;
    },

    displayTrialLabel() {
      if (currentTrialIndex < 0) {
        return `PRACTICE TRIAL ${NUM_PRACTICES + currentTrialIndex + 1}`;
      }
      return `TRIAL ${currentTrialIndex + 1} of ${NUM_TRIALS}`;
    },

    showBodyMapThisTrial() {
      if (currentTrialIndex < 0) return false;
      return (currentTrialIndex + 1) % BODY_MAP_EVERY === 0;
    },

    isLastTrial() {
      return currentTrialIndex === NUM_TRIALS - 1;
    },

    advanceTrial() {
      currentTrialIndex++;
    },

    addTrialResult(trialData) {
      sessionData.syncroTraining.push(trialData);
    },

    addBaseline(baselineData) {
      sessionData.baselines.push(baselineData);
    },

    finalizeSession() {
      sessionData.endDate = new Date().toISOString();
    },

    exportJSON() {
      return JSON.stringify(sessionData, null, 2);
    },
  };
})();


// ============================================================
// UI CONTROLLER — manages screens and user interaction
// ============================================================
const UI = (function () {
  // Screen references
  const screens = {};
  let currentScreen = null;
  let knobInteracted = false;

  // Knob interaction state
  let knobEl, knobAngle = 0, knobDragging = false;
  let knobCenterX = 0, knobCenterY = 0;
  let lastAngle = 0;

  // Baseline state
  let baselineBPMs = [];
  let baselineTimer = null;
  let baselineStartTime = 0;

  // References
  let videoEl, canvasEl;

  function show(screenId) {
    if (currentScreen) currentScreen.classList.remove("active");
    currentScreen = screens[screenId];
    currentScreen.classList.add("active");
  }

  // ---- Knob logic (ported from Knob.swift) ----
  function initKnob() {
    knobEl = document.getElementById("knob");
    knobEl.addEventListener("pointerdown", knobStart, { passive: false });
    window.addEventListener("pointermove", knobMove, { passive: false });
    window.addEventListener("pointerup", knobEnd);
  }

  function setKnobAngle(value) {
    // Map value [-1, 1] to angle [-π, π]
    const normalized = (value + PAT.KNOB_VALUE_RANGE) / (2 * PAT.KNOB_VALUE_RANGE);
    knobAngle = (normalized * 2 * Math.PI) - Math.PI;
    updateKnobVisual();
  }

  function knobStart(e) {
    e.preventDefault();
    knobDragging = true;
    const rect = knobEl.getBoundingClientRect();
    knobCenterX = rect.left + rect.width / 2;
    knobCenterY = rect.top + rect.height / 2;
    lastAngle = Math.atan2(e.clientY - knobCenterY, e.clientX - knobCenterX);
    knobEl.setPointerCapture(e.pointerId);
  }

  function knobMove(e) {
    if (!knobDragging) return;
    e.preventDefault();
    knobInteracted = true;
    const angle = Math.atan2(e.clientY - knobCenterY, e.clientX - knobCenterX);
    let delta = angle - lastAngle;
    // Handle wraparound
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;

    knobAngle += delta;
    // Clamp to [-π, π]
    knobAngle = Math.max(-Math.PI, Math.min(Math.PI, knobAngle));
    lastAngle = angle;

    // Map angle to value: [-π, π] → [-1, 1]
    const normalized = (knobAngle + Math.PI) / (2 * Math.PI);
    PAT.currentKnobValue = (normalized * 2 - 1) * PAT.KNOB_VALUE_RANGE;

    updateKnobVisual();
    document.getElementById("confirm-trial-btn").disabled = false;
  }

  function knobEnd() {
    knobDragging = false;
  }

  function updateKnobVisual() {
    const dial = document.getElementById("knob-dial");
    if (dial) dial.style.transform = `rotate(${knobAngle}rad)`;
  }

  // ---- Screen flow ----
  function showParticipantId() {
    show("screen-participant");
    document.getElementById("participant-input").focus();
  }

  function showOnboarding(step) {
    show("screen-onboarding");
    const steps = document.querySelectorAll(".onboarding-step");
    steps.forEach((s) => s.classList.remove("active"));
    const target = document.querySelector(`.onboarding-step[data-step="${step}"]`);
    if (target) target.classList.add("active");
  }

  async function showBaseline() {
    show("screen-baseline");
    baselineBPMs = [];
    baselineStartTime = Date.now();
    const progressEl = document.getElementById("baseline-progress");
    const secsEl = document.getElementById("baseline-secs");
    const bpmIndicator = document.getElementById("baseline-bpm");

    videoEl = document.getElementById("video-feed");
    canvasEl = document.getElementById("sampling-canvas");

    await BeatDetector.start({
      video: videoEl,
      canvas: canvasEl,
      onBeatCb: (beat) => {
        baselineBPMs.push(beat.instantBPM);
        bpmIndicator.textContent = Math.round(beat.averageBPM);
      },
      onFingerChangeCb: (present) => {
        document.getElementById("baseline-finger-overlay").classList.toggle("visible", !present);
      },
    });

    baselineTimer = setInterval(() => {
      const elapsed = (Date.now() - baselineStartTime) / 1000;
      const remaining = Math.max(0, PAT.BASELINE_DURATION_S - elapsed);
      const pct = Math.min(1, elapsed / PAT.BASELINE_DURATION_S);
      progressEl.style.setProperty("--progress", pct);
      progressEl.textContent = Math.round(pct * 100) + "%";
      secsEl.textContent = Math.ceil(remaining);

      if (remaining <= 0) {
        clearInterval(baselineTimer);
        finishBaseline();
      }
    }, 1000);
  }

  async function finishBaseline() {
    await BeatDetector.stop();
    PAT.addBaseline({
      date: new Date().toISOString(),
      recordedHR: baselineBPMs.map((b) => Math.round(b)),
      instantBpms: [...baselineBPMs],
    });
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
      video: videoEl,
      canvas: canvasEl,
      onBeatCb: (beat) => {
        PAT.handleTrialBeat(beat);
        document.getElementById("trial-bpm").textContent = Math.round(beat.averageBPM);
      },
      onFingerChangeCb: (present) => {
        document.getElementById("trial-finger-overlay").classList.toggle("visible", !present);
      },
    });
  }

  async function confirmTrial() {
    PAT.trialRunning = false;
    await BeatDetector.stop();
    const trialData = PAT.collectTrialData();

    // Show confidence screen
    showConfidence(trialData);
  }

  function showConfidence(trialData) {
    show("screen-confidence");
    const slider = document.getElementById("confidence-slider");
    const valueDisplay = document.getElementById("confidence-value");
    // Random starting position like Swift app
    slider.value = Math.floor(Math.random() * 10);
    valueDisplay.textContent = slider.value;
    let userSet = false;

    const handleChange = () => {
      valueDisplay.textContent = slider.value;
      userSet = true;
      document.getElementById("confirm-confidence-btn").disabled = false;
    };
    slider.oninput = handleChange;

    document.getElementById("confirm-confidence-btn").disabled = true;
    document.getElementById("confirm-confidence-btn").onclick = () => {
      trialData.confidence = parseInt(slider.value);

      if (PAT.showBodyMapThisTrial()) {
        showBodyMap(trialData);
      } else {
        finalizeTrial(trialData);
      }
    };
  }

  function showBodyMap(trialData) {
    show("screen-bodymap");
    const parts = document.querySelectorAll(".body-part");
    const nowhereBtn = document.getElementById("nowhere-btn");
    const confirmBtn = document.getElementById("confirm-bodymap-btn");
    const selectedLabel = document.getElementById("bodymap-selected");
    let selectedPart = -1;

    confirmBtn.disabled = true;

    parts.forEach((p) => {
      p.classList.remove("selected");
      p.onclick = () => {
        parts.forEach((pp) => pp.classList.remove("selected"));
        nowhereBtn.classList.remove("selected");
        p.classList.add("selected");
        selectedPart = parseInt(p.dataset.value);
        selectedLabel.textContent = `You selected: ${p.dataset.name}`;
        confirmBtn.disabled = false;
      };
    });

    nowhereBtn.classList.remove("selected");
    nowhereBtn.onclick = () => {
      parts.forEach((pp) => pp.classList.remove("selected"));
      nowhereBtn.classList.add("selected");
      selectedPart = 8;
      selectedLabel.textContent = "You selected: nowhere";
      confirmBtn.disabled = false;
    };

    confirmBtn.onclick = () => {
      trialData.bodyPos = selectedPart;
      finalizeTrial(trialData);
    };
  }

  function finalizeTrial(trialData) {
    PAT.addTrialResult(trialData);
    PAT.advanceTrial();

    if (PAT.isLastTrial() || (PAT.currentTrialIndex >= PAT.NUM_TRIALS)) {
      showEnd();
    } else {
      startTrial();
    }
  }

  function showEnd() {
    PAT.finalizeSession();
    show("screen-end");
    const json = PAT.exportJSON();
    document.getElementById("data-preview").textContent =
      `Session complete. ${PAT.sessionData.syncroTraining.length} trials recorded.`;
  }

  function downloadData() {
    const json = PAT.exportJSON();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `PAT_${PAT.participantId}_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- Init ----
  function init() {
    // Cache screens
    document.querySelectorAll(".screen").forEach((s) => {
      screens[s.id] = s;
    });

    initKnob();
    AudioEngine.init();

    // Participant ID screen
    document.getElementById("start-btn").onclick = () => {
      const pid = document.getElementById("participant-input").value.trim();
      if (!pid) return;
      PAT.participantId = pid;
      PAT.initSession();
      showOnboarding("1");
    };

    // Onboarding navigation
    document.querySelectorAll("[data-next-step]").forEach((btn) => {
      btn.onclick = () => {
        const next = btn.dataset.nextStep;
        if (next === "baseline") {
          showBaseline();
        } else if (next === "start-trials") {
          startTrial();
        } else {
          showOnboarding(next);
        }
      };
    });

    // Trial confirm
    document.getElementById("confirm-trial-btn").onclick = () => {
      AudioEngine.resume();
      confirmTrial();
    };

    // Download
    document.getElementById("download-btn").onclick = downloadData;

    // Start
    showParticipantId();
  }

  return { init, downloadData };
})();


// ============================================================
// Boot
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  UI.init();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
});
