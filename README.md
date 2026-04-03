# ePAT: Ecological Phase Assessment Task

A browser-based, mobile-first implementation of the Phase Adjustment Task (PAT) for measuring interoceptive accuracy in ecological settings, paired with an Ecological Momentary Assessment (EMA) protocol for longitudinal body awareness tracking.

## Overview

The Ecological Phase Assessment Task (ePAT) moves heartbeat detection research out of the laboratory and into the participant's natural environment. By utilizing standard smartphone hardware, ePAT measures a participant's ability to perceive the timing of their own heartbeat without the need for proprietary software or external sensors.

Unlike traditional heartbeat counting tasks — which are confounded by prior knowledge of heart rate, estimation heuristics, and time-counting strategies — the PAT is a psychophysical measure that requires participants to judge the synchronicity between their pulse and an external auditory tone. The phase adjustment approach yields a continuous dependent variable (the millisecond-level offset between heartbeat and stimulus) rather than a binary correct/incorrect count, providing richer data on interoceptive precision.

ePAT extends this paradigm by integrating the PAT with a longitudinal EMA protocol, enabling researchers to examine how interoceptive accuracy relates to daily fluctuations in body awareness, stress, and somatic sensation.

## Application Structure

The application consists of three standalone HTML files, each serving a distinct role in the study protocol:

| File | Purpose |
|---|---|
| `onboarding.html` | Participant enrollment: informed consent, EMA scheduling preferences, device compatibility checks, and a practice trial to verify PPG signal quality. |
| `index.html` | The core task application. Routes to either the PAT session (`?session=pat`) or the daily EMA check-in (`?session=ema`) via URL parameters. |
| `validation.html` | A researcher-facing tool for validating the browser PPG signal against external hardware (e.g., CNAP, ECG). Records beat timestamps, sync markers (manual or accelerometer-triggered tap), and audio tone events for offline alignment. |

All files are zero-dependency (vanilla JS/CSS/HTML) with no build step. The application also references a `manifest.json` and `sw.js` for optional PWA/home-screen installation.

### URL Parameters

The application supports URL-based configuration for programmatic session management:

| Parameter | Values | Effect |
|---|---|---|
| `id` | Any string | Pre-fills the participant ID field. |
| `session` | `pat` or `ema` | Routes to the Phase Adjustment Task or the daily EMA check-in. |
| `theme` | `blue`, `teal`, `violet`, `rose`, `amber` | Sets the UI accent colour (chosen during onboarding). |

## Technical Implementation

### PPG Signal Processing

The heart rate detection pipeline operates on frames from the device's rear camera with the torch (flashlight) active, creating a photoplethysmography (PPG) signal from light transmitted through the fingertip.

1. **Red channel extraction.** Each frame is drawn to a 40×40 canvas. The mean red channel intensity is computed across all pixels. Red dominance and overall brightness are used to determine whether a finger is present (with an 8-frame debounce to avoid flicker).

2. **Bandpass filtering.** The raw red channel signal passes through a custom IIR bandpass filter (high-pass at 0.67 Hz, low-pass at 3.33 Hz) to isolate the pulsatile cardiac component and reject DC drift and high-frequency noise. This passband corresponds to approximately 40–200 BPM. Filter coefficients are recomputed dynamically based on the actual camera framerate (see Dynamic Framerate below).

3. **WABP onset detection.** Beat detection uses a JavaScript port of the WABP algorithm (Zong, Heldt, Moody & Mark, 2003; *Computers in Cardiology* 30:259–262), adapted from the [PhysioNet reference implementation](http://www.physionet.org/physiotools/wfdb/app/wabp.c) for camera-rate PPG. The algorithm operates on the first derivative of the filtered signal:
   - The sample-to-sample difference is half-wave rectified (negative slopes zeroed) to isolate rising edges.
   - A moving sum over a 130ms window produces a "slope energy" signal with a bump at each pulse upstroke.
   - An adaptive dual-threshold system (Ta / T1 = Ta/3) self-calibrates during an 8-second learning period, tracking the running amplitude of detected pulses and decaying toward a minimum if no pulse is found for 2.5 seconds.
   - When the slope energy crosses the threshold, the algorithm searches backward from the crossing point to locate the pulse wave **onset** (the foot of the upstroke), not the peak.
   - A 250ms eye-closing period prevents within-beat retriggering. An additional 400ms minimum IBI guard at the BeatDetector layer rejects dicrotic notch reflections — the secondary pressure wave bump that can appear 300–400ms after onset, outside the WABP eye-closing window. This corresponds to a physiological ceiling of 150 BPM.
   - All time constants (eye-closing, slope window, learning period, threshold decay) rescale dynamically based on the actual camera framerate.

4. **iOS multi-camera handling.** On multi-lens iPhones, virtual camera devices (labeled "Dual" or "Triple") trigger automatic macro lens switching when the finger is close to the lens, destabilising the signal. The camera initialisation routine enumerates all physical cameras, skips virtual composites, and targets a specific single lens with confirmed torch capability.

### Dynamic Framerate Adaptation

Mobile camera framerates vary by device and can fluctuate during recording (ISP auto-exposure adjustments when the lens is occluded). The pipeline adapts to this:

- **High framerate request.** All `getUserMedia()` calls request `frameRate: { ideal: 120, min: 30 }`, yielding 60fps on most iPhones, 120fps on some flagships, and never worse than 30fps.
- **Actual FPS readback.** After stream acquisition, the actual negotiated framerate is read from `track.getSettings().frameRate` and used to recompute all framerate-dependent parameters (filter coefficients, WABP time constants, buffer sizes).
- **Per-frame processing.** The processing loop uses `requestVideoFrameCallback` when available (Chrome, Safari), which fires exactly once per decoded video frame — so at 120fps video, the signal is processed 120 times per second regardless of display refresh rate. Falls back to `requestAnimationFrame` on browsers without support.
- **Temporal resolution.** Higher framerates directly improve onset timing precision: ±33ms at 30fps → ±17ms at 60fps → ±8ms at 120fps (approaching the original WABP design point of 125Hz).

### Signal Quality Diagnostics

Each recording session collects per-trial diagnostics for post-hoc quality control:

- **Frame timing.** Inter-frame deltas are tracked continuously. The effective FPS (median-based), frame drop count (intervals > 2× expected), and frame interval jitter (IQR) are computed and logged.
- **ISP clipping detection.** Frames where brightness saturates above 0.95 or below 0.05 (with finger present) are counted. High clipping rates indicate the ISP auto-exposure is crushing the AC pulse component.
- **Group delay estimation.** The combined group delay of the bandpass filter cascade is analytically computed at 1.2 Hz (typical cardiac fundamental) for the actual framerate and filter coefficients.

Diagnostics are logged per-trial and per-baseline as a `ppgDiagnostics` object in the JSON output, enabling principled exclusion criteria and covariate analysis.

### Tone Scheduling

Auditory tones are triggered directly by detected heartbeats (beat-triggered scheduling), consistent with the PAT 2.0 approach (Palmer, Murphy, Bird et al., 2025). The earlier PAT 1.0 used predictive scheduling (estimating HR and scheduling tones at predicted future beat times), which was abandoned in PAT 2.0 because prediction error from sinus arrhythmia compounds with detection latency.

Tones are scheduled using the Web Audio API's `AudioContext` clock rather than `setTimeout` or `setInterval`. The `AudioContext` clock runs on a dedicated high-priority audio thread and provides sub-millisecond scheduling precision — critical for a task where the dependent variable is a temporal offset on the order of tens of milliseconds. Each tone event records both the `AudioContext.currentTime` at scheduling and the corresponding `performance.now()` value, enabling post-hoc alignment between the audio timeline and all other event timestamps.

### Motion Detection

The accelerometer (via the DeviceMotion API) monitors for excessive movement during trials. In the validation module, it additionally functions as a tap detector: a sharp acceleration spike above a threshold triggers an automatic sync marker, enabling researchers to align the browser timeline with external recording hardware by simultaneously tapping the phone and marking the external device.

## Data Output

Each session generates a JSON file containing the complete trial-level record. The structure is designed for direct ingestion into R (via `jsonlite::fromJSON()`) or Python (`json.load()` / `pandas`).

### PAT Session (`PAT_{id}_{date}.json`)

The top-level object contains:

- `participantID`, `taskType`, `date` — Session identifiers.
- `detectionAlgorithm` — The beat detection method used (currently `wabp_onset`).
- `device` — Device and browser metadata (model, OS, browser name/version, screen dimensions, pixel ratio, touch support, raw user agent string).
- `data[]` — An array of event objects, each with a `type` field:

**`type: "baseline"`** — The 120-second calibration recording.
- `recordedHR`: Array of instantaneous BPM values for every detected beat.
- `totalBeats`: Total beat count (minimum 80 required to proceed).
- `ppgSampleRate`: The actual camera framerate used during recording.
- `ppgDiagnostics`: Signal quality metrics (see Signal Quality Diagnostics above).

**`type: "trial"`** — One per trial (2 practice + 20 experimental).
- `isPractice`: Boolean flag.
- `initialKnobValue`: The randomised starting position of the dial (range ±1.0).
- `instantPeriods` / `averagePeriods`: IBI arrays (seconds) recorded at each beat during the trial.
- `knobScales`: The dial position at each beat (the participant's running adjustment).
- `currentDelays`: The computed tone delay (seconds) applied at each beat.
- `instantErrs`: Beat-to-beat period change (for IBI variability analysis).
- `recordedHR` / `instantBpms`: Instantaneous and smoothed BPM at each beat.
- `toneTimings[]`: Per-tone timing metadata — `beatDetectedAt` (performance.now), `beatTime`, `intendedDelay`, `scheduledAt` (AudioContext time), `perfNow` at scheduling.
- `fingerLossEvents[]`: Timestamps of finger-off and finger-on events.
- `confidence`: 0–9 Likert scale rating.
- `bodyPos`: Body region code (1–7) or 8 ("did not feel it") or -1 (not asked on this trial). Collected every 4th trial.
- `ppgDiagnostics`: Signal quality metrics for this trial (frame timing, clipping, group delay).

### EMA Session (`EMA_{id}_{date}.json`)

- `type: "ema"`
- `connected`: 0–100 slider (body awareness).
- `stress`: 0–100 slider.
- `text`: Free-text description of physical sensations.

### Onboarding (`onboarding_{id}_{date}.json`)

Contains consent metadata (initials, timestamp), scheduling preferences (available days, EMA time windows), device compatibility check results, practice trial summary (beat count, mean BPM), chosen theme, and device metadata.

### Validation (`{id}_CNAP_SYNC.json`)

- `beatTimestamps[]`: `performance.now()` values for every detected PPG onset.
- `syncMarkers[]`: Manual or tap-triggered markers with timestamps and type labels.
- `toneTimestamps[]`: Timestamps of test tones for audio latency measurement.
- `pulseBeepTimestamps[]`: Timestamps of pulse-triggered beeps (when pulse beep mode is active).

## Analysis

The data output is structured for compatibility with the PAT 2.0 analysis pipeline (Palmer, Murphy, Bird et al., 2025). Two scoring approaches are supported:

- **Phase-based consistency** (PAT 1.0): The selected delay is expressed as a proportion of the participant's IBI on each trial. Consistency is measured across trials.
- **Delay-based consistency** (PAT 2.0, recommended): The raw delay in milliseconds is used directly, without IBI normalisation. This captures fixed neural propagation delays that should not vary with heart rate.

PAT 2.0 recommends classifying participants as interoceptive or non-interoceptive using individualised thresholds (simulating random responders with the participant's own IBI distribution) rather than comparing continuous consistency scores across participants. Example analysis code is available at [osf.io/fp5sq](https://osf.io/fp5sq/).

## Browser and Device Compatibility

The PPG pipeline requires rear camera access with torch control, which limits functional deployment to mobile browsers that expose these hardware APIs:

| Platform | Browser | Status |
|---|---|---|
| iOS 15+ | Safari | Fully supported (primary target). |
| iOS 15+ | Chrome / Firefox / Edge (iOS) | Functional — all use WebKit under the hood on iOS. |
| Android 8+ | Chrome | Fully supported. |
| Android | Firefox | Torch API support is inconsistent; may fail silently. |
| Desktop | Any | Camera/torch unavailable — cannot run PPG. EMA check-ins work. |

The `DeviceMotionEvent.requestPermission()` flow (required on iOS 13+) is handled automatically. Device and browser metadata are collected at session start for methods reporting.

## Known Limitations

- **No ISP control.** Browser APIs cannot disable auto-exposure, auto-white-balance, or auto-focus. The native Huma PAT app locks these for the finger-on-lens scenario. Mitigated by signal quality diagnostics (clipping detection, frame drop tracking) enabling post-hoc QC.
- **Audio latency.** Web Audio API introduces 5–20ms non-deterministic latency through the browser audio graph vs. CoreAudio/AAudio in native apps. This latency is constant within a session and does not affect consistency scores, but limits absolute delay comparisons across platforms.
- **Variable framerate.** Mobile ISPs can drop frames or reduce framerate when the lens is occluded to increase exposure time. Mitigated by frame timing diagnostics but not preventable from JavaScript.
- **IIR filter group delay.** The bandpass filter introduces a frequency-dependent phase shift (~30–80ms at cardiac frequencies depending on framerate). This is constant across beats within a session and cancels out in consistency scoring. The delay is analytically estimated and logged in `ppgDiagnostics.estimatedGroupDelayMs`.

## Acknowledgments

This project was developed at **The Ohio State University — The Affective Science Lab** under the supervision of **Dr. Kristen Lindquist**.

The ePAT is built upon and inspired by the following research and open-source software:

- **The Phase Adjustment Task (PAT):** The core psychophysical task logic is adapted from the PAT developed by Plans, Ponzo, Morelli, Cairo, Ring, Keating, Cunningham, Catmur, Murphy & Bird.
    - Original paper: [Measuring interoception: the phase adjustment task (2021)](https://www.sciencedirect.com/science/article/pii/S0301051121001642). *Biological Psychology*, 165, 108171.
    - PAT 2.0 refinements: Palmer, Murphy, Bird et al. (2025). Refinements of the Phase Adjustment Task (PAT 2.0). Preprint, [doi:10.31219/osf.io/4qtwv](https://doi.org/10.31219/osf.io/4qtwv).
    - Original source code (Swift/iOS): [huma-engineering/Phase-Adjustment-Task](https://github.com/huma-engineering/Phase-Adjustment-Task)

- **WABP Beat Detection Algorithm:** The onset detection algorithm is a JavaScript port of the WABP arterial blood pressure pulse detector.
    - Zong, W., Heldt, T., Moody, G.B. & Mark, R.G. (2003). An open-source algorithm to detect onset of arterial blood pressure pulses. *Computers in Cardiology*, 30, 259–262.
    - PhysioNet source: [wabp.c](http://www.physionet.org/physiotools/wfdb/app/wabp.c)

- **Web-Based PPG Detection:** The camera-based heart rate monitoring approach was informed by the open-source work of Richard Moore.
    - Live demo: [heartrate.netlify.app](https://heartrate.netlify.app/)
    - Source code (JavaScript): [richrd/heart-rate-monitor](https://github.com/richrd/heart-rate-monitor)

- **Conceptual Framework:** The application of this tool for ecological momentary assessment is grounded in the Theory of Constructed Emotion and research into interoceptive predictive processing.

---

**Maintained by:** Keegan Whitacre
