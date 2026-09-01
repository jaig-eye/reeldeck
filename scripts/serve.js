// Correct-MIME static server for the browser / PWA version, reachable from
// other devices on your LAN (phone, tablet) via this machine's IP.
// (Python's http.server serves .js as text/plain on some Windows setups, which
//  breaks service-worker registration — use this instead: `npm run serve`.)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 5178;
const HOST = '0.0.0.0'; // all interfaces, so phones on the same Wi-Fi can reach it

function lanIPs() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name in ifaces) {
    for (const net of ifaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp'
};

// Identical guarding to electron/main.js, and it matters MORE here: this binds
// 0.0.0.0 so anything on the Wi-Fi can reach it, and plain Node really does exit the
// process on an uncaught request-listener throw -- one malformed URL would kill the
// dev server for every device using it.
const serveFile = (req, res) => {
  let rel;
  try { rel = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch (e) { res.writeHead(400); return res.end('Bad request'); }   // e.g. GET /%
  if (rel.indexOf('\0') >= 0) { res.writeHead(400); return res.end('Bad request'); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  // Path containment, not string containment -- startsWith also admitted siblings.
  const inside = path.relative(ROOT, file);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate'  // always serve fresh in dev
    });
    res.end(data);
  });
};

// Backstop: nothing may escape the handler, because an uncaught throw here takes the
// whole dev server down for every device on the LAN.
http.createServer((req, res) => {
  try { serveFile(req, res); }
  catch (e) { try { res.writeHead(500); res.end('Server error'); } catch (e2) {} }
}).listen(PORT, HOST, () => {
  console.log(`\nReeldeck is serving on port ${PORT}\n`);
  console.log(`  On THIS computer:   http://localhost:${PORT}`);
  const ips = lanIPs();
  if (ips.length) {
    console.log(`  On your PHONE (same Wi-Fi), open one of:`);
    ips.forEach((ip) => console.log(`      http://${ip}:${PORT}`));
  }
  console.log(`\n  (Windows may ask to allow Node through the firewall the first time — click Allow.)`);
  console.log(`  Stop with Ctrl+C.\n`);
});
