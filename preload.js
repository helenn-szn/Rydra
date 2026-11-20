// MileZero preload: loads the SmartSpectra bridge and exposes a small, fixed API for local storage.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

if (process.env.MZ_DEMO_SENSOR !== '1') {
  require('@smartspectra/node-sdk/preload');
}

contextBridge.exposeInMainWorld('mz', {
  load: () => ipcRenderer.invoke('mz:load'),
  save: (data) => ipcRenderer.invoke('mz:save', data),
  wipe: () => ipcRenderer.invoke('mz:wipe'),
  config: () => ipcRenderer.invoke('mz:config'),
});
