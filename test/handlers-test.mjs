// Inline on*= handler contract check.
//
// Inline handlers (onclick="foo()") resolve their identifiers against the GLOBAL
// scope. Today index.html's app code is one classic <script>, so every top-level
// `function`/`let`/`const` is global and every handler resolves for free.
//
// That freebie disappears the moment the script becomes a module (or moves to
// ui.js): module top-level bindings are NOT global, so each handler identifier
// must be explicitly bridged onto window. A missed name doesn't throw at load —
// it silently does nothing when the user clicks. This test is the safety net.
//
// It checks two things:
//   1. every identifier CALLED from a handler is reachable (declared pre-split,
//      or present in ui.js's window bridge post-split);
//   2. no handler passes a BARE IDENTIFIER as an argument — e.g.
//      onclick="startGuidedTrip(tripMatch)". Bridging the function is not enough;
//      the ARGUMENT must resolve globally too, and a lexical `let` will not.
//      This rule is what catches that whole class of bug.
//
// Works before and after the split: if ui.js exists it validates against the
// bridge, otherwise against index.html's top-level declarations.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ck = (name, cond, info = '') => {
  if (cond) { pass++; }
  else { fail++; console.log(`   \x1b[31m✗\x1b[0m ${name}${info ? '  → ' + info : ''}`); }
};

// Identifiers that appear inside handler text but are never resolved from the
// global scope at click time.
const IGNORE = new Set([
  'event', 'this',
  // generation-time helpers: these run while BUILDING the html string, not on click
  'esc',
  // DOM/method names (we strip `.method(` already, but belt-and-braces)
  'stopPropagation', 'preventDefault', 'toggle', 'add', 'remove', 'contains',
  'classList', 'parentElement', 'closest',
  // literals
  'true', 'false', 'null', 'undefined',
]);

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const lines = html.split(/\r?\n/);

// ── Locate the app <script> block ──────────────────────────────────────────
const openIdx = lines.findIndex(l => l.trim() === '<script>');
const closeIdx = lines.findIndex((l, i) => i > openIdx && l.trim() === '</script>');
const hasInlineApp = openIdx !== -1 && closeIdx !== -1;

const markup = hasInlineApp ? lines.slice(0, openIdx).join('\n') : html;
const inlineScript = hasInlineApp ? lines.slice(openIdx + 1, closeIdx).join('\n') : '';

const uiPath = path.join(ROOT, 'ui.js');
const hasUi = fs.existsSync(uiPath);
const uiSrc = hasUi ? fs.readFileSync(uiPath, 'utf8') : '';

// Regions that can contain handler text: static markup + wherever the app code lives.
const generatedSrc = hasUi ? uiSrc : inlineScript;

// ── Extract handlers ───────────────────────────────────────────────────────
// Matches `onclick="..."` in real markup AND inside JS string literals.
// Stops at the closing double quote; for concatenated handlers the captured body
// contains build-time junk ('+esc(x)+') which the IGNORE list and the
// dynamic-arg rule below handle.
function handlersIn(src, region) {
  const out = [];
  for (const m of src.matchAll(/\son([a-z]+)=\\?"([^"]*)"/g)) {
    out.push({ event: m[1], body: m[2], region });
  }
  return out;
}

const handlers = [...handlersIn(markup, 'markup'), ...handlersIn(generatedSrc, hasUi ? 'ui.js' : 'index.html script')];

// Called identifiers: `name(` not preceded by a dot (so `event.stopPropagation()` is skipped).
function callsIn(body) {
  const names = [];
  for (const m of body.matchAll(/(\.)?\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (m[1] === '.') continue;             // method call on an object
    names.push(m[2]);
  }
  return names;
}

// Bare identifier arguments: `fn(tripMatch)` → ['tripMatch']; literals/dynamic → [].
function bareArgsIn(body) {
  const bare = [];
  for (const m of body.matchAll(/(\.)?\b([A-Za-z_$][\w$]*)\s*\(([^()]*)\)/g)) {
    if (m[1] === '.') continue;
    const argsText = m[3].trim();
    if (!argsText) continue;
    for (let a of argsText.split(',')) {
      a = a.trim();
      if (!a) continue;
      if (/^['"]/.test(a)) continue;                 // string literal
      if (/^-?\d/.test(a)) continue;                 // number
      if (/^(true|false|null|undefined)$/.test(a)) continue;
      if (/['"+\\]/.test(a)) continue;               // build-time concatenation, not a click-time ident
      if (/^[A-Za-z_$][\w$]*$/.test(a)) bare.push({ fn: m[2], arg: a });
    }
  }
  return bare;
}

// ── Build the set of names reachable from global scope ──────────────────────
let reachable, mode;
if (hasUi) {
  mode = 'ui.js window bridge';
  reachable = new Set();
  // Object.assign(window, { a, b, c })
  const bridge = uiSrc.match(/Object\.assign\(\s*window\s*,\s*\{([\s\S]*?)\}\s*\)/);
  if (bridge) {
    for (const m of bridge[1].matchAll(/([A-Za-z_$][\w$]*)\s*(?:,|:|$)/gm)) reachable.add(m[1]);
  }
  // explicit window.foo = ...
  for (const m of uiSrc.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) reachable.add(m[1]);
} else {
  mode = 'index.html top-level declarations';
  reachable = new Set();
  for (const m of inlineScript.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) reachable.add(m[1]);
  for (const m of inlineScript.matchAll(/^\s*(?:let|const|var)\s+([A-Za-z_$][\w$]*)/gm)) reachable.add(m[1]);
  for (const m of inlineScript.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) reachable.add(m[1]);
}

// ── Assertions ─────────────────────────────────────────────────────────────
console.log(`\n── inline handler contract (${mode}) ──\n`);

ck('found the app script block', hasInlineApp || hasUi);
ck('found inline handlers', handlers.length > 20, `${handlers.length} found`);

const missing = [];
for (const h of handlers) {
  for (const name of callsIn(h.body)) {
    if (IGNORE.has(name)) continue;
    if (!reachable.has(name)) missing.push(`${name}()  [${h.region}: on${h.event}="${h.body}"]`);
  }
}
ck('every handler function is reachable from global scope', missing.length === 0,
   missing.length ? '\n      ' + [...new Set(missing)].join('\n      ') : '');

const bares = [];
for (const h of handlers) {
  for (const b of bareArgsIn(h.body)) {
    // `esc(displayCode)` and friends run while BUILDING the string, so their args
    // are build-time locals, not click-time globals. Skip build-time callers.
    if (IGNORE.has(b.fn) || IGNORE.has(b.arg)) continue;
    bares.push(`${b.fn}(${b.arg})  [${h.region}: on${h.event}="${h.body}"]`);
  }
}
ck('no handler passes a bare identifier as an argument', bares.length === 0,
   bares.length ? '\n      ' + [...new Set(bares)].join('\n      ')
     + '\n      → the ARGUMENT must resolve globally too; a lexical `let` will not survive the module split.' : '');

console.log(`\n${fail ? '\x1b[31m' + fail + ' failed\x1b[0m, ' : ''}\x1b[32m${pass} passed\x1b[0m`);
console.log(`   ${handlers.length} handlers checked, ${reachable.size} reachable names\n`);
process.exit(fail ? 1 : 0);
