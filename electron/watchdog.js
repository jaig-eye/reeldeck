// Did the player load? The desktop app's answer to "this server is just a black (or white)
// screen". The page cannot see into a cross-origin player; the main process can. It asks on
// the page's behalf (ipc reeldeck:player-check, a few seconds after a player frame is created),
// and app.js decides from the answer whether to move on to the next server (playerWatch).
//
// Two kinds of evidence, both about the player frame the page names:
//  - hard: the frame's own document failed to load (DNS, refused, timed out, reset -- a
//    did-fail-load we saw for that frame) or came back with an HTTP error status. A mirror
//    that is gone looks exactly like this.
//  - content: what is drawn in the frame and every frame nested in it -- videos (and whether
//    one is playing), visible pictures, buttons and canvases, and text. "Nothing at all, in
//    any of them" is the blank screen. A poster with a play button is NOT blank, nor is a
//    Cloudflare check, so neither is ever skipped.
// Nothing is changed in the frame: the probe only reads, and runs once per check.
const { webFrameMain } = require('electron');

// Load failures by frameTreeNodeId, per webContents. ERR_ABORTED (-3) is not a failure: it is
// a navigation replaced by another one, or refused by our own guards (the player pin).
const fails = new WeakMap();
function attach(contents) {
  if (fails.has(contents)) return;
  const map = new Map();
  fails.set(contents, map);
  const failed = (e, code, desc, url, isMainFrame, pid, rid) => {
    if (isMainFrame || code === -3) return;
    let f = null, player = false;
    try { f = webFrameMain.fromId(pid, rid); player = !!f && !!f.parent && !f.parent.parent; } catch (err) {}
    // Only frames the page itself made (check() never asks about another): every ad frame the
    // ad blocker refuses also fails to load, and those would pile up for the life of the window.
    if (player) map.set(f.frameTreeNodeId, { code: code, desc: String(desc || ''), url: String(url || '').slice(0, 200) });
  };
  contents.on('did-fail-load', failed);
  contents.on('did-fail-provisional-load', failed);
  // A new navigation of a frame starts its record over (the next server's frame is a new
  // frame anyway; this is a player that reloaded itself).
  contents.on('did-start-navigation', (e) => {
    try { if (e && e.frame && !e.isSameDocument && !e.isMainFrame) map.delete(e.frame.frameTreeNodeId); } catch (err) {}
  });
}

// Runs inside each frame. Reads only. A frame can lie to it (it is the frame's own JS world),
// which at worst makes a broken player look alive -- the safe direction.
const PROBE = `(() => { try {
  const d = document, b = d.body;
  const nav = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
  // Every element, into open shadow roots as well: web-component players (<media-player> and
  // the like) draw everything in there. A closed root cannot be opened, so a big custom element
  // counts as drawn on its own.
  const all = [], vids = [];
  (function walk(root) {
    const els = root.querySelectorAll('*');
    for (let i = 0; i < els.length && all.length < 1500; i++) {
      const el = els[i];
      all.push(el);
      if (el.tagName === 'VIDEO') vids.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  })(d);
  const playing = vids.some((v) => v.currentTime > 0 && !v.paused && !v.ended);
  const ready = vids.some((v) => v.readyState >= 2);
  const MEDIA = { IMG: 1, svg: 1, SVG: 1, CANVAS: 1, VIDEO: 1, BUTTON: 1, A: 1, INPUT: 1, OBJECT: 1, EMBED: 1, PICTURE: 1 };
  let vis = 0;
  const big = (el, min) => { const r = el.getBoundingClientRect(); return r.width * r.height >= min && r.bottom > 0 && r.right > 0; };
  const shown = (el) => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05 ? cs : null; };
  const painted = (cs) => !!cs.backgroundImage && cs.backgroundImage !== 'none';
  // A poster painted on the page itself.
  [d.documentElement, b].forEach((el) => { if (el && painted(getComputedStyle(el))) vis++; });
  // A full-size frame is the player: what is IN it is judged by its own probe (check()), so
  // this does not count it. Everything else drawn counts: media, controls, custom elements, a
  // picture painted as a background (a poster, a play icon), something to click (a click-to-
  // load overlay), and an icon drawn as a glyph (::before / ::after, a font icon's play arrow).
  for (let i = 0; i < all.length && vis < 3; i++) {
    const el = all[i], t = el.tagName;
    if (t === 'IFRAME' || t === 'FRAME' || t === 'SCRIPT' || t === 'STYLE' || t === 'HEAD' || t === 'BODY' || t === 'HTML') continue;
    if (!big(el, 400)) continue;
    const cs = shown(el);
    if (!cs) continue;
    if (MEDIA[t] || t.indexOf('-') > 0 || el.getAttribute('role') === 'button' || painted(cs) || cs.cursor === 'pointer') { vis++; continue; }
    const glyph = (p) => { const c = getComputedStyle(el, p).content; return !!c && c !== 'none' && c !== 'normal' && c !== '""'; };
    if (glyph('::before') || glyph('::after')) vis++;
  }
  // Text a person can see: not innerText, which falls back to raw textContent (the source of
  // every inline <script> included) whenever the frame is not being rendered.
  let text = 0;
  if (b) {
    const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
    const tw = d.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(), k = 0; n && text <= 20 && k < 3000; n = tw.nextNode(), k++) {
      const p = n.parentElement;
      if (!p || SKIP[p.tagName]) continue;
      const t = n.nodeValue.replace(/\\s+/g, '');
      if (t && big(p, 1) && shown(p)) text += t.length;
    }
  }
  return { status: nav && nav.responseStatus ? nav.responseStatus : 0, videos: vids.length, playing: playing, ready: ready, vis: vis, text: text };
} catch (e) { return { threw: String(e && e.message || e).slice(0, 80) }; } })()`;

const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
const isError = (u) => /^chrome-error:/.test(u || '');

/** The player frame among the page's own child frames: by name, else the only one there is. */
function playerFrame(top, name) {
  let kids = [];
  try { kids = top.frames || []; } catch (e) { return null; }
  const named = kids.filter((f) => { try { return !!name && f.name === name; } catch (e) { return false; } });
  if (named.length) return named[0];
  return kids.length === 1 ? kids[0] : null;
}

/**
 * The report for the page's player frame. `top` is the page's own frame (the ipc sender's),
 * so a request can only ever look at frames inside the window that asked.
 */
async function check(contents, top, name) {
  const f = playerFrame(top, String(name || '').slice(0, 40));
  if (!f) return { found: false };
  let id = 0, url = '';
  try { id = f.frameTreeNodeId; url = f.url; } catch (e) { return { found: false }; }
  const fail = (fails.get(contents) || new Map()).get(id) || null;
  let subtree = [];
  try { subtree = f.framesInSubtree || [f]; } catch (e) { subtree = [f]; }
  const all = subtree.length;
  subtree = subtree.slice(0, 12);
  const probes = await Promise.all(subtree.map((fr) => {
    let u = '';
    try { u = fr.url; } catch (e) { return Promise.resolve(null); }
    if (isError(u)) return Promise.resolve({ error: true, self: fr === f });
    return within(fr.executeJavaScript(PROBE).catch(() => null), 1500)
      .then((r) => r ? Object.assign({ self: fr === f }, r) : null);
  }));
  const own = probes.filter((p) => p && p.self)[0] || null;
  const live = probes.filter((p) => p && !p.error && !p.threw);
  // Blank is a claim about EVERY frame: it needs the player's own document read, and an answer
  // from each frame (an error page answers: it has nothing). A probe that timed out, or frames
  // past the cap, leave the look undecided -- never blank.
  const answered = probes.filter((p) => p && !p.threw).length;
  return {
    found: true,
    url: String(url || '').slice(0, 200),
    failed: fail || (isError(url) ? { code: 0, desc: 'error page', url: '' } : null),
    status: own && own.status ? own.status : 0,
    frames: subtree.length,
    playing: live.some((p) => p.playing),
    ready: live.some((p) => p.ready),
    videos: live.reduce((a, p) => a + (p.videos || 0), 0),
    content: live.some((p) => (p.videos || 0) > 0 || (p.vis || 0) > 0 || (p.text || 0) > 20),
    probed: live.length,
    // every frame answered, the player's own document among them, and none were left out
    complete: !!own && !own.threw && answered === subtree.length && all <= 12,
  };
}

module.exports = { attach, check };
