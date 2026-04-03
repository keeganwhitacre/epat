# ePAT: Ecological Phase Assessment Task

A browser-based, mobile-first implementation of the Phase Adjustment Task (PAT) for measuring interoceptive accuracy in ecological settings.

## Overview

The Ecological Phase Assessment Task (ePAT) is designed to move heartbeat detection research out of the laboratory and into the participant's natural environment. By utilizing standard smartphone hardware, ePAT measures a participant's ability to perceive the timing of their own heartbeat without the need for proprietary software or external sensors.

Unlike traditional heartbeat counting tasks, which are often confounded by prior knowledge of heart rate or time-counting strategies, the PAT is a psychophysical measure that requires participants to judge the synchronicity between their pulse and an external auditory tone.

## Technical Implementation

### Architecture
- **Single-File Deployment:** The entire application (logic, UI, and signal processing) is contained within a single HTML file.
- **Zero Dependencies:** Built using vanilla JavaScript, CSS, and HTML. No build steps or external libraries are required.
- **Hardware Access:** Utilizes the device camera and torch for photoplethysmography (PPG) and the accelerometer for motion detection.

### Signal Processing
- **PPG Pipeline:** Extracting the mean of the red channel from the camera feed, the app uses a custom IIR bandpass filter (0.67–3.33 Hz) to isolate the pulsatile signal.
- **Peak Detection:** Real-time adaptive peak detection identifies systolic peaks to calculate inter-beat intervals (IBIs).

### Precision Audio Engine
- **Web Audio API:** Tones are scheduled using the `AudioContext` clock to ensure sub-millisecond temporal precision. This is critical for phase adjustment tasks where the dependent variable is the millisecond-level offset between the heartbeat and the stimulus.

## Data Output

The application generates a comprehensive **JSON object** for each session. This structure is designed for easy integration with various backends (e.g., Firebase, Supabase, or local downloads) and is compatible with standard R or Python data analysis pipelines.

Data points include:
- Instantaneous and average heart rate periods.
- Precise timestamps for every detected beat and scheduled tone.
- User-adjusted knob positions and confidence ratings.
- Motion detection events and "finger lost" timestamps for data cleaning.
- Device metadata (Model, OS, Browser).

## Current Status

- **Development:** Core PAT logic and PPG pipeline are functional.
- **Validation:** Awaiting more validation metrics. (CNAP comparison, ECG, pilot)
- **Deployment:** Accessible via any modern mobile browser (optimized for iOS Safari).

## Acknowledgments

This project was developed at the **The Ohio State University - The Affective Science Lab** under the supervision of **Dr. Kristen Lindquist**. 

The **ePAT** is built upon and inspired by the following open-source research and software:

* **The Phase Adjustment Task (PAT):** The core psychophysical task logic is a port of the original PAT developed by the Huma Engineering team.
    * **Research Paper:** [A phase adjustment task for the assessment of heartbeat perception accuracy (2021)](https://www.sciencedirect.com/science/article/pii/S0301051121001642)
    * **Original Source Code (Swift/iOS):** [huma-engineering/Phase-Adjustment-Task](https://github.com/huma-engineering/Phase-Adjustment-Task)

* **Web-Based PPG Detection:** The camera-based heart rate monitoring logic was adapted from the open-source work of Richard Moore.
    * **Live Demo:** [heartrate.netlify.app](https://heartrate.netlify.app/)
    * **Source Code (JavaScript):** [richrd/heart-rate-monitor](https://github.com/richrd/heart-rate-monitor)

* **Conceptual Framework:** The application of this tool for ecological momentary assessment is grounded in the **Theory of Constructed Emotion** and research into interoceptive predictive processing.

---
**Maintained by:** Keegan Whitacre
