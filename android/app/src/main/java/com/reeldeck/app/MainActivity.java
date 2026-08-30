package com.reeldeck.app;

import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        final WebView webView = getBridge().getWebView();
        if (webView == null) return;

        // Block pop-up / new-window ads spawned from the player iframe.
        webView.getSettings().setSupportMultipleWindows(false);
        webView.getSettings().setJavaScriptCanOpenWindowsAutomatically(false);

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
}
