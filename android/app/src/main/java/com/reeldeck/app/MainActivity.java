package com.reeldeck.app;

import android.app.UiModeManager;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

public class MainActivity extends BridgeActivity {

    /** Set once the web layer first talks to us; the only way to talk back. */
    private volatile JavaScriptReplyProxy replyProxy;
    /** True only while a player iframe is on screen — see nativeSetPlayer() in app.js. */
    private volatile boolean playerOpen;
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

        // On a TV, flag it to the web layer (via UA) so it can switch on the
        // 10-foot / D-pad experience. Set before the queued page load runs.
        UiModeManager uiMode = (UiModeManager) getSystemService(UI_MODE_SERVICE);
        boolean isTv = uiMode != null
                && uiMode.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;
        if (isTv) {
            String ua = webView.getSettings().getUserAgentString();
            if (ua != null && !ua.contains("ReeldeckTV")) {
                webView.getSettings().setUserAgentString(ua + " ReeldeckTV");
            }
        }

        if (isTv) installPointerBridge(webView);

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
                    if (!inApp) {
                        // Swallow the redirect — do NOT navigate away and do NOT open a browser.
                        return true;
                    }
                }
                return super.shouldOverrideUrlLoading(view, request);
            }
        });
    }

    /**
     * A D-pad-driven pointer for the video players.
     *
     * The mirrors are cross-origin iframes and their play/pause controls are plain
     * <div>s with click handlers — not focusable, so no amount of DOM focus will ever
     * land on one, and the web layer cannot script into the frame to click it. The one
     * thing that does reach inside is a real MotionEvent: the compositor hit-tests it
     * exactly like a finger and routes it to whichever frame is under the point. So the
     * web layer draws a cursor, moves it with the D-pad, and asks us to tap through it.
     *
     * Deliberately WebMessageListener rather than addJavascriptInterface: a JS interface
     * is injected into every frame, which would hand a synthetic-tap primitive to the
     * ad-laden third-party players we embed. This one is scoped to the app's own origin,
     * and we additionally refuse anything that is not the main frame. Where the feature
     * is unavailable (WebView < 88) the bridge is simply absent and the web layer says
     * pointer control is not supported rather than falling back to the unsafe API.
     */
    private void installPointerBridge(final WebView webView) {
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
                            // Asked for after we hand it the play/pause key: focus is
                            // in the embed by then, so a real Space reaches the
                            // player's own key handler.
                            if (data.equals("space")) {
                                sendKeyToWeb(KeyEvent.KEYCODE_SPACE);
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

    /**
     * The remote's dedicated media keys. WebView does not route these into page
     * content, so left alone they do nothing at all on the watch screen. We only
     * claim them while a player is up, and we do not act on them here: the web
     * layer has to move focus into the embed first, then asks us for the Space.
     */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        boolean isPlayPause = code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
                || code == KeyEvent.KEYCODE_MEDIA_PLAY
                || code == KeyEvent.KEYCODE_MEDIA_PAUSE;
        if (playerOpen && isPlayPause) {
            JavaScriptReplyProxy proxy = replyProxy;
            if (proxy != null && event.getAction() == KeyEvent.ACTION_DOWN) {
                try { proxy.postMessage("key:playpause"); }
                catch (RuntimeException e) { /* page went away */ }
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
