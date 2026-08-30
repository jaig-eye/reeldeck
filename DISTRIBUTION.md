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

---

## Removing the warnings entirely (optional, costs money)

- **macOS:** Apple **Developer Program ($99/yr)** → sign with a Developer ID + **notarize** (`notarytool`).
  This removes the Gatekeeper prompt completely.
- **Windows:** a **code-signing certificate** (OV ≈ low-hundreds/yr, EV more). Note even a freshly
  OV-signed app can still trip SmartScreen until it builds download "reputation"; EV clears it immediately.

For sharing with friends/a small group, the free unsigned builds + the steps above are the normal path.
