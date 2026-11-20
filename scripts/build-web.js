// Builds the browser demo into web/ (static files, deployable to Vercel or any static host).
// The demo runs the full Rydra interface with the clearly labelled demo sensor: no camera, no SDK.
'use strict';

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const out = path.join(root, 'web');
const assets = path.join(out, 'assets');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(assets, 'fonts'), { recursive: true });

esbuild.buildSync({
  entryPoints: [path.join(root, 'src/ui/app.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  outfile: path.join(assets, 'app.js'),
  external: ['@smartspectra/*'],     // the SDK only runs in the desktop app
  logLevel: 'warning',
});

fs.copyFileSync(path.join(root, 'styles.css'), path.join(assets, 'styles.css'));
fs.copyFileSync(path.join(root, 'node_modules/leaflet/dist/leaflet.css'), path.join(assets, 'leaflet.css'));

let fonts = '';
for (const w of [400, 500, 600]) {
  const file = `geist-sans-latin-${w}-normal.woff2`;
  fs.copyFileSync(path.join(root, 'node_modules/@fontsource/geist-sans/files', file), path.join(assets, 'fonts', file));
  fonts += `@font-face{font-family:'Geist Sans';font-style:normal;font-display:swap;font-weight:${w};src:url(./fonts/${file}) format('woff2');}\n`;
}
fs.writeFileSync(path.join(assets, 'fonts.css'), fonts);

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  .replace(/<link rel="stylesheet" href="\.\/node_modules\/@fontsource[^>]*>\s*/g, '')
  .replace('<link rel="stylesheet" href="./node_modules/leaflet/dist/leaflet.css">', '<link rel="stylesheet" href="./assets/fonts.css">\n  <link rel="stylesheet" href="./assets/leaflet.css">')
  .replace('<link rel="stylesheet" href="./styles.css">', '<link rel="stylesheet" href="./assets/styles.css">')
  .replace('<script src="./dist/renderer.bundle.js"></script>', '<script src="./assets/app.js"></script>')
  .replace('<title>Rydra</title>', '<title>Rydra: web demo</title>\n  <meta name="description" content="Rydra web demo: a private check-in and rest planner for drivers. Simulated readings; the camera check runs in the desktop app.">');
fs.writeFileSync(path.join(out, 'index.html'), html);

fs.writeFileSync(path.join(out, 'vercel.json'), JSON.stringify({
  headers: [{ source: '/(.*)', headers: [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  ] }],
}, null, 2));

console.log('Built web demo in', out);
