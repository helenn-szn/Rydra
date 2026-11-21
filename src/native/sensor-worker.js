// Rydra camera engine. Runs in its own background process (Electron utilityProcess),
// so SmartSpectra's processing can never freeze Rydra's window.
// SmartSpectra reads the camera itself here; the window only receives results,
// status updates and a small preview image a few times a second.
'use strict';

const { SmartSpectraSDK, CameraSelection, SmartSpectraLogLevel, ProcessingStatus } = require('@smartspectra/node-sdk');
const { decodeMetrics } = require('@smartspectra/node-sdk/messages');
const { summarize, collect } = require('../sensor/summarize');
const { preconfigureWithDeviceId } = require('./device-id');

const port = process.parentPort;
const send = (msg) => { try { port.postMessage(msg); } catch { /* window gone */ } };
const log = (m) => console.log(`[camera] ${m}`);
const DEBUG = process.env.SMARTSPECTRA_DIAGNOSTICS === '1';

let sdk = null;
let sdkKey = '';          // apiKey + metrics the current session was made for
let check = null;         // the check in progress
let stopping = null;      // promise while a previous check is stopping
let previewPort = null;

// Heartbeat: lets the window's process notice if this process stops responding.
setInterval(() => send({ type: 'tick' }), 1000);

function session(apiKey, metrics, telemetry) {
  const key = `${apiKey}|${metrics.join(',')}|${telemetry}`;
  if (sdk && sdkKey === key) return sdk;
  if (sdk) { try { sdk.destroy(); } catch { /* already gone */ } }
  sdk = new SmartSpectraSDK({
    apiKey, requestedMetrics: metrics, enableTelemetry: !!telemetry,
    logLevel: DEBUG ? SmartSpectraLogLevel.kInfo : SmartSpectraLogLevel.kWarning,
  });
  sdkKey = key;
  return sdk;
}

// ---- preview: a small RGBA copy of what SmartSpectra sees, about 6 times a second
let lastPreview = 0;
function sendPreview(buf, width, height, stride, pixelFormat) {
  if (!previewPort || !check) return;
  const now = Date.now();
  if (now - lastPreview < 160) return;
  lastPreview = now;
  // 0 RGB, 1 BGR, 2 RGBA, 3 BGRA. Other formats (YUV) aren't drawn.
  const bpp = { 0: 3, 1: 3, 2: 4, 3: 4 }[pixelFormat];
  if (!bpp) return;
  const bgr = pixelFormat === 1 || pixelFormat === 3;
  const step = Math.max(1, Math.ceil(width / 240));
  const w = Math.floor(width / step); const h = Math.floor(height / step);
  const out = new Uint8ClampedArray(w * h * 4);
  const src = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const rowBytes = stride || width * bpp;
  for (let y = 0; y < h; y += 1) {
    const row = y * step * rowBytes;
    for (let x = 0; x < w; x += 1) {
      const i = row + x * step * bpp; const o = (y * w + x) * 4;
      out[o] = src[bgr ? i + 2 : i]; out[o + 1] = src[i + 1]; out[o + 2] = src[bgr ? i : i + 2]; out[o + 3] = 255;
    }
  }
  // Copied, not transferred: Electron's MessagePortMain can only transfer ports. ~170 KB, 6 times a second.
  try { previewPort.postMessage({ w, h, data: out.buffer }); } catch { /* window closed the port */ }
}

// ---- one check
async function start(opts) {
  if (stopping) {
    log('waiting for the previous check to finish stopping…');
    await Promise.race([stopping, new Promise((r) => setTimeout(r, 15000))]);
  }
  const { id, apiKey, telemetry, metrics, cameraId, width, height, seconds, breathingOnly } = opts;
  const acc = { pulse: [], breathing: [], hrv: [] };
  let s;
  try { s = session(apiKey, metrics, telemetry); }
  catch (e) { send({ type: 'error', id, code: e.code, message: e.message }); return; }

  let frames = 0; let framesThisSecond = 0; let runningAt = 0; let timer = null; let lastLive = 0;
  check = { id, finished: false };
  const fpsTimer = setInterval(() => {
    // Some cameras don't report frames back; only show a rate when there is one.
    if (framesThisSecond > 0) send({ type: 'camera', id, width, height, fps: framesThisSecond });
    framesThisSecond = 0;
  }, 1000);
  const watchdog = setTimeout(() => { if (!runningAt) finish({ code: 'notStarted', message: 'The camera check did not start.', connection: true }); }, 45000);

  const finish = (err) => {
    if (!check || check.id !== id || check.finished) return;
    check.finished = true;
    clearTimeout(timer); clearTimeout(watchdog); clearInterval(fpsTimer);
    const secs = runningAt ? (Date.now() - runningAt) / 1000 : 0;
    log(`END (${err ? `error ${err.code}` : 'time up'}) after ${secs.toFixed(1)} s; ${frames} frames (${secs ? (frames / secs).toFixed(1) : '?'} per second)`);
    if (err) send(Object.assign({ type: 'error', id }, err));
    else send({ type: 'result', id, reading: Object.assign(summarize(acc, { breathingOnly }), { source: 'camera' }), frames, secs });
    check = null;
    const t0 = Date.now();
    stopping = (async () => {
      log('BEFORE stop()');
      try { await s.stopAsync(); log(`AFTER stop(): ${Date.now() - t0} ms`); }
      catch (e) { log(`AFTER stop(): failed after ${Date.now() - t0} ms: ${e && e.message}`); }
      if (err) { try { s.reset(); } catch { /* best effort */ } }
      send({ type: 'stopped', id, ms: Date.now() - t0 });
    })().finally(() => { stopping = null; });
  };
  check.finish = finish;

  s.on('processingStatus', (status) => {
    send({ type: 'status', id, status });
    if (status === ProcessingStatus.kRunning && !runningAt) {
      runningAt = Date.now();
      log(`check running (${seconds} s, metrics ${metrics.join(',')})`);
      timer = setTimeout(() => finish(null), seconds * 1000);
    }
  });
  s.on('validationStatus', (code) => send({ type: 'hint', id, code }));
  s.on('frameSentThrough', (ok) => { if (ok !== false) { frames += 1; framesThisSecond += 1; } });
  s.on('metrics', (buf) => {
    try { collect(decodeMetrics(buf), acc); } catch (e) { log(`could not read a metrics packet: ${e.message}`); return; }
    const now = Date.now();
    if (now - lastLive > 500) { lastLive = now; send({ type: 'live', id, reading: summarize(acc, { breathingOnly }) }); }
  });
  s.on('videoOutput', sendPreview);
  s.on('error', (code, message) => { log(`SmartSpectra error ${code}: ${message}`); finish({ code, message }); });

  try {
    s.useCamera(cameraId ? CameraSelection.byId(cameraId) : CameraSelection.default,
      { width: width || 0, height: height || 0, fps: 30 });
    s.start();
  } catch (e) {
    log(`start failed: ${e.code} ${e.message}`);
    finish({ code: e.code, message: e.message });
  }
}

port.on('message', (e) => {
  const msg = e.data || {};
  if (msg.type === 'init') {
    try { log(preconfigureWithDeviceId(msg.sdkDir, msg.idFile)); }
    catch (err) { log(`device ID setup failed: ${err.message}`); }
    send({ type: 'ready' });
  } else if (msg.type === 'cameras') {
    let list = [];
    try { list = SmartSpectraSDK.availableCameras().map((c) => ({ id: c.id, name: c.name || c.id })); }
    catch (err) { log(`camera list unavailable: ${err.message}`); }
    send({ type: 'cameras', reqId: msg.reqId, list });
  } else if (msg.type === 'preview') {
    if (previewPort) { try { previewPort.close(); } catch { /* ignore */ } }
    previewPort = e.ports && e.ports[0];
    if (previewPort && previewPort.start) previewPort.start();
  } else if (msg.type === 'start') {
    start(msg.opts);
  } else if (msg.type === 'cancel') {
    if (check && check.finish) check.finish({ code: 'cancelled', message: 'Cancelled', cancelled: true });
  }
});

log(`camera engine started (SmartSpectra ${SmartSpectraSDK.version || ''})`);
