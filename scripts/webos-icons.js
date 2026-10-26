// The LG app's two icons, from the same brand icon as every other target: icon.png (80x80,
// the launcher bar) and largeIcon.png (130x130, the app list). Run by `npm run webos:ipk`.
const sharp = require('sharp');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'assets', 'icon-512.png');
Promise.all([
  sharp(SRC).resize(80, 80).png().toFile(path.join(ROOT, 'webos', 'icon.png')),
  sharp(SRC).resize(130, 130).png().toFile(path.join(ROOT, 'webos', 'largeIcon.png')),
]).then(() => console.log('webos icons written'), (e) => { console.error(e); process.exit(1); });
