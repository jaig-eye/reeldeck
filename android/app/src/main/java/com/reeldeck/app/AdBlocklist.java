package com.reeldeck.app;

import android.content.Context;
import android.net.Uri;
import android.util.Log;
import android.webkit.WebResourceResponse;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Domain block-list for everything the WebView loads -- the player frames above all.
 *
 * The desktop build gets this from Ghostery; the TV and phone had nothing, and an
 * UNSANDBOXED mirror frame is free to pull every ad, pop-under and fingerprinting
 * script its network serves. Domain-level only: no cosmetic filtering, no path rules.
 *
 * The list is HaGeZi's Multi NORMAL in its "wildcard, domains only" form: one domain per
 * line, each one standing for itself AND all its subdomains, which is exactly what a
 * label walk wants (a.b.c.com -> b.c.com -> c.com) and keeps the file to ~175k entries
 * (~3.5 MB) where the expanded variants repeat every subdomain. Actively maintained
 * (rebuilt several times a day), covers ads + trackers + badware/malware in one list,
 * and is curated against breakage. LIGHT was the smaller option, but it is built only
 * from Top-1M domains, and the ad networks that serve piracy mirrors largely are not.
 *
 * Held as a SORTED long[] of 64-bit hashes, not a HashSet<String>: 175k strings plus
 * their hash nodes are ~20 MB of heap on a TV; the hashes are 1.4 MB, and a binary
 * search per label is as fast. A false positive needs a 64-bit collision -- with 175k
 * entries, odds near 1 in 10^14 per lookup, and the cost is one wrongly blocked load.
 *
 * Fails OPEN everywhere: no list yet, a bad download, a parse error, even an OOM, all
 * leave the previous table (or none) in place. Blocking nothing is the old behaviour;
 * crashing the app over an ad list is not acceptable.
 */
final class AdBlocklist {

    private AdBlocklist() {}

    // jsDelivr is the fallback for the same file: raw.githubusercontent.com rate-limits
    // and is blocked on some networks. Both are HTTPS; nothing here is ever fetched in clear.
    private static final String[] SOURCES = {
            "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/multi-onlydomains.txt",
            "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/multi-onlydomains.txt",
    };
    private static final String CACHE = "blocklist.txt";
    private static final long MAX_BYTES = 8L * 1024 * 1024;        // ~2x today's size
    private static final long MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000;
    // Below this it is an error page or a truncated file, not the list; above this the
    // list has changed shape and we would rather keep the old one than balloon the heap.
    private static final int MIN_ENTRIES = 1000;
    private static final int MAX_ENTRIES = 600000;

    /** Sorted, de-duplicated hashes; null = no list = block nothing. Replaced whole, never mutated. */
    private static volatile long[] table;
    private static final AtomicBoolean busy = new AtomicBoolean();
    private static volatile long lastCheck;

    /**
     * Load the cached list and refresh it when stale. Returns at once; all disk and
     * network work is on its own thread. Cheap to call on every resume: the whole pass
     * runs at most once an hour and only one refresh is ever in flight.
     */
    static void refreshAsync(Context ctx) {
        final File dir = ctx.getApplicationContext().getFilesDir();
        long now = System.currentTimeMillis();
        // Hourly with or WITHOUT a table: gated only on success, a list that never parses
        // (grown past the caps, a captive portal answering every fetch) was re-downloaded,
        // up to 8 MB a source, on every resume -- forever, on metered phone data.
        if (now - lastCheck < 60L * 60 * 1000) return;
        if (!busy.compareAndSet(false, true)) return;
        lastCheck = now;
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    File cache = new File(dir, CACHE);
                    boolean stale = !cache.isFile() || System.currentTimeMillis() - cache.lastModified() > MAX_AGE_MS;
                    if (table == null && cache.isFile()) {
                        // A fresh-dated cache that will not parse (damaged in place on a
                        // TV's cheap flash) is as good as none: replace it now, not once
                        // its mtime turns a week old, blocking nothing until then.
                        long[] t = null;
                        try { t = parse(cache); } catch (Exception e) { /* treated as unreadable */ }
                        if (t != null) table = t; else stale = true;
                    }
                    if (stale) download(dir, cache);
                } catch (Throwable e) {
                    // Fail open, including OutOfMemoryError: whatever table we had stays.
                } finally {
                    busy.set(false);
                }
            }
        }, "reeldeck-blocklist");
        t.setPriority(Thread.MIN_PRIORITY);   // never compete with playback for a TV's CPU
        t.setDaemon(true);
        t.start();
    }

    private static void download(File dir, File cache) {
        File tmp = new File(dir, CACHE + ".tmp");
        for (String src : SOURCES) {
            HttpURLConnection c = null;
            InputStream in = null;
            FileOutputStream out = null;
            try {
                c = (HttpURLConnection) new URL(src).openConnection();
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                c.connect();
                if (c.getResponseCode() != 200) continue;
                in = c.getInputStream();
                out = new FileOutputStream(tmp);
                byte[] buf = new byte[32768];
                long got = 0;
                int n;
                boolean tooBig = false;
                while ((n = in.read(buf)) > 0) {
                    got += n;
                    if (got > MAX_BYTES) { tooBig = true; break; }
                    out.write(buf, 0, n);
                }
                out.close(); out = null;
                if (tooBig) continue;
                // Parsed BEFORE it replaces the cache: a captive-portal page or a cut-off
                // transfer must not overwrite a good list from last week.
                long[] t = parse(tmp);
                if (t == null) continue;
                if (!tmp.renameTo(cache)) {
                    cache.delete();
                    if (!tmp.renameTo(cache)) continue;
                }
                table = t;
                return;
            } catch (Throwable e) {
                // try the next source
            } finally {
                try { if (out != null) out.close(); } catch (Exception ignored) {}
                try { if (in != null) in.close(); } catch (Exception ignored) {}
                if (c != null) c.disconnect();
                tmp.delete();
            }
        }
        // Every source failed. Touch nothing: a stale list still beats none, and the next
        // launch (or the hourly re-check on resume) tries again.
    }

    /** One domain per line, '#' comments. Also tolerates hosts-file lines ("0.0.0.0 x.com"). */
    private static long[] parse(File f) throws Exception {
        BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(f), "UTF-8"), 65536);
        try {
            long[] out = new long[200000];
            int count = 0;
            String line;
            while ((line = r.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty() || line.charAt(0) == '#' || line.charAt(0) == '!') continue;
                int sp = line.lastIndexOf(' ');
                if (sp >= 0) line = line.substring(sp + 1);
                line = line.toLowerCase(Locale.ROOT);
                // A bare TLD ("com") or a malformed line would block far more than any
                // list means to; only accept something with at least one dot in it.
                if (!isDomain(line)) continue;
                if (count == out.length) {
                    if (count >= MAX_ENTRIES) return null;
                    out = Arrays.copyOf(out, Math.min(count * 2, MAX_ENTRIES));
                }
                out[count++] = hash(line, 0);
            }
            if (count < MIN_ENTRIES) return null;
            Arrays.sort(out, 0, count);
            int w = 1;
            for (int i = 1; i < count; i++) if (out[i] != out[w - 1]) out[w++] = out[i];
            return Arrays.copyOf(out, w);
        } finally {
            r.close();
        }
    }

    private static boolean isDomain(String s) {
        int n = s.length();
        if (n < 3 || n > 253 || s.charAt(0) == '.' || s.charAt(n - 1) == '.') return false;
        boolean dot = false;
        for (int i = 0; i < n; i++) {
            char ch = s.charAt(i);
            if (ch == '.') dot = true;
            else if (!((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '-' || ch == '_')) return false;
        }
        return dot;
    }

    /** FNV-1a over host[from..], then a splitmix64 finalizer so similar names spread out. */
    private static long hash(String s, int from) {
        long h = 0xcbf29ce484222325L;
        for (int i = from, n = s.length(); i < n; i++) {
            h ^= s.charAt(i);
            h *= 0x100000001b3L;
        }
        h ^= h >>> 33; h *= 0xff51afd7ed558ccdL;
        h ^= h >>> 33; h *= 0xc4ceb9fe1a85ec53L;
        h ^= h >>> 33;
        return h;
    }

    /**
     * True when this request should be refused. Runs for EVERY request the WebView
     * makes, on a WebView worker thread: no allocation beyond one lower-cased host,
     * no locks, no I/O.
     */
    static boolean isBlocked(Uri uri) {
        long[] t = table;
        if (t == null || uri == null) return false;
        String scheme = uri.getScheme();
        if (scheme == null) return false;
        if (!(scheme.equals("https") || scheme.equals("http") || scheme.equals("wss") || scheme.equals("ws"))) return false;
        String host = uri.getHost();
        if (host == null || host.isEmpty()) return false;
        host = host.toLowerCase(Locale.ROOT);
        if (host.endsWith(".")) host = host.substring(0, host.length() - 1);
        // IP literals: the list is names only, and a numeric "suffix" means nothing.
        if (host.indexOf(':') >= 0 || isNumericHost(host)) return false;
        if (neverBlock(host)) return false;
        Set<String> ex = exempt;
        if (!ex.isEmpty()) {
            int j = 0;
            while (true) {
                if (ex.contains(host.substring(j))) return false;
                int dot = host.indexOf('.', j);
                if (dot < 0) break;
                j = dot + 1;
            }
        }
        // a.b.c.com, b.c.com, c.com -- never the bare "com" (the loop needs a dot left).
        int i = 0;
        while (true) {
            int dot = host.indexOf('.', i);
            if (dot < 0) return false;
            if (Arrays.binarySearch(t, hash(host, i)) >= 0) { noteBlocked(host); return true; }
            i = dot + 1;
        }
    }

    // Each blocked host logged ONCE (adb logcat -s ReeldeckBlock). The list is pulled in by
    // the weekly refresh, not by a release, and nothing checks it against the mirror table:
    // a mirror -- or the player host it redirects to -- landing on it shows up only as a
    // blank frame on Android. This is how that gets told apart from a dead mirror. Capped,
    // so an ad-heavy page cannot grow the set without bound.
    private static final Set<String> logged =
            Collections.newSetFromMap(new ConcurrentHashMap<String, Boolean>());

    private static void noteBlocked(String host) {
        if (logged.size() < 512 && logged.add(host)) Log.i("ReeldeckBlock", host);
    }

    private static boolean isNumericHost(String h) {
        for (int i = 0; i < h.length(); i++) {
            char ch = h.charAt(i);
            if (ch != '.' && (ch < '0' || ch > '9')) return false;
        }
        return true;
    }

    /**
     * What the app itself depends on. Checked BEFORE the list, so no upstream list
     * change can take these down -- the list does carry entries under some of them
     * (collector.github.com, copilot-telemetry.githubusercontent.com, assorted
     * *.workers.dev), and one bad entry must not break updates, sync or trailers.
     */
    private static boolean neverBlock(String h) {
        return h.equals("localhost")                          // Capacitor serves the app here
                || under(h, "themoviedb.org") || under(h, "tmdb.org")   // API + image.tmdb.org
                || h.equals("reeldeck.disisbo.workers.dev")   // SYNC_URL in app.js -- exact, not all of workers.dev
                || under(h, "github.com") || under(h, "githubusercontent.com")   // updater + release checks
                || under(h, "youtube-nocookie.com") || under(h, "ytimg.com") || under(h, "googlevideo.com")   // trailers
                || h.equals("tinyurl.com") || h.equals("spoo.me");   // the share-link shorteners app.js calls
    }

    /**
     * The SITES of the app's own configured servers (on shared hosting, the host itself), sent by app.js over the bridge
     * ("exempt:host,host"). A server -- or the numbered host its site redirects to on
     * first load -- must never be the thing the list blanks out. Replaced whole on every
     * message; only our own page can reach the bridge.
     */
    private static volatile Set<String> exempt = Collections.<String>emptySet();

    static void setExempt(String csv) {
        Set<String> out = new HashSet<String>();
        if (csv != null) {
            for (String raw : csv.split(",")) {
                String h = raw.trim().toLowerCase(Locale.ROOT);
                if (h.endsWith(".")) h = h.substring(0, h.length() - 1);
                if (h.isEmpty() || h.length() > 253 || !h.matches("[a-z0-9.-]+") || isNumericHost(h)) continue;
                String site = siteOf(h);
                // On shared hosting the server's own name is as wide as the exemption may
                // go (its owner's sibling hosts are someone else's); the bare shared domain
                // itself is never exempted.
                if (site == null) continue;
                if (!neverExempt(site)) out.add(site);
                else if (!h.equals(site)) out.add(h);
                if (out.size() >= 64) break;
            }
        }
        exempt = Collections.unmodifiableSet(out);
    }

    /** example.com from a.b.example.com; a short second level under a two-letter TLD
     *  (example.co.uk) keeps three labels. An approximation, not the Public Suffix List. */
    private static String siteOf(String h) {
        String[] p = h.split("\\.");
        if (p.length < 2) return null;
        int keep = (p.length >= 3 && p[p.length - 1].length() == 2 && p[p.length - 2].length() <= 3) ? 3 : 2;
        StringBuilder b = new StringBuilder();
        for (int k = p.length - keep; k < p.length; k++) { if (b.length() > 0) b.append('.'); b.append(p[k]); }
        return b.toString();
    }

    /** Shared hosting where one site is many owners: exempting the whole of it would
     *  exempt every ad on it too. siteOf() is not the Public Suffix List, so these are the
     *  shared domains a mirror or CDN is likely to sit on, listed by hand. */
    private static boolean neverExempt(String site) {
        return site.equals("workers.dev") || site.equals("pages.dev") || site.equals("github.io")
                || site.equals("netlify.app") || site.equals("vercel.app") || site.equals("herokuapp.com")
                || site.equals("blogspot.com") || site.equals("appspot.com") || site.equals("web.app")
                || site.equals("firebaseapp.com") || site.equals("cloudfront.net") || site.equals("azurewebsites.net")
                || site.equals("b-cdn.net") || site.equals("r2.dev") || site.equals("amazonaws.com")
                || site.equals("cloudflarestorage.com") || site.equals("onrender.com") || site.equals("fly.dev")
                || site.equals("surge.sh") || site.equals("glitch.me") || site.equals("repl.co")
                || site.equals("ngrok-free.app");
    }

    private static boolean under(String h, String d) {
        return h.equals(d) || (h.length() > d.length() && h.endsWith(d) && h.charAt(h.length() - d.length() - 1) == '.');
    }

    /**
     * A refusal the page sees as a failed load. 403 with an empty body rather than a
     * thrown error or null: null means "load it from the network" to the WebView.
     * A fresh stream every time -- a WebResourceResponse is consumed when read.
     */
    static WebResourceResponse blockedResponse() {
        return new WebResourceResponse("text/plain", "utf-8", 403, "Blocked",
                Collections.<String, String>emptyMap(), new ByteArrayInputStream(new byte[0]));
    }
}
