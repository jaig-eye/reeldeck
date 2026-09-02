/* ============================================================================
   Reeldeck sync — Cloudflare Worker in front of Upstash Redis
   ----------------------------------------------------------------------------
   WHY THIS EXISTS AT ALL: two secrets must never reach a browser. The Upstash
   token can read, rewrite and wipe the whole database. The Google client secret
   is MANDATORY on the device-flow token exchange (Google's discovery document
   offers only client_secret_post / client_secret_basic — there is no "none").
   app.js ships to every device and anyone can open DevTools, so both live here,
   the browser only ever talks to this Worker, and the Worker decides what a
   caller is allowed to touch.

   PASTE THIS into the Cloudflare dashboard editor (Workers & Pages -> your
   Worker -> Edit code). It has no imports and no build step.

   FIVE secrets, set under Settings -> Variables and Secrets, all as type
   "Secret" (encrypted) — never as plaintext variables:
       UPSTASH_REDIS_REST_URL     https://xxx-12345.upstash.io
       UPSTASH_REDIS_REST_TOKEN   AY...
       GOOGLE_CLIENT_ID           xxx.apps.googleusercontent.com
       GOOGLE_CLIENT_SECRET       GOCSPX-...
       UID_PEPPER                 32 random bytes, base64  <-- BACK THIS UP FIRST

   ABOUT UID_PEPPER, because getting this wrong is unrecoverable: it is the HMAC
   key that turns a Google account id into a Reeldeck uid. Cloudflare secrets are
   write-only once saved, so if it is lost it cannot be read back, and every
   account derived from it becomes unreachable. Never rotate it — rotating is
   arithmetically identical to deleting every account at once.

   THE IDENTITY MODEL, stated plainly so it is not mistaken for more than it is:
   a "user" is an opaque id the app holds. That id IS the credential — whoever
   holds it can read and write that account's data. There are no passwords, which
   is deliberate: it means a TV never has to type one. An id arrives one of two
   ways, and downstream nothing can tell them apart, which is correct because
   they must be treated identically:
     - anonymous : the app generates 192 random bits locally
     - Google    : HMAC(pepper, "reeldeck:uid:v1:google:<sub>:0")

   WHY THE HMAC IS KEYED AND NOT A PLAIN HASH. Google's discovery document
   reports subject_types_supported: ["public"], meaning the sub is byte-for-byte
   identical in every app the user has ever signed into. Under a public
   SHA-256(sub), anyone who runs any website with a Google button could compute
   Reeldeck uids offline, in bulk, for every one of their visitors, and then read
   or wipe those people's history. The pepper is not hardening. It is the whole
   difference between an account system and a public database.

   Endpoints (all POST, all JSON):
     /v1/pull              { uid }             -> { data, at }
     /v1/push              { uid, data }       -> { ok, at }
     /v1/pair/start        { }                 -> { code, expires }   (the TV)
     /v1/pair/claim        { code, uid }       -> { ok }              (the phone)
     /v1/pair/poll         { code }            -> { uid } | { pending }
     /v1/auth/google/start { }                 -> { session, user_code, qr_url, ... }
     /v1/auth/google/poll  { session }         -> { status, uid?, name?, picture? }
   ========================================================================== */

const CORS = {
  // The app runs from https://localhost (Capacitor), a loopback port (Electron),
  // and whatever host the PWA is served from. No cookies are used and the uid
  // travels in the body, so there is nothing for a browser origin check to
  // protect here — the id itself is the credential, and the attack against this
  // Worker is a script, not a browser. Restricting origins would break three of
  // the four targets and stop nothing.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const PAIR_TTL = 300;                  // 5 minutes
const AUTH_TTL = 1800;                 // Google device codes last ~30 min
const DATA_TTL = 60 * 60 * 24 * 400;   // touched at least yearly or it lapses
const MAX_BODY = 512 * 1024;           // a watch history is kilobytes

function json(obj, status = 200) {
  // `now` rides on EVERY response, including errors. It is the only trusted clock in
  // the system: a client cannot tell its own stalled clock from another device's fast
  // one, because both look like "the account is far ahead of me". With server time
  // available before the first merge, neither case can arise -- a device corrects
  // itself on its very first call and never writes a poisoned stamp at all.
  return new Response(JSON.stringify(Object.assign({ now: Date.now() }, obj)), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

/* ---------------------------------------------------------------------------
   Throttle. Per-isolate and therefore leaky — Cloudflare may run many isolates
   and this Map is not shared between them. It is still worth having: it costs
   nothing, adds no subrequest, and stops the single-script flood that is very
   nearly all of what actually reaches a public URL. The endpoints that spend a
   finite external resource (Google device-code quota, a Redis write from an
   unauthenticated caller) get the hard limit; reads get the loose one.
   --------------------------------------------------------------------------- */
const HITS = new Map();
function throttle(request, bucket, limit) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  // Bucketed per endpoint CLASS, not per IP alone. A single counter would let
  // ordinary polling — which legitimately runs at 60/min during a sign-in — eat the
  // budget of the limit-5 endpoints, so the fifth request of any kind would make
  // "Sign in" fail with a 429 for the next minute. The expensive-resource limit has
  // to be spent only by the expensive resource.
  const key = ip + '|' + bucket;
  const now = Date.now();
  if (HITS.size > 10000) HITS.clear();     // crude, bounded, self-healing
  let e = HITS.get(key);
  if (!e || now > e.resetAt) { e = { n: 0, resetAt: now + 60000 }; HITS.set(key, e); }
  return ++e.n <= limit;
}

/** One Upstash REST call. Commands are sent as a JSON array: ["SET","k","v","EX",60]. */
async function redis(env, ...cmd) {
  const res = await fetch(env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error('upstash ' + res.status);
  const body = await res.json();
  if (body.error) throw new Error(body.error);
  return body.result;
}

/** Ids are opaque and go straight into a key name, so they are validated, not trusted. */
const isUid = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(v);
const isCode = (v) => typeof v === 'string' && /^[A-Z0-9]{6}$/.test(v);
const isSession = (v) => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v);

/** Ambiguous glyphs left out on purpose: this gets read off a TV and typed on a phone. */
function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I, O, 0, 1
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* Imported once per isolate, not once per request — importKey is not free. */
let _pepperKey = null;
async function pepperKey(env) {
  if (_pepperKey) return _pepperKey;
  const raw = Uint8Array.from(atob(env.UID_PEPPER), (c) => c.charCodeAt(0));
  if (raw.length < 32) throw new Error('UID_PEPPER too short');
  _pepperKey = await crypto.subtle.importKey(
    'raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return _pepperKey;
}

async function deriveUid(env, sub) {
  // The trailing ":0" is a per-user epoch, baked in NOW as a literal so that
  // adding a real "sign out everywhere" later is a matter of bumping a number
  // rather than a migration that invalidates every uid in existence.
  const msg = 'reeldeck:uid:v1:google:' + sub + ':0';
  const mac = await crypto.subtle.sign(
    'HMAC', await pepperKey(env), new TextEncoder().encode(msg)
  );
  return b64url(mac);      // 43 chars of [A-Za-z0-9_-]; passes isUid unchanged
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

    if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
      return json({ error: 'Worker is missing its Upstash secrets' }, 500);
    }

    const path = new URL(request.url).pathname.replace(/\/+$/, '');
    let body;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY) return json({ error: 'too large' }, 413);
      body = text ? JSON.parse(text) : {};
    } catch (e) {
      return json({ error: 'bad JSON' }, 400);
    }

    try {
      // ---- sync -----------------------------------------------------------
      if (path === '/v1/pull') {
        if (!throttle(request, 'rw', 60)) return json({ error: 'slow down' }, 429);
        if (!isUid(body.uid)) return json({ error: 'bad uid' }, 400);
        const raw = await redis(env, 'GET', 'u:' + body.uid);
        return json(raw ? JSON.parse(raw) : { data: null, at: 0 });
      }

      if (path === '/v1/push') {
        if (!throttle(request, 'rw', 60)) return json({ error: 'slow down' }, 429);
        if (!isUid(body.uid)) return json({ error: 'bad uid' }, 400);
        if (!body.data || typeof body.data !== 'object') return json({ error: 'bad data' }, 400);
        // The MERGE happens in the app, not here: it already owns the per-entry
        // timestamps and the rules about which store wins. Keeping the server a
        // dumb blob store means there is exactly one place that logic can be
        // wrong, and it is the place that can be tested without a network.
        const at = Date.now();
        await redis(env, 'SET', 'u:' + body.uid, JSON.stringify({ data: body.data, at }), 'EX', DATA_TTL);
        return json({ ok: true, at });
      }

      // ---- device pairing --------------------------------------------------
      // The TV asks for a code and polls. The phone, which already has an id,
      // claims the code. The TV then adopts that id. Nothing is ever typed on
      // the TV, which is the entire point.
      if (path === '/v1/pair/start') {
        // Hard limit: this is an unauthenticated Redis WRITE on a public URL.
        if (!throttle(request, 'start', 5)) return json({ error: 'slow down' }, 429);
        const code = newCode();
        // The code is SHOWN ON A TELEVISION, so it must not also be the credential that
        // collects the result. It is only the thing the phone types in. The watcher
        // token is returned to the TV alone and is required to poll -- otherwise anyone
        // who could read the screen could poll faster than the TV, take the uid the
        // phone had just attached, and burn the single-use code, leaving the real TV
        // showing "expired" and the onlooker holding the account.
        const watcher = crypto.randomUUID();
        await redis(env, 'SET', 'p:' + code,
          JSON.stringify({ state: 'pending', w: watcher }), 'EX', PAIR_TTL);
        return json({ code, watcher, expires: PAIR_TTL });
      }

      if (path === '/v1/pair/claim') {
        if (!throttle(request, 'rw', 60)) return json({ error: 'slow down' }, 429);
        if (!isCode(body.code) || !isUid(body.uid)) return json({ error: 'bad request' }, 400);
        // Only claim a code that is still pending. Without the check, a claim
        // could overwrite an already-completed pairing and hand a TV somebody
        // else's id.
        const raw = await redis(env, 'GET', 'p:' + body.code);
        if (raw === null) return json({ error: 'expired' }, 410);
        let rec; try { rec = JSON.parse(raw); } catch (e) { return json({ error: 'expired' }, 410); }
        if (rec.state !== 'pending') return json({ error: 'already claimed' }, 409);
        rec.state = body.uid;
        await redis(env, 'SET', 'p:' + body.code, JSON.stringify(rec), 'EX', PAIR_TTL);
        return json({ ok: true });
      }

      if (path === '/v1/pair/poll') {
        if (!throttle(request, 'rw', 60)) return json({ error: 'slow down' }, 429);
        if (!isCode(body.code)) return json({ error: 'bad code' }, 400);
        if (!isSession(body.watcher)) return json({ error: 'bad watcher' }, 400);
        const raw2 = await redis(env, 'GET', 'p:' + body.code);
        if (raw2 === null) return json({ error: 'expired' }, 410);
        let rec2; try { rec2 = JSON.parse(raw2); } catch (e) { return json({ error: 'expired' }, 410); }
        // Only the device that ASKED for this code may collect its result.
        if (rec2.w !== body.watcher) return json({ error: 'expired' }, 410);
        if (rec2.state === 'pending') return json({ pending: true });
        // Single use: burn it the moment it is handed over, so a code photographed off
        // a screen is worth nothing afterwards.
        await redis(env, 'DEL', 'p:' + body.code);
        return json({ uid: rec2.state });
      }

      // ---- Google sign-in, OAuth 2.0 device flow ---------------------------
      // Chosen because it needs no redirect URI and no registered JavaScript
      // origin, so ONE code path serves the Capacitor phone build, the Capacitor
      // TV build, Electron and the PWA. A conventional "Sign in with Google"
      // button cannot: Google returns disallowed_useragent to embedded WebViews,
      // which is what both Capacitor builds are.
      if (path === '/v1/auth/google/start' || path === '/v1/auth/google/poll') {
        if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.UID_PEPPER) {
          return json({ error: 'Worker is missing its Google secrets' }, 500);
        }
      }

      if (path === '/v1/auth/google/start') {
        // Hardest limit of all: each call spends Google device-code quota, which
        // is unpublished and, once exhausted, breaks sign-in for everybody.
        if (!throttle(request, 'start', 5)) return json({ error: 'slow down' }, 429);
        const r = await fetch('https://oauth2.googleapis.com/device/code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: env.GOOGLE_CLIENT_ID,
            // Bare spellings: the device-flow allowlist is written this way. The
            // console Data Access page uses the long .../auth/userinfo.* forms
            // for the same three scopes; both are correct in their own place.
            scope: 'openid email profile',
          }),
        });
        const d = await r.json();
        // Never echo Google's body: it can carry the client_id and internal detail.
        if (!r.ok) return json({ error: 'google_unavailable' }, 503);
        const sid = crypto.randomUUID();
        // Google returns verification_url; RFC 8628 spells it verification_uri.
        // Read Google's spelling, hedge against them fixing it later.
        const vurl = d.verification_url || d.verification_uri;
        // device_code is the secret half of this exchange. It stays server-side
        // and is NEVER returned — the client only ever holds the session id.
        await redis(env, 'SET', 'g:' + sid,
          JSON.stringify({ device_code: d.device_code, interval: d.interval || 5 }),
          'EX', Math.min(d.expires_in || AUTH_TTL, AUTH_TTL));
        return json({
          session: sid,
          user_code: d.user_code,     // display VERBATIM — it is case-sensitive
          verification_url: vurl,
          // Prefilling ?user_code= is undocumented and may stop working without
          // notice, so the client must always show user_code as well.
          qr_url: vurl + '?user_code=' + encodeURIComponent(d.user_code),
          interval: d.interval || 5,
          expires_in: d.expires_in || AUTH_TTL,
        });
      }

      if (path === '/v1/auth/google/poll') {
        if (!throttle(request, 'rw', 60)) return json({ error: 'slow down' }, 429);
        if (!isSession(body.session)) return json({ error: 'bad session' }, 400);

        const rawSt = await redis(env, 'GET', 'g:' + body.session);
        if (!rawSt) return json({ status: 'expired' });
        const st = JSON.parse(rawSt);

        const t = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            device_code: st.device_code,
            // The RFC URN, not the legacy http://oauth.net/grant_type/device/1.0
            // that one older Google page still shows. Settled by the live
            // discovery document, which advertises only this one.
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
        });
        const j = await t.json();
        // NEVER log j. It carries live tokens, and Worker logs are readable by
        // anyone with dashboard access.

        if (!t.ok) {
          switch (j.error) {
            case 'authorization_pending':
              return json({ status: 'pending', interval: st.interval });
            case 'slow_down':
              st.interval = (st.interval || 5) + 5;
              await redis(env, 'SET', 'g:' + body.session, JSON.stringify(st), 'EX', AUTH_TTL);
              return json({ status: 'pending', interval: st.interval });
            case 'access_denied':
              await redis(env, 'DEL', 'g:' + body.session);
              return json({ status: 'denied' });
            case 'expired_token':
            case 'invalid_grant':
              await redis(env, 'DEL', 'g:' + body.session);
              return json({ status: 'expired' });
            default:
              // invalid_client, rate_limit_exceeded, admin_policy_enforced, ...
              // All terminal: polling on only burns more quota.
              await redis(env, 'DEL', 'g:' + body.session);
              return json({ status: 'error', error: String(j.error || 'unknown') }, 400);
          }
        }

        await redis(env, 'DEL', 'g:' + body.session);      // single use

        // Identity without any JWT parsing. This Worker performed the exchange
        // itself with its own client_id and client_secret, so the access token is
        // ours by construction — there is no forwarded token to be confused about
        // and therefore no confused-deputy check to get wrong. That deletes the
        // whole RS256/JWKS/key-rotation surface for one extra subrequest, paid
        // once at sign-in rather than on every sync.
        const ui = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
          headers: { Authorization: 'Bearer ' + j.access_token },
        });
        if (!ui.ok) return json({ status: 'error', error: 'userinfo_failed' }, 400);
        const u = await ui.json();
        if (!u.sub) return json({ status: 'error', error: 'no_sub' }, 400);

        const uid = await deriveUid(env, u.sub);

        // Hand the Google grant straight back. Reeldeck calls TMDB, never Google,
        // so a retained refresh token would be a credential far more valuable
        // than the movie list it protects, sitting on a living-room TV, bought
        // for exactly no benefit.
        if (j.refresh_token) {
          try {
            await fetch('https://oauth2.googleapis.com/revoke', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ token: j.refresh_token }),
            });
          } catch (e) { /* best effort — never fail sign-in over this */ }
        }

        return json({
          status: 'ok',
          uid,
          name: u.given_name || u.name || '',
          picture: u.picture || '',
        });
      }

      return json({ error: 'unknown endpoint' }, 404);
    } catch (e) {
      // Never echo the upstream error: it can carry the Upstash URL or a token.
      return json({ error: 'upstream failure' }, 502);
    }
  },
};
