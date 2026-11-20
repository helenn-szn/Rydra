// Real camera measurement through the Presage SmartSpectra renderer SDK.
'use strict';

const {
  SmartSpectraSDK, ProcessingStatus, ValidationCode, SmartSpectraErrorCode,
  breathingMetrics, cardioMetrics,
} = require('@smartspectra/node-sdk/renderer');
const { decodeMetrics } = require('@smartspectra/node-sdk/messages');
const { summarize, collect } = require('./summarize');

const HINTS = {
  [ValidationCode.kOk]: null,
  [ValidationCode.kNoFaceFound]: 'Look at the camera so your face is in view.',
  [ValidationCode.kMultipleFacesFound]: 'Only the driver should be in view.',
  [ValidationCode.kFaceNotCentered]: 'Move to the centre of the picture.',
  [ValidationCode.kFaceTooClose]: 'Move back a little.',
  [ValidationCode.kFaceTooFar]: 'Come a little closer.',
  [ValidationCode.kFaceTooHigh]: 'Lower the camera or yourself a little.',
  [ValidationCode.kFaceTooLow]: 'Raise the camera a little.',
  [ValidationCode.kFaceNotForward]: 'Face the camera straight on.',
  [ValidationCode.kTooDark]: 'Too dark. Move to better light.',
  [ValidationCode.kTooBright]: 'Too bright. Move out of direct sun.',
  [ValidationCode.kChestNotVisible]: 'Sit back so your upper chest is in view.',
  [ValidationCode.kCameraTuning]: 'Adjusting the camera…',
  [ValidationCode.kFrameRateTooLow]: 'The camera is too slow. Close other apps.',
  [ValidationCode.kExcessiveMotion]: 'Try to sit still.',
};

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
  }

  /**
   * Measure for `seconds` of running time.
   * @param {{seconds:number, video?:HTMLVideoElement, onLive?:Function, onHint?:Function, onRunning?:Function, abort?:{aborted:boolean}}} opts
   * @returns {Promise<{pulse,breathing,hrv,quality,samples,source:'camera'}>}
   */
  measure({ seconds, video, onLive, onHint, onRunning, abort }) {
    const acc = { pulse: [], breathing: [], hrv: [] };
    const sdk = new SmartSpectraSDK({
      apiKey: this.apiKey,
      requestedMetrics: [...breathingMetrics, ...cardioMetrics],
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
        if (err) reject(err); else resolve(Object.assign(summarize(acc), { source: 'camera' }));
      };

      sdk.on('streamAvailable', (stream) => { if (video) video.srcObject = stream; });
      sdk.on('validationStatus', (code) => onHint && onHint(HINTS[code] ?? null));
      sdk.on('metrics', (buf) => {
        collect(decodeMetrics(buf), acc);
        if (onLive) onLive(summarize(acc));
      });
      sdk.on('processingStatus', (status) => {
        if (status === ProcessingStatus.kRunning && !timer) {
          if (onRunning) onRunning();
          timer = setTimeout(() => finish(), seconds * 1000);
        }
      });
      sdk.on('error', (code, message) => {
        const e = new Error(message || 'SmartSpectra error');
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
        err.connection = err.connection || CONNECTION_ERRORS.has(err.code);
        finish(err);
      });
    });
  }
}

module.exports = { SmartSpectraSensor, HINTS };
