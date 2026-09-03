# Sharing Reeldeck as a desktop app (Windows + macOS)

The app is packaged with Electron via `electron-builder`. No hosting, no server, no cost —
you hand people a file, they run it. This is verified against Aug 2026 tooling.

---

## Windows — built and ready

Already built on this machine, in `release/`:

| File | What it is |
|---|---|
| `Reeldeck-1.0.0-portable.exe` | **Single file, no install** — the easiest thing to share. |
| `Reeldeck-1.0.0-x64.exe` | A normal installer (adds a Start-menu entry). |

Rebuild anytime: `npm run dist`.

### Lightweight "web installer" (tiny file to hand out)

Instead of sharing the ~87 MB installer, you can share a **~0.7 MB stub** that downloads the app during
install. Built with `npm run dist:web` → `release/nsis-web/`:

| File | Size | Role |
|---|---|---|
| `Reeldeck-Web-Setup-1.0.0.exe` | **~0.7 MB** | The stub you hand out. |
| `reeldeck-1.0.0-x64.nsis.7z` | ~82 MB | The payload — **you host this**; the stub downloads it. |

**The catch:** the stub bakes in a download URL at build time, and that URL must be an **anonymous,
direct-download** link to the `.7z`. So:

1. Set `build.publish.url` in `package.json` to where you'll host the `.7z` (it's a placeholder now).
2. `npm run dist:web`.
3. Upload the `.7z` to that exact location. Share the stub.

Where to host the payload:

- ✅ **GitHub Releases (public repo) — already wired up.** `build.publish` is set to `github`, and the
  CI builds the web installer and uploads the stub + payload to a Release on every version tag. You just
  create the repo and push (steps below). The repo must be **public** — a private repo's release files
  need a login, which the stub can't do — so the app becomes publicly downloadable.
- ✅ **A static host / Cloudflare R2 / S3 bucket** — set `provider: generic` + the bucket URL.
- ❌ **Google Drive / Dropbox share links** — these serve a "scan/confirm" HTML page for big files
  instead of the raw file, so the stub's automatic download fails. Fine for a human clicking a link,
  not for the stub.

**Simpler alternative (no stub):** just upload the full `Reeldeck-1.0.0-portable.exe` to any host
(**Google Drive is fine here**) and share the link. The file people download is one self-contained
`.exe` — bigger, but there's nothing to configure and no host-uptime dependency at install time.

Either way you are hosting the app for others to download, so pick a spot you're comfortable being
reachable.

### Publishing to GitHub Releases (the steps you run)

The config auto-targets whatever repo you push to. On github.com, create a **public** repo (e.g.
`reeldeck`), then from this folder:

```bash
git remote add origin https://github.com/<your-username>/reeldeck.git
git push -u origin main

# Tag a version — this is what triggers the cloud build + publish:
git tag v1.0.0
git push origin v1.0.0
```

~5 minutes later, `https://github.com/<your-username>/reeldeck/releases` will hold:

| Asset | What to do with it |
|---|---|
| `Reeldeck-Web-Setup-1.0.0.exe` | **Share this** — the ~0.7 MB installer. |
| `reeldeck-1.0.0-x64.nsis.7z` | Leave it in the release — the stub downloads it. |
| `Reeldeck-1.0.0-portable.exe` | Full single-file exe, if someone wants the direct download. |
| `Reeldeck-1.0.0-*.dmg` / `.zip` | The macOS builds. |

To ship an update later: bump `version` in `package.json`, commit, and push a new tag (`v1.0.1`).

---

## macOS — build it free in the cloud (can't be built on Windows)

A macOS `.dmg` **cannot** be produced on a Windows PC — Apple's disk-image tooling only runs on
macOS. Two ways to get the Mac build:

### Option A — a Mac (fastest if you have access to one)
```bash
npm install
npm run dist:mac    # -> release/Reeldeck-1.0.0-arm64.dmg  and  -x64.dmg
```

### Option B — free GitHub Actions (no Mac required)
A ready workflow is in `.github/workflows/build.yml`. GitHub's cloud runners build **both**
Windows and macOS for you.

1. Put this folder in a **private** GitHub repo (private keeps the source off the public web):
   ```bash
   git init && git add . && git commit -m "Reeldeck"
   git branch -M main
   git remote add origin https://github.com/<you>/reeldeck.git
   git push -u origin main
   ```
2. In the repo → **Actions** tab → run **"Build Electron App"** (button: *Run workflow*), or push a
   version tag to trigger it automatically:
   ```bash
   git tag v1.0.0 && git push origin v1.0.0
   ```
3. When it finishes (~5 min), open the run → **Artifacts** → download **`installers-macos-latest`**.
   Inside are the `.dmg` files (Apple Silicon `arm64` + Intel `x64`) to share with Mac users.
   (`installers-windows-latest` has the Windows build too.)

**Cost:** on a **private** repo the macOS runner bills at **10× minutes** (a ~5-min Mac build ≈ 50 of
the free plan's 2,000 monthly minutes) — plenty for occasional builds. A **public** repo makes runners
free/unmetered, but publishes the source, so I'd keep it private.

---

## What the people you share it with will see (and how to get past it)

Both builds are **unsigned** (no paid Apple/Microsoft certificate), so the first launch shows a
scary-looking warning. It's expected for a directly-shared app — here's how to open it. Only do this
for a copy received from someone trusted.

### Windows
1. Download the file. The browser may say it "isn't commonly downloaded" → **Keep / Keep anyway**.
2. Double-click it. A blue box appears: **"Windows protected your PC."** (No Run button yet — on purpose.)
3. Click the small **More info** link → then the **Run anyway** button that appears.
4. For the installer, also click **Yes** on the "allow this app to make changes?" prompt.

If **Run anyway** never shows: right-click the file → **Properties** → tick **Unblock** → **OK**, then run it.

### macOS
Which message appears depends on the Mac:

**"…cannot be opened because Apple cannot check it" (Intel, or newer macOS):**
1. Double-click, dismiss the warning.
2. Apple menu → **System Settings → Privacy & Security**.
3. Scroll to **Security** — there's a line about Reeldeck being blocked → click **Open Anyway** → **Open**.
   (On recent macOS the old right-click→Open trick no longer works; use this button.)

**"Reeldeck is damaged and can't be opened" (Apple Silicon, unsigned — a false alarm, not real damage):**
1. Open **Terminal** (Applications → Utilities → Terminal).
2. Type `xattr -cr ` (with a trailing space) — don't press Return yet.
3. Drag the Reeldeck app from Finder into the Terminal window (fills in its path).
4. Press **Return**, then open the app normally. (If "permission denied", prefix with `sudo `.)

### Which Mac file to download

 → **About This Mac**. "Apple M1/M2/M3/M4…" → take the **arm64** dmg. "Intel" → take
the **x64** one. The wrong one either refuses to launch or runs slowly under Rosetta.

### Why the build carries an ad-hoc signature

`build.mac.identity` is `"-"`, an ad-hoc signature. It does not satisfy Gatekeeper and
it is not notarization, but it does give the arm64 binary a valid cdhash — and without
*any* signature an arm64 binary is refused outright with an unbypassable "is damaged"
error, whereas one with a cdhash gets the recoverable "Apple could not verify" dialog
that has an **Open Anyway** button. It must not be paired with `hardenedRuntime`.

Do not try to explain this in `package.json` itself. electron-builder validates its
config against a schema with `additionalProperties: false`, so a `"//identity"` key
added as a comment fails the build — on **both** Windows and macOS, because the whole
config is validated regardless of the platform being built. That mistake cost the
v1.0.17 desktop installers.

### Auto-update does not work on macOS

Squirrel.Mac refuses to apply an update to an app without a valid code signature, and
these builds are unsigned. Rather than detect a release, promise an install and then
fail — every six hours, for ever — the desktop updater is switched off on macOS: it
reports that a newer version exists and asks you to download it. Windows auto-update is
unaffected. Sign the build and this restriction goes away on its own.

---

## iPhone and iPad — install the web app, free

There is no App Store build and there does not need to be. The app installs from Safari:

1. Open the site in **Safari**. It has to be Safari — other iOS browsers cannot install
   web apps.
2. **Share** → **Add to Home Screen** → **Add**.

It gets its own icon and opens without browser chrome, like any other app. The watchlist
and history live in the device's local storage, which an installed home-screen web app
keeps; and if you are signed in, all of it is on the sync server as well.

**Honest differences from the Android app**, so nobody is surprised:

- **No ad blocking.** The Android build blocks pop-unders in native code and the desktop
  build uses a blocklist. Safari has neither, so mirror ads behave as they do in any
  browser tab.
- **Autoplay will not fire.** iOS requires a tap inside the player before video starts,
  whatever the provider's autoplay setting says.
- **TV mode does less on an iPhone.** iOS does not permit fullscreen on arbitrary
  elements, so the layout fills the screen but the system does not go fullscreen.
  Nothing breaks; the button simply does less than it does elsewhere. It works properly
  on iPad.
- Some mirrors will jump straight into iOS's own fullscreen video player when playback
  starts. That is usually an improvement.

---

## Apple TV — not possible, and what to do instead

**There is no way to run this on an Apple TV.** Not difficult — impossible. tvOS ships
no web view of any kind, so there is nothing for a web app to run inside, and no browser
has ever existed for the platform. A native rewrite would not rescue it either: this app
deliberately embeds player *pages* rather than video URLs, and tvOS has no way to render
a page. Apps sold as "browsers for Apple TV" are iPhone apps that mirror their own
screen, which is something you can already do for free.

Two substitutes, better one first:

1. **A cheap Google TV or Chromecast dongle in the other HDMI port.** It runs the APK
   this repo already builds — native ad blocking, D-pad navigation, real TV resolution,
   no phone involved. Cheaper than an Apple developer account and better than anything
   Apple would have permitted.
2. **AirPlay screen mirroring** from the iPhone web app: Control Centre → **Screen
   Mirroring** → the Apple TV, then open a title and press **TV mode**. It mirrors and
   re-encodes the phone's screen, so expect some latency, set Auto-Lock to Never because
   the phone must stay awake for the whole film, hold it landscape to avoid black bars,
   and be aware that notifications and calls appear on the television.

---

## Removing the warnings entirely (optional, costs money)

- **macOS:** Apple **Developer Program ($99/yr)** → sign with a Developer ID + **notarize** (`notarytool`).
  This removes the Gatekeeper prompt completely.
- **Windows:** a **code-signing certificate** (OV ≈ low-hundreds/yr, EV more). Note even a freshly
  OV-signed app can still trip SmartScreen until it builds download "reputation"; EV clears it immediately.

For sharing with friends/a small group, the free unsigned builds + the steps above are the normal path.

---

## Android — the release signing key (read this before touching releases)

Android will only install an APK over an existing app **if both are signed by the same
certificate**. A mismatch is refused with `App not installed` — which looks like a
corrupt download or Play Protect, and is neither. Disabling Play Protect does nothing,
because Play Protect was never involved.

### What went wrong once, so it is not repeated

CI builds the APK with `assembleDebug`. Left to itself, Gradle signs debug builds with
`~/.android/debug.keystore` — and a fresh CI runner has no such file, so it **generates
a new random one every run**. Three consecutive releases were therefore signed by three
different keys and none could update the one before it:

| release | signer | SHA-256 (first bytes) |
|---|---|---|
| v1.0.10 | `CN=Android Debug` | `47:F6:63:78…` |
| v1.0.11 | `CN=Android Debug` | `1C:F1:F8:2E…` |
| v1.0.12 | `CN=Android Debug` | `F8:20:8D:CF…` |
| **v1.0.14** | **`CN=Robert, OU=Reeldeck`** | **`4D:E1:A3:F1…`** |
| **v1.0.15** | **`CN=Robert, OU=Reeldeck`** | **`4D:E1:A3:F1…`** |
| **v1.0.16** | **`CN=Robert, OU=Reeldeck`** | **`4D:E1:A3:F1…`** |

Three consecutive releases now carry the same fingerprint, which is the proof this
document asked for: the key is stable and updates install over the app in place.
Each was checked against the DOWNLOADED APK rather than the build config -- the config
was right for v1.0.12 too, and the APK was not.

`android/app/build.gradle` now defines `signingConfigs.shared` and applies it to **both**
build types. Both matters: the shipped APK is a *debug* build, so signing only `release`
would have changed nothing.

### The secrets CI needs

Repository → Settings → Secrets and variables → Actions:

| Secret | Required | Notes |
|---|---|---|
| `ANDROID_KEYSTORE_BASE64` | yes | the `.jks`, base64, one line, no wrapping |
| `ANDROID_KEYSTORE_PASSWORD` | yes | |
| `ANDROID_KEY_ALIAS` | yes | e.g. `reeldeck` |
| `ANDROID_KEY_PASSWORD` | **no** | only if the key has its *own* password; otherwise Gradle falls back to the store password, which is what `keytool` uses when you accept its offer to reuse it |

With the secrets absent the build still succeeds — it just produces an APK that cannot
update anything, and logs a GitHub **warning** saying so. It does not fail the release,
because a missing secret should not block a desktop build.

### The key itself

- Lives **outside** the repository. `.gitignore` blocks `*.jks`, `*.keystore`, `*.b64`
  and `keystore.properties` so it cannot be committed by accident.
- **Back it up.** It is the only key that can update installs already in the wild. Lose
  it and every user has to uninstall and reinstall by hand — permanently, every time.
- Delete any `.b64` copy once the secret is stored; it is the key in plain text.
- Never commit it, even to a private repo. A public repo would let anyone sign an APK
  that installs over yours.

### Verifying a release actually got signed

```bash
keytool -printcert -jarfile Reeldeck.apk
```

Expect `Owner: CN=Robert, OU=Reeldeck, …` and SHA-256 `4D:E1:A3:F1:41:29:D9:AC:…`.

- `CN=Android Debug` → the secrets are not reaching the build; updates will fail.
- A *different* non-debug fingerprint → the keystore was replaced. Every existing
  install must be uninstalled once more.

Two consecutive releases showing the **same** fingerprint is the proof it is stable.

### Crossing over from an unsigned release

Anyone on v1.0.12 or earlier carries one of the random debug keys, so nothing can update
over it. They must uninstall Reeldeck once by hand and install v1.0.14 or later. This is
a one-time cost; updates apply normally afterwards. The in-app updater says so when the
installer is opened.
