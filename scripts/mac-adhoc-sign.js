// Ad-hoc signs the macOS .app after electron-builder has assembled it.
//
// WHY THIS FILE EXISTS. On Apple Silicon, macOS refuses to launch a native binary with
// NO code signature at all: the user gets "Reeldeck is damaged and can't be opened",
// which has no override — there is no "Open Anyway" button in Privacy & Security for
// it, and the only escape is a Terminal command. An AD-HOC signature (a cdhash with no
// certificate behind it) does not satisfy Gatekeeper and is not notarization, but it is
// enough to demote that hard block to the ordinary "Apple could not verify…" dialog,
// which the user can clear with two clicks.
//
// WHY NOT build.mac.identity = "-". Because that does not do what it looks like it
// does. electron-builder treats `identity` as a QUALIFIER passed to findIdentity(),
// i.e. a certificate name to search the keychain for — see
// app-builder-lib/out/macPackager.js, where a null result falls through to
// reportError() and signing is skipped entirely. A clean CI runner has no keychain
// identities, so "-" matched nothing and the app shipped unsigned. Verified by
// downloading the produced zip and finding no _CodeSignature anywhere in 258 entries.
//
// afterPack, not afterSign: afterSign is tied to electron-builder's own signing step,
// which is exactly the step that does not run here.

const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function macAdhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  try {
    // --deep is deprecated for real distribution signing, but it is the right tool for
    // an ad-hoc pass over a bundle full of unsigned Electron helpers.
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
      stdio: 'inherit',
    });
    // Prove it took, in the build log, rather than assuming.
    execFileSync('codesign', ['--verify', '--verbose=2', appPath], { stdio: 'inherit' });
    console.log(`[mac-adhoc-sign] ad-hoc signed ${appPath}`);
  } catch (e) {
    // Never fail the build over this: an unsigned build is still a usable build, it
    // just costs the user a Terminal command. Say so loudly instead.
    console.warn('[mac-adhoc-sign] could not ad-hoc sign — the arm64 build will need ' +
                 'the xattr/codesign workaround in DISTRIBUTION.md:', e && e.message);
  }
};
