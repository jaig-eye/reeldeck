// Copies ONLY the web assets into www/ (what Capacitor bundles into the APK).
// Keeps electron/, scripts/, node_modules/ out of the mobile build.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'www');
const FILES = ['index.html', 'app.js', 'styles.css', 'sw.js', 'manifest.webmanifest'];
const DIRS = ['assets'];

fs.rmSync(WWW, { recursive: true, force: true });
fs.mkdirSync(WWW, { recursive: true });
for (const f of FILES) fs.copyFileSync(path.join(ROOT, f), path.join(WWW, f));
for (const d of DIRS) fs.cpSync(path.join(ROOT, d), path.join(WWW, d), { recursive: true });
console.log('Web assets -> www/  (' + FILES.concat(DIRS).join(', ') + ')');
