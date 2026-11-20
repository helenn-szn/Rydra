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

// What Rydra asks the SDK for. Arterial pressure (part of the SDK's "cardio" bundle) is left out:
// Rydra never uses it, and it needs extra model setup that can fail with "configuration failed".
const FULL_METRICS = [...breathingMetrics, MetricType.PULSE_RATE, MetricType.HRV];
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
  }

  async measure(opts) {
    try {
      return await this.measureWith(this.breathingOnly ? BREATHING_ONLY : FULL_METRICS, opts);
    } catch (err) {
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
  measureWith(requestedMetrics, { seconds, video, onLive, onHint, onRunning, abort }) {
    const acc = { pulse: [], breathing: [], hrv: [] };
    const sdk = new SmartSpectraSDK({
      apiKey: this.apiKey,
      requestedMetrics,
      enableTelemetry: this.telemetry,
    });

    return new Promise((resolve, reject) => {
      let timer = null;
      let watchdog = null;
      let finished = false;

      const finish = async (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer); clearTimeout(watchdog); clearInterval(abortPoll);
        try { await sdk.stop(); } catch { /* already stopped */ }
        try { sdk.destroy(); } catch { /* ignore */ }
        if (video) video.srcObject = null;
        if (err) reject(err); else resolve(Object.assign(summarize(acc, { breathingOnly: requestedMetrics === BREATHING_ONLY }), { source: 'camera' }));
      };

      sdk.on('streamAvailable', (stream) => { if (video) video.srcObject = stream; });
      sdk.on('validationStatus', (code) => onHint && onHint(HINTS[code] || 'ok'));
      sdk.on('metrics', (buf) => {
        collect(decodeMetrics(buf), acc);
        if (onLive) onLive(summarize(acc, { breathingOnly: requestedMetrics === BREATHING_ONLY }));
      });
      sdk.on('processingStatus', (status) => {
        if (status === ProcessingStatus.kStarting && onHint) onHint('connecting');
        if (status === ProcessingStatus.kRunning && !timer) {
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
