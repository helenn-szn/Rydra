// Gives SmartSpectra a stable device ID before it sets itself up.
// On some Windows PCs the SDK cannot create its own device identity and then fails
// with "device_id is required for remote model download", which blocks pulse and HRV.
// The ID is a random value made once and kept in a file; it says nothing about the person.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sdkFfi() {
  // ffi.js is not in the package's export map, so load it by file path.
  return require(path.join(path.dirname(require.resolve('@smartspectra/node-sdk')), 'ffi.js'));
}

function stableId(idFile) {
  try {
    const id = fs.readFileSync(idFile, 'utf8').trim();
    if (/^[0-9a-f-]{36}$/.test(id)) return id;
  } catch { /* make a new one */ }
  const id = crypto.randomUUID();
  fs.mkdirSync(path.dirname(idFile), { recursive: true });
  fs.writeFileSync(idFile, id);
  return id;
}

/** Call before bindSmartSpectraIpc() or before the first session starts. Returns a short status line. */
function preconfigureWithDeviceId(sdkDirectory, idFile) {
  const id = stableId(idFile);
  fs.mkdirSync(sdkDirectory, { recursive: true, mode: 0o700 });
  sdkFfi().preconfigure(sdkDirectory, id);
  return `SmartSpectra set up with a stable device ID (${id.slice(0, 8)}…) in ${sdkDirectory}`;
}

module.exports = { preconfigureWithDeviceId };
