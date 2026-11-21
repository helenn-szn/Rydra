// Camera checks through Rydra's background camera engine (src/native/sensor-worker.js).
// SmartSpectra runs in a separate process and reads the camera itself, so a slow or stuck
// SmartSpectra session can't freeze this window. Same interface as SmartSpectraSensor.
'use strict';

const { ValidationCode, SmartSpectraErrorCode, ProcessingStatus, breathingMetrics, MetricType } = require('@smartspectra/node-sdk/renderer');
const { HINTS } = require('./hints');

const SIZES = { standard: { width: 640, height: 480 }, light: { width: 320, height: 240 } };
const FULL_METRICS = [...breathingMetrics, MetricType.PULSE_RATE, MetricType.HRV];
const LIGHT_METRICS = [...breathingMetrics, MetricType.PULSE_RATE];
const BREATHING_ONLY = [...breathingMetrics];
const RETRY_BREATHING_ONLY = new Set([SmartSpectraErrorCode.kConfigurationFailed, SmartSpectraErrorCode.kMetricNotAuthorized]);
const CONNECTION_ERRORS = new Set([
  SmartSpectraErrorCode.kNetworkError, SmartSpectraErrorCode.kServerError,
  SmartSpectraErrorCode.kAuthenticationFailed, SmartSpectraErrorCode.kCreditExhausted,
]);
void ValidationCode;

// Preview: the engine sends small RGBA images on a message port; they're drawn on a canvas
// whose stream feeds the check screen's <video> element.
const preview = { canvas: null, ctx: null, stream: null, port: null };
function previewStream() {
  if (!preview.canvas) {
    preview.canvas = document.createElement('canvas');
    preview.canvas.width = 240; preview.canvas.height = 180;
    preview.ctx = preview.canvas.getContext('2d');
    preview.ctx.fillStyle = '#15181c'; preview.ctx.fillRect(0, 0, 240, 180);
    preview.stream = preview.canvas.captureStream(10);
  }
  return preview.stream;
}
window.addEventListener('message', (e) => {
  if (!e.data || !e.data.rydraPreviewPort || !e.ports || !e.ports[0]) return;
  if (preview.port) { try { preview.port.close(); } catch { /* ignore */ } }
  preview.port = e.ports[0];
  preview.port.onmessage = ({ data }) => {
    if (!data || !preview.ctx) return;
    if (preview.canvas.width !== data.w || preview.canvas.height !== data.h) { preview.canvas.width = data.w; preview.canvas.height = data.h; }
    preview.ctx.putImageData(new ImageData(new Uint8ClampedArray(data.data), data.w, data.h), 0, 0);
  };
});

let seq = 0;

class BackgroundSensor {
  constructor({ apiKey, telemetry }) {
    this.apiKey = apiKey;
    this.telemetry = !!telemetry;
    this.label = 'SmartSpectra camera (background engine)';
    this.breathingOnly = false;
    this.mode = 'standard';
    this.cameraId = null;     // native camera id from listCameras()
    this.native = true;       // the UI uses listCameras() below instead of the browser's list
    this.videoFile = null;    // set to a recorded video's path to check from that instead of the camera
  }

  dispose() { try { window.mz.sensor.cancel(); } catch { /* window closing */ } }

  async listCameras() {
    try { return await window.mz.sensor.cameras(); } catch { return []; }
  }

  metrics() {
    if (this.breathingOnly) return BREATHING_ONLY;
    return this.mode === 'light' ? LIGHT_METRICS : FULL_METRICS;
  }

  async measure(opts) {
    try {
      return await this.measureWith(this.metrics(), opts);
    } catch (err) {
      if (opts.abort && opts.abort.aborted) throw err;
      if (err.code === SmartSpectraErrorCode.kSustainedLowFrameRate && this.mode === 'standard') {
        console.warn('[rydra] Low frame rate; retrying in light camera mode.');
        this.mode = 'light';
        this.label = 'SmartSpectra camera (background engine, light mode)';
        if (opts.onHint) opts.onHint('lightMode');
        return this.measure(opts);
      }
      if (!this.breathingOnly && RETRY_BREATHING_ONLY.has(err.code)) {
        console.warn('[rydra] SmartSpectra rejected pulse + HRV; retrying with breathing only.', err.code, err.message);
        this.breathingOnly = true;
        this.label = 'SmartSpectra camera (background engine, breathing only)';
        if (opts.onHint) opts.onHint('tuning');
        const r = await this.measureWith(BREATHING_ONLY, opts);
        return Object.assign(r, { limited: true });
      }
      throw err;
    }
  }

  measureWith(metrics, { seconds, video, onLive, onHint, onRunning, onCamera, abort }) {
    const id = `c${Date.now()}-${++seq}`;
    const size = SIZES[this.mode] || SIZES.standard;
    if (video) video.srcObject = previewStream();
    return new Promise((resolve, reject) => {
      let done = false;
      let running = false;
      const off = window.mz.sensor.onEvent((m) => {
        if (m.id !== id || done) return;
        if (m.type === 'status') {
          if (m.status === ProcessingStatus.kStarting && onHint) onHint('connecting');
          if (m.status === ProcessingStatus.kRunning && !running) { running = true; console.log(`[rydra] check running (${seconds} s)`); if (onRunning) onRunning(); }
        } else if (m.type === 'hint') { if (onHint) onHint(HINTS[m.code] || 'ok'); }
        else if (m.type === 'camera') { if (onCamera) onCamera({ width: m.width, height: m.height, fps: m.fps }); }
        else if (m.type === 'live') { if (onLive) onLive(m.reading); }
        else if (m.type === 'result') {
          end(); console.log(`[rydra] result from the camera engine: ${m.frames} frames in ${m.secs.toFixed(1)} s`);
          resolve(this.videoFile ? Object.assign(m.reading, { fromVideo: true }) : m.reading);
        }
        else if (m.type === 'error') {
          end();
          const e = new Error(m.cancelled ? 'Cancelled' : `${m.message || 'SmartSpectra error'} (code ${m.code})`);
          e.code = m.code; e.cancelled = !!m.cancelled;
          e.connection = !!m.connection || CONNECTION_ERRORS.has(m.code);
          reject(e);
        }
      });
      const poll = setInterval(() => { if (abort && abort.aborted) window.mz.sensor.cancel(); }, 200);
      function end() { done = true; off(); clearInterval(poll); if (video) video.srcObject = null; }
      window.mz.sensor.start({
        id, apiKey: this.apiKey, telemetry: this.telemetry, metrics, cameraId: this.cameraId,
        width: size.width, height: size.height, seconds, breathingOnly: metrics === BREATHING_ONLY,
        file: this.videoFile || undefined,
      }).catch((err) => { if (!done) { end(); reject(err); } });
    });
  }
}

module.exports = { BackgroundSensor };
