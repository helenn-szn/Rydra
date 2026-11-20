// Rydra main process.
// - Opens the app window with the SmartSpectra preload bridge.
// - Stores all journey data in ONE local JSON file in the user's app-data folder.
// - Hands the API key to the renderer (read from the environment or a local .env file).

'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, session } = require('electron');

// Packaged builds ship the native SDK runtime as an extra resource (see package.json#build).
if (app.isPackaged) {
  const LIB = { darwin: 'libsmartspectra_capi.dylib', win32: 'smartspectra_capi.dll', linux: 'libsmartspectra_capi.so' }[process.platform];
  if (LIB) process.env.SMARTSPECTRA_CAPI_PATH = path.join(process.resourcesPath, 'smartspectra', LIB);
}

loadDotEnv(path.join(__dirname, '.env'));

const DEMO_SENSOR = process.env.MZ_DEMO_SENSOR === '1';
let bindSmartSpectraIpc = null;
if (!DEMO_SENSOR) {
  ({ bindSmartSpectraIpc } = require('@smartspectra/node-sdk/main'));
}

const { seedDemoData } = require('./src/core/seed');

const storeFile = () => path.join(app.getPath('userData'), 'rydra-data.json');

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
ipcMain.handle('mz:config', () => ({
  apiKey: process.env.SMARTSPECTRA_API_KEY || '',
  demoSensor: DEMO_SENSOR,
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
    },
  });

  if (bindSmartSpectraIpc) bindSmartSpectraIpc(win);

  // Rydra only ever shows its own local page.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  // Grant the camera only, only to our own bundled page. No microphone.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
    const mediaTypes = (details && details.mediaTypes) || [];
    const cameraOnly = mediaTypes.length === 1 && mediaTypes[0] === 'video';
    callback(permission === 'media' && cameraOnly && url.startsWith('file://'));
  });

  if (process.env.MZ_SEED_DEMO === '1') {
    writeStore(seedDemoData(readStore()));
    console.log('[rydra] Seeded demo history into', storeFile());
  }

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch { /* no .env file is fine */ }
}
