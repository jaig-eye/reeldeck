package com.reeldeck.app;

import android.app.UiModeManager;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;

import androidx.core.content.FileProvider;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

public class MainActivity extends BridgeActivity {

    /** Set once the web layer first talks to us; the only way to talk back. */
    private volatile JavaScriptReplyProxy replyProxy;
    /** True only while a player iframe is on screen — see nativeSetPlayer() in app.js. */
    private volatile boolean playerOpen;
    private volatile boolean downloading;
    /** Media keys are a REMOTE affordance; on a phone they belong to whatever the
     *  user was actually listening to, so we never take them there. */
    private volatile boolean isTelevision;
    private WebView bridgeWebView;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        final WebView webView = getBridge().getWebView();
        if (webView == null) return;
        bridgeWebView = webView;

        // Block pop-up / new-window ads spawned from the player iframe.
        webView.getSettings().setSupportMultipleWindows(false);
        webView.getSettings().setJavaScriptCanOpenWindowsAutomatically(false);

        // Hardware volume keys should move MEDIA volume, not the ringer — the app is
        // a video player and there is nothing else on a TV for them to mean.
        setVolumeControlStream(AudioManager.STREAM_MUSIC);

        // On a TV, flag it to the web layer (via UA) so it can switch on the
        // 10-foot / D-pad experience. Set before the queued page load runs.
        UiModeManager uiMode = (UiModeManager) getSystemService(UI_MODE_SERVICE);
        boolean isTv = uiMode != null
                && uiMode.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;
        isTelevision = isTv;
        if (isTv) {
            String ua = webView.getSettings().getUserAgentString();
            if (ua != null && !ua.contains("ReeldeckTV")) {
                webView.getSettings().setUserAgentString(ua + " ReeldeckTV");
            }
        }

        // Installed on EVERY Android build, not just TV: the pointer is only one of the
        // things that rides this channel, and self-updating matters just as much on a
        // phone. The web layer decides what to use.
        installNativeBridge(webView);

        // Block the other ad vector: a framed player trying to navigate the WHOLE
        // app (top frame) to an ad URL. Allow the iframe's own sub-frame loads
        // (its player + stream), and keep Capacitor's normal handling otherwise.
        webView.setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request.isForMainFrame()) {
                    String url = request.getUrl().toString();
                    boolean inApp = url.startsWith("https://localhost")
                            || url.startsWith("http://localhost")
                            || url.startsWith("capacitor://");
                    if (!inApp && !isOwnOutboundLink(request.getUrl())) {
                        // Swallow the redirect — do NOT navigate away and do NOT open a browser.
                        return true;
                    }
                }
                return super.shouldOverrideUrlLoading(view, request);
            }
        });
    }

    /**
     * The app's OWN outbound links, which must reach the system browser.
     *
     * Four hosts: the Releases page, the TMDB attribution the API terms require, and
     * the two Google endpoints the sign-in flow hands to the browser.
     *
     * Returning true for every off-origin main-frame load also swallowed the two links
     * the app itself offers: the Releases page, and the TMDB attribution in the footer
     * that TMDB's API terms require to work. WebView retargets window.open(_blank) and
     * target="_blank" into main-frame navigations, so both landed here and died
     * silently. Falling through to super hands them to Capacitor's launchIntent.
     *
     * Matched on HOST and https only, so a player redirect cannot dress itself up as
     * one of ours with a lookalike path.
     */
    private static boolean isOwnOutboundLink(Uri uri) {
        if (uri == null || !"https".equals(uri.getScheme())) return false;
        String host = uri.getHost();
        if (host == null) return false;
        host = host.toLowerCase(Locale.ROOT);
        return host.equals("github.com") || host.endsWith(".github.com")
                || host.equals("themoviedb.org") || host.endsWith(".themoviedb.org")
                // Google sign-in. The app opens https://www.google.com/device?user_code=...
                // in the system browser; without these two hosts that navigation is
                // swallowed here and the Sign in button appears to do nothing at all.
                // EXACT hosts, not a .google.com suffix: the suffix would also admit
                // every Google-hosted redirector and ad domain, and a mirror redirect
                // only has to reach one of those to escape this check.
                || host.equals("www.google.com") || host.equals("accounts.google.com");
    }

    /**
     * The app's one channel to the web layer.
     *
     * The headline user of it is a D-pad-driven pointer for the video players. The
     * mirrors are cross-origin iframes and their play/pause controls are plain <div>s
     * with click handlers — not focusable, so no amount of DOM focus will ever land on
     * one, and the web layer cannot script into the frame to click it. The one thing
     * that does reach inside is a real MotionEvent: the compositor hit-tests it exactly
     * like a finger and routes it to whichever frame is under the point. So the web
     * layer draws a cursor, moves it with the D-pad, and asks us to tap through it.
     *
     * Deliberately WebMessageListener rather than addJavascriptInterface: a JS interface
     * is injected into every frame, which would hand a synthetic-tap primitive to the
     * ad-laden third-party players we embed. This one is scoped to the app's own origin,
     * and we additionally refuse anything that is not the main frame. Where the feature
     * is unavailable (WebView < 88) the bridge is simply absent and the web layer says
     * pointer control is not supported rather than falling back to the unsafe API.
     */
    private void installNativeBridge(final WebView webView) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;

        // Capacitor serves the app from https://localhost (androidScheme in
        // capacitor.config.json). Both forms are listed so a scheme change does not
        // silently leave the bridge uninjected.
        final Set<String> allowedOrigins = new HashSet<String>(
                Arrays.asList("https://localhost", "http://localhost"));

        try {
            WebViewCompat.addWebMessageListener(webView, "ReeldeckNative", allowedOrigins,
                    new WebViewCompat.WebMessageListener() {
                        @Override
                        public void onPostMessage(WebView view, WebMessageCompat message,
                                                  Uri sourceOrigin, boolean isMainFrame,
                                                  JavaScriptReplyProxy replyProxy) {
                            if (!isMainFrame || message == null) return;
                            // getData() throws if the payload is not a string on
                            // WebView builds without the payload-type feature.
                            String data;
                            try {
                                data = message.getData();
                            } catch (RuntimeException e) {
                                return;
                            }
                            if (data == null) return;

                            MainActivity.this.replyProxy = replyProxy;

                            // The web layer tells us when a player is actually on
                            // screen. Without it we would have to guess, and claiming
                            // the remote's media keys on the wrong screen makes them
                            // look broken.
                            if (data.startsWith("player:")) {
                                playerOpen = data.endsWith("1");
                                return;
                            }
                            // Asked for after we hand it a media key: focus is in the
                            // embed by then, so a real key press reaches the player's
                            // own handler.
                            if (data.equals("space")) { sendKeyToWeb(KeyEvent.KEYCODE_SPACE); return; }
                            if (data.equals("left"))  { sendKeyToWeb(KeyEvent.KEYCODE_DPAD_LEFT); return; }
                            if (data.equals("right")) { sendKeyToWeb(KeyEvent.KEYCODE_DPAD_RIGHT); return; }

                            // Volume is the one player control we can work the whole
                            // way ourselves — it is the device's, not the embed's.
                            if (data.startsWith("vol:")) { adjustVolume(data.substring(4)); return; }

                            if (data.startsWith("update:")) {
                                downloadAndInstall(data.substring(7));
                                return;
                            }

                            if (!data.startsWith("tap:")) return;

                            // Normalised 0..1, deliberately: the page thinks in CSS
                            // pixels and the view in physical ones, and the ratio
                            // between them is only devicePixelRatio while the page
                            // sits at scale 1. A fraction of the view needs no such
                            // assumption and cannot drift.
                            final float[] p = parsePoint(data.substring(4));
                            if (p == null) return;

                            final JavaScriptReplyProxy proxy = replyProxy;
                            webView.post(new Runnable() {
                                @Override
                                public void run() {
                                    dispatchTap(webView, p[0], p[1]);
                                    // Ack only AFTER dispatch. A tap landing inside the
                                    // embed pulls DOM focus in with it, and the web
                                    // layer has to take it back or the D-pad goes dead;
                                    // acking any earlier would race that focus change.
                                    try { proxy.postMessage("tapped"); }
                                    catch (RuntimeException e) { /* page went away */ }
                                }
                            });
                        }
                    });
        } catch (RuntimeException e) {
            // Feature reported as supported but unavailable on this WebView build —
            // leave the bridge absent; the web layer degrades on its own.
        }
    }

    /** Send one line back to the web layer. Safe to call from any thread. */
    private void toWeb(final String msg) {
        final WebView wv = bridgeWebView;
        if (wv == null) return;
        wv.post(new Runnable() {
            @Override
            public void run() {
                JavaScriptReplyProxy p = replyProxy;
                if (p == null) return;
                try { p.postMessage(msg); } catch (RuntimeException e) { /* page went away */ }
            }
        });
    }

    /**
     * The remote's dedicated media keys. WebView does not route these into page
     * content, so left alone they do nothing at all on the watch screen. We only
     * claim them while a player is up, and we do not act on them here: the web
     * layer has to move focus into the embed first, then asks us for the key.
     */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        boolean isPlayPause = code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
                || code == KeyEvent.KEYCODE_MEDIA_PLAY
                || code == KeyEvent.KEYCODE_MEDIA_PAUSE;
        boolean isSeek = code == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD
                || code == KeyEvent.KEYCODE_MEDIA_REWIND;
        if (isTelevision && playerOpen && (isPlayPause || isSeek)) {
            if (event.getAction() == KeyEvent.ACTION_DOWN) {
                toWeb(isPlayPause ? "key:playpause"
                        : (code == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD ? "key:forward" : "key:rewind"));
            }
            return true;   // consume DOWN and UP together, or the pair splits
        }
        return super.dispatchKeyEvent(event);
    }

    private void sendKeyToWeb(int keyCode) {
        WebView wv = bridgeWebView;
        if (wv == null) return;
        long t = SystemClock.uptimeMillis();
        wv.dispatchKeyEvent(new KeyEvent(t, t, KeyEvent.ACTION_DOWN, keyCode, 0));
        wv.dispatchKeyEvent(new KeyEvent(t, t + 40, KeyEvent.ACTION_UP, keyCode, 0));
        // Delivered. The web layer has to take focus back off the embed now, or the
        // cross-origin frame keeps the remote and the D-pad is gone until Back.
        toWeb("keysent");
    }

    private void adjustVolume(String what) {
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return;
        int dir;
        if ("up".equals(what)) dir = AudioManager.ADJUST_RAISE;
        else if ("down".equals(what)) dir = AudioManager.ADJUST_LOWER;
        else if ("mute".equals(what)) dir = AudioManager.ADJUST_TOGGLE_MUTE;
        else return;
        try {
            am.adjustStreamVolume(AudioManager.STREAM_MUSIC, dir, AudioManager.FLAG_SHOW_UI);
        } catch (SecurityException e) {
            return;   // some TV builds refuse ADJUST_TOGGLE_MUTE
        }
        int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        int cur = am.getStreamVolume(AudioManager.STREAM_MUSIC);
        toWeb("vol:" + (max > 0 ? (cur * 100 / max) : 0));
    }

    /**
     * Fetch a release APK and hand it to the package installer.
     *
     * A TV has no browser to fall back on and no file manager to find a download in,
     * so "go to the website and sideload it" is not an instruction anyone can follow
     * with a remote. Progress goes back to the web layer because a silent 7 MB
     * download on a slow connection is indistinguishable from a hang.
     */
    private void downloadAndInstall(final String url) {
        if (downloading) return;
        if (url == null || !url.startsWith("https://")) { toWeb("upd:err:Bad update URL."); return; }
        // On O+ the install intent is refused outright unless the user has granted
        // this app the right to install. Ask FIRST — failing after the download
        // wastes it and explains nothing.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getPackageManager().canRequestPackageInstalls()) {
            toWeb("upd:err:Allow Reeldeck to install apps, then press Update again.");
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName())));
            } catch (RuntimeException e) { /* no such settings screen on this build */ }
            return;
        }
        downloading = true;
        new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection c = null;
                InputStream in = null;
                FileOutputStream out = null;
                File apk = new File(getCacheDir(), "update.apk");
                boolean handedOver = false;   // true once the installer has the file
                try {
                    // A stale part-file from an interrupted attempt must never be
                    // handed to the installer as if it were this release.
                    if (apk.exists() && !apk.delete()) throw new Exception("Could not clear the previous download.");

                    // Redirects by hand. HttpURLConnection follows them automatically
                    // ONLY within the same protocol, and the release URL hops
                    // github.com -> release-assets.githubusercontent.com; the moment
                    // one of those hops changes scheme the automatic path stops and
                    // hands back a redirect BODY, which would be written out as a
                    // few hundred bytes of HTML named update.apk.
                    String at = url;
                    for (int hop = 0; ; hop++) {
                        if (hop > 5) throw new Exception("Too many redirects.");
                        c = (HttpURLConnection) new URL(at).openConnection();
                        c.setInstanceFollowRedirects(false);
                        c.setConnectTimeout(20000);
                        c.setReadTimeout(30000);
                        c.setRequestProperty("Accept", "*/*");
                        c.connect();
                        int code = c.getResponseCode();
                        if (code / 100 == 3) {
                            String next = c.getHeaderField("Location");
                            if (next == null) throw new Exception("Redirect with no destination.");
                            at = new URL(new URL(at), next).toString();     // may be relative
                            if (!at.startsWith("https://")) throw new Exception("Refusing a non-HTTPS redirect.");
                            c.disconnect(); c = null;
                            continue;
                        }
                        if (code / 100 != 2) throw new Exception("HTTP " + code);
                        break;
                    }

                    long total = -1;
                    try { total = Long.parseLong(c.getHeaderField("Content-Length")); } catch (Exception ignored) {}

                    in = c.getInputStream();
                    out = new FileOutputStream(apk);
                    byte[] buf = new byte[65536];
                    long got = 0;
                    int last = -1, n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        got += n;
                        if (total > 0) {
                            int pct = (int) (got * 100 / total);
                            // Only on change: a message per 64 KB chunk would be
                            // hundreds of pointless hops across the bridge.
                            if (pct != last) { last = pct; toWeb("upd:" + pct); }
                        }
                    }
                    out.flush();
                    out.getFD().sync();          // on disk before the installer reads it
                    out.close(); out = null;

                    // A truncated APK does not fail loudly -- the installer reports
                    // "package appears to be invalid", which reads like a bad build.
                    // Catch it here, where we can say what actually happened.
                    if (total > 0 && got != total) {
                        throw new Exception("Download incomplete (" + got + " of " + total + " bytes).");
                    }
                    if (got < 100000) throw new Exception("Downloaded file is too small to be the app.");

                    install(apk);
                    handedOver = true;
                } catch (Exception e) {
                    String m = e.getMessage();
                    toWeb("upd:err:" + (m == null ? "Download failed." : m));
                } finally {
                    downloading = false;
                    // Close BEFORE deleting: a delete with the stream still open fails
                    // silently on some filesystems and leaves the part-file behind for
                    // the next attempt to trip over.
                    try { if (out != null) out.close(); } catch (Exception ignored) {}
                    try { if (in != null) in.close(); } catch (Exception ignored) {}
                    if (c != null) c.disconnect();
                    if (!handedOver) { try { apk.delete(); } catch (Exception ignored) {} }
                }
            }
        }).start();
    }

    private void install(File apk) {
        // minSdkVersion is 22, but the pre-Nougat package installer only accepts
        // file:// URIs for ACTION_VIEW, and this APK sits in app-private cache which a
        // file:// URI cannot expose. Rather than launch an installer that is certain to
        // fail, send the user somewhere that works.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            toWeb("upd:err:This Android version cannot install updates in-app \u2014 "
                    + "download the APK from the Releases page instead.");
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apk);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
            toWeb("upd:done");
        } catch (RuntimeException e) {
            toWeb("upd:err:Could not start the installer.");
        }
    }

    /** Parses "x,y" as two fractions of the view, each 0..1. */
    private static float[] parsePoint(String csv) {
        int comma = csv.indexOf(',');
        if (comma <= 0) return null;
        try {
            float x = Float.parseFloat(csv.substring(0, comma));
            float y = Float.parseFloat(csv.substring(comma + 1));
            if (Float.isNaN(x) || Float.isNaN(y)) return null;
            if (x < 0 || x > 1 || y < 0 || y > 1) return null;
            return new float[]{x, y};
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static void dispatchTap(WebView webView, float fx, float fy) {
        int w = webView.getWidth(), h = webView.getHeight();
        if (w <= 0 || h <= 0) return;
        // Clamp inside the view so a bad coordinate can never be dispatched elsewhere.
        float cx = Math.max(0, Math.min(fx * w, w - 1));
        float cy = Math.max(0, Math.min(fy * h, h - 1));

        long down = SystemClock.uptimeMillis();
        MotionEvent d = MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, cx, cy, 0);
        d.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        webView.dispatchTouchEvent(d);
        d.recycle();

        MotionEvent u = MotionEvent.obtain(down, down + 90, MotionEvent.ACTION_UP, cx, cy, 0);
        u.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        webView.dispatchTouchEvent(u);
        u.recycle();
    }
}
