// The web app is exactly these files. build-web.js copies them into www/ (what the APK and
// Pages ship) and serve.js serves nothing else -- the repo root also holds the private Worker
// file, .git, keys and build output, and serve.js listens on the LAN.
module.exports = {
  FILES: ['index.html', 'app.js', 'styles.css', 'stage.css', 'compat.css', 'sw.js', 'manifest.webmanifest'],
  DIRS: ['assets'],
};
