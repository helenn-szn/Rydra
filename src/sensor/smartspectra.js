// Real camera measurement through the Presage SmartSpectra renderer SDK.
'use strict';

const {
  SmartSpectraSDK, ProcessingStatus, ValidationCode, SmartSpectraErrorCode,
  breathingMetrics, MetricType,
} = require('@smartspectra/node-sdk/renderer');
const { decodeMetrics } = require('@smartspectra/node-sdk/messages');
const { summarize, collect } = require('./summarize');

// SDK validation codes -> Rydra hint keys (translated in the UI and grouped into light / position / stillness).
const HINTS = {
  [ValidationCode.kOk]: 'ok',
  [ValidationCode.kNoFaceFound]: 'noFace',
  [ValidationCode.kMultipleFacesFound]: 'multipleFaces',
  [ValidationCode.kFaceNotCentered]: 'notCentered',
  [ValidationCode.kFaceTooClose]: 'tooClose',
  [ValidationCode.kFaceTooFar]: 'tooFar',
  [ValidationCode.kFaceTooHigh]: 'tooHigh',
  [ValidationCode.kFaceTooLow]: 'tooLow',
  [ValidationCode.kFaceNotForward]: 'notForward',
  [ValidationCode.kTooDark]: 'tooDark',
  [ValidationCode.kTooBright]: 'tooBright',
  [ValidationCode.kChestNotVisible]: 'chestNotVisible',
  [ValidationCode.kCameraTuning]: 'tuning',
  [ValidationCode.kFrameRateTooLow]: 'lowFps',
  [ValidationCode.kExcessiveMotion]: 'motion',
};

// Rydra opens the camera itself at a modest resolution. The SDK's default (1280x720) has to be copied
// from the window to the SDK frame by frame, and on many laptops that pushes the frame rate below what
// the SDK needs ("frame rate stayed too low", code 14). 640x480 at 30 fps is plenty for a face.
// Every frame is copied from the window to the SDK in full, so frame size sets the frame rate the SDK
// actually receives. On a typical laptop 640x480 arrived at only 15-20 fps (below what the SDK needs),
// even with the camera itself delivering 30. A face at arm's length is still well covered at these sizes.
const CAMERA = {
  standard: { width: 480, height: 360 },    // ~0.7 MB per frame, about half of 640x480
  light: { width: 320, height: 240 },       // fallback after a low-frame-rate stop: ~0.3 MB per frame
};

async function openCamera(mode, deviceId) {
  const size = CAMERA[mode] || CAMERA.standard;
  const pick = deviceId ? { deviceId: { exact: deviceId } } : {};
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: Object.assign({ width: { ideal: size.width }, height: { ideal: size.height }, frameRate: { ideal: 30, min: 15 } }, pick),
    });
  } catch (err) {
    // Some cameras reject the frame-rate floor; retry with just the size.
    if (err && err.name === 'OverconstrainedError') {
      return navigator.mediaDevices.getUserMedia({ audio: false, video: Object.assign({ width: { ideal: size.width }, height: { ideal: size.height } }, pick) });
    }
    const e = new Error(err && err.name === 'NotAllowedError'
      ? 'Camera access was blocked. Check Windows Settings > Privacy & security > Camera.'
      : err && err.name === 'NotReadableError'
        ? 'The camera is busy in another app. Close other apps using it and try again.'
        : `Could not open the camera (${(err && err.name) || 'unknown error'}).`);
    e.camera = true;
    throw e;
  }
}

/** Reports the camera's real delivered frame rate once a second, so problems are visible on screen. */
function watchFrameRate(stream, { onCamera, abort }) {
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  const settings = track.getSettings ? track.getSettings() : {};
  const probe = document.createElement('video');
  probe.muted = true; probe.playsInline = true; probe.srcObject = stream;
  probe.play().catch(() => {});
  let frames = 0;
  let last = performance.now();
  const tick = () => {
    if (track.readyState === 'ended' || (abort && abort.aborted)) { probe.srcObject = null; return; }
    frames += 1;
    const now = performance.now();
    if (now - last >= 1000) {
      onCamera({ width: settings.width, height: settings.height, fps: Math.round((frames * 1000) / (now - last)), label: track.label });
      frames = 0; last = now;
    }
    probe.requestVideoFrameCallback(tick);
  };
  if (probe.requestVideoFrameCallback) probe.requestVideoFrameCallback(tick);
  else onCamera({ width: settings.width, height: settings.height, fps: Math.round(settings.frameRate || 0), label: track.label });
}

// What Rydra asks the SDK for. Arterial pressure (part of the SDK's "cardio" bundle) is left out:
// Rydra never uses it, and it needs extra model setup that can fail with "configuration failed".
const FULL_METRICS = [...breathingMetrics, MetricType.PULSE_RATE, MetricType.HRV];
// Light mode (after a low-frame-rate stop) also skips HRV, the heaviest extra measurement.
const LIGHT_METRICS = [...breathingMetrics, MetricType.PULSE_RATE];
const BREATHING_ONLY = [...breathingMetrics];

// Errors that mean the requested measurements can't run here; Rydra retries once with breathing only.
const RETRY_BREATHING_ONLY = new Set([SmartSpectraErrorCode.kConfigurationFailed, SmartSpectraErrorCode.kMetricNotAuthorized]);

// Errors that mean "could not reach Presage". The app falls back to a questions-only check.
const CONNECTION_ERRORS = new Set([
  SmartSpectraErrorCode.kNetworkError, SmartSpectraErrorCode.kServerError,
  SmartSpectraErrorCode.kAuthenticationFailed, SmartSpectraErrorCode.kCreditExhausted,
]);

class SmartSpectraSensor {
  constructor({ apiKey, telemetry }) {
    this.apiKey = apiKey;
    this.telemetry = !!telemetry;
    this.label = 'SmartSpectra camera';
    this.breathingOnly = false;   // set after a fallback, so later checks skip the failing setup
    this.mode = 'standard';       // switches to 'light' after a low-frame-rate stop, for the rest of the session
  }

  /**
   * One SDK session, reused for every check. Presage's SDK is built to stop and start a single
   * session; destroying it unloads models on the app's main thread, which can freeze the window
   * ("Not Responding"). A new session is made only when the requested measurements change.
   */
  session(requestedMetrics) {
    if (this.sdk && this.sdkMetrics === requestedMetrics) return this.sdk;
    this.dispose();
    this.sdk = new SmartSpectraSDK({ apiKey: this.apiKey, requestedMetrics, enableTelemetry: this.telemetry });
    this.sdkMetrics = requestedMetrics;
    return this.sdk;
  }

  /** Fully release the SDK (app closing, or switching measurements). */
  dispose() {
    if (!this.sdk) return;
    try { this.sdk.destroy(); } catch { /* already gone */ }
    this.sdk = null;
    this.sdkMetrics = null;
  }

  metrics() {
    if (this.breathingOnly) return BREATHING_ONLY;
    return this.mode === 'light' ? LIGHT_METRICS : FULL_METRICS;
  }

  async measure(opts) {
    try {
      return await this.measureWith(this.metrics(), opts);
    } catch (err) {
      if (err.code === SmartSpectraErrorCode.kSustainedLowFrameRate && this.mode === 'standard' && !(opts.abort && opts.abort.aborted)) {
        console.warn('[rydra] Low frame rate; retrying in light camera mode.');
        this.mode = 'light';
        this.label = 'SmartSpectra camera (light mode)';
        if (opts.onHint) opts.onHint('lightMode');
        return this.measure(opts);
      }
      if (!this.breathingOnly && RETRY_BREATHING_ONLY.has(err.code) && !(opts.abort && opts.abort.aborted)) {
        console.warn('[rydra] SmartSpectra rejected pulse + HRV; retrying with breathing only.', err.code, err.message);
        this.breathingOnly = true;
        this.label = 'SmartSpectra camera (breathing only)';
        if (opts.onHint) opts.onHint('tuning');
        const r = await this.measureWith(BREATHING_ONLY, opts);
        return Object.assign(r, { limited: true });
      }
      throw err;
    }
  }

  /**
   * Measure for `seconds` of running time.
   * @param {{seconds:number, video?:HTMLVideoElement, onLive?:Function, onHint?:Function, onRunning?:Function, abort?:{aborted:boolean}}} opts
   * @returns {Promise<{pulse,breathing,hrv,quality,samples,source:'camera'}>}
   */
  async measureWith(requestedMetrics, opts) {
    // A previous check may still be stopping in the background; wait (up to 15 s) before reusing the session.
    if (this.stopping) {
      console.log('[rydra] waiting for the previous check to finish stopping…');
      await Promise.race([this.stopping, new Promise((r) => setTimeout(r, 15000))]);
    }
    const stream = await openCamera(this.mode, this.cameraId);
    if (opts.onCamera) watchFrameRate(stream, opts);
    try {
      return await this.run(requestedMetrics, stream, opts);
    } finally {
      for (const track of stream.getTracks()) { try { track.stop(); } catch { /* already stopped */ } }
    }
  }

  run(requestedMetrics, stream, { seconds, video, onLive, onHint, onRunning, abort }) {
    const acc = { pulse: [], breathing: [], hrv: [] };
    const sdk = this.session(requestedMetrics);

    return new Promise((resolve, reject) => {
      let timer = null;
      let watchdog = null;
      let finished = false;

      const finish = (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer); clearTimeout(watchdog); clearInterval(abortPoll);
        if (video) video.srcObject = null;
        // Hand the result to the app straight away. Stopping the SDK drains its processing pipeline,
        // which can take several seconds, so it runs in the background and the next check waits for it.
        const reading = err ? null : Object.assign(summarize(acc, { breathingOnly: requestedMetrics === BREATHING_ONLY }), { source: 'camera' });
        const t0 = performance.now();
        const secs = runningAt ? (performance.now() - runningAt) / 1000 : 0;
        console.log(`[rydra] check finished after ${secs.toFixed(1)} s; SDK processed ${sent} frames (${secs ? (sent / secs).toFixed(1) : '?'} per second); stopping in the background`);
        this.stopping = (async () => {
          try { await sdk.stop(); } catch (e) { console.warn('[rydra] stop failed', e && e.message); }
          // After an SDK error the session must be reset before it can start again.
          if (err && !err.cancelled) { try { await sdk.reset(); } catch { /* best effort */ } }
          console.log(`[rydra] SmartSpectra stopped in ${Math.round(performance.now() - t0)} ms`);
        })().finally(() => { this.stopping = null; });
        if (err) reject(err); else resolve(reading);
      };

      sdk.useMediaStream(stream);
      if (video) video.srcObject = stream;
      sdk.on('streamAvailable', (s) => { if (video && video.srcObject !== s) video.srcObject = s; });
      sdk.on('validationStatus', (code) => onHint && onHint(HINTS[code] || 'ok'));
      sdk.on('metrics', (buf) => {
        collect(decodeMetrics(buf), acc);
        if (onLive) onLive(summarize(acc, { breathingOnly: requestedMetrics === BREATHING_ONLY }));
      });
      let sent = 0;
      let runningAt = 0;
      sdk.on('frameSentThrough', (ok) => { if (ok !== false) sent += 1; });
      sdk.on('processingStatus', (status) => {
        if (status === ProcessingStatus.kStarting && onHint) onHint('connecting');
        if (status === ProcessingStatus.kRunning && !timer) {
          runningAt = performance.now();
          console.log(`[rydra] check running (${seconds} s, ${requestedMetrics.length} measurements)`);
          if (onRunning) onRunning();
          timer = setTimeout(() => finish(), seconds * 1000);
        }
      });
      sdk.on('error', (code, message) => {
        console.error('[rydra] SmartSpectra error', code, message);
        const e = new Error(`${message || 'SmartSpectra error'} (code ${code})`);
        e.code = code;
        e.connection = CONNECTION_ERRORS.has(code);
        finish(e);
      });

      // If the session never reaches Running (no camera, no connection), give up cleanly.
      watchdog = setTimeout(() => {
        if (!timer) {
          const e = new Error('The camera check did not start.');
          e.connection = true;
          finish(e);
        }
      }, 45000);

      const abortPoll = setInterval(() => {
        if (abort && abort.aborted) {
          const e = new Error('Cancelled');
          e.cancelled = true;
          finish(e);
        }
      }, 200);

      sdk.start().catch((err) => {
        console.error('[rydra] SmartSpectra start failed', err.code, err.message);
        err.connection = err.connection || CONNECTION_ERRORS.has(err.code);
        finish(err);
      });
    });
  }
}

module.exports = { SmartSpectraSensor, HINTS };
