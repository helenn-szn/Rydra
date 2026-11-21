// Runs Rydra's camera engine (sensor-worker.js) as a separate background process and
// relays messages between it and the window. If the engine stops responding it is
// ended and started again, so a stuck SmartSpectra session never freezes Rydra.
'use strict';

const fs = require('fs');
const path = require('path');
const { app, ipcMain, dialog, BrowserWindow, utilityProcess, MessageChannelMain } = require('electron');

const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm'];

const stamp = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
const STUCK_MS = 10000;   // no heartbeat for this long during a check = stuck

function startEngineHost(getWindow) {
  let child = null;
  let lastTick = 0;
  let current = null;      // id of the check in progress
  let reqSeq = 0;
  const pending = new Map();

  const toWindow = (msg) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('mz:sensor:event', msg);
  };

  function spawn() {
    child = utilityProcess.fork(path.join(__dirname, 'sensor-worker.js'), [], {
      serviceName: 'Rydra camera engine', stdio: 'pipe', env: process.env,
    });
    const pipe = (stream) => stream && stream.on('data', (d) => {
      for (const line of String(d).split(/\r?\n/)) if (line.trim()) console.log(line.startsWith('[camera]') ? `[${stamp()}] ${line}` : `[camera sdk] ${line}`);
    });
    pipe(child.stdout); pipe(child.stderr);
    lastTick = Date.now();
    child.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'tick') { lastTick = Date.now(); return; }
      if (msg.type === 'cameras') { const r = pending.get(msg.reqId); pending.delete(msg.reqId); if (r) r(msg.list); return; }
      if ((msg.type === 'result' || msg.type === 'error') && msg.id === current) current = null;
      toWindow(msg);
    });
    child.on('exit', (code) => {
      console.log(`[rydra ${stamp()}] camera engine exited (code ${code})`);
      child = null;
      for (const r of pending.values()) r([]);
      pending.clear();
      if (current) { toWindow({ type: 'error', id: current, code: 'engine', message: 'The camera engine stopped. Please try the check again.' }); current = null; }
    });
    child.postMessage({
      type: 'init',
      sdkDir: path.join(app.getPath('cache'), app.getName(), 'SmartSpectraSDK'),
      idFile: path.join(app.getPath('userData'), 'smartspectra-device-id.txt'),
    });
  }
  const engine = () => { if (!child) spawn(); return child; };

  // Watchdog: if the engine stops answering, end it; the next check starts a fresh one.
  setInterval(() => {
    if (child && Date.now() - lastTick > STUCK_MS) {
      console.log(`[rydra ${stamp()}] camera engine stopped responding for ${Math.round((Date.now() - lastTick) / 1000)} s; restarting it`);
      const c = child; child = null;
      try { c.kill(); } catch { /* already gone */ }
      if (current) { toWindow({ type: 'error', id: current, code: 'engine', message: 'The camera engine stopped responding. Please try the check again.' }); current = null; }
    }
  }, 2000).unref();

  ipcMain.handle('mz:sensor:cameras', () => new Promise((resolve) => {
    const reqId = ++reqSeq;
    pending.set(reqId, resolve);
    engine().postMessage({ type: 'cameras', reqId });
    setTimeout(() => { if (pending.has(reqId)) { pending.delete(reqId); resolve([]); } }, 8000);
  }));

  // Recorded-video checks: only a file the person picked, with a video extension, that exists.
  let pickedVideo = null;
  ipcMain.handle('mz:sensor:pickVideo', async () => {
    const r = await dialog.showOpenDialog(BrowserWindow.getAllWindows()[0], {
      title: 'Choose a recorded video of your face', properties: ['openFile'],
      filters: [{ name: 'Video', extensions: VIDEO_EXT }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    pickedVideo = r.filePaths[0];
    return pickedVideo;
  });

  ipcMain.handle('mz:sensor:start', (_e, opts) => {
    if (opts.file) {
      const ext = path.extname(opts.file).slice(1).toLowerCase();
      if (!VIDEO_EXT.includes(ext) || !fs.existsSync(opts.file)) throw new Error('That video file could not be found. Choose it again in Settings.');
    }
    const e = engine();
    current = opts.id;
    lastTick = Date.now();
    // A direct channel for preview images, engine -> window, without passing through this process's JS.
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      const { port1, port2 } = new MessageChannelMain();
      e.postMessage({ type: 'preview' }, [port1]);
      win.webContents.postMessage('mz:sensor:preview', null, [port2]);
    }
    e.postMessage({ type: 'start', opts });
    return true;
  });

  ipcMain.on('mz:sensor:cancel', () => { if (child) child.postMessage({ type: 'cancel' }); });

  app.on('will-quit', () => { if (child) { try { child.kill(); } catch { /* gone */ } } });
  return { warmUp: () => engine() };
}

module.exports = { startEngineHost };
