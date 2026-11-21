// Rydra preload: loads the SmartSpectra bridge and exposes a small, fixed API for local storage.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

if (process.env.MZ_DEMO_SENSOR !== '1' && process.env.MZ_ENGINE === 'window') {
  require('@smartspectra/node-sdk/preload');
}

contextBridge.exposeInMainWorld('mz', {
  load: () => ipcRenderer.invoke('mz:load'),
  save: (data) => ipcRenderer.invoke('mz:save', data),
  wipe: () => ipcRenderer.invoke('mz:wipe'),
  config: () => ipcRenderer.invoke('mz:config'),
  setKey: (key) => ipcRenderer.invoke('mz:setKey', key),
  // Background camera engine (see src/native/sensor-worker.js).
  sensor: {
    cameras: () => ipcRenderer.invoke('mz:sensor:cameras'),
    start: (opts) => ipcRenderer.invoke('mz:sensor:start', opts),
    cancel: () => ipcRenderer.send('mz:sensor:cancel'),
    onEvent: (cb) => {
      const h = (_e, msg) => cb(msg);
      ipcRenderer.on('mz:sensor:event', h);
      return () => ipcRenderer.removeListener('mz:sensor:event', h);
    },
  },
});

// Preview images arrive on a message port; ports can't cross the context bridge, so hand it over with postMessage.
ipcRenderer.on('mz:sensor:preview', (e) => { window.postMessage({ rydraPreviewPort: true }, '*', e.ports); });
