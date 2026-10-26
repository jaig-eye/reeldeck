/* ============================================================================
   Reeldeck backend: a Cloudflare Worker in front of Upstash Redis.
   Paste into the dashboard editor (Workers & Pages -> the Worker -> Edit code) and
   Deploy. No imports, no build step. Secrets take effect on the next Deploy.

   Secrets (Settings -> Variables and Secrets, type Secret):
     UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN   the database
     ACCESS_CODES        name=code pairs, comma or newline separated: alex=1234, sam=5678
                         Each four-digit code is a person's account: the name is what
                         their watchlist and history are stored under.
     ACCESS_SIGNING_KEY  32+ random characters; signs the tokens devices keep.
   Binding:
     SOURCES_KV          KV namespace with the source list (see loadSources).

   Endpoints (POST, JSON):
     /v1/access/enter  { code }       -> { acc, exp, uid, name }
     /v1/access/check  { acc }        -> { ok, uid, name, renew? }
     /v1/sources       { acc }        -> { sources, rev, health }
     /v1/pull          { acc }        -> { data, at }
     /v1/push          { acc, data }  -> { ok, at }
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
/**
 * The playback sources -- managed in the Cloudflare dashboard, NOT in this file.
 *
 * One Workers KV entry per service, in a namespace bound to this Worker as SOURCES_KV
 * (Settings -> Bindings -> KV namespace). Key `src:<anything>`, value a JSON object:
 *
 *   { "name": "Example", "movie": "https://host/movie/{id}", "tv": "https://host/tv/{id}/{season}/{episode}",
 *     "tracked": 1, "resume": "startAt", "order": 10 }
 *
 * `tracked` (the service reports playback position) and `resume` (a URL parameter name) and
 * `order` (lower first; ties by name) are optional. Placeholders: {id} {imdb} {season}
 * {episode} {color}. Add, edit or delete an entry in the dashboard and the app sees it within
 * five minutes -- no redeploy, and no revision number to bump (it is derived from the list).
 *
 * No KV namespace yet? SOURCES_JSON works as a plain variable holding the same objects as a
 * JSON array. (Variables are capped at 5 KB; KV is not.) With neither, the list is empty and
 * the app simply has no servers -- see refreshSources in app.js.
 *
 * Every entry is validated here exactly as the app validates it again on arrival: https only,
 * a bounded length, and {id} present -- a malformed entry is skipped, not served.
 */
const SRC_PREFIX = 'src:';
const SRC_TTL = 5 * 60 * 1000;     // KV reads are metered; a few minutes of lag is fine
let _srcCache = null;

const okUrl = (u) => typeof u === 'string' && u.length <= 400 &&
                     /^https:\/\/[a-z0-9.-]+\//i.test(u) && u.indexOf('{id}') >= 0;
function cleanSource(o) {
  if (!o || typeof o !== 'object' || typeof o.name !== 'string' || !o.name || o.name.length > 40) return null;
  if (!okUrl(o.movie) || !okUrl(o.tv)) return null;
  const row = { name: o.name, movie: o.movie, tv: o.tv, tracked: o.tracked ? 1 : 0,
                resume: (typeof o.resume === 'string' && /^[a-zA-Z]{1,24}$/.test(o.resume)) ? o.resume : '' };
  return { row, order: Number.isFinite(+o.order) ? +o.order : 1000 };
}
/** 32-bit FNV-1a of the served list, never 0: the app compares revisions for equality. */
function listRev(rows) {
  let h = 0x811c9dc5;
  const s = JSON.stringify(rows);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h % 2147483646) + 1;
}
async function loadSources(env) {
  if (_srcCache && Date.now() - _srcCache.at < SRC_TTL) return _srcCache;
  let raw = [];
  try {
    if (env.SOURCES_KV) {
      const names = []; let cursor;
      do {
        const page = await env.SOURCES_KV.list({ prefix: SRC_PREFIX, cursor });
        page.keys.forEach((k) => names.push(k.name));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor && names.length < 200);
      raw = (await Promise.all(names.slice(0, 100).map((n) => env.SOURCES_KV.get(n, 'json').catch(() => null))));
    } else if (env.SOURCES_JSON) {
      const j = JSON.parse(env.SOURCES_JSON);
      raw = Array.isArray(j) ? j : [];
    }
  } catch (e) {
    // A KV or parse failure keeps the last good list rather than serving "no servers".
    if (_srcCache) return _srcCache;
    raw = [];
  }
  const rows = raw.map(cleanSource).filter(Boolean)
    .sort((a, b) => a.order - b.order || a.row.name.localeCompare(b.row.name))
    .slice(0, 40).map((x) => x.row);
  _srcCache = { at: Date.now(), rows, rev: listRev(rows) };
  return _srcCache;
}

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

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

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

/* ---------------------------------------------------------------------------
   Mirror health. Each mirror's film page is requested from here, with a short
   timeout, and the names that do not answer ride along on /v1/sources as
   `health.down`. The client keeps those out of the server room and never starts
   on one.

   This is CLOUDFLARE'S view of each mirror, not the viewer's: a mirror can be
   blocked on someone's network and still answer here, or refuse Cloudflare's IPs
   and work fine at home. So a mirror is "down" only when NOTHING answers for it:
     dns          the name does not resolve
     unreachable  no connection / TLS at all
     timeout      connected to nothing within PROBE_MS, twice
     origin       Cloudflare answering FOR a mirror whose server is gone (521-530)
   ANY reply from the mirror itself -- a bot challenge, a 403, a 429, even a 500 or
   502 -- counts as up: it is there, and a real viewer may well get through (one
   mirror answers 502 to everyone but the sites it is embedded on). A failure is
   retried once before it is believed. The client keeps down mirrors behind "Show
   offline" rather than deleting them, and shows everything if every mirror is
   down, since that says more about this Worker's network than about the mirrors.

   Never on the request path: /v1/sources serves the last stored verdict and, if
   it is stale, refreshes it in the background (ctx.waitUntil). A lock stops every
   cold isolate from probing all mirrors at once. A Cron Trigger (Settings ->
   Triggers, e.g. every 10 minutes) keeps it warm through `scheduled` below, but
   it is optional.
   --------------------------------------------------------------------------- */
const HEALTH_KEY = 'mh:v1';
const HEALTH_FRESH = 10 * 60 * 1000;   // re-probe once the verdict is ten minutes old
const HEALTH_TTL = 60 * 60;            // and never serve one older than an hour
const PROBE_MS = 6000;
const PROBE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// Cloudflare's own "the origin behind me is gone" codes: the mirror said nothing.
const CF_ORIGIN_DOWN = new Set([521, 522, 523, 525, 526, 530]);

/** null = answering; otherwise a short reason. Fight Club, because every mirror has it. */
async function probeMirror(s) {
  const u = s.movie.replace(/\{id\}|\{tmdbId\}|\{externalId\}/g, '550')
                   .replace(/\{imdb\}/g, 'tt0137523')
                   .replace(/\{color\}|\{primaryColor\}/g, 'f5c518')
                   .replace(/\{[a-zA-Z]+\}/g, '1');
  try {
    const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(PROBE_MS),
                               headers: { 'user-agent': PROBE_UA, accept: 'text/html,*/*' } });
    try { if (r.body) await r.body.cancel(); } catch (e) { /* only the status is wanted */ }
    return CF_ORIGIN_DOWN.has(r.status) ? 'origin' : null;
  } catch (e) {
    if (e && e.name === 'TimeoutError') return 'timeout';
    // The Workers runtime reports every connection failure the same way; a cause code
    // (Node, where this file is tested) can still tell a missing name apart.
    const code = String((e && e.cause && e.cause.code) || '');
    return /ENOTFOUND|EAI_AGAIN|ESERVFAIL/.test(code) ? 'dns' : 'unreachable';
  }
}

async function refreshHealth(env) {
  const lock = await redis(env, 'SET', 'mh:lock', '1', 'EX', 60, 'NX');
  if (lock === null) return null;                 // another isolate is already probing
  const down = {};
  const { rows } = await loadSources(env);
  await Promise.all(rows.map(async (s) => {
    let why = await probeMirror(s);
    if (why) why = await probeMirror(s);          // one dropped connection is not an outage
    if (why) down[s.name] = why;
  }));
  const rec = { at: Date.now(), down };
  await redis(env, 'SET', HEALTH_KEY, JSON.stringify(rec), 'EX', HEALTH_TTL);
  return rec;
}

/** The stored verdict, now; a refresh in the background if it is stale. Never throws. */
async function mirrorHealth(env, ctx) {
  let rec = null;
  try { rec = JSON.parse((await redis(env, 'GET', HEALTH_KEY)) || 'null'); } catch (e) { rec = null; }
  if (!rec || !(Date.now() - rec.at < HEALTH_FRESH)) {
    const job = refreshHealth(env).catch(() => null);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
  }
  return rec && rec.down && typeof rec.down === 'object' ? rec : null;
}

/* ---------------------------------------------------------------------------
   Access codes are the accounts. ACCESS_CODES holds name=code pairs; a device that enters a
   code gets a token for that name's account, valid 90 days and re-issued as it is used.
   The account id is a hash of the name, so changing someone's code keeps their data, and
   removing their line locks their devices (tokens are tied to the name AND the code).
   Token: exp.iat.uid.cid.sig -- uid is the account, cid a short HMAC of name+code, sig an
   HMAC of the rest. Fails closed: with no codes or no signing key nothing opens.
   --------------------------------------------------------------------------- */
const ACCESS_TTL = 90 * 86400;            // seconds
const ACCESS_RENEW_AFTER = 86400;         // re-issue once a token is a day old
const ACCESS_FAIL_MAX = 10, ACCESS_FAIL_WINDOW = 900;
let _accKey = null;
const nowSec = () => Math.floor(Date.now() / 1000);

/** name -> code, from ACCESS_CODES. */
function accessCodes(env) {
  const m = new Map();
  String(env.ACCESS_CODES || '').split(/[\s,;]+/).filter(Boolean).forEach((item) => {
    const x = /^([^=:]{1,40})[=:](\d{4})$/.exec(item);
    if (x) m.set(x[1].trim().toLowerCase(), x[2]);
  });
  return m;
}
const accessReady = (env) => !!env.ACCESS_CODES && !!env.ACCESS_SIGNING_KEY;

async function accessHmac(env, msg) {
  if (!_accKey || _accKey.src !== env.ACCESS_SIGNING_KEY) {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(env.ACCESS_SIGNING_KEY)),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    _accKey = { src: env.ACCESS_SIGNING_KEY, k };
  }
  return b64url(await crypto.subtle.sign('HMAC', _accKey.k, new TextEncoder().encode(msg)));
}
const accountId = (name) => sha256b64('reeldeck:acct:v1:' + name);            // 43 chars
const codeId = async (env, name, code) => (await accessHmac(env, 'reeldeck:cid:v1:' + name + ':' + code)).slice(0, 12);

async function mintToken(env, uid, cid) {
  const exp = nowSec() + ACCESS_TTL, iat = nowSec();
  const body = exp + '.' + iat + '.' + uid + '.' + cid;
  return { token: body + '.' + (await accessHmac(env, 'reeldeck:tok:v1:' + body)), exp };
}
/** { ok, uid, name, cid, iat } for a valid token whose name and code still exist. */
async function readToken(env, tok) {
  const bad = { ok: false };
  const p = typeof tok === 'string' && tok.length < 260 ? tok.split('.') : [];
  if (p.length !== 5 || !/^\d+$/.test(p[0]) || !/^\d+$/.test(p[1]) ||
      !/^[A-Za-z0-9_-]{43}$/.test(p[2]) || !/^[A-Za-z0-9_-]{12}$/.test(p[3])) return bad;
  if (+p[0] <= nowSec()) return bad;
  const sig = await accessHmac(env, 'reeldeck:tok:v1:' + p.slice(0, 4).join('.'));
  if (!timingSafeEqual(sig, p[4])) return bad;
  for (const [name, code] of accessCodes(env)) {
    if (timingSafeEqual(await codeId(env, name, code), p[3]) && timingSafeEqual(await accountId(name), p[2])) {
      return { ok: true, uid: p[2], name, cid: p[3], iat: +p[1] };
    }
  }
  return bad;
}
/** The caller's account, or a response to send instead. */
async function needAccount(env, body) {
  if (!accessReady(env)) return { res: json({ error: 'access not configured' }, 500) };
  const v = await readToken(env, body && body.acc);
  return v.ok ? { v } : { res: json({ error: 'locked' }, 401) };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshHealth(env).catch(() => null));
  },

  async fetch(request, env, ctx) {
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
      // ---- playback mirrors -----------------------------------------------
      // Served from here rather than compiled into the client, so the list is not
      // sitting in a public repository, in the bundle every visitor downloads, or in
      // the APK. It is not a secret from anyone running the app -- the browser is told
      // these URLs in order to load the frame -- it is simply not published.
      // ---- access code -----------------------------------------------------
      if (path === '/v1/access/check') {
        if (!throttle(request, 'rw', 60)) return json({ error: 'slow down' }, 429);
        const acct = await needAccount(env, body);
        if (acct.res) return acct.res.status === 401 ? json({ ok: false }) : acct.res;
        const out = { ok: true, uid: acct.v.uid, name: acct.v.name };
        if (nowSec() - acct.v.iat > ACCESS_RENEW_AFTER) out.renew = (await mintToken(env, acct.v.uid, acct.v.cid)).token;
        return json(out);
      }
      if (path === '/v1/access/enter') {
        if (!throttle(request, 'access', 12)) return json({ error: 'slow down' }, 429);
        if (!accessReady(env)) return json({ error: 'access not configured' }, 500);
        if (typeof body.code !== 'string' || !/^\d{4}$/.test(body.code)) return json({ error: 'bad code' }, 400);
        // Per-address limit on wrong codes, kept in Redis so it holds across isolates.
        const fkey = 'af:' + (await sha256b64('reeldeck:af:v1:' + (request.headers.get('CF-Connecting-IP') || 'unknown')));
        if ((parseInt(await redis(env, 'GET', fkey), 10) || 0) >= ACCESS_FAIL_MAX) return json({ error: 'locked out' }, 429);
        // Compare against every code (no early exit), so timing says nothing.
        let hit = null;
        for (const [name, code] of accessCodes(env)) { if (timingSafeEqual(code, body.code) && !hit) hit = name; }
        if (!hit) {
          await redis(env, 'SET', fkey, '0', 'EX', ACCESS_FAIL_WINDOW, 'NX');
          await redis(env, 'INCR', fkey);
          return json({ error: 'bad code' }, 401);
        }
        await redis(env, 'DEL', fkey);
        const uid = await accountId(hit);
        const t = await mintToken(env, uid, await codeId(env, hit, body.code));
        return json({ ok: true, acc: t.token, exp: t.exp, uid, name: hit });
      }

      if (path === '/v1/sources') {
        if (!throttle(request, 'rw', 60)) return json({ error: 'slow down' }, 429);
        { const acct = await needAccount(env, body); if (acct.res) return acct.res; }
        // Health is advisory: a missing verdict (first call, Upstash down) serves the
        // table exactly as before and the client shows every mirror.
        const [h, src] = await Promise.all([mirrorHealth(env, ctx), loadSources(env)]);
        return json({ sources: src.rows, rev: src.rev,
                      health: h ? { at: h.at, down: Object.keys(h.down), why: h.down } : null });
      }

      // ---- sync -----------------------------------------------------------
      if (path === '/v1/pull') {
        if (!throttle(request, 'rw', 60)) return json({ error: 'slow down' }, 429);
        const acct = await needAccount(env, body); if (acct.res) return acct.res;
        const raw = await redis(env, 'GET', 'u:' + acct.v.uid);
        return json(raw ? JSON.parse(raw) : { data: null, at: 0 });
      }

      if (path === '/v1/push') {
        if (!throttle(request, 'rw', 60)) return json({ error: 'slow down' }, 429);
        const acct = await needAccount(env, body); if (acct.res) return acct.res;
        if (!body.data || typeof body.data !== 'object') return json({ error: 'bad data' }, 400);
        // The MERGE happens in the app, not here: it already owns the per-entry
        // timestamps and the rules about which store wins. Keeping the server a
        // dumb blob store means there is exactly one place that logic can be
        // wrong, and it is the place that can be tested without a network.
        const at = Date.now();
        await redis(env, 'SET', 'u:' + acct.v.uid, JSON.stringify({ data: body.data, at }), 'EX', DATA_TTL);
        return json({ ok: true, at });
      }

      return json({ error: 'unknown endpoint' }, 404);
    } catch (e) {
      // Never echo the upstream error: it can carry the Upstash URL or a token.
      return json({ error: 'upstream failure' }, 502);
    }
  },
};
