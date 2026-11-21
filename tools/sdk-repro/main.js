// Minimal SmartSpectra reproduction for Rydra's end-of-check freeze.
// Same SDK, Electron version, camera path (useMediaStream), resolution and metrics as Rydra,
// but none of Rydra's screens, storage or logic. Based on Presage's electron-quickstart.
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, session } = require('electron');
const { bindSmartSpectraIpc } = require('@smartspectra/node-sdk/main');

// API key: SMARTSPECTRA_API_KEY in the environment or in Rydra's .env (two folders up).
function readKey() {
  if (process.env.SMARTSPECTRA_API_KEY) return process.env.SMARTSPECTRA_API_KEY;
  try {
    const line = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8').split(/\r?\n/).find((l) => /^\s*SMARTSPECTRA_API_KEY\s*=/.test(l));
    return line ? line.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '') : '';
  } catch { return ''; }
}

const stamp = () => {
  const d = new Date();
  return `${d.toLocaleTimeString('en-GB', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};
const CHATTY = /frameSentThrough|<- metrics|<- validationStatus|forwarded \d+ frames/;

// Main-process block monitor: Windows' "Not Responding" means this thread stopped answering.
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const lag = now - lastTick - 250;
  if (lag > 500) console.log(`[main ${stamp()}] MAIN PROCESS BLOCKED for ${lag} ms`);
  lastTick = now;
}, 250).unref();

function createWindow() {
  const win = new BrowserWindow({
    width: 900, height: 760, backgroundColor: '#f4f5f7', title: 'SmartSpectra repro',
    webPreferences: {
      preload: require.resolve('@smartspectra/node-sdk/preload'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  if (process.env.REPRO_NO_DEVICE_ID !== '1') {
    try {
      const { preconfigureWithDeviceId } = require('../../src/native/device-id');
      console.log(`[main ${stamp()}] ` + preconfigureWithDeviceId(
        path.join(app.getPath('cache'), app.getName(), 'SmartSpectraSDK'),
        path.join(app.getPath('userData'), 'smartspectra-device-id.txt')));
    } catch (e) { console.log(`[main ${stamp()}] could not set the device ID: ${e && e.message}`); }
  }
  bindSmartSpectraIpc(win);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('console-message', (e, _level, message) => {
    const msg = String(e && e.message !== undefined ? e.message : message);
    if (!CHATTY.test(msg)) console.log(`[page ${stamp()}] ${msg}`);
  });
  win.on('unresponsive', () => console.log(`[main ${stamp()}] WINDOW UNRESPONSIVE`));
  win.on('responsive', () => console.log(`[main ${stamp()}] window responsive again`));
  win.loadFile(path.join(__dirname, 'index.html'), { query: { key: readKey() } });
}

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
    const types = (details && details.mediaTypes) || [];
    callback(permission === 'media' && types.length === 1 && types[0] === 'video' && url.startsWith('file://'));
  });
  console.log(`[main ${stamp()}] repro started (Electron ${process.versions.electron})`);
  createWindow();
});
app.on('window-all-closed', () => app.quit());
