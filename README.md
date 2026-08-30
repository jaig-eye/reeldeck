# Reeldeck — a clean, ad-free movie & TV browser

A single-page app that replicates what `1moviesgot.pages.dev` does — live search, browse,
filter, detail pages, cast, trailers, watchlist — **without the ad scripts and pop-unders**.

It is fully client-side (no build step, no server required). All data comes from the
**TMDB API v3**, which is exactly the backend the original site uses under the hood.

---

## Run it

**Option A — just open it**

Double-click `index.html`. It runs from `file://`. (TMDB allows browser requests, so it works.)

**Option B — serve it (recommended; required for PWA install)**

```bash
cd moviestream
npm run serve
```
Then open <http://localhost:5178>. This uses the bundled Node server with **correct MIME types** —
needed for the service worker / "Add to Home Screen" to work. (Avoid `python -m http.server` here:
on Windows it serves `.js` as `text/plain`, which silently disables the service worker.)

---

## Everything is configurable — "change the link and it picks up on everything"

Click the **gear icon → Settings**. Every request is built from these values, so if you
re-point the base URL or key, the whole app follows:

| Setting | What it does | Default |
|---|---|---|
| API base URL | Where all movie/TV data is fetched from | `https://api.themoviedb.org/3` |
| API key | TMDB key. A shared demo key is baked in so it works instantly. | *(demo key)* |
| Image CDN base | Where posters/backdrops load from | `https://image.tmdb.org/t/p` |
| Language / Region | TMDB `language` + `region` params | `en-US` / `US` |
| Accent color | Whole-app theme color | gold |
| Playback sources | The mirror/embed list (see below) | *14 mirrors, pre-filled* |

> **Get your own free TMDB key** (2 min): themoviedb.org → account → Settings → API →
> request a key → paste it into Settings. The demo key can be rate-limited or revoked, so
> use your own for anything real.

### The API surface it uses (all TMDB v3)
- Search: `/search/movie`, `/search/tv`, `/search/multi` (`?query=` — same idea as the site's `?q=`)
- Browse: `/discover/movie`, `/discover/tv` (sort, genres, year range, min rating, language)
- Details: `/movie/{id}`, `/tv/{id}` + `/credits`, `/videos`, `/similar`, `/images`, `/external_ids`
- Home rails: `/trending/all/day`, `/movie/popular`, `/tv/popular`, `/movie/top_rated`, `/movie/upcoming`
- TV episodes: `/tv/{id}/season/{n}`

---

## Playback (read this)

**This app hosts no video.** Exactly like the original site, the "Watch" button just loads a
third-party player URL inside an `<iframe>`, and the player screen is a **"Server room"** with a
list of mirrors you switch between. Those third-party providers are where the ads — and the
copyright/legal risk — actually live. That part is on whatever mirror you choose, not on this app.

The same **14 mirrors** the source site uses (VidSrcMe, VidKing, VidEasy, Cinemaos, VidSrc RU/SU,
MultiEmbed, Vsrc, VidLink, AutoEmbed, VidFast, 111Movies, Vidora, Smashy) ship pre-filled and are
fully **editable / removable** in **Settings → Playback sources**. No single mirror carries every
title — if one is black or errors, click another (exactly what the source's "switch mirrors" note
means). Note: many of these providers refuse to embed on unknown origins, so a given mirror may
render blank until the app is served from a domain they allow.

Each source is just a URL template. Placeholders:

- `{id}` — TMDB id
- `{imdb}` — IMDb id (auto-fetched)
- `{season}` / `{episode}` — TV only
- `{color}` — accent color (hex, no `#`)

Example shape (you supply the host):
```
Movie:  https://<provider-host>/embed/movie/{id}
TV:     https://<provider-host>/embed/tv/{id}/{season}/{episode}
```

### Ads, and the "Iframe Sandbox Detected" error

An iframe `sandbox` blocks pop-up/redirect ads — but most of these providers **detect the sandbox
and refuse to play**, showing **"Iframe Sandbox Detected."** The sandbox is their anti-adblock gate.
You can't have both a sandbox *and* playback without defeating their detection, which this app
doesn't do. So the model is inverted:

- **Sandbox is OFF by default** (that alone clears the "Iframe Sandbox Detected" error and lets video play).
- The ads are removed a better way: the **desktop app blocks ad/pop-under/tracker requests at the
  network layer** using a real ad-blocker filter list ([`@ghostery/adblocker-electron`](https://www.npmjs.com/package/@ghostery/adblocker-electron),
  EasyList/uBlock). The video stream loads from a non-ad host, so it's unaffected — the pop-unders
  and redirects just never load. The Electron shell also denies pop-up windows and blocks top-level redirects.
- **In a plain browser** (not the desktop app) there's no built-in network blocker, so install
  **uBlock Origin** for the same result. The `Force sandbox` toggle in the player exists for the rare
  provider that tolerates a sandbox, but leave it off for most.

Bottom line: **desktop app + sandbox off = video plays and the nonsense ads are gone.**

---

## Desktop app (Electron)

A desktop build is included — it's the same app, wrapped so it runs as its own
process/executable (which is what makes per-app VPN routing possible).

```bash
cd moviestream
npm install      # first time only
npm start        # launch the desktop app
```

Build a distributable Windows app:

```bash
npm run dist            # installer (.exe) + portable, in ./release
npm run dist:portable   # single portable .exe only
```

What the desktop shell adds over the browser version:
- **Network-layer ad blocking** (EasyList/uBlock via `@ghostery/adblocker-electron`) — pop-under/ad/tracker
  requests are dropped before they load, which is what actually removes the ads now that the iframe
  sandbox is off. Filter lists are cached to disk after first run.
- **Blocks in-app pop-up windows** and top-level redirects at the process level — belt-and-suspenders
  over the network blocker. Your explicit "Open" clicks still go to your real browser.
- Serves the app from a private `127.0.0.1` loopback origin (better embed compatibility than `file://`).
- Runs the renderer with `contextIsolation` on and Node integration off.

---

## Mobile, installing as an app & casting to a TV

### It's a PWA — install it on your phone (no store, no APK needed)

Serve it with **correct MIME types** first. The desktop app already does this; for the browser
version use **`npm run serve`** (a small Node server) — *not* Python's `http.server`, which serves
`.js` as `text/plain` on Windows and silently breaks the service worker / install. Then:

- **Android (Chrome):** open the URL → ⋮ menu → **Install app / Add to Home screen**. Launches
  fullscreen with its own icon, like a native app.
- **iPhone/iPad (Safari):** open the URL → Share → **Add to Home Screen**. Same standalone launch.
  (iOS only installs PWAs from Safari.)

The bottom tab bar, notch/safe-area insets, standalone display and app icon are all wired up.

### Casting / AirPlay / Chromecast — the honest version

The video plays inside the provider's **cross-origin `<iframe>`**, which this app doesn't own — so it
can't grab the stream URL to cast it directly (that would be stream-ripping). Two things that DO work:

1. **The provider's own cast/AirPlay button.** Several of these players (VidKing, VidEasy, …) have
   Chromecast/AirPlay built into their controls. The player iframe is now granted `picture-in-picture`,
   `fullscreen` and `airplay` permissions so those buttons function — just tap the player's own cast icon.
2. **OS screen mirroring** — universal, works for every mirror:
   - **iPhone/iPad → Apple TV:** Control Center → **Screen Mirroring**.
   - **Android → Chromecast / Android TV / Google TV:** Quick Settings → **Cast / Screen cast**.
   - **Desktop Chrome → any Cast device:** ⋮ → **Cast → Tab**.
   Tap **TV mode** in the player first — it fills the whole screen so the mirrored image is clean and full-bleed.

### Turning it into real installed apps (later)

- **Android APK — BUILT.** The project is wrapped with **Capacitor 6** (`capacitor.config.json`, `android/`).
  The web assets are bundled into the APK, so once installed the app runs off the phone's own internet — no
  PC, LAN, or tunnel. `android/app/src/main/java/.../MainActivity.java` adds a native WebView ad blocker
  (blocks pop-up windows and full-page redirect ads — the thing the plain browser can't stop).
  Rebuild anytime:
  ```bash
  npm run apk        # -> android/app/build/outputs/apk/debug/app-debug.apk
  ```
  Install on the phone: transfer the APK, tap it, allow **install unknown apps** for your browser/Files app.
  (Requires the Android SDK + JDK 17; already present on this machine.)
- **iPhone:** iOS does **not** run APKs (Android-only), and this kind of app won't pass App Store review.
  Options: the **PWA via Add to Home Screen** (works today, no signing), or a native build
  (Capacitor → Xcode) **sideloaded** with a free Apple ID via **AltStore/SideStore** (7-day resign) or a
  paid developer cert. The PWA is by far the least friction on iOS.

Surfshark's mobile apps also have split-tunneling, so you can route just the installed app (or
Safari/Chrome for the PWA) through the VPN.

---

## Routing only this app through Surfshark

There is **no "API key" that sends a single app through a VPN** — that isn't how consumer VPNs
work. But per-app routing is achievable. Options, easiest first:

1. **Surfshark "Bypasser" (split tunneling) — the recommended path, and why the Electron build exists.**
   The Surfshark Windows app can route the VPN by *application*. Steps:
   - `npm run dist` to produce `release/Reeldeck-1.0.0-x64.exe` (or use the portable build), and install/run it.
   - Surfshark app → **Settings → VPN Settings → Bypasser** → set it to *"Route the following apps through the VPN"*
     (inverse of the default "bypass" mode) → **Add app** → pick `Reeldeck.exe`.
   - Connect Surfshark. Now only Reeldeck's traffic is tunneled; the rest of your machine is untouched.
   - (Exact menu wording shifts between Surfshark versions; the feature is "Bypasser".)

2. **WireGuard config** — Surfshark can generate a manual WireGuard configuration (keys +
   `.conf`) from their dashboard. That's the closest thing to "a key for the app." You then bind
   the app (or a small local proxy the app talks to) to that tunnel. Advanced, OS-level.

3. **Whole-browser VPN** — as a plain web app, the player iframe is fetched by your *browser*, so
   turning Surfshark on for the machine/browser already covers it. Simplest, but not "app-only."

If you want true app-only routing, the clean path is: **package this as an Electron desktop app +
Surfshark Bypasser split tunneling.** I can set that up on request.

---

## Files
```
moviestream/
  index.html            # shell + PWA meta tags
  styles.css            # cinematic dark theme, mobile bottom-nav, TV mode (CSS vars)
  app.js                # router, TMDB client, all views, server-room player, settings
  manifest.webmanifest  # PWA manifest (installable app)
  sw.js                 # service worker (installability; app-shell cache only)
  assets/               # generated app icons (192/512/180)
  electron/
    main.js             # desktop wrapper: loopback server, ad-blocker, popup denial
    preload.js          # trusted "open external" bridge (top-frame only)
  scripts/
    serve.js            # correct-MIME static server for the browser/PWA build (`npm run serve`)
    make-icons.js       # regenerates the PNG icons (`npm run icons`)
  package.json          # electron + electron-builder + serve/icons scripts
  README.md
```
