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
// The source artwork the icons are GENERATED from is not runtime content. mark.png is
// gen-icons.js's input, icon.png is its 1024px intermediate, and wordmark.png is
// referenced by nothing at all -- yet all three were being copied into the web bundle
// and into the APK, where they are ~1.8 MB that no code path ever requests.
const SKIP = ['assets/brand/mark.png', 'assets/brand/wordmark.png', 'assets/icon.png'];
let skipped = 0;
for (const d of DIRS) {
  fs.cpSync(path.join(ROOT, d), path.join(WWW, d), {
    recursive: true,
    // Matched by SUFFIX rather than by path.relative(ROOT, src), because on Windows
    // Node hands the filter an extended-length path: src arrives with a \\?\ prefix,
    // so relative() returns "//?/C:/Users/.../assets/brand/mark.png" and nothing ever
    // matches. A filter that matches nothing copies everything, which looks exactly
    // like success -- which is how these files shipped in the first place.
    filter: (src) => {
      const p = src.split(path.sep).join('/');
      const drop = SKIP.some((s) => p.endsWith('/' + s) || p.endsWith(s));
      if (drop) skipped++;
      return !drop;
    },
  });
}
// Fail loudly rather than silently shipping them again: if the prefix handling ever
// changes under us, the count goes to zero and this build stops.
if (skipped !== SKIP.length) {
  console.error('build-web: expected to skip ' + SKIP.length + ' generator sources, skipped ' + skipped);
  process.exit(1);
}
console.log('Web assets -> www/  (' + FILES.concat(DIRS).join(', ') + ')  [' + skipped + ' build-only sources excluded]');
