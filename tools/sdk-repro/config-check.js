// Starts SmartSpectra with each set of measurements, with full SDK logging, to see
// which set the SDK accepts on this computer and key, and the SDK's own reason when not.
// No camera or video is used: each set is started, then stopped after a few seconds.
'use strict';

const fs = require('fs');
const path = require('path');
const {
  SmartSpectraSDK, SmartSpectraLogLevel, MetricType, breathingMetrics,
} = require('@smartspectra/node-sdk');

function readKey() {
  if (process.env.SMARTSPECTRA_API_KEY) return process.env.SMARTSPECTRA_API_KEY.trim();
  try {
    const line = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8')
      .split(/\r?\n/).find((l) => /^\s*SMARTSPECTRA_API_KEY\s*=/.test(l));
    return line ? line.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '') : '';
  } catch { return ''; }
}

const SETS = [
  ['breathing only', [...breathingMetrics]],
  ['breathing + pulse', [...breathingMetrics, MetricType.PULSE_RATE]],
  ['breathing + HRV', [...breathingMetrics, MetricType.HRV]],
  ['breathing + pulse + HRV', [...breathingMetrics, MetricType.PULSE_RATE, MetricType.HRV]],
  ['pulse only', [MetricType.PULSE_RATE]],
];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function trySet(name, metrics, apiKey) {
  console.log(`\n===== ${name} (metrics ${metrics.join(', ')}) =====`);
  const sdk = new SmartSpectraSDK({
    apiKey, requestedMetrics: metrics, enableTelemetry: false, logLevel: SmartSpectraLogLevel.kInfo,
  });
  let result = 'no answer within 20 s';
  sdk.on('processingStatus', (s) => console.log(`  status ${s}`));
  sdk.on('error', (code, message) => { console.log(`  SDK error ${code}: ${message}`); result = `FAILED, error ${code}: ${message}`; });
  try {
    sdk.useCustomInput();
    sdk.start();
    for (let i = 0; i < 40; i += 1) {
      await wait(500);
      if (sdk.processingStatus === 3) { result = 'OK, the SDK accepted this set and started'; break; } // kRunning
      if (result.startsWith('FAILED')) break;
      if (sdk.processingStatus === 5) { result = 'FAILED (SDK went into its error state)'; break; }
    }
  } catch (e) {
    result = `FAILED at start, error ${e.code}: ${e.message}`;
  }
  try { await sdk.stopAsync(); } catch { /* already stopped */ }
  try { await sdk.destroy(); } catch { /* already gone */ }
  console.log(`  RESULT: ${result}`);
  return result;
}

(async () => {
  const apiKey = readKey();
  if (!apiKey) { console.log('No API key found. Put SMARTSPECTRA_API_KEY in the .env file in the Rydra folder.'); return; }
  console.log(`SmartSpectra ${SmartSpectraSDK.version || ''}, Node ${process.version}, ${process.platform} ${process.arch}`);
  // Give the SDK a stable device ID before its first session (what Rydra now does).
  // Run with NO_DEVICE_ID=1 to see the SDK's own behaviour instead.
  const os = require('os');
  const dir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.cache'), 'SmartSpectraSDK');
  if (process.env.NO_DEVICE_ID === '1') console.log('Device ID: left to the SDK (NO_DEVICE_ID=1)');
  else {
    try {
      const { preconfigureWithDeviceId } = require('../../src/native/device-id');
      console.log('Device ID: ' + preconfigureWithDeviceId(dir, path.join(dir, '..', 'Rydra-device-id.txt')));
    } catch (e) { console.log(`Device ID: FAILED to set, error ${e.code}: ${e.message}`); }
  }
  const summary = [];
  for (const [name, metrics] of SETS) summary.push(`${name.padEnd(26)} ${await trySet(name, metrics, apiKey)}`);
  console.log('\n===== SUMMARY =====');
  summary.forEach((l) => console.log(l));
})();
