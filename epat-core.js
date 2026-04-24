/* ============================================================
 * epat-core.js
 * ------------------------------------------------------------
 * the ecological phase adjustment task — core signal pipeline.
 *
 * this file is the validated ppg + audio + motion stack,
 * extracted from the study code so it can be reused across
 * entry points (task, onboarding, validation) without copy-paste.
 *
 * cnap-validated against a ground-truth hemodynamic reference.
 * do not modify without re-running the validation sync session.
 *
 * exposes a single global namespace: window.ePATCore
 *   - WakeLockCtrl   : screen wake lock (ios/android)
 *   - WabpDetector   : zong et al. 2003 wabp onset algorithm
 *   - BeatDetector   : full ppg pipeline (camera → filter → wabp → beats)
 *   - AudioEngine    : web audio scheduler with refractory gate
 *   - MotionDetector : accelerometer movement watchdog
 *
 * api contract notes:
 *   - BeatDetector.setCallbacks() does NOT reset filter/detector state.
 *     this is deliberate — filter continuity across trials is the whole
 *     reason the callbacks are swappable mid-stream.
 *   - only BeatDetector.stop() fully tears down camera + filter state.
 *   - all timestamps use performance.now() (monotonic, ms since page load).
 *     wall-clock anchoring is the responsibility of the caller.
 * ============================================================ */

(function () {

  // ============================================================
  // WAKE LOCK CONTROLLER
  // ============================================================
  const WakeLockCtrl = (function() {
    let wl = null;
    return {
      async request() {
        try { if ("wakeLock" in navigator) { wl = await navigator.wakeLock.request("screen"); } } catch (e) {}
      },
      release() {
        try { if (wl) { wl.release(); wl = null; } } catch (e) {}
      }
    };
  })();

  // ============================================================
  // WABP ONSET DETECTOR (Zong et al. 2003, adapted for camera PPG)
  // ------------------------------------------------------------
  // sample-indexed, not time-indexed. reset() converts time constants
  // to sample counts based on the current framerate. stay close to the
  // paper's defaults — aggressive tuning diverges from published behavior.
  // ============================================================
  const WabpDetector = (function () {
    let SAMPLE_RATE, EYE_CLS_SAMPLES, SLP_WINDOW, NDP_SAMPLES, LPERIOD_SAMPLES, INIT_WINDOW;
    const TM_FLOOR_RATIO = 0.05;

    let slopeBuffer = [], slopeEnergyBuffer = [];
    let sampleIndex = 0, learning = true, learningComplete = false;
    let T0 = 0, Ta = 0, T1 = 0, Tm = 0;
    let lastOnsetIndex = -Infinity, noDetectTimer = 0, prevSample = 0;

    function reset(sampleRate) {
      SAMPLE_RATE      = sampleRate || 30;
      EYE_CLS_SAMPLES  = Math.round(0.25  * SAMPLE_RATE);
      SLP_WINDOW       = Math.max(2, Math.round(0.13 * SAMPLE_RATE));
      NDP_SAMPLES      = Math.round(2.5   * SAMPLE_RATE);
      LPERIOD_SAMPLES  = Math.round(8.0   * SAMPLE_RATE);
      INIT_WINDOW      = Math.round(8.0   * SAMPLE_RATE);
      slopeBuffer = []; slopeEnergyBuffer = [];
      sampleIndex = 0; learning = true; learningComplete = false;
      T0 = 0; Ta = 0; T1 = 0; Tm = 0;
      lastOnsetIndex = -Infinity; noDetectTimer = 0; prevSample = 0;
    }

    function processSample(filteredSample) {
      sampleIndex++;
      const dy = Math.max(0, filteredSample - prevSample);
      prevSample = filteredSample;
      slopeBuffer.push(dy);

      let slopeEnergy = 0;
      const startIdx = Math.max(0, slopeBuffer.length - SLP_WINDOW);
      for (let i = startIdx; i < slopeBuffer.length; i++) slopeEnergy += slopeBuffer[i];
      slopeEnergyBuffer.push(slopeEnergy);

      const MAX_BUF = SAMPLE_RATE * 10;
      if (slopeBuffer.length > MAX_BUF) {
        slopeBuffer = slopeBuffer.slice(-MAX_BUF);
        slopeEnergyBuffer = slopeEnergyBuffer.slice(-MAX_BUF);
      }

      if (learning) {
        if (sampleIndex === INIT_WINDOW) {
          let sum = 0;
          for (let i = 0; i < slopeEnergyBuffer.length; i++) sum += slopeEnergyBuffer[i];
          T0 = sum / slopeEnergyBuffer.length;
          Ta = 3 * T0; Tm = T0 * TM_FLOOR_RATIO;
        }
        if (sampleIndex <= LPERIOD_SAMPLES) { T1 = 2 * T0; return { detected: false }; }
        else { learning = false; learningComplete = true; T1 = Ta / 3; }
      }
      if (!learningComplete) return { detected: false };

      if (sampleIndex - lastOnsetIndex < EYE_CLS_SAMPLES) return { detected: false };

      if (slopeEnergy > T1) {
        const seLen = slopeEnergyBuffer.length;
        const halfEye = Math.floor(EYE_CLS_SAMPLES / 2);
        if (seLen >= 3) {
          const s0 = slopeEnergyBuffer[seLen - 3], s1 = slopeEnergyBuffer[seLen - 2], s2 = slopeEnergyBuffer[seLen - 1];
          if (s1 >= s0 && s1 >= s2 && s1 > T1) {
            let maxVal = s1, minVal = s1;
            for (let j = seLen - 2; j >= Math.max(0, seLen - 2 - halfEye); j--) {
              if (slopeEnergyBuffer[j] > maxVal) maxVal = slopeEnergyBuffer[j];
              if (slopeEnergyBuffer[j] < minVal) minVal = slopeEnergyBuffer[j];
            }
            if (maxVal > minVal * 1.5 + 1e-6) {
              const onsetThresh = maxVal * 0.02;
              let onsetIdx = seLen - 2;
              for (let j = seLen - 2; j >= Math.max(0, seLen - 2 - halfEye); j--) {
                if (j > 0 && (slopeEnergyBuffer[j] - slopeEnergyBuffer[j - 1]) < onsetThresh) { onsetIdx = j; break; }
              }
              Ta += (maxVal - Ta) / 10; T1 = Ta / 3;
              lastOnsetIndex = sampleIndex; noDetectTimer = 0;
              const framesAgo = (seLen - 1) - onsetIdx;
              return { detected: true, onsetIndex: sampleIndex - framesAgo, peakEnergy: maxVal };
            }
          }
        }
      }

      noDetectTimer++;
      if (noDetectTimer > NDP_SAMPLES && Ta > Tm) { Ta -= Ta * 0.005; if (Ta < Tm) Ta = Tm; T1 = Ta / 3; }
      return { detected: false };
    }

    return { reset, processSample };
  })();

  // ============================================================
  // PPG BEAT DETECTOR (WABP onset, dynamic framerate, rAF loop)
  // ------------------------------------------------------------
  // pipeline: camera red channel → iir bandpass 0.67–3.33 hz → wabp.
  // dicrotic rejection via median-anchored 60% gate. median not mean
  // so a single fast outlier can't poison the running period.
  // camera selection excludes front + physical lens labels (ultra/tele)
  // + composite virtuals (dual/triple) so ios doesn't hand us a lens
  // that can't drive torch.
  // ============================================================
  const BeatDetector = (function () {
    const IMAGE_SIZE = 40, BUFFER_SECONDS = 8;
    const FINGER_BRIGHTNESS_MIN = 0.15, FINGER_BRIGHTNESS_MAX = 0.98, FINGER_RED_DOMINANCE = 0.38;

    let video = null, canvas = null, ctx = null, stream = null, track = null;
    let running = false, animFrameId = null, actualFPS = 30, startTime = 0, lastFrameTime = 0;
    let fingerPresent = false, fingerDebounceCount = 0;
    const FINGER_DEBOUNCE_FRAMES = 8;

    let rawBuffer = [], timeBuffer = [], filteredBuffer = [];
    let instantPeriod = 0, averagePeriod = 0, lastBeatTime = 0;
    let prevAcceptedBeatTime = 0, prevAcceptedIbi = 0;
    let recentPeriods = [];
    const MAX_RECENT_PERIODS = 10;

    // --- dicrotic notch rejection state ---
    let dicroticRejectCount = 0;

    // --- sqi (signal quality index) via perfusion index ---
    let lastSqiTime = 0, currentSqi = 0;
    const SQI_INTERVAL_MS = 1000;
    const SQI_WINDOW_S = 2;

    // --- frame timing diagnostics (vfr detection) ---
    let frameDeltaBuffer = [], frameDropCount = 0, totalFrames = 0;

    // --- brightness clipping diagnostics (isp auto-exposure) ---
    let clipCount = 0, clipTotal = 0;

    // bandpass filter — coefficients recomputed when actualFPS is known
    let HP_ALPHA = 0, LP_ALPHA = 0, hpState = { x1: 0, y1: 0 }, lpState = { y1: 0 };

    function computeFilterCoeffs(sr) {
      const hpRC = 1 / (2 * Math.PI * 0.67), lpRC = 1 / (2 * Math.PI * 3.33);
      HP_ALPHA = hpRC / (hpRC + 1 / sr); LP_ALPHA = (1 / sr) / (lpRC + 1 / sr);
    }
    function highpass(x) { const y = HP_ALPHA * (hpState.y1 + x - hpState.x1); hpState.x1 = x; hpState.y1 = y; return y; }
    function lowpass(x) { const y = lpState.y1 + LP_ALPHA * (x - lpState.y1); lpState.y1 = y; return y; }
    function bandpass(x) { return lowpass(highpass(x)); }
    function resetFilters() { hpState = { x1: 0, y1: 0 }; lpState = { y1: 0 }; }

    function getMedian(arr) {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }

    // callbacks — swappable mid-stream via setCallbacks()
    let onBeat = null, onFingerChange = null, onPPGSample = null, onSqiUpdate = null, onDicroticReject = null;

    function extractRedMean() {
      ctx.drawImage(video, 0, 0, IMAGE_SIZE, IMAGE_SIZE);
      const d = ctx.getImageData(0, 0, IMAGE_SIZE, IMAGE_SIZE).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
      const rMean = r / n / 255, gMean = g / n / 255, bMean = b / n / 255;
      const brightness = (rMean + gMean + bMean) / 3;
      const redRatio = rMean / (rMean + gMean + bMean + 1e-6);

      // clipping diagnostic — isp drove exposure to the rails
      clipTotal++;
      if (rMean > 0.97) clipCount++;

      const looksLikeFinger = brightness > FINGER_BRIGHTNESS_MIN && brightness < FINGER_BRIGHTNESS_MAX && redRatio > FINGER_RED_DOMINANCE;
      if (looksLikeFinger === fingerPresent) fingerDebounceCount = 0;
      else {
        fingerDebounceCount++;
        if (fingerDebounceCount >= FINGER_DEBOUNCE_FRAMES) {
          fingerPresent = looksLikeFinger;
          fingerDebounceCount = 0;
          if (onFingerChange) onFingerChange(fingerPresent);
        }
      }
      return rMean;
    }

    function computeSqi() {
      const windowSamples = Math.round(actualFPS * SQI_WINDOW_S);
      if (rawBuffer.length < windowSamples) return 0;
      const window = rawBuffer.slice(-windowSamples);
      let min = window[0], max = window[0], sum = 0;
      for (let i = 0; i < window.length; i++) {
        if (window[i] < min) min = window[i];
        if (window[i] > max) max = window[i];
        sum += window[i];
      }
      const mean = sum / window.length;
      if (mean < 1e-6) return 0;
      return (max - min) / mean; // perfusion index
    }

    function processFrame() {
      if (!running) return;
      const now = performance.now();
      const rawValue = extractRedMean(), filtered = bandpass(rawValue);
      const BUFFER_SIZE = Math.round(actualFPS * BUFFER_SECONDS);

      // track actual inter-frame timing
      totalFrames++;
      if (lastFrameTime > 0) {
        const dt = now - lastFrameTime;
        frameDeltaBuffer.push(dt);
        if (frameDeltaBuffer.length > 300) frameDeltaBuffer.shift();
        const expectedInterval = 1000 / actualFPS;
        if (dt > expectedInterval * 2) frameDropCount++;
      }
      lastFrameTime = now;

      rawBuffer.push(rawValue); timeBuffer.push(now); filteredBuffer.push(filtered);
      if (rawBuffer.length > BUFFER_SIZE) { rawBuffer.shift(); timeBuffer.shift(); filteredBuffer.shift(); }
      if (onPPGSample) onPPGSample(filtered);

      if (fingerPresent && (now - lastSqiTime > SQI_INTERVAL_MS)) {
        currentSqi = computeSqi();
        lastSqiTime = now;
        if (onSqiUpdate) onSqiUpdate(currentSqi);
      }

      if (fingerPresent && (now - startTime > 2000)) {
        const result = WabpDetector.processSample(filtered);
        if (result.detected) {
          const beatTime = now - (1000 / actualFPS);
          const interval = beatTime - lastBeatTime;

          // signal drop re-anchor
          if (lastBeatTime === 0 || interval > 2500) {
            lastBeatTime = beatTime;
            recentPeriods = [];
            animFrameId = requestAnimationFrame(processFrame);
            return;
          }

          // absolute physiological floor — 350ms = 171bpm, no resting human
          if (interval < 350) {
            animFrameId = requestAnimationFrame(processFrame);
            return;
          }

          // median-anchored dicrotic gate
            let isDicrotic = false;
            const DICROTIC_MIN_PERIODS = 3;
            // Default to a safe 800ms (75 BPM) baseline while learning the first 3 beats
            const expectedPeriodMs = recentPeriods.length >= DICROTIC_MIN_PERIODS 
            ? getMedian(recentPeriods) * 1000 
            : 800;
            // 60% allows deep-breath rsa but blocks the notch (fires ~30–45% through cycle)
            if (interval < expectedPeriodMs * 0.60) isDicrotic = true;

            if (isDicrotic) {
            dicroticRejectCount++;
            if (onDicroticReject) onDicroticReject({
                time: beatTime,
                rejectedIbi: interval,
                expectedPeriod: expectedPeriodMs // <-- Use the warmup variable
            });
            // do NOT update lastBeatTime — notch is ignored
          } else {
            prevAcceptedBeatTime = lastBeatTime;
            prevAcceptedIbi = interval;
            lastBeatTime = beatTime;

            instantPeriod = interval / 1000;
            const instantBPM = 60 / instantPeriod;

            recentPeriods.push(instantPeriod);
            if (recentPeriods.length > MAX_RECENT_PERIODS) recentPeriods.shift();

            averagePeriod = getMedian(recentPeriods);
            const averageBPM = 60 / averagePeriod;

            if (onBeat) onBeat({ instantBPM, averageBPM, instantPeriod, averagePeriod, time: beatTime });
          }
        }
      }

      animFrameId = requestAnimationFrame(processFrame);
    }

async function startCamera() {
      if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }

      // prime permissions — ios enumerateDevices returns empty labels before permission
      try {
        const tempStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        tempStream.getTracks().forEach(t => t.stop());
      } catch (e) { /* ignore */ }

      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter((d) => d.kind === "videoinput");
      let torchWorking = false;

      // rank cameras — exclude front, virtual composites, and individual physical lenses
      const ranked = [];
      for (const cam of cameras) {
        const label = (cam.label || "").toLowerCase();
        if (label.includes("front") || label.includes("facetime")) continue;
        if (label.includes("dual") || label.includes("triple")) continue;
        if (label.includes("ultra") || label.includes("tele")) continue;
        ranked.push(cam);
      }
      // fallback: if filtering killed everything, try any back camera
      if (ranked.length === 0) {
        for (const cam of cameras) {
          const label = (cam.label || "").toLowerCase();
          if (!label.includes("front") && !label.includes("facetime")) ranked.push(cam);
        }
      }

      for (const cam of ranked) {
        let streamSuccess = false;
        
        // The Waterfall: Try strict 60, then strict 30, then fallback to anything
        const frameRateFallbacks = [
          { exact: 60 },
          { exact: 30 },
          { ideal: 30 } 
        ];

        for (const fpsTarget of frameRateFallbacks) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: {
                deviceId: { exact: cam.deviceId },
                width:  { ideal: 640 },
                height: { ideal: 480 },
                frameRate: fpsTarget
              }
            });
            streamSuccess = true;
            break; // We successfully locked a framerate, stop trying
          } catch (e) {
            // Phone rejected this framerate constraint, loop and try the next one
          }
        }

        if (!streamSuccess) continue; // Move to the next physical lens if all fallbacks failed

        track = stream.getVideoTracks()[0];
        
        // try torch
        try {
          const caps = track.getCapabilities ? track.getCapabilities() : {};
          if (caps.torch) {
            await track.applyConstraints({ advanced: [{ torch: true }] });
            torchWorking = true;
            break; // Success! Break out of the camera loop
          }
        } catch (e) {}
        
        // no torch — release and keep looking
        stream.getTracks().forEach(t => t.stop()); stream = null; track = null;
      }

      if (!stream) throw new Error("no usable rear camera with torch");
      if (!torchWorking) throw new Error("torch not available on any rear camera");

      video.srcObject = stream;
      await video.play();

      const settings = track.getSettings();
      actualFPS = settings.frameRate || 30;

      return { actualFPS, label: track.label, torchWorking };
    }

    async function stopCamera() {
      try {
        if (track && track.getCapabilities && track.getCapabilities().torch) {
          await track.applyConstraints({ advanced: [{ torch: false }] });
        }
      } catch (e) {}
      if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; track = null; }
      if (video) video.srcObject = null;
    }

    return {
      async start(opts) {
        video  = opts.video;
        canvas = opts.canvas;
        ctx    = canvas.getContext("2d", { willReadFrequently: true });
        canvas.width = IMAGE_SIZE; canvas.height = IMAGE_SIZE;

        onBeat           = opts.onBeatCb || null;
        onFingerChange   = opts.onFingerChangeCb || null;
        onPPGSample      = opts.onPPGSampleCb || null;
        onSqiUpdate      = opts.onSqiUpdateCb || null;
        onDicroticReject = opts.onDicroticRejectCb || null;

        await startCamera();

        // reset all running state
        rawBuffer = []; timeBuffer = []; filteredBuffer = [];
        recentPeriods = []; instantPeriod = 0; averagePeriod = 0;
        lastBeatTime = 0; prevAcceptedBeatTime = 0; prevAcceptedIbi = 0;
        fingerPresent = false; fingerDebounceCount = 0;
        lastSqiTime = 0; currentSqi = 0;
        frameDeltaBuffer = []; frameDropCount = 0; totalFrames = 0;
        clipCount = 0; clipTotal = 0;
        dicroticRejectCount = 0;

        computeFilterCoeffs(actualFPS); resetFilters();
        WabpDetector.reset(actualFPS);

        startTime = performance.now(); lastFrameTime = 0; running = true;
        processFrame();

        // return the stream so callers can inspect video track capabilities
        // (onboarding uses this to check torch capability)
        return stream;
      },

      async stop() {
        running = false;
        if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
        await stopCamera();
      },

      // swap callbacks without touching filter/detector state.
      // this is how trial boundaries work — new trial, new callbacks, same running pipeline.
      setCallbacks(cbs) {
        if (cbs.onBeatCb !== undefined)           onBeat           = cbs.onBeatCb;
        if (cbs.onFingerChangeCb !== undefined)   onFingerChange   = cbs.onFingerChangeCb;
        if (cbs.onPPGSampleCb !== undefined)      onPPGSample      = cbs.onPPGSampleCb;
        if (cbs.onSqiUpdateCb !== undefined)      onSqiUpdate      = cbs.onSqiUpdateCb;
        if (cbs.onDicroticRejectCb !== undefined) onDicroticReject = cbs.onDicroticRejectCb;
      },

      getActualFPS() { return actualFPS; },
      getSqi() { return currentSqi; },
      getDicroticRejectCount() { return dicroticRejectCount; },
      getDiagnostics() {
        const avgDelta = frameDeltaBuffer.length
          ? frameDeltaBuffer.reduce((a, b) => a + b, 0) / frameDeltaBuffer.length
          : 0;
        return {
          totalFrames, frameDropCount, avgFrameDelta: avgDelta,
          clipRate: clipTotal ? (clipCount / clipTotal) * 100 : 0,
          dicroticRejects: dicroticRejectCount,
        };
      },
    };
  })();

  // ============================================================
  // AUDIO ENGINE
  // ------------------------------------------------------------
  // two apis:
  //   scheduleAt(delaySec) — audio-clock scheduled, frame-accurate.
  //     use this for task tones where timing vs beat detection matters.
  //   play() — fire now with a perf-clock refractory gate.
  //     use this for "beep on pulse" monitoring in the validation tool.
  //
  // reactive on-detection scheduling (pat 2.0 correct architecture).
  // 350ms refractory gate prevents physiologically impossible tone pairs.
  // defensive resume for ios suspended + interrupted states.
  // ============================================================
  const AudioEngine = (function () {
    let audioCtx = null, lowBuf = null;

    function createBeep(freq, dur) {
      const sr = 44100, len = sr * dur, buf = audioCtx.createBuffer(1, len, sr), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        d[i] = Math.sin(2 * Math.PI * freq * t) * Math.min(1, t * 50) * Math.min(1, (dur - t) * 50) * 0.5;
      }
      return buf;
    }

    // physiological floor — 350ms ≈ 171bpm. closer pairs can't reflect distinct cycles.
    const MIN_TONE_SPACING = 0.35;       // seconds — used by scheduleAt
    const MIN_TONE_SPACING_MS = 350;     // ms — used by play()
    let lastScheduledWhen = 0;
    let lastPlayedPerfNow = 0;
    let dropLog = []; // {perfNow, requestedWhen?, sinceLastMs, ctxState}

    return {
      init() {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        lowBuf = createBeep(440, 0.08);
      },
      scheduleAt(delaySec) {
        if (!audioCtx) return null;
        // defensive resume — ios suspends aggressively on backgrounding/notifications
        if (audioCtx.state === "suspended" || audioCtx.state === "interrupted") {
          audioCtx.resume();
        }
        const when = audioCtx.currentTime + Math.max(0, delaySec);
        const sinceLast = (when - lastScheduledWhen) * 1000;
        if (when - lastScheduledWhen < MIN_TONE_SPACING) {
          dropLog.push({ perfNow: performance.now(), requestedWhen: when, sinceLastMs: Math.round(sinceLast), ctxState: audioCtx.state });
          return { dropped: true, sinceLastMs: sinceLast };
        }
        const s = audioCtx.createBufferSource();
        s.buffer = lowBuf; s.connect(audioCtx.destination);
        s.start(when);
        lastScheduledWhen = when;
        return { scheduledAt: when, perfNow: performance.now(), delaySec, ctxState: audioCtx.state };
      },
      // fire immediately with a perf-clock refractory gate. validation tool uses this.
      play() {
        if (!audioCtx) return null;
        if (audioCtx.state === "suspended" || audioCtx.state === "interrupted") audioCtx.resume();
        const now = performance.now();
        const sinceLast = now - lastPlayedPerfNow;
        if (sinceLast < MIN_TONE_SPACING_MS) {
          dropLog.push({ perfNow: now, sinceLastMs: Math.round(sinceLast), ctxState: audioCtx.state });
          return { dropped: true, sinceLastMs: sinceLast };
        }
        const s = audioCtx.createBufferSource();
        s.buffer = lowBuf; s.connect(audioCtx.destination);
        s.start();
        lastPlayedPerfNow = now;
        return { perfNow: now, ctxState: audioCtx.state };
      },
      resetSchedulerState() { lastScheduledWhen = 0; lastPlayedPerfNow = 0; },
      getDropLog() { return dropLog.slice(); },
      clearDropLog() { dropLog = []; },
      playLow() {
        if (!audioCtx) return;
        if (audioCtx.state === "suspended" || audioCtx.state === "interrupted") audioCtx.resume();
        const s = audioCtx.createBufferSource(); s.buffer = lowBuf; s.connect(audioCtx.destination); s.start();
      },
      resume() { if (audioCtx && (audioCtx.state === "suspended" || audioCtx.state === "interrupted")) audioCtx.resume(); },
      getState() { return audioCtx ? audioCtx.state : "uninitialized"; },
      getContext() { return audioCtx; },
    };
  })();

  // ============================================================
  // MOTION DETECTOR
  // ------------------------------------------------------------
  // accelerometer watchdog. warns when the phone is being moved
  // beyond a light-tremor threshold during a trial.
  //
  // also handles hard-tap detection — used by the validation tool
  // to drop sync markers into the timeline for cnap alignment.
  // the task itself doesn't pass a tap callback, so tap detection
  // is effectively off during a trial.
  // ============================================================
  const MotionDetector = (function () {
    const MOVEMENT_THRESHOLD = 0.2;
    const HARD_TAP_THRESHOLD = 12;

    let accBuffer = [], lastAcc = { x: 0, y: 0, z: 0 };
    let listening = false, permitted = false;
    let onMovementWarning = null, onTapCb = null;
    let tapDebounce = false;

    function handleMotion(e) {
      const a = e.accelerationIncludingGravity || e.acceleration;
      if (!a) return;
      const diffMag = Math.sqrt(Math.pow(a.x - lastAcc.x, 2) + Math.pow(a.y - lastAcc.y, 2) + Math.pow(a.z - lastAcc.z, 2));
      accBuffer.push(diffMag);

      // hard tap → fire sync callback (validation uses this for cnap alignment)
      if (diffMag > HARD_TAP_THRESHOLD && !tapDebounce) {
        if (onTapCb) onTapCb();
        tapDebounce = true;
        setTimeout(() => tapDebounce = false, 800);
      }

      lastAcc = { x: a.x, y: a.y, z: a.z };
    }

    return {
      async requestPermission() {
        if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
          try { const perm = await DeviceMotionEvent.requestPermission(); permitted = (perm === "granted"); } catch (e) { permitted = false; }
        } else { permitted = true; }
        return permitted;
      },
      // second arg (tapCb) is optional — only used by validation tool
      start(warningCb, tapCb) {
        if (!permitted) return;
        onMovementWarning = warningCb || null;
        onTapCb = tapCb || null;
        accBuffer = []; lastAcc = { x: 0, y: 0, z: 0 }; tapDebounce = false;
        window.addEventListener("devicemotion", handleMotion); listening = true;
      },
      stop() { if (listening) { window.removeEventListener("devicemotion", handleMotion); listening = false; } },
      checkMovement() {
        if (accBuffer.length === 0) return false;
        const mean = accBuffer.reduce((a, b) => a + b, 0) / accBuffer.length;
        accBuffer = [];
        const tooMuch = mean > MOVEMENT_THRESHOLD;
        if (tooMuch && onMovementWarning) onMovementWarning();
        return tooMuch;
      },
    };
  })();

  // ============================================================
  // EXPORT
  // ============================================================
  window.ePATCore = {
    WakeLockCtrl,
    WabpDetector,
    BeatDetector,
    AudioEngine,
    MotionDetector,
  };

})();
