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

2. **Bandpass filtering.** The raw red channel signal passes through a custom IIR bandpass filter (high-pass at 0.67 Hz, low-pass at 3.33 Hz) to isolate the pulsatile cardiac component and reject DC drift and high-frequency noise. This passband corresponds to approximately 40–200 BPM.

3. **Adaptive peak detection.** Systolic peaks are identified in real-time using a three-sample peak test (sample N-1 is greater than both N-2 and N) with an amplitude threshold set at 60% of the local signal range over the preceding 3 seconds. A 500 ms refractory period prevents double-counting.

4. **iOS multi-camera handling.** On multi-lens iPhones, virtual camera devices (labeled "Dual" or "Triple") trigger automatic macro lens switching when the finger is close to the lens, destabilising the signal. The camera initialisation routine enumerates all physical cameras, skips virtual composites, and targets a specific single lens with confirmed torch capability.

### Audio Precision

Auditory tones are scheduled using the Web Audio API's `AudioContext` clock rather than `setTimeout` or `setInterval`. The `AudioContext` clock runs on a dedicated high-priority audio thread and provides sub-millisecond scheduling precision — critical for a task where the dependent variable is a temporal offset on the order of tens of milliseconds. Each tone event records both the `AudioContext.currentTime` at scheduling and the corresponding `performance.now()` value, enabling post-hoc alignment between the audio timeline and all other event timestamps.

### Motion Detection

The accelerometer (via the DeviceMotion API) monitors for excessive movement during trials. In the validation module, it additionally functions as a tap detector: a sharp acceleration spike above a threshold triggers an automatic sync marker, enabling researchers to align the browser timeline with external recording hardware by simultaneously tapping the phone and marking the external device.

## Data Output

Each session generates a JSON file containing the complete trial-level record. The structure is designed for direct ingestion into R (via `jsonlite::fromJSON()`) or Python (`json.load()` / `pandas`).

### PAT Session (`PAT_{id}_{date}.json`)

The top-level object contains:

- `participantID`, `taskType`, `date` — Session identifiers.
- `device` — Device and browser metadata (model, OS, browser name/version, screen dimensions, pixel ratio, touch support, raw user agent string).
- `data[]` — An array of event objects, each with a `type` field:

**`type: "baseline"`** — The 120-second calibration recording.
- `recordedHR`: Array of instantaneous BPM values for every detected beat.
- `totalBeats`: Total beat count (minimum 80 required to proceed).

**`type: "trial"`** — One per trial (2 practice + 20 experimental).
- `isPractice`: Boolean flag.
- `initialKnobValue`: The randomised starting position of the dial (range ±1.0).
- `instantPeriods` / `averagePeriods`: IBI arrays (seconds) recorded at each beat during the trial.
- `knobScales`: The dial position at each beat (the participant's running adjustment).
- `currentDelays`: The computed tone delay (seconds) applied at each beat.
- `instantErrs`: Beat-to-beat period change (for IBI variability analysis).
- `recordedHR` / `instantBpms`: Instantaneous and smoothed BPM at each beat.
- `toneTimings[]`: Per-tone timing metadata — `beatDetectedAt` (performance.now), `intendedDelay`, `scheduledAt` (AudioContext time), `perfNow` at scheduling.
- `fingerLossEvents[]`: Timestamps of finger-off and finger-on events.
- `confidence`: 0–9 Likert scale rating.
- `bodyPos`: Body region code (1–7) or 8 ("did not feel it") or -1 (not asked on this trial). Collected every 4th trial.

### EMA Session (`EMA_{id}_{date}.json`)

- `type: "ema"`
- `connected`: 0–100 slider (body awareness).
- `stress`: 0–100 slider.
- `text`: Free-text description of physical sensations.

### Onboarding (`onboarding_{id}_{date}.json`)

Contains consent metadata (initials, timestamp), scheduling preferences (available days, EMA time windows), device compatibility check results, practice trial summary (beat count, mean BPM), chosen theme, and device metadata.

### Validation (`{id}_CNAP_SYNC.json`)

- `beatTimestamps[]`: `performance.now()` values for every detected PPG peak.
- `syncMarkers[]`: Manual or tap-triggered markers with timestamps and type labels.
- `toneTimestamps[]`: Timestamps of test tones for audio latency measurement.

## Browser and Device Compatibility

The PPG pipeline requires rear camera access with torch control, which limits functional deployment to mobile browsers that expose these hardware APIs:

| Platform | Browser | Status |
|---|---|---|
| iOS 15+ | Safari | Fully supported (primary target). |
| iOS 15+ | Chrome / Firefox / Edge (iOS) | Functional — all use WebKit under the hood on iOS. |
| Android 8+ | Chrome | Fully supported. |
| Android | Firefox | Torch API support is inconsistent; may fail silently. |
| Desktop | Any | Camera/torch unavailable — cannot run PPG. EMA check-ins work. |

The `DeviceMotionEvent.requestPermission()` flow (required on iOS 13+) is handled automatically. Device and browser metadata are now collected at session start for methods reporting.

## Current Status

- **Core application:** PAT logic, PPG pipeline, EMA protocol, and onboarding flow are functional and deployed.
- **Validation:** A dedicated validation module (`validation.html`) supports CNAP/ECG comparison via synchronized timestamping. Formal validation is in progress.
- **Deployment:** Accessible via any modern mobile browser. Optimised for iOS Safari on iPhone.

## Acknowledgments

This project was developed at **The Ohio State University — The Affective Science Lab** under the supervision of **Dr. Kristen Lindquist**.

The ePAT is built upon and inspired by the following open-source research and software:

- **The Phase Adjustment Task (PAT):** The core psychophysical task logic is a port of the original PAT developed by the Huma Engineering team.
    - Research paper: [A phase adjustment task for the assessment of heartbeat perception accuracy (2021)](https://www.sciencedirect.com/science/article/pii/S0301051121001642)
    - Original source code (Swift/iOS): [huma-engineering/Phase-Adjustment-Task](https://github.com/huma-engineering/Phase-Adjustment-Task)

- **Web-Based PPG Detection:** The camera-based heart rate monitoring logic was adapted from the open-source work of Richard Moore.
    - Live demo: [heartrate.netlify.app](https://heartrate.netlify.app/)
    - Source code (JavaScript): [richrd/heart-rate-monitor](https://github.com/richrd/heart-rate-monitor)

- **Conceptual Framework:** The application of this tool for ecological momentary assessment is grounded in the Theory of Constructed Emotion and research into interoceptive predictive processing.

---

**Maintained by:** Keegan Whitacre
