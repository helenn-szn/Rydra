# SmartSpectra Node SDK 3.5.0 on Windows: missing device ID, NCrypt error, and main-process freeze in Electron

**From:** helenn-szn (building Rydra for the DEV Presage SmartSpectra SDK Challenge)
**Reproduction:** https://github.com/helenn-szn/Rydra, folder `tools/sdk-repro` (a minimal app based on your `electron-quickstart`, with no app code)

## Setup

- `@smartspectra/node-sdk` 3.5.0 (win32-x64 native package), Electron 43.8.1, Node from Electron
- HP laptop, Windows 11 — CPU / RAM: _[fill in from Settings > System > About]_
- Camera: Iriun Webcam (phone as webcam), 480×360 at 30 fps confirmed by `getSettings()`; also seen with the built-in HP webcam (15 fps)
- Telemetry off (`enableTelemetry: false`)

## Issue 1: pulse and HRV fail with "configuration failed" because no device ID is set

With the default setup (`bindSmartSpectraIpc(win)`, or plain Node with `ensurePreconfigured()`), every metric set that includes `PULSE_RATE` or `HRV` fails at `start()` with error 3 (kConfigurationFailed), followed by error 8. Breathing-only works. The native log gives the reason:

```
CalculatorGraph::Run() failed: Calculator::Open() for node
"preprocessingcpucontinuousjson__preprocessingcpu__phasicedapipeline__PhysiologyInferenceCalculator_1"
failed: device_id is required for remote model download
SmartSpectra::Initialize failed: SmartSpectra configuration failed.
```

**Workaround that fixed it:** calling the internal `preconfigure(sdkDirectory, deviceId)` from `js/ffi.js` with our own stable random UUID before `bindSmartSpectraIpc()` / the first session. After that, all metric sets start. The Electron glue (`js/main/index.js`) calls `capiPreconfigure(sdkDirectory)` with no device ID, so on this machine the SDK never gets one.

**Questions:** Is a host expected to supply a device ID? If so, could `bindSmartSpectraIpc` / `SmartSpectraOptions` accept one, or could the SDK fall back to generating and storing one when it can't create its own identity?

## Issue 2: `NCryptDecrypt(size) failed: Invalid flags specified`

After the workaround, this appears on each start (we don't request arterial pressure):

```
secure_model_loader.cc:459] Device key store error: NCryptDecrypt(size) failed: Invalid flags specified. (-2146893815)
secure_model_loader.cc:306] LoadInternal failed for model_id=phasic-bp-inference, error=NCryptDecrypt(size) failed: Invalid flags specified. (-2146893815)
physiology_inference_calculator.cc:581] Model load failed.
```

The session still starts. Is this expected when arterial pressure isn't requested, and could it be related to Issue 1?

## Issue 3: the Electron main process stops responding during a check

Using the renderer SDK with `useMediaStream()` (your quickstart pattern), metrics breathing + `PULSE_RATE` + `HRV`, 480×360 at 30 fps:

```
[main 12:41:18.501] MAIN PROCESS BLOCKED for 3240 ms     (during start)
[page 12:41:18.585] processing status 3                   (running)
[main 12:42:08.233] MAIN PROCESS BLOCKED for 1941 ms
[main 12:42:10.533] MAIN PROCESS BLOCKED for 2050 ms
(nothing after this: the 60 s timer never fires, sdk.stop() is never reached, Windows shows "Not Responding")
```

The "blocked" lines come from a 250 ms `setInterval` in the main process measuring its own delay. In our app the same freeze happened with breathing only, at the end of a 60 s check. Earlier runs also delivered only 15–20 processed frames per second to the SDK at 640×480, with the camera itself delivering 30.

**Steps:** clone the repo, `npm install`, put `SMARTSPECTRA_API_KEY=...` in `.env`, run `npm run repro`, choose the camera, keep 480×360 and "Breathing + pulse + HRV", and click Start check.

**Questions:** Is per-frame processing in the Electron main process expected to block it for seconds on mid-range Windows laptops? Is there a recommended way to run the SDK off the main thread in Electron (for example a `utilityProcess`), or settings that reduce the load?

## What we're doing meanwhile

Rydra now runs the SDK in an Electron `utilityProcess` with `useCamera()` (native capture), so the window stays responsive even if a session stalls. It also supplies the device ID as described above.
