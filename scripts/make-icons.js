// Generates PWA/app icons (dark bg + gold play glyph) as PNGs — no dependencies.
// Run: node scripts/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function png(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * w * 4, y * w * 4 + w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
function draw(size) {
  const w = size, h = size, buf = Buffer.alloc(w * h * 4);
  const bg = [18, 21, 29], bg2 = [31, 36, 49], gold = [245, 197, 24];
  const cx = w / 2, cy = h / 2, rRing = w * 0.30, tS = w * 0.15;
  const ax = cx - tS * 0.72, ay = cy - tS, bx = cx - tS * 0.72, by = cy + tS, dx3 = cx + tS, dy3 = cy;
  const denom = (by - dy3) * (ax - dx3) + (dx3 - bx) * (ay - dy3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dx = x - cx, dy = y - cy, dist = Math.sqrt(dx * dx + dy * dy);
      const t = Math.min(1, dist / (w * 0.72));
      let col = [Math.round(bg2[0] + (bg[0] - bg2[0]) * t), Math.round(bg2[1] + (bg[1] - bg2[1]) * t), Math.round(bg2[2] + (bg[2] - bg2[2]) * t)];
      if (dist < rRing && dist > rRing * 0.85) col = gold;
      const a = ((by - dy3) * (x - dx3) + (dx3 - bx) * (y - dy3)) / denom;
      const b = ((dy3 - ay) * (x - dx3) + (ax - dx3) * (y - dy3)) / denom;
      if (a >= 0 && b >= 0 && (1 - a - b) >= 0) col = gold;
      buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2]; buf[i + 3] = 255;
    }
  }
  return png(w, h, buf);
}
const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
for (const s of [192, 512, 180]) fs.writeFileSync(path.join(outDir, `icon-${s}.png`), draw(s));
console.log('icons written to assets/');
