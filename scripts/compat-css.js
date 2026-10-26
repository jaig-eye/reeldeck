#!/usr/bin/env node
/*
 * Writes compat.css: fallbacks for browser engines older than the stylesheets assume.
 *
 * LG's webOS 6 (2021 sets) runs Chromium 79. styles.css and stage.css use four things it does
 * not have, and each fails quietly but badly there:
 *   inset          the Stage's layers, scrims and overlays collapse to 0x0
 *   color-mix()    the declaration is dropped: scrims and tints vanish
 *   flex gap       79 knows gap for grid only: flex items touch
 *   aspect-ratio   boxes whose content is absolutely placed (the player) are 0px tall
 *
 * Every rule written here sits behind a test that only an old engine passes -- @supports not
 * (...), or html.no-flexgap, which app.js sets after measuring -- so a current browser loads
 * the file and applies none of it. Run it after editing either stylesheet:
 *   node scripts/compat-css.js            (npm run compat)
 *   node scripts/compat-css.js --check    exits 1 if compat.css is out of date (CI)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCES = ['styles.css', 'stage.css'];          // load order, as in index.html
const OUT = path.join(ROOT, 'compat.css');

/* ---------------------------------------------------------------- a small CSS reader
   Enough for these two files: comments, strings, nested @media/@supports, rules. Keyframes,
   font faces and other at-rules are passed over whole. */
function parse(css) {
  const rules = [];
  let i = 0;
  const n = css.length;
  function skipComment() { const e = css.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; }
  // Read up to (not including) one of the stop characters at depth 0, honouring strings,
  // comments and parentheses.
  function readUntil(stops) {
    let out = '', depth = 0;
    while (i < n) {
      const c = css[i];
      if (c === '/' && css[i + 1] === '*') { skipComment(); continue; }
      if (c === '"' || c === "'") {
        const q = c; out += c; i++;
        while (i < n && css[i] !== q) { if (css[i] === '\\') { out += css[i++]; } out += css[i++]; }
        out += css[i++] || ''; continue;
      }
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (depth === 0 && stops.indexOf(c) >= 0) return out;
      out += c; i++;
    }
    return out;
  }
  function block(ctx) {
    while (i < n) {
      const pre = readUntil('{};').trim();
      const c = css[i];
      if (c === '}') { i++; return; }
      if (c === ';') { i++; continue; }          // @import / @charset and the like
      if (c !== '{') return;
      i++;
      if (/^@(media|supports)\b/i.test(pre)) { block(ctx.concat(pre.replace(/\s+/g, ' '))); continue; }
      if (pre.charAt(0) === '@') { skipBlock(); continue; }   // @keyframes, @font-face, @property, @container...
      const body = readUntil('}'); i++;
      rules.push({ ctx: ctx, sel: pre.replace(/\s+/g, ' '), decls: splitDecls(body) });
    }
  }
  function skipBlock() {
    let depth = 1;
    while (i < n && depth) {
      const c = css[i];
      if (c === '/' && css[i + 1] === '*') { skipComment(); continue; }
      if (c === '"' || c === "'") { const q = c; i++; while (i < n && css[i] !== q) { if (css[i] === '\\') i++; i++; } i++; continue; }
      if (c === '{') depth++; else if (c === '}') depth--;
      i++;
    }
  }
  block([]);
  return rules;
}

function splitDecls(body) {
  const out = [];
  let cur = '', depth = 0, q = '';
  for (let k = 0; k < body.length; k++) {
    const c = body[k];
    if (q) { cur += c; if (c === '\\') { cur += body[++k] || ''; } else if (c === q) q = ''; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '/' && body[k + 1] === '*') { const e = body.indexOf('*/', k + 2); k = e < 0 ? body.length : e + 1; continue; }
    if (c === '(') depth++; else if (c === ')') depth--;
    if (c === ';' && depth === 0) { push(cur); cur = ''; continue; }
    cur += c;
  }
  push(cur);
  return out;
  function push(s) {
    const t = s.trim(); if (!t) return;
    const m = /^([-a-zA-Z]+)\s*:\s*([\s\S]+)$/.exec(t);
    if (!m) return;
    let val = m[2].replace(/\s+/g, ' ').trim(), imp = '';   // one line, so the output is the same on every OS
    if (/!important$/i.test(val)) { imp = ' !important'; val = val.replace(/\s*!important$/i, ''); }
    out.push({ prop: m[1].toLowerCase(), val: val, imp: imp });
  }
}

// Split on top-level separators (whitespace or commas), keeping parentheses whole.
function topSplit(s, sep) {
  const out = []; let cur = '', depth = 0;
  for (const c of s) {
    if (c === '(') depth++; else if (c === ')') depth--;
    if (depth === 0 && (sep === ' ' ? /\s/.test(c) : c === sep)) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/* ---------------------------------------------------------------- colours, for color-mix() */
function rootVars(rules) {
  const vars = {};
  rules.filter((r) => !r.ctx.length && r.sel === ':root').forEach((r) => r.decls.forEach((d) => {
    if (d.prop.indexOf('--') === 0 && !(d.prop in vars)) vars[d.prop] = d.val;
  }));
  // Set at run time by the house lights (app.js ambientSet); a neutral stand-in here.
  if (!vars['--ambient']) vars['--ambient'] = 'rgb(80, 110, 150)';
  return vars;
}
function parseColor(s, vars, depth) {
  s = s.trim();
  if ((depth || 0) > 6) return null;
  let m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(s);
  if (m) {
    if (m[1] in vars) return parseColor(vars[m[1]], vars, (depth || 0) + 1);
    return m[2] ? parseColor(m[2], vars, (depth || 0) + 1) : null;
  }
  if (/^transparent$/i.test(s)) return [0, 0, 0, 0];
  if (/^black$/i.test(s)) return [0, 0, 0, 1];
  if (/^white$/i.test(s)) return [255, 255, 255, 1];
  m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((x) => x + x).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  m = /^rgba?\(([^)]*)\)$/i.exec(s);
  if (m) {
    const parts = m[1].replace('/', ',').split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const a = parts[3] === undefined ? 1 : (/%$/.test(parts[3]) ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]));
    return [parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2]), a];
  }
  m = /^color-mix\(([\s\S]*)\)$/i.exec(s);
  if (m) return mix(m[1], vars, (depth || 0) + 1);
  return null;
}
// color-mix(in <space>, A [p%], B [q%]) -- mixed in sRGB with premultiplied alpha, which is close
// enough for a fallback whatever space the original names.
function mix(args, vars, depth) {
  const parts = topSplit(args, ',');
  if (parts.length !== 3 || !/^in\s/i.test(parts[0])) return null;
  const side = (p) => { const m = /^([\s\S]*?)\s+([\d.]+)%$/.exec(p); return m ? { c: m[1], p: parseFloat(m[2]) / 100 } : { c: p, p: null }; };
  const a = side(parts[1]), b = side(parts[2]);
  let pa = a.p, pb = b.p;
  if (pa === null && pb === null) { pa = 0.5; pb = 0.5; } else if (pa === null) pa = 1 - pb; else if (pb === null) pb = 1 - pa;
  const sum = pa + pb; if (!(sum > 0)) return null;
  pa /= sum; pb /= sum;
  const ca = parseColor(a.c, vars, depth), cb = parseColor(b.c, vars, depth);
  if (!ca || !cb) return null;
  const alpha = ca[3] * pa + cb[3] * pb;
  if (alpha === 0) return [0, 0, 0, 0];
  const ch = (k) => (ca[k] * ca[3] * pa + cb[k] * cb[3] * pb) / alpha;
  return [ch(0), ch(1), ch(2), alpha];
}
const rgba = (c) => 'rgba(' + c.slice(0, 3).map((x) => Math.round(x)).join(', ') + ', ' + (+c[3].toFixed(3)) + ')';
// Every color-mix() in a value replaced by its computed colour; null if any cannot be worked out.
function resolveMixes(val, vars) {
  let out = '', i = 0, failed = false;
  while (i < val.length) {
    const k = val.toLowerCase().indexOf('color-mix(', i);
    if (k < 0) { out += val.slice(i); break; }
    out += val.slice(i, k);
    let depth = 0, j = k + 'color-mix'.length;
    for (; j < val.length; j++) { if (val[j] === '(') depth++; else if (val[j] === ')') { depth--; if (!depth) break; } }
    const c = parseColor(val.slice(k, j + 1), vars, 0);
    if (!c) { failed = true; break; }
    out += rgba(c);
    i = j + 1;
  }
  return failed ? null : out;
}

/* ---------------------------------------------------------------- the fallbacks */
function insetSides(val) {
  const v = topSplit(val, ' ');
  if (!v.length || v.length > 4) return null;
  const [t, r = t, b = t, l = r] = v;
  return { top: t, right: r, bottom: b, left: l };
}
function flexGapOf(rule) {
  const get = (p) => { const d = rule.decls.filter((x) => x.prop === p).pop(); return d && d.val; };
  const display = get('display') || '';
  const isFlex = /(^|\s)(inline-)?flex\b/.test(display) || get('flex-direction') || get('flex-flow') || get('flex-wrap');
  if (!isFlex || /grid/.test(display)) return null;
  const gap = get('gap'), colGap = get('column-gap'), rowGap = get('row-gap');
  const g = gap ? topSplit(gap, ' ') : [];
  const dir = (get('flex-direction') || get('flex-flow') || 'row').split(/\s+/)[0];
  const column = /^column/.test(dir);
  const main = column ? (rowGap || g[0]) : (colGap || g[1] || g[0]);
  if (!main || /^(0|0px|normal)$/.test(main)) return null;
  return { column: column, size: main };
}

function build() {
  const rules = SOURCES.flatMap((f) => parse(fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n?/g, '\n')));
  const vars = rootVars(rules);
  const wrap = (ctx, inner) => ctx.reduceRight((acc, c) => c + ' {\n' + acc.replace(/^/gm, '  ') + '\n}', inner);
  const sections = { inset: [], mix: [], logical: [], gap: [] };
  let skippedMix = 0;
  for (const r of rules) {
    const sels = topSplit(r.sel, ',');
    const ins = [], mixes = [], logical = [];
    for (const d of r.decls) {
      if (d.prop === 'inset') {
        const s = insetSides(d.val);
        if (s) ins.push(`top: ${s.top}${d.imp}; right: ${s.right}${d.imp}; bottom: ${s.bottom}${d.imp}; left: ${s.left}${d.imp};`);
      }
      if (/color-mix\(/i.test(d.val)) {
        const v = resolveMixes(d.val, vars);
        if (v) mixes.push(`${d.prop}: ${v}${d.imp};`); else skippedMix++;
      }
      const lm = /^(margin|padding)-inline$/.exec(d.prop);
      if (lm) { const v = topSplit(d.val, ' '); logical.push(`${lm[1]}-left: ${v[0]}${d.imp}; ${lm[1]}-right: ${v[1] || v[0]}${d.imp};`); }
    }
    if (ins.length) sections.inset.push(wrap(r.ctx, `${r.sel} { ${ins.join(' ')} }`));
    if (mixes.length) sections.mix.push(wrap(r.ctx, `${r.sel} { ${mixes.join(' ')} }`));
    if (logical.length) sections.logical.push(wrap(r.ctx, `${r.sel} { ${logical.join(' ')} }`));
    const fg = flexGapOf(r);
    if (fg) {
      const kids = sels.filter((s) => s.indexOf('::') < 0).map((s) => `html.no-flexgap ${s} > * + *`);
      if (kids.length) sections.gap.push(wrap(r.ctx, `${kids.join(',\n')} { margin-${fg.column ? 'top' : 'left'}: ${fg.size}; }`));
    }
  }
  const head = `/* GENERATED by scripts/compat-css.js from ${SOURCES.join(' and ')} -- do not edit; run \`npm run compat\`.
   Fallbacks for engines older than those files assume (LG webOS 6 = Chromium 79). Every rule
   is behind a test only an old engine passes, so current browsers apply none of it. */\n`;
  const block = (test, list) => list.length ? `${test} {\n${list.join('\n').replace(/^/gm, '  ')}\n}\n` : '';
  const handWritten = `
/* Boxes that take their height from aspect-ratio and hold absolutely placed content, so without
   it they are 0px tall: the player above all. Padding sets the ratio instead; what is inside is
   placed over it. (Written by hand in scripts/compat-css.js.) */
@supports not (aspect-ratio: 1 / 1) {
  .card .poster, .sk.poster { height: 0; padding-top: 150%; }
  .cw-card .poster { padding-top: 56.25%; }
  .card .poster > img { position: absolute; top: 0; left: 0; }
  .epx-thumb { height: 0; padding-top: 56.25%; }
  .epx-thumb > img { position: absolute; top: 0; left: 0; }
  .player-frame, .modal .video-wrap { height: 0; padding-top: 56.25%; }
  .player-frame.cinema { height: 100vh; padding-top: 0; }
  .genre-tile { min-height: 110px; }
}
`;
  return head
    + '\n/* inset -> top/right/bottom/left */\n' + block('@supports not (inset: 0)', sections.inset)
    + '\n/* color-mix() -> the colour it makes with the default (Midnight) theme */\n'
    + block('@supports not (color: color-mix(in srgb, red 50%, blue))', sections.mix)
    + '\n/* margin-inline / padding-inline -> left and right */\n' + block('@supports not (margin-inline: 0)', sections.logical)
    + '\n/* flex gap -> margins between the children (html.no-flexgap: app.js measures it) */\n' + sections.gap.join('\n') + '\n'
    + handWritten
    + (skippedMix ? `\n/* ${skippedMix} color-mix() declaration(s) could not be worked out and have no fallback. */\n` : '');
}

const css = build().replace(/\r\n?/g, '\n');   // LF on every OS, whatever this file was saved with
if (process.argv.includes('--check')) {
  const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n?/g, '\n') : '';   // a Windows checkout has CRLF
  if (have !== css) { console.error('compat.css is out of date: run npm run compat'); process.exit(1); }
  console.log('compat.css is up to date');
} else {
  fs.writeFileSync(OUT, css);
  const count = (re) => (css.match(re) || []).length;
  console.log(`compat.css written: ${count(/top: /g)} inset, ${count(/rgba\(/g)} colour, ${count(/html\.no-flexgap/g)} flex-gap fallbacks`);
}
