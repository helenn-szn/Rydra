'use strict';
const { SmartSpectraSDK, ProcessingStatus, breathingMetrics, MetricType } = require('@smartspectra/node-sdk/renderer');

const $ = (id) => document.getElementById(id);
const KEY = new URLSearchParams(location.search).get('key') || '';
const log = (m) => console.log(`[repro] ${m}`);
const show = (m) => { $('stats').textContent = m; };
const METRICS = {
  full: [...breathingMetrics, MetricType.PULSE_RATE, MetricType.HRV],
  pulse: [...breathingMetrics, MetricType.PULSE_RATE],
  breathing: [...breathingMetrics],
};

// Renderer block monitor (separate from the main-process one in the terminal).
let lastTick = performance.now();
setInterval(() => {
  const now = performance.now();
  const lag = now - lastTick - 250;
  if (lag > 500) log(`RENDERER BLOCKED for ${Math.round(lag)} ms`);
  lastTick = now;
}, 250);

async function listCameras() {
  try { const s = await navigator.mediaDevices.getUserMedia({ video: true }); s.getTracks().forEach((t) => t.stop()); } catch { /* names may stay blank */ }
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  $('cam').innerHTML = cams.map((c, i) => `<option value="${c.deviceId}" ${/iriun/i.test(c.label) ? 'selected' : ''}>${c.label || `Camera ${i + 1}`}</option>`).join('');
}

async function run() {
  if (!KEY) { show('No API key found. Put SMARTSPECTRA_API_KEY in the .env file in the Rydra folder.'); return; }
  $('go').disabled = true;
  const [w, h] = $('size').value.split('x').map(Number);
  const metricsName = $('metrics').value;
  const seconds = Math.max(10, Number($('secs').value) || 60);
  log(`--- new check: ${w}x${h}, ${metricsName}, ${seconds} s, camera "${$('cam').selectedOptions[0].textContent}"`);

  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: $('cam').value }, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } } });
  const st = stream.getVideoTracks()[0].getSettings();
  log(`camera opened at ${st.width}x${st.height}, ${Math.round(st.frameRate || 0)} fps`);
  $('video').srcObject = stream;

  const sdk = new SmartSpectraSDK({ apiKey: KEY, requestedMetrics: METRICS[metricsName], enableTelemetry: false });
  sdk.useMediaStream(stream);
  let sent = 0; let runningAt = 0; let timer = null; let ended = false;
  sdk.on('frameSentThrough', (ok) => { if (ok !== false) sent += 1; });
  sdk.on('validationStatus', () => {});
  sdk.on('metrics', () => {});
  const ticker = setInterval(() => {
    if (!runningAt) return;
    const secs = (performance.now() - runningAt) / 1000;
    show(`Running: ${secs.toFixed(0)} / ${seconds} s\nFrames processed by SDK: ${sent} (${(sent / secs).toFixed(1)} per second)`);
  }, 500);

  const end = async (why, err) => {
    if (ended) return; ended = true;
    clearTimeout(timer); clearInterval(ticker);
    const secs = runningAt ? (performance.now() - runningAt) / 1000 : 0;
    log(`END (${why}) after ${secs.toFixed(1)} s; SDK processed ${sent} frames (${secs ? (sent / secs).toFixed(1) : '?'} per second)${err ? `; error ${err}` : ''}`);
    log('BEFORE sdk.stop()');
    const t0 = performance.now();
    try { await sdk.stop(); log(`AFTER sdk.stop(): resolved in ${Math.round(performance.now() - t0)} ms`); }
    catch (e) { log(`AFTER sdk.stop(): threw after ${Math.round(performance.now() - t0)} ms: ${e && e.message}`); }
    stream.getTracks().forEach((t) => t.stop());
    $('video').srcObject = null;
    log('camera released; check complete');
    show(`Finished (${why}).\nFrames processed by SDK: ${sent} in ${secs.toFixed(1)} s (${secs ? (sent / secs).toFixed(1) : '?'} per second).\nsdk.stop() took ${Math.round(performance.now() - t0)} ms.\nSee the terminal for the full log.`);
    $('go').disabled = false;
    // The session is kept (as Rydra does). Closing the window destroys it.
  };

  sdk.on('processingStatus', (s) => {
    log(`processing status ${s}`);
    if (s === ProcessingStatus.kRunning && !runningAt) {
      runningAt = performance.now();
      timer = setTimeout(() => end('time up'), seconds * 1000);
    }
  });
  sdk.on('error', (code, message) => { log(`SDK error ${code}: ${message}`); end('SDK error', code); });
  show('Starting…');
  try { await sdk.start(); log('sdk.start() resolved'); } catch (e) { log(`sdk.start() failed: ${e && e.message}`); end('start failed', e && e.code); }
}

$('go').addEventListener('click', run);
listCameras();
