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
let beat = 0;
setInterval(() => {
  send({ type: 'tick' });
  beat += 1;
  if (check && beat % 10 === 0) log('still working…');
}, 1000);

async function session(apiKey, metrics, telemetry, source) {
  // A new session when anything changes, including camera <-> video file (the SDK won't switch source mid-session).
  const key = `${apiKey}|${metrics.join(',')}|${telemetry}|${source}`;
  if (sdk && sdkKey === key) return sdk;
  if (sdk) { try { await sdk.destroy(); } catch { /* already gone */ } }
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

// ---- frames via ffmpeg: a recorded video, or a camera SmartSpectra can't open itself.
// Decodes to RGB and hands each frame to SmartSpectra with sendFrame(), like the in-window path does.
function ffmpegPath() {
  const p = require('ffmpeg-static');
  return p ? p.replace('app.asar', 'app.asar.unpacked') : p;
}

function listDshowCameras() {
  const { spawnSync } = require('child_process');
  if (process.platform !== 'win32') return [];
  const r = spawnSync(ffmpegPath(), ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { encoding: 'utf8', windowsHide: true });
  const names = [];
  for (const line of String(r.stderr || '').split(/\r?\n/)) {
    const m = line.match(/"([^"]+)"\s*\(video\)/);
    if (m) names.push(m[1]);
  }
  return names;
}

function startFrameSource({ file, cameraName, onFrame, onEnd, onError }) {
  const { spawn } = require('child_process');
  const W = 640; const H = 480;
  // Fit inside 640x480 and pad, so every frame has the same size; 30 fps, real-time pace.
  // Files are paced at 30 fps with exact timestamps; cameras keep their own timing (stamped on arrival).
  const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2${file ? ',fps=30' : ''}`;
  const input = file
    ? ['-re', '-i', file]
    : ['-f', 'dshow', '-rtbufsize', '64M', '-framerate', '30', '-i', `video=${cameraName}`];
  const args = ['-hide_banner', '-loglevel', 'error', ...input, '-an', '-vf', vf, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'];
  log(`frames via ffmpeg from ${file ? 'the video file' : `camera "${cameraName}"`}`);
  const p = spawn(ffmpegPath(), args, { windowsHide: true });
  const frameBytes = W * H * 3;
  let pending = Buffer.alloc(0);
  let errText = '';
  const queue = [];
  let pumping = false;
  let dropped = 0;
  // One frame per turn of the event loop, so SmartSpectra's callbacks, timers and the heartbeat
  // always get a turn. If more than a few frames wait, the oldest are dropped instead of piling up.
  const pump = () => {
    const frame = queue.shift();
    if (!frame) { pumping = false; return; }
    onFrame(frame, W, H);
    setImmediate(pump);
  };
  p.stdout.on('data', (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= frameBytes) {
      queue.push(Buffer.from(pending.subarray(0, frameBytes)));
      pending = pending.subarray(frameBytes);
    }
    while (queue.length > 3) { queue.shift(); dropped += 1; if (dropped % 30 === 1) log(`falling behind: ${dropped} frames skipped so far`); }
    if (!pumping) { pumping = true; setImmediate(pump); }
  });
  p.stderr.on('data', (d) => { errText = (errText + d).slice(-1500); });
  p.on('error', (e) => onError(`Could not start ffmpeg: ${e.message}`));
  p.on('close', (code) => {
    if (errText.trim()) log(`ffmpeg: ${errText.trim().split(/\r?\n/).slice(-3).join(' | ')}`);
    if (code === 0 || code === null) onEnd(); else onError(file ? 'The video could not be read.' : `The camera "${cameraName}" could not be opened. Is another app using it?`);
  });
  return { stop: () => { try { p.kill(); } catch { /* gone */ } } };
}

// ---- one check
async function start(opts) {
  if (stopping) {
    log('waiting for the previous check to finish stopping…');
    await Promise.race([stopping, new Promise((r) => setTimeout(r, 15000))]);
  }
  const { id, apiKey, telemetry, metrics, cameraId, width, height, seconds, breathingOnly, file } = opts;
  const acc = { pulse: [], breathing: [], hrv: [] };
  let s;
  // Cameras listed only by DirectShow, or any camera SmartSpectra couldn't open itself (code 7), go through ffmpeg.
  let ffmpegCamera = null;
  if (!file && cameraId && cameraId.startsWith('dshow:')) ffmpegCamera = cameraId.slice(6);
  else if (!file && opts.forceFfmpeg) {
    let name = null;
    try { const c = SmartSpectraSDK.availableCameras().find((x) => x.id === cameraId); if (c) name = c.name; } catch { /* no list */ }
    if (!name) { try { name = listDshowCameras()[0] || null; } catch { /* none */ } }
    ffmpegCamera = name;
    if (!name) { send({ type: 'error', id, code: 7, message: 'No camera was found.' }); return; }
  }
  opts.ffmpegCamera = ffmpegCamera;
  const viaFfmpeg = !!file || !!ffmpegCamera;
  try { s = await session(apiKey, metrics, telemetry, viaFfmpeg ? 'frames' : 'camera'); }
  catch (e) { send({ type: 'error', id, code: e.code, message: e.message }); return; }

  let frames = 0; let framesThisSecond = 0; let runningAt = 0; let timer = null; let lastLive = 0;
  let source = null;
  check = { id, finished: false };
  const fpsTimer = setInterval(() => {
    // Some cameras don't report frames back; only show a rate when there is one.
    if (framesThisSecond > 0) send({ type: 'camera', id, width: viaFfmpeg ? 640 : width, height: viaFfmpeg ? 480 : height, fps: framesThisSecond });
    framesThisSecond = 0;
  }, 1000);
  const watchdog = setTimeout(() => { if (!runningAt) finish({ code: 'notStarted', message: 'The camera check did not start.', connection: true }); }, 45000);

  const finish = (err) => {
    if (!check || check.id !== id || check.finished) return;
    check.finished = true;
    clearTimeout(timer); clearTimeout(watchdog); clearInterval(fpsTimer);
    if (source) source.stop();
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
    // A video file can end before the check time is up: use what was measured.
    if (status === ProcessingStatus.kRunning && !runningAt) {
      runningAt = Date.now();
      log(`check running (${seconds} s, metrics ${metrics.join(',')})`);
      timer = setTimeout(() => finish(null), seconds * 1000);
    }
  });
  s.on('validationStatus', (code) => send({ type: 'hint', id, code }));
  s.on('frameSentThrough', (ok) => { if (!viaFfmpeg && ok !== false) { frames += 1; framesThisSecond += 1; } });
  s.on('metrics', (buf) => {
    try { collect(decodeMetrics(buf), acc); } catch (e) { log(`could not read a metrics packet: ${e.message}`); return; }
    const now = Date.now();
    if (now - lastLive > 500) { lastLive = now; send({ type: 'live', id, reading: summarize(acc, { breathingOnly }) }); }
  });
  s.on('videoOutput', sendPreview);
  s.on('error', (code, message) => { log(`SmartSpectra error ${code}: ${message}`); finish({ code, message }); });

  try {
    if (viaFfmpeg) {
      if (file) log(`reading a recorded video instead of the camera: ${file}`);
      s.useCustomInput();
      s.start();
      let n = 0; let lastTs = -1; const t0 = process.hrtime.bigint();
      source = startFrameSource({
        file,
        cameraName: opts.ffmpegCamera,
        onFrame: (buf, w, h) => {
          if (!check || check.id !== id) return;
          let ts = file ? n * 33333 : Number((process.hrtime.bigint() - t0) / 1000n);
          if (ts <= lastTs) ts = lastTs + 1;
          lastTs = ts;
          const t1 = Date.now();
          try { if (s.sendFrame(buf, w, h, w * 3, 0, ts) !== false) { frames += 1; framesThisSecond += 1; } } catch (err) { log(`sendFrame: ${err.message}`); }
          const took = Date.now() - t1;
          if (took > 500) log(`SmartSpectra took ${took} ms to accept one frame`);
          n += 1;
          if (n % 5 === 0) sendPreview(buf, w, h, w * 3, 0);
        },
        onEnd: () => { log('video finished'); if (runningAt) finish(null); else finish({ code: 'video', message: 'The video ended before the check could start.' }); },
        onError: (message) => finish({ code: 7, message }),
      });
      return;
    }
    {
      s.useCamera(cameraId ? CameraSelection.byId(cameraId) : CameraSelection.default,
        width ? { width, height, fps: 30 } : {});   // {} = the camera's own default format
    }
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
    try {
      for (const name of listDshowCameras()) {
        if (!list.some((c) => c.name === name)) list.push({ id: `dshow:${name}`, name });
      }
    } catch (err) { log(`DirectShow camera list unavailable: ${err.message}`); }
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
