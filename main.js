// Rydra main process.
// - Opens the app window with the SmartSpectra preload bridge.
// - Stores all journey data in ONE local JSON file in the user's app-data folder.
// - Hands the API key to the renderer (read from the environment or a local .env file).

'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, session, shell } = require('electron');

// Packaged builds ship the native SDK runtime as an extra resource (see package.json#build).
if (app.isPackaged) {
  const LIB = { darwin: 'libsmartspectra_capi.dylib', win32: 'smartspectra_capi.dll', linux: 'libsmartspectra_capi.so' }[process.platform];
  if (LIB) process.env.SMARTSPECTRA_CAPI_PATH = path.join(process.resourcesPath, 'smartspectra', LIB);
}

loadDotEnv(path.join(__dirname, '.env'));

// Don't let Chromium slow the renderer down while a camera check is running.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

const DEMO_SENSOR = process.env.MZ_DEMO_SENSOR === '1';
// Camera engine. 'background' (default): SmartSpectra runs in its own process and reads the camera
// itself, so it can't freeze the window. 'window' (MZ_ENGINE=window): the old in-window setup.
const ENGINE = DEMO_SENSOR ? 'demo' : process.env.MZ_ENGINE === 'window' ? 'window' : 'background';
let bindSmartSpectraIpc = null;
if (ENGINE === 'window') {
  ({ bindSmartSpectraIpc } = require('@smartspectra/node-sdk/main'));
}
let engineHost = null;

const { seedDemoData } = require('./src/core/seed');

const storeFile = () => path.join(app.getPath('userData'), 'rydra-data.json');
// The API key is kept apart from journey data: deleting your data doesn't remove it, and it is never exported.
const keyFile = () => path.join(app.getPath('userData'), 'rydra-key.json');

function savedKey() {
  try { return JSON.parse(fs.readFileSync(keyFile(), 'utf8')).apiKey || ''; } catch { return ''; }
}

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
  } catch {
    return null;
  }
}

function writeStore(data) {
  const file = storeFile();
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // atomic replace, so a crash never leaves half a file
}

ipcMain.handle('mz:load', () => readStore());
ipcMain.handle('mz:save', (_e, data) => { writeStore(data); return true; });
ipcMain.handle('mz:wipe', () => {
  try { fs.rmSync(storeFile(), { force: true }); } catch { /* already gone */ }
  return true;
});
ipcMain.handle('mz:setKey', (_e, key) => {
  const clean = String(key || '').trim();
  if (!clean) { try { fs.rmSync(keyFile(), { force: true }); } catch { /* already gone */ } return true; }
  if (!/^[A-Za-z0-9_\-.]{8,200}$/.test(clean)) throw new Error('That does not look like an API key.');
  fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
  fs.writeFileSync(keyFile(), JSON.stringify({ apiKey: clean }), { mode: 0o600 });
  return true;
});
ipcMain.handle('mz:config', () => ({
  apiKey: process.env.SMARTSPECTRA_API_KEY || savedKey(),
  keySource: process.env.SMARTSPECTRA_API_KEY ? 'env' : savedKey() ? 'settings' : 'none',
  demoSensor: DEMO_SENSOR,
  engine: ENGINE,
  platform: process.platform,
}));

function createWindow() {
  const win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 420,
    backgroundColor: '#f6f4ef',
    title: 'Rydra',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      // Our preload loads the SDK's preload bridge from node_modules, which needs require().
      sandbox: false,
      nodeIntegration: false,
      // Keep the frame pump running at full speed even if the window loses focus.
      backgroundThrottling: false,
    },
  });

  if (bindSmartSpectraIpc) {
    // Same folder the SDK's Electron glue uses, so its own later setup call matches ours.
    try {
      const { preconfigureWithDeviceId } = require('./src/native/device-id');
      console.log('[rydra] ' + preconfigureWithDeviceId(
        path.join(app.getPath('cache'), app.getName(), 'SmartSpectraSDK'),
        path.join(app.getPath('userData'), 'smartspectra-device-id.txt')));
    } catch (e) { console.log(`[rydra] could not set the SmartSpectra device ID: ${e && e.message}`); }
    bindSmartSpectraIpc(win);
  }

  // Terminal logging. Always: Rydra's own messages and errors (cheap). With the debug launcher
  // (SMARTSPECTRA_DIAGNOSTICS=1): everything except the per-frame chatter, which itself slows the app.
  const stamp = () => new Date().toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0');
  const debug = process.env.SMARTSPECTRA_DIAGNOSTICS === '1';
  const CHATTY = /frameSentThrough|<- metrics|<- validationStatus|forwarded \d+ frames/;
  win.webContents.on('console-message', (e, _level, message) => {
    const msg = String(e && e.message !== undefined ? e.message : message);   // newer and older Electron signatures
    if (debug ? !CHATTY.test(msg) : /\[rydra\]|error/i.test(msg)) console.log(`[app ${stamp()}] ${msg}`);
  });
  win.on('unresponsive', () => console.log(`[rydra ${stamp()}] window became UNRESPONSIVE`));
  win.on('responsive', () => console.log(`[rydra ${stamp()}] window responsive again`));

  // Rydra only ever shows its own local page. Map attribution links open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(www\.)?openstreetmap\.org\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.loadFile(path.join(__dirname, 'index.html'));
}

// Only one Rydra at a time: two copies fight over the camera and its frame rate drops.
if (!app.requestSingleInstanceLock()) {
  console.log('\n[rydra] Rydra is already running, so this copy is closing.');
  console.log('[rydra] If you cannot see it, it may be frozen: open Task Manager (Ctrl+Shift+Esc),');
  console.log('[rydra] end every "Electron" or "Rydra" task, then start Rydra again.\n');
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

app.whenReady().then(() => {
  // Grant the camera only, only to our own bundled page. No microphone.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
    const mediaTypes = (details && details.mediaTypes) || [];
    const cameraOnly = mediaTypes.length === 1 && mediaTypes[0] === 'video';
    const local = url.startsWith('file://');
    // Camera (video only) for checks; notifications for break reminders. Nothing else.
    callback(local && ((permission === 'media' && cameraOnly) || permission === 'notifications'));
  });

  // OpenStreetMap's usage policies ask apps to identify themselves.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://nominatim.openstreetmap.org/*', 'https://tile.openstreetmap.org/*', 'https://router.project-osrm.org/*'] },
    (details, cb) => {
      details.requestHeaders['User-Agent'] = `Rydra/${app.getVersion()} (driver rest-planning app; Electron)`;
      cb({ requestHeaders: details.requestHeaders });
    },
  );

  if (process.env.MZ_SEED_DEMO === '1') {
    writeStore(seedDemoData(readStore()));
    console.log('[rydra] Seeded demo history into', storeFile());
  }

  if (ENGINE === 'background') {
    const { startEngineHost } = require('./src/native/engine-host');
    engineHost = startEngineHost(() => BrowserWindow.getAllWindows()[0]);
    engineHost.warmUp();   // start the engine now so the first check doesn't wait for it
    console.log('[rydra] camera engine: background process');
  }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// Reports when the main process is blocked (it is what Windows calls "Not Responding").
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const lag = now - lastTick - 250;
  if (lag > 500) console.log(`[rydra] MAIN PROCESS BLOCKED for ${lag} ms (just before ${new Date(now).toLocaleTimeString('en-GB', { hour12: false })})`);
  lastTick = now;
}, 250).unref();

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch { /* no .env file is fine */ }
}
