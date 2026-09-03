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

   SEVEN secrets, set under Settings -> Variables and Secrets, all as type
   "Secret" (encrypted) — never as plaintext variables:
       UPSTASH_REDIS_REST_URL     https://xxx-12345.upstash.io
       UPSTASH_REDIS_REST_TOKEN   AY...
       GOOGLE_CLIENT_ID           xxx.apps.googleusercontent.com   (TV, device flow)
       GOOGLE_CLIENT_SECRET       GOCSPX-...
       GOOGLE_WEB_CLIENT_ID       xxx.apps.googleusercontent.com   (everything else)
       GOOGLE_WEB_CLIENT_SECRET   GOCSPX-...

   TWO Google clients, because one client cannot do both grants: the device flow needs
   a "TVs and Limited Input devices" client and the redirect flow needs a "Web
   application" one. Put them in the SAME Cloud project. The account id is unaffected --
   Google's discovery document reports subject_types_supported: ["public"], so the
   subject is identical across clients, and the same person gets the same account from
   either flow.
       UID_PEPPER                 32 random bytes, base64  <-- BACK THIS UP FIRST

   ABOUT UID_PEPPER, because getting this wrong is unrecoverable: it is the HMAC
   key that turns a Google account id into a Reeldeck uid. Cloudflare secrets are
   write-only once saved, so if it is lost it cannot be read back, and every
   account derived from it becomes unreachable. Never rotate it — rotating is
   arithmetically identical to deleting every account at once.

   GOOGLE SIGN-IN IS TWO FLOWS, and which one runs is decided by the device. A
   television gets the device code -- a short code typed at google.com/device -- because
   the alternative is entering an email on a D-pad. Everything else gets the ordinary
   redirect: the system browser opens Google's own consent screen and comes straight
   back. The redirect flow is brokered here rather than run by the app, which is why it
   needs no registered JavaScript origin, no Android package and SHA-1, and no iOS
   bundle id: the app only ever opens one https URL on this domain, and this Worker is
   the only party that talks to Google.

   THE IDENTITY MODEL, stated plainly so it is not mistaken for more than it is:
   a "user" is an opaque id the app holds. That id IS the credential — whoever
   holds it can read and write that account's data. An id arrives three ways, and
   downstream nothing can tell them apart, which is correct because they must be
   treated identically:
     - anonymous : the app generates 192 random bits locally
     - Google    : HMAC(pepper, "reeldeck:uid:v1:google:<sub>:0")
     - password  : HMAC(pepper, "reeldeck:uid:v1:email:<email>:0")

   The Google and password namespaces are separate on purpose. Signing in with
   Google using an address you also registered by password gives a DIFFERENT
   account, and the UI says so — silently linking them would mean guessing which
   history is authoritative, and guessing wrong loses somebody's library.

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
     /v1/pair/start        { }                 -> { code, watcher, expires }  (the TV)
     /v1/pair/claim        { code, uid }       -> { ok }              (the phone)
     /v1/pair/poll         { code, watcher }   -> { uid } | { pending }
     /v1/auth/google/start { }                 -> { session, user_code, qr_url, ... }
     /v1/auth/google/poll  { session }         -> { status, uid?, name?, picture? }
     /v1/auth/google/begin  { }                -> { session, url, expires }
     /v1/auth/google/callback  (GET, from Google) -> an HTML "you can close this" page
     /v1/auth/google/finish { session }        -> { status, uid?, name?, picture? }
     /v1/auth/pw/signup    { email, dk }       -> { uid } | 409 exists
     /v1/auth/pw/login     { email, dk }       -> { uid } | 401 bad login

   `dk` is PBKDF2(password, "reeldeck:pw:v1:"+email, 210000, SHA-256) computed on the
   DEVICE. The password itself never leaves it, and the server never has to spend the
   CPU a Worker does not have.
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

const RX_EMAIL = /^[^\s@]{1,64}@[^\s@.]{1,63}(\.[^\s@.]{1,63}){1,4}$/;
/** The derived key the client computes. 32 bytes, base64url, so 43 characters. */
const isDk = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
const normEmail = (v) => String(v || '').trim().toLowerCase();

async function sha256b64(str) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return b64url(d);
}

/** Length-independent comparison. Both sides are fixed-length base64url here, but
 *  writing it this way means it stays correct if that ever changes. */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** What actually gets stored. The client already spent 210k PBKDF2 iterations getting
 *  to dk, so one keyed hash here is enough: without the pepper a dump is inert, and
 *  with it an attacker still faces the full PBKDF2 cost per guess. */
async function pwHash(env, dk) {
  const mac = await crypto.subtle.sign(
    'HMAC', await pepperKey(env), new TextEncoder().encode('reeldeck:pw:v1:' + dk)
  );
  return b64url(mac);
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

/** The same construction as the Google one, in its own namespace so the two can never
 *  collide -- signing in with Google using the address you also registered by password
 *  is a DIFFERENT account, and saying so plainly in the UI is better than pretending
 *  to link them and getting the merge wrong. */
async function deriveEmailUid(env, email) {
  const mac = await crypto.subtle.sign(
    'HMAC', await pepperKey(env), new TextEncoder().encode('reeldeck:uid:v1:email:' + email + ':0')
  );
  return b64url(mac);
}

/** A plain page for the browser tab Google sends back. It carries NOTHING secret:
 *  the app collects the result over its own POST to /finish, using the session it has
 *  held since /begin. So this page is safe in history, in a screenshot, anywhere. */
function donePage(title, detail) {
  return new Response(
    '<!doctype html><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + title + '</title>' +
    '<style>html{color-scheme:dark light}body{margin:0;min-height:100vh;display:grid;' +
    'place-items:center;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
    'background:#0b0d12;color:#e8ecf5;text-align:center;padding:24px}' +
    'h1{font-size:22px;margin:0 0 10px}p{margin:0;color:#9aa4bb;max-width:34ch}</style>' +
    '<div><h1>' + title + '</h1><p>' + detail + '</p></div>',
    { status: 200, headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      } }
  );
}

/**
 * Where Google sends the browser back. A GET, from an unauthenticated caller, on a
 * public URL -- so it validates the state before spending a token exchange.
 */
async function googleCallback(request, env, url) {
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405);
  // Its OWN bucket. Sharing 'start' meant each sign-in spent two of the five tokens
  // that /begin, /pair/start and the password endpoints also draw on, so the third
  // attempt in a minute locked the user out of every sign-in method at once.
  if (!throttle(request, 'oauthcb', 20)) return donePage('Too many attempts', 'Wait a minute and try signing in again.');
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  const err = url.searchParams.get('error') || '';

  if (!isSession(state)) return donePage('Sign-in failed', 'That link is not valid. Start again from the app.');
  const raw = await redis(env, 'GET', 'gs:' + state);
  if (!raw) return donePage('Sign-in expired', 'That took too long. Start again from the app.');
  let rec; try { rec = JSON.parse(raw); } catch (e) { return donePage('Sign-in failed', 'Start again from the app.'); }
  if (rec.status !== 'pending') return donePage('Already used', 'That sign-in link has already been used.');

  const finish = async (patch) => {
    await redis(env, 'SET', 'gs:' + state, JSON.stringify(Object.assign(rec, patch)), 'EX', PAIR_TTL);
  };

  if (err) {
    await finish({ status: err === 'access_denied' ? 'denied' : 'error' });
    return donePage('Sign-in cancelled', 'You can close this and try again in the app.');
  }
  if (!code) { await finish({ status: 'error' }); return donePage('Sign-in failed', 'Google sent no authorization code.'); }

  try {
    const t = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_WEB_CLIENT_ID,
        client_secret: env.GOOGLE_WEB_CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: url.origin + '/v1/auth/google/callback',
      }),
    });
    const j = await t.json();          // never logged: it carries live tokens
    if (!t.ok) { await finish({ status: 'error' }); return donePage('Sign-in failed', 'Google would not complete the exchange.'); }

    // IDENTICAL to the device path on purpose. Reading u.email here instead of u.sub,
    // or deriving the id any other way, would silently split every existing Google
    // account in two -- the same person would get a different account depending on
    // which flow they used.
    const ui = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: 'Bearer ' + j.access_token },
    });
    if (!ui.ok) { await finish({ status: 'error' }); return donePage('Sign-in failed', 'Could not read your Google profile.'); }
    const u = await ui.json();
    if (!u.sub) { await finish({ status: 'error' }); return donePage('Sign-in failed', 'Google returned no account id.'); }

    await finish({
      status: 'ok',
      uid: await deriveUid(env, u.sub),
      name: u.given_name || u.name || '',
      picture: u.picture || '',
    });
    return donePage('Signed in', 'You can close this tab and go back to Reeldeck.');
  } catch (e) {
    await finish({ status: 'error' });
    return donePage('Sign-in failed', 'Something went wrong. Try again from the app.');
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
      return json({ error: 'Worker is missing its Upstash secrets' }, 500);
    }

    // Path FIRST, then the method guard. Google's redirect back to the OAuth callback
    // is a GET, and the old order rejected it with "POST only" before the path was even
    // read -- so the callback would have 405'd with every other part of the flow
    // looking correct.
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    if (path === '/v1/auth/google/callback') return googleCallback(request, env, url);
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
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

      // ---- Google, redirect flow (phone, desktop, web) ----------------------
      // The device code stays for television only. Everywhere else this is the
      // ordinary consent screen people expect: tap, choose an account, done.
      if (path === '/v1/auth/google/begin') {
        if (!throttle(request, 'start', 5)) return json({ error: 'slow down' }, 429);
        if (!env.GOOGLE_WEB_CLIENT_ID || !env.GOOGLE_WEB_CLIENT_SECRET) {
          return json({ error: 'Worker is missing its Google web client' }, 500);
        }
        // PUBLIC: goes to Google and ends up in a browser URL bar.
        const state = crypto.randomUUID();
        // SECRET: returned here and nowhere else. /finish requires it.
        const session = crypto.randomUUID();
        await redis(env, 'SET', 'gs:' + state,
          JSON.stringify({ sess: session, status: 'pending' }), 'EX', PAIR_TTL);
        await redis(env, 'SET', 'gx:' + session, state, 'EX', PAIR_TTL);
        const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        auth.searchParams.set('client_id', env.GOOGLE_WEB_CLIENT_ID);
        auth.searchParams.set('redirect_uri', new URL(request.url).origin + '/v1/auth/google/callback');
        auth.searchParams.set('response_type', 'code');
        auth.searchParams.set('scope', 'openid email profile');
        auth.searchParams.set('state', state);
        // No refresh token is wanted: this exchange is used once, to read a subject.
        auth.searchParams.set('access_type', 'online');
        // Always show the picker. Without it a browser already signed in to one Google
        // account silently reuses it, which on a shared machine signs you in as
        // somebody else with no visible step.
        auth.searchParams.set('prompt', 'select_account');
        return json({ session, url: auth.toString(), expires: PAIR_TTL });
      }

      if (path === '/v1/auth/google/finish') {
        if (!throttle(request, 'rw', 60)) return json({ error: 'slow down' }, 429);
        if (!isSession(body.session)) return json({ error: 'bad session' }, 400);
        const st8 = await redis(env, 'GET', 'gx:' + body.session);
        if (!st8) return json({ status: 'expired' });
        const raw3 = await redis(env, 'GET', 'gs:' + st8);
        if (!raw3) return json({ status: 'expired' });
        let rec3; try { rec3 = JSON.parse(raw3); } catch (e) { return json({ status: 'expired' }); }
        // The session is the credential here; the state alone must never be enough.
        if (rec3.sess !== body.session) return json({ status: 'expired' });
        if (rec3.status === 'pending') return json({ status: 'pending' });
        // Single use: burn both keys the moment the result is handed over.
        await redis(env, 'DEL', 'gs:' + st8);
        await redis(env, 'DEL', 'gx:' + body.session);
        if (rec3.status !== 'ok') return json({ status: rec3.status || 'error' });
        return json({ status: 'ok', uid: rec3.uid, name: rec3.name || '', picture: rec3.picture || '' });
      }

      // ---- email + password ------------------------------------------------
      // No reset flow, deliberately and visibly: sending mail from a Worker needs a
      // paid provider, and a half-built reset is worse than none. The recovery path is
      // the pairing flow -- sign in on a device that still works and connect this one,
      // which is stronger than an emailed link anyway. The UI says so.
      if (path === '/v1/auth/pw/signup' || path === '/v1/auth/pw/login') {
        // Named for what is actually missing. Password sign-in needs only the pepper,
        // not the Google client, and saying "Google secrets" sends whoever is
        // configuring this to the wrong dashboard.
        if (!env.UID_PEPPER) return json({ error: 'Worker is missing UID_PEPPER' }, 500);
        // Hard limit: this is the brute-forceable surface, and it is a Redis write.
        if (!throttle(request, 'start', 5)) return json({ error: 'slow down' }, 429);

        const email = normEmail(body.email);
        if (!RX_EMAIL.test(email) || email.length > 190) return json({ error: 'bad email' }, 400);
        if (!isDk(body.dk)) return json({ error: 'bad request' }, 400);

        const key = 'pw:' + (await sha256b64('reeldeck:acct:v1:' + email));
        const stored = await redis(env, 'GET', key);
        const hash = await pwHash(env, body.dk);

        if (path === '/v1/auth/pw/signup') {
          if (stored) return json({ error: 'exists' }, 409);
          // NO EXPIRY, deliberately. The account id is a pure function of the address,
          // so if this record ever lapses while the account is still in use, anyone who
          // knows the address can "sign up" again and be handed the existing id -- a
          // full takeover on a fixed schedule. /v1/push refreshes the DATA key on every
          // sync, so an active account would have kept its history and quietly lost the
          // only thing protecting it. The record is about sixty bytes; its expiry buys
          // nothing and costs the account.
          await redis(env, 'SET', key, JSON.stringify({ h: hash, at: Date.now() }));
          return json({ uid: await deriveEmailUid(env, email) });
        }

        // PER-ACCOUNT lockout, not just per-IP. The client-side KDF means the salt
        // is the email, so an attacker targeting one known address can pay the 210k
        // iterations ONCE offline for a whole dictionary and then spend only network
        // per guess -- and the per-IP throttle is per-isolate and trivially bypassed
        // from several addresses. This counter is the only thing that actually costs
        // a distributed guesser anything.
        const fkey = 'fail:' + key.slice(3);
        const fails = parseInt(await redis(env, 'GET', fkey), 10) || 0;
        if (fails >= 10) return json({ error: 'locked' }, 429);

        // Compare against a dummy when the account does not exist, so the response
        // does not tell an attacker which addresses are registered.
        let rec = null;
        try { rec = stored ? JSON.parse(stored) : null; } catch (e) { rec = null; }
        const ok = timingSafeEqual(hash, (rec && rec.h) || 'x'.repeat(hash.length));
        if (!stored || !ok) {
          // INCR then EXPIRE: a sliding 15-minute window that costs one round trip and
          // only on failure, so the happy path pays nothing.
          const n = await redis(env, 'INCR', fkey);
          if (n === 1) await redis(env, 'EXPIRE', fkey, 900);
          return json({ error: 'bad login' }, 401);
        }
        if (fails) await redis(env, 'DEL', fkey);     // a real sign-in clears the count
        return json({ uid: await deriveEmailUid(env, email) });
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
