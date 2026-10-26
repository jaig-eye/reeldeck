// The release lockstep, checked in one place:
//   package.json version == APP_VERSION (app.js) == versionName (build.gradle) [== tag]
//   every ?v=N in index.html == sw.js CACHE 'reeldeck-vN' == every ?v=N in sw.js
// Any one of these drifting has shipped a real bug: an Android client whose APP_VERSION lags
// package.json sees an update for ever; a ?v that did not move keeps installed PWAs on the old
// file. Run by both workflows, and locally with `npm run check:versions [vX.Y.Z]`.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const errors = [];
const one = (label, re, text) => {
  const m = re.exec(text);
  if (!m) errors.push('could not find ' + label);
  return m ? m[1] : null;
};

const pkg = JSON.parse(read('package.json')).version;
const app = one('APP_VERSION in app.js', /const APP_VERSION\s*=\s*'([^']+)'/, read('app.js'));
const gradle = read('android/app/build.gradle');
const vName = one('versionName in build.gradle', /versionName\s+"([^"]+)"/, gradle);
one('versionCode in build.gradle', /versionCode\s+(\d+)/, gradle);

if (app && app !== pkg) errors.push(`APP_VERSION ${app} != package.json ${pkg}`);
if (vName && vName !== pkg) errors.push(`build.gradle versionName ${vName} != package.json ${pkg}`);
// The LG app (webos/) carries its own version for the TV's app list.
const webos = JSON.parse(read('webos/appinfo.json')).version;
if (webos !== pkg) errors.push(`webos/appinfo.json version ${webos} != package.json ${pkg}`);

const tag = process.argv[2] || '';
if (tag && tag.replace(/^v/, '') !== pkg) errors.push(`tag ${tag} != package.json ${pkg}`);

const html = read('index.html');
const sw = read('sw.js');
const htmlV = [...html.matchAll(/\?v=(\d+)/g)].map((m) => m[1]);
const swV = [...sw.matchAll(/\?v=(\d+)/g)].map((m) => m[1]);
const cache = one("sw.js CACHE 'reeldeck-vN'", /const CACHE\s*=\s*'reeldeck-v(\d+)'/, sw);
if (htmlV.length < 2) errors.push('expected ?v= on both app.js and styles.css in index.html');
if (swV.length < 2) errors.push('expected ?v= on both shell URLs in sw.js');
const all = new Set([...htmlV, ...swV, ...(cache ? [cache] : [])]);
if (all.size > 1) errors.push(`cache-busting versions disagree: index.html ${htmlV.join(',')} / sw.js ?v ${swV.join(',')} / CACHE v${cache}`);

// The desktop package lists its files separately from the web build. A file added to one
// and not the other ships a desktop app without it (stage.css nearly did).
const { FILES, DIRS } = require('./web-files');
const packed = ((JSON.parse(read('package.json')).build || {}).files) || [];
FILES.forEach((f) => { if (!packed.includes(f)) errors.push(`package.json build.files is missing ${f}`); });
DIRS.forEach((d) => { if (!packed.includes(d + '/**')) errors.push(`package.json build.files is missing ${d}/**`); });
if (!packed.includes('scripts/web-files.js')) errors.push('package.json build.files is missing scripts/web-files.js (electron/main.js requires it)');

if (errors.length) {
  errors.forEach((e) => console.error('::error::' + e));
  process.exit(1);
}
console.log(`versions agree: ${pkg}${tag ? ' (' + tag + ')' : ''}, cache v${cache}`);
