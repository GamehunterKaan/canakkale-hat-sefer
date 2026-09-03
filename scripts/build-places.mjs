/**
 * Builds data/places.json — the local POI index the map search box searches
 * before (and alongside) the online geocoder.
 *
 * Input is an Overture Maps "places" extract for the Çanakkale bbox, produced
 * by the workflow step:
 *
 *   overturemaps download --bbox=26.30,39.95,26.55,40.25 -f geojson --type=place
 *
 * WHY a second source at all: the geocoder (Photon) indexes OpenStreetMap, and
 * OSM simply doesn't have most Turkish businesses and venues. "Container Hall
 * Çanakkale" — a real bar people ask for by name — has zero matches anywhere in
 * the Çanakkale bbox in raw OSM, but Overture has it at 0.99 confidence, because
 * Overture merges Meta, Microsoft, Foursquare and AllThePlaces listings on top
 * of OSM. Shipping that extract as static JSON also means POI search keeps
 * working offline, which a live geocoder never can.
 *
 * Overture places data is CDLA-Permissive-2.0; attribution lives in the map
 * credit line and the README.
 *
 * Usage:
 *   node scripts/build-places.mjs <overture.geojson> [out.json]
 *   node scripts/build-places.mjs --self-test
 */

import { readFileSync, writeFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { MAP_BOUNDS, foldTr, haversine } from '../core.js';

// Derived from core.js's MAP_BOUNDS rather than restated: a place outside the
// box can't be planned to (applyPoint rejects it), so indexing it would be a
// dead end — and a second copy of the numbers would drift from the app's.
const [[BBOX_S, BBOX_W], [BBOX_N, BBOX_E]] = MAP_BOUNDS;
export const BBOX = { w: BBOX_W, s: BBOX_S, e: BBOX_E, n: BBOX_N };

// The exact string the workflow passes to `overturemaps download --bbox=…`, so
// the extract is clipped to the same box the app uses. Printed by --print-bbox.
export const BBOX_ARG = [BBOX.w, BBOX.s, BBOX.e, BBOX.n].join(',');

// Overture scores every place 0–1 on how confident it is the listing is real and
// current. The long tail below 0.5 is mostly dead businesses and duplicates.
export const MIN_CONFIDENCE = 0.5;

// Two listings of the same name this close together are the same place seen by
// two upstream providers (Meta + Foursquare, say) that Overture didn't conflate.
export const DEDUPE_M = 60;

// Drop listings no upstream provider has touched in this long. Measured on the
// real extract: Meta and AllThePlaces refresh constantly (median 24-28 days, 0%
// over a year), while Foursquare (median 484 d, 65% over a year) and Microsoft
// (926 d, 81%) carry a long tail of businesses that closed years ago and were
// never retired. That tail is 3% of rows and is where the ghosts live — like a
// "Sürat Kargo" branch last confirmed in June 2025 that no longer exists.
export const MAX_SOURCE_AGE_DAYS = 365;

// Every row ALSO carries an "Overture" source whose update_time is just the
// release date, identical across the dataset. Ignoring it is the whole trick:
// include it and every record looks fresh.
export function newestUpstream(p) {
  let best = null;
  for (const s of (p?.sources || [])) {
    if (s?.dataset === 'Overture' || !s?.update_time) continue;
    const t = Date.parse(s.update_time);
    if (!isNaN(t) && (best === null || t > best)) best = t;
  }
  return best;
}

const NAME_MAX = 90;
const ADDR_MAX = 46;

// The list needs one short line that tells two same-named shops apart. `locality`
// is "Çanakkale" for 92% of the extract, so it says nothing — the street from
// `freeform` does. Freeform is a full postal address ("Barbaros Mah. Atatürk
// Cad. No:12, Merkez / Çanakkale"), so keep only its leading segment.
export function shortAddress(a) {
  const raw = String(a?.freeform || '').replace(/\s+/g, ' ').trim();
  if (raw) {
    const head = raw.split(/[,/]/)[0].replace(/\s+no[:.]?\s*\d+\w*$/i, '').trim();
    if (head && head.length <= ADDR_MAX) return head;
    if (head) return head.slice(0, ADDR_MAX - 1).trimEnd() + '…';
  }
  const loc = String(a?.locality || '').replace(/\s+/g, ' ').trim();
  return loc.slice(0, ADDR_MAX);
}

export function normalizeFeature(f, now = Date.now()) {
  const p = f?.properties || {};
  const c = f?.geometry?.coordinates;
  if (!Array.isArray(c) || c.length < 2) return null;

  const lng = +(+c[0]).toFixed(5), lat = +(+c[1]).toFixed(5);   // ~1 m; halves the file size
  if (!isFinite(lat) || !isFinite(lng)) return null;
  if (lat < BBOX.s || lat > BBOX.n || lng < BBOX.w || lng > BBOX.e) return null;

  if ((p.confidence ?? 0) < MIN_CONFIDENCE) return null;

  // A stale listing is worse than a missing one: sending someone across town to
  // a shop that shut two years ago is a failure the app gets blamed for. A row
  // with no upstream date at all is kept — absent evidence isn't evidence of
  // staleness.
  const seen = newestUpstream(p);
  if (seen !== null && now - seen > MAX_SOURCE_AGE_DAYS * 86400000) return null;

  const name = String(p.names?.primary || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  if (!name) return null;

  const cat  = String(p.categories?.primary || '');
  const area = shortAddress(p.addresses?.[0]);

  return { name, cat, lat, lng, area, conf: p.confidence ?? 0 };
}

export function buildPlaces(features, { now = Date.now(), overrides = null, stats = null } = {}) {
  const kept = [];
  for (const f of features) {
    const p = normalizeFeature(f, now);
    if (p) kept.push(p);
  }
  // Highest confidence first, so the survivor of a dedupe is the best-attested
  // copy of the place.
  kept.sort((a, b) => b.conf - a.conf);

  // Bucket by folded name, then collapse near-duplicates within each bucket.
  const byName = new Map();
  const out = [];
  for (const p of kept) {
    const k = foldTr(p.name);
    const bucket = byName.get(k);
    if (bucket) {
      if (bucket.some(q => haversine(p.lat, p.lng, q.lat, q.lng) < DEDUPE_M)) continue;
      bucket.push(p);
    } else {
      byName.set(k, [p]);
    }
    out.push(p);
  }

  let final = out;
  if (overrides) {
    const res = applyOverrides(out, overrides);
    final = res.rows;
    if (stats) Object.assign(stats, res.stats);   // caller-supplied sink, no globals
  }

  // Deterministic order keeps the monthly diff to actual data changes rather
  // than upstream row shuffling.
  final.sort((a, b) => a.name.localeCompare(b.name, 'tr') || a.lat - b.lat || a.lng - b.lng);
  return final.map(p => [p.name, p.cat, p.lat, p.lng, p.area]);
}

// ── hand corrections ────────────────────────────────────────────────────────
// Upstream is right about ~6,600 places and wrong about a handful, and no
// threshold fixes a WRONG COORDINATE on an otherwise-current listing — Meta had
// Container Hall at 0.99 confidence, refreshed three weeks before this was
// written, in the wrong street. So corrections live in
// data/places-overrides.json and are re-applied on top of every rebuild:
//
//   drop: [{ name, near?: [lat,lng], reason }]                     kill a ghost
//   fix:  [{ name, near?: [lat,lng], lat?, lng?, cat?, area?, rename?, reason }]
//   add:  [{ name, lat, lng, cat?, area? }]              something upstream lacks
//
// `near` scopes a rule to one branch, so a rule about the Kepez Migros cannot
// hit the İskele one. Without it, the rule applies to every same-named row.
export const OVERRIDE_NEAR_M = 400;

function overrideMatches(rule, row) {
  if (foldTr(rule.name) !== foldTr(row.name)) return false;
  if (!Array.isArray(rule.near)) return true;
  return haversine(rule.near[0], rule.near[1], row.lat, row.lng) <= (rule.nearM ?? OVERRIDE_NEAR_M);
}

// Returns { rows, stats } — never stashes state on the function itself, so two
// builds in one process can't read each other's counts.
export function applyOverrides(rows, ov) {
  const stats = { dropped: 0, fixed: 0, added: 0, unmatched: [], dropUnmatched: [] };
  let out = rows;

  for (const rule of (ov?.drop || [])) {
    const before = out.length;
    out = out.filter(r => !overrideMatches(rule, r));
    const n = before - out.length;
    stats.dropped += n;
    // Not a problem on its own: the freshness filter may already have removed
    // the row, and the rule still earns its keep via the deny list below.
    if (!n) stats.dropUnmatched.push(rule.name);
  }

  for (const rule of (ov?.fix || [])) {
    let n = 0;
    out = out.map(r => {
      if (!overrideMatches(rule, r)) return r;
      n++;
      return {
        ...r,
        lat:  rule.lat    != null ? +(+rule.lat).toFixed(5) : r.lat,
        lng:  rule.lng    != null ? +(+rule.lng).toFixed(5) : r.lng,
        cat:  rule.cat    != null ? String(rule.cat)        : r.cat,
        area: rule.area   != null ? String(rule.area)       : r.area,
        name: rule.rename != null ? String(rule.rename)     : r.name,
      };
    });
    stats.fixed += n;
    if (!n) stats.unmatched.push(`fix "${rule.name}"`);
  }

  for (const rule of (ov?.add || [])) {
    const name = String(rule.name || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
    const lat = +(+rule.lat).toFixed(5), lng = +(+rule.lng).toFixed(5);
    if (!name || !isFinite(lat) || !isFinite(lng)) { stats.unmatched.push(`add "${rule.name}" (bad row)`); continue; }
    if (lat < BBOX.s || lat > BBOX.n || lng < BBOX.w || lng > BBOX.e) { stats.unmatched.push(`add "${name}" (outside bbox)`); continue; }
    // An added place replaces the upstream row it supersedes, rather than
    // sitting next to it as a duplicate.
    out = out.filter(r => !(foldTr(r.name) === foldTr(name) && haversine(lat, lng, r.lat, r.lng) < DEDUPE_M));
    out.push({ name, cat: String(rule.cat || ''), lat, lng, area: String(rule.area || ''), conf: 1 });
    stats.added++;
  }

  return { rows: out, stats };
}

// ── self-test ───────────────────────────────────────────────────────────────
function selfTest() {
  const mk = (name, lat, lng, conf = 0.9, extra = {}) => ({
    geometry: { type: 'Point', coordinates: [lng, lat] },
    properties: { names: { primary: name }, confidence: conf, categories: { primary: 'bar' }, ...extra },
  });
  let pass = 0, fail = 0;
  const ck = (label, cond) => { cond ? pass++ : (fail++, console.log(`   \x1b[31m✗\x1b[0m ${label}`)); };

  ck('keeps an in-bbox, confident, named place',
    buildPlaces([mk('Container Hall Çanakkale', 40.15789, 26.4147)]).length === 1);
  ck('drops low confidence',
    buildPlaces([mk('Faded Shop', 40.15, 26.41, 0.2)]).length === 0);
  ck('drops out-of-bbox',
    buildPlaces([mk('İstanbul Yeri', 41.01, 28.97)]).length === 0);
  ck('drops nameless',
    buildPlaces([{ geometry: { type: 'Point', coordinates: [26.41, 40.15] }, properties: { confidence: 1 } }]).length === 0);
  ck('drops malformed geometry',
    buildPlaces([{ properties: { names: { primary: 'X' }, confidence: 1 } }]).length === 0);
  ck('collapses the same name within 60 m',
    buildPlaces([mk('Kahve', 40.15000, 26.41000), mk('Kahve', 40.15020, 26.41000)]).length === 1);
  ck('keeps the same name far apart (real chain branches)',
    buildPlaces([mk('Migros', 40.15, 26.41), mk('Migros', 40.10, 26.38)]).length === 2);
  ck('dedupes case/diacritic variants of one name',
    buildPlaces([mk('ŞEHİTLER', 40.15, 26.41), mk('şehitler', 40.15005, 26.41)]).length === 1);
  ck('keeps the higher-confidence copy',
    buildPlaces([mk('Bar', 40.15, 26.41, 0.6), mk('Bar', 40.15005, 26.41, 0.95, { addresses: [{ locality: 'Kepez' }] })])[0][4] === 'Kepez');
  ck('emits [name, cat, lat, lng, area] rows',
    JSON.stringify(buildPlaces([mk('A', 40.15, 26.41, 0.9, { addresses: [{ locality: 'Merkez' }] })])) === '[["A","bar",40.15,26.41,"Merkez"]]');
  ck('rounds coordinates to 5 dp',
    buildPlaces([mk('B', 40.1512345678, 26.4123456789)])[0][2] === 40.15123);
  ck('sorts deterministically by name',
    buildPlaces([mk('Zebra', 40.15, 26.41), mk('Alfa', 40.16, 26.42)]).map(r => r[0]).join() === 'Alfa,Zebra');
  ck('trims and collapses whitespace in names',
    buildPlaces([mk('  Çok   Boşluklu  ', 40.15, 26.41)])[0][0] === 'Çok Boşluklu');
  ck('detail line prefers the street over the useless "Çanakkale" locality',
    buildPlaces([mk('Kafe', 40.15, 26.41, .9, { addresses: [{ freeform: 'Atatürk Caddesi No:12, Merkez / Çanakkale', locality: 'Çanakkale' }] })])[0][4] === 'Atatürk Caddesi');
  ck('detail line falls back to locality when there is no street',
    buildPlaces([mk('Kafe', 40.15, 26.41, .9, { addresses: [{ locality: 'Eceabat' }] })])[0][4] === 'Eceabat');
  ck('detail line survives a missing address entirely',
    buildPlaces([mk('Kafe', 40.15, 26.41)])[0][4] === '');
  ck('over-long street segments are ellipsised, not dropped',
    (() => { const v = buildPlaces([mk('K', 40.15, 26.41, .9, { addresses: [{ freeform: 'A'.repeat(80) + ', X' }] })])[0][4];
             return v.length <= 46 && v.endsWith('…'); })());

  // ── freshness ──
  const NOW = Date.parse('2026-09-03T00:00:00Z');
  const aged = (name, days, dataset = 'Foursquare') => ({
    geometry: { type: 'Point', coordinates: [26.41, 40.15] },
    properties: {
      names: { primary: name }, confidence: 0.9, categories: { primary: 'bar' },
      sources: [
        { dataset, update_time: new Date(NOW - days * 86400000).toISOString() },
        { dataset: 'Overture', update_time: '2026-08-14T19:46:07Z' },   // release stamp: must be ignored
      ],
    },
  });
  ck('keeps a listing confirmed this month',
    buildPlaces([aged('Fresh', 20)], { now: NOW }).length === 1);
  ck('drops a listing nobody has confirmed in over a year',
    buildPlaces([aged('Ghost', 450)], { now: NOW }).length === 0);
  ck('the Overture release stamp does not rescue a stale row',
    buildPlaces([aged('Ghost', 900)], { now: NOW }).length === 0);
  ck('keeps a row that carries no upstream date at all',
    buildPlaces([mk('Undated', 40.15, 26.41)], { now: NOW }).length === 1);
  ck('newestUpstream ignores the Overture pseudo-source',
    newestUpstream(aged('X', 10).properties) === NOW - 10 * 86400000);

  // ── hand corrections ──
  const rows = [mk('Ghost Kargo', 40.13971, 26.40819), mk('Container Hall', 40.15789, 26.4147)];
  ck('drop removes a named row',
    buildPlaces(rows, { now: NOW, overrides: { drop: [{ name: 'Ghost Kargo' }] } }).length === 1);
  ck('drop scoped by `near` spares a same-named branch elsewhere',
    buildPlaces([mk('Migros', 40.15, 26.41), mk('Migros', 40.10, 26.38)],
      { now: NOW, overrides: { drop: [{ name: 'Migros', near: [40.15, 26.41] }] } }).length === 1);
  ck('fix moves a place to corrected coordinates',
    buildPlaces(rows, { now: NOW, overrides: { fix: [{ name: 'Container Hall', lat: 40.145, lng: 26.405 }] } })
      .find(r => r[0] === 'Container Hall').slice(2, 4).join() === '40.145,26.405');
  ck('fix leaves untouched fields alone',
    buildPlaces(rows, { now: NOW, overrides: { fix: [{ name: 'Container Hall', lat: 40.145 }] } })
      .find(r => r[0] === 'Container Hall')[3] === 26.4147);
  ck('add inserts a place upstream does not have',
    buildPlaces(rows, { now: NOW, overrides: { add: [{ name: 'Yeni Yer', lat: 40.16, lng: 26.42, cat: 'cafe' }] } })
      .some(r => r[0] === 'Yeni Yer' && r[1] === 'cafe'));
  ck('add replaces the upstream row it supersedes instead of duplicating it',
    buildPlaces(rows, { now: NOW, overrides: { add: [{ name: 'Container Hall', lat: 40.15789, lng: 26.4147 }] } })
      .filter(r => r[0] === 'Container Hall').length === 1);
  ck('add outside the bbox is refused',
    !buildPlaces(rows, { now: NOW, overrides: { add: [{ name: 'Uzak', lat: 41.01, lng: 28.97 }] } })
      .some(r => r[0] === 'Uzak'));
  ck('a fix that matches nothing is reported loudly',
    (() => { const st = {};
             buildPlaces(rows, { now: NOW, stats: st, overrides: { fix: [{ name: 'Yok Böyle Bir Yer', lat: 40.15 }] } });
             return st.unmatched.length === 1; })());
  ck('a drop that matches no index row is noted separately, not as an error',
    (() => { const st = {};
             buildPlaces(rows, { now: NOW, stats: st, overrides: { drop: [{ name: 'Already Gone' }] } });
             return st.dropUnmatched.length === 1 && st.unmatched.length === 0; })());
  ck('stats are returned, not left on the function for the next call to read',
    applyOverrides([], { drop: [{ name: 'X' }] }).stats.dropUnmatched.length === 1
      && applyOverrides.lastStats === undefined);
  ck('drop rules are exported as geocoder deny rules, with the radius resolved',
    JSON.stringify(denyList({ drop: [{ name: 'Ghost', near: [40.1397123, 26.4082198], reason: 'closed' }] }))
      === '[{"name":"Ghost","near":[40.13971,26.40822],"nearM":400}]');
  ck('an explicit zero radius survives export (means: this exact pin only)',
    denyList({ drop: [{ name: 'A', near: [40.15, 26.41], nearM: 0 }] })[0].nearM === 0);
  ck('deny export drops nameless rules and a radius with no centre',
    JSON.stringify(denyList({ drop: [{ name: 'A', nearM: 120 }, { name: '' }] })) === '[{"name":"A"}]');

  // ── shared constants ──
  ck('the bbox is derived from core.js MAP_BOUNDS, not a second copy',
    BBOX.s === MAP_BOUNDS[0][0] && BBOX.w === MAP_BOUNDS[0][1]
      && BBOX.n === MAP_BOUNDS[1][0] && BBOX.e === MAP_BOUNDS[1][1]);
  ck('--print-bbox emits west,south,east,north for the Overture CLI',
    BBOX_ARG === [BBOX.w, BBOX.s, BBOX.e, BBOX.n].join(','));
  ck('dedupe folds names with the same helper the app searches with',
    foldTr('ŞEHİTLER CAMİİ') === foldTr('sehitler camii'));
  ck('corrected rows still come out name-sorted',
    buildPlaces(rows, { now: NOW, overrides: { add: [{ name: 'Aaa', lat: 40.16, lng: 26.42 }] } })[0][0] === 'Aaa');

  console.log(`\n${fail ? `\x1b[31m${fail} failed\x1b[0m, ` : ''}\x1b[32m${pass} passed\x1b[0m  (build-places self-test)\n`);
  process.exit(fail ? 1 : 0);
}

// Drop rules are ALSO shipped to the app, which applies them to live geocoder
// results. Deleting a ghost from this index is only half the job: the same
// closed business is usually in OpenStreetMap too, where the freshness filter
// cannot reach it, and the geocoder would cheerfully serve back the very row we
// just deleted. (Exactly what happened with "Sürat Kargo 18 MART": dropped from
// Overture as stale, still live in OSM as node 8804890101.)
export function denyList(ov) {
  return (ov?.drop || [])
    .map(r => {
      const e = { name: String(r.name || '').trim() };
      if (Array.isArray(r.near) && r.near.length === 2) {
        e.near = [+(+r.near[0]).toFixed(5), +(+r.near[1]).toFixed(5)];
        // Always emit the RESOLVED radius. If the app had to supply the default
        // it would be a second copy of this constant, and `nearM: 0` — the
        // natural way to write "this exact pin only" — would read as unset.
        e.nearM = r.nearM != null ? +r.nearM : OVERRIDE_NEAR_M;
      }
      return e;
    })
    .filter(e => e.name);
}

// ── main ────────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();
  // The workflow asks the script for the bbox instead of hardcoding a copy.
  if (args.includes('--print-bbox')) { console.log(BBOX_ARG); return; }

  const inPath  = args[0];
  const outPath = args[1] || 'data/places.json';
  const ovPath  = args[2] || 'data/places-overrides.json';
  if (!inPath) {
    console.error('usage: node scripts/build-places.mjs <overture.geojson> [out.json]');
    process.exit(2);
  }

  const raw = JSON.parse(readFileSync(inPath, 'utf8'));
  const features = Array.isArray(raw) ? raw : (raw.features || []);
  console.log(`Read ${features.length} Overture features from ${inPath}`);

  let overrides = null;
  try {
    overrides = JSON.parse(readFileSync(ovPath, 'utf8'));
    const n = (overrides.drop?.length || 0) + (overrides.fix?.length || 0) + (overrides.add?.length || 0);
    console.log(`Loaded ${n} hand correction(s) from ${ovPath}`);
  } catch { console.log(`No overrides file at ${ovPath} — using upstream data as-is`); }

  const st = {};
  const places = buildPlaces(features, { overrides, stats: st });
  console.log(`  → ${places.length} places after confidence/freshness/bbox/dedupe filtering`);
  if (overrides && st.dropped != null) {
    console.log(`  → corrections: ${st.dropped} dropped, ${st.fixed} fixed, ${st.added} added`);
    for (const n of st.dropUnmatched)
      console.log(`  · drop "${n}" matched no index row — kept as a geocoder deny rule`);
    // A fix/add that matches nothing is either a typo or a correction upstream
    // has since made itself — either way it needs a human look, so say so loudly.
    for (const u of st.unmatched) console.warn(`  ! override matched nothing: ${u}`);
  }
  if (!places.length) {
    console.error('Refusing to write an empty index — the extract looks wrong.');
    process.exit(1);
  }

  const deny = denyList(overrides);
  if (deny.length) console.log(`  → ${deny.length} deny rule(s) shipped for live geocoder results`);

  // Keep the previous fetchedAt when the payload is byte-identical, so an
  // unchanged monthly run produces no diff and therefore no commit.
  let fetchedAt = new Date().toISOString();
  try {
    const prev = JSON.parse(readFileSync(outPath, 'utf8'));
    if (JSON.stringify(prev.places) === JSON.stringify(places)
     && JSON.stringify(prev.deny || []) === JSON.stringify(deny)) {
      console.log('Places unchanged since last run — keeping previous fetchedAt.');
      fetchedAt = prev.fetchedAt || fetchedAt;
    }
  } catch {}

  writeFileSync(outPath, JSON.stringify({
    fetchedAt,
    source: 'Overture Maps places (CDLA-Permissive-2.0)',
    bbox: [BBOX.w, BBOX.s, BBOX.e, BBOX.n],
    minConfidence: MIN_CONFIDENCE,
    count: places.length,
    deny,
    places,
  }));
  console.log(`Wrote ${outPath}`);
}

// Only run when executed directly. Every helper above is exported for reuse, and
// an unconditional main() would exit(2) the moment a test imported this file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
