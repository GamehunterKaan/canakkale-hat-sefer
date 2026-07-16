// core.js contract: it must stay HEADLESS.
//
// The whole point of core.js is that it runs with no webpage — so it can be
// imported straight from GitHub Pages (or vendored into Node) and used without a
// browser. That invariant is easy to break by accident: one `document.getElementById`
// or `localStorage.getItem` slipped into a helper and core silently only works in
// a page again.
//
// This test enforces it two ways:
//   1. RUNTIME — importing core.js under bare node, where document/window/
//      localStorage/L genuinely do not exist. If core touches them at module
//      scope, the import throws.
//   2. SOURCE — a scan for browser-only identifiers, which catches references
//      inside function bodies that a mere import would never execute.
//
// Note: `navigator` exists in Node 21+ (navigator.userAgent), so its absence is
// NOT a valid runtime proof — the source scan is what covers it.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ck = (name, cond, info = '') => {
  if (cond) pass++;
  else { fail++; console.log(`   \x1b[31m✗\x1b[0m ${name}${info ? '  → ' + info : ''}`); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

console.log('\n── core.js is headless ──\n');

for (const g of ['document', 'window', 'localStorage', 'L']) {
  ck(`node runtime really has no ${g} (so the import below is a real proof)`,
     typeof globalThis[g] === 'undefined');
}

const core = await import('../core.js');
ck('core.js imports under bare node', typeof core === 'object');
ck('core.js exports a usable surface', Object.keys(core).length > 20, Object.keys(core).length + ' exports');

// Source scan — strip comments/strings first so prose like "the DOM" can't trip it.
const raw = fs.readFileSync(path.join(ROOT, 'core.js'), 'utf8');
const stripped = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  .replace(/'(?:\\.|[^'\\])*'/g, "''")
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/`(?:\\.|[^`\\])*`/g, '``');

const FORBIDDEN = [
  [/\bdocument\s*\./, 'document.'],
  [/\bwindow\s*\./, 'window.'],
  [/\blocalStorage\b/, 'localStorage'],
  [/\bsessionStorage\b/, 'sessionStorage'],
  [/\bnavigator\s*\./, 'navigator.'],
  [/\bL\s*\.\s*(map|marker|polyline|layerGroup|circleMarker|divIcon|tileLayer|canvas|DomEvent)\b/, 'Leaflet L.*'],
  [/\balert\s*\(/, 'alert('],
];
for (const [re, label] of FORBIDDEN) {
  const m = stripped.match(re);
  ck(`core.js never touches ${label}`, !m,
     m ? 'found: ' + stripped.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ') : '');
}

console.log('\n── pure helpers behave ──\n');

// geo — haversine(la1, lo1, la2, lo2), scalars not objects
const d = core.haversine(40.146, 26.409, 40.128, 26.371);
ck('haversine returns metres for a known Çanakkale hop', near(d, 3800, 600), Math.round(d) + ' m');
ck('haversine of a point with itself is 0', core.haversine(40.1, 26.4, 40.1, 26.4) === 0);

// service-day time frame: anything before 04:00 belongs to the previous day
ck('_tmMin maps 01:30 into the next service day', core._tmMin('01:30') === 90 + 1440, String(core._tmMin('01:30')));
ck('_tmMin leaves 07:00 alone', core._tmMin('07:00') === 420, String(core._tmMin('07:00')));
ck('_schedFrame wraps early-morning clock minutes', core._schedFrame(90) === 1530, String(core._schedFrame(90)));
ck('_schedFrame leaves afternoon alone', core._schedFrame(14 * 60) === 840, String(core._schedFrame(840)));

// wrap-aware "next N departures"
ck('_nextTimes is wrap-aware across midnight',
   JSON.stringify(core._nextTimes(['23:50', '00:20', '07:00'], 2)) === JSON.stringify(['23:50', '00:20']));

// taxi: 100₺ open + 50₺/km, 200₺ minimum, rounded to 5₺
const t5 = core._taxiEstimate(5000, 600);
ck('taxi 5 km = 100 open + 5×50', t5.tl === 350, JSON.stringify(t5));
const tShort = core._taxiEstimate(300, 120);
ck('taxi enforces the 200₺ minimum', tShort.tl >= 200, JSON.stringify(tShort));

// schedule code normalisation
ck('schedCodeNorm upper-cases Turkish route codes', core.schedCodeNorm('ç-11k ekspres').includes('Ç-11K'));

// guided geometry
ck('withinM true just inside the radius', core.withinM({ lat: 40.146, lng: 26.409 }, { lat: 40.1461, lng: 26.4091 }, 35));
ck('withinM false well outside the radius', !core.withinM({ lat: 40.146, lng: 26.409 }, { lat: 40.20, lng: 26.50 }, 35));

// i18n dictionary
ck('STR has both languages', !!core.STR.tr && !!core.STR.en);
ck('STR tr/en have the same keys',
   Object.keys(core.STR.tr).length === Object.keys(core.STR.en).length,
   `${Object.keys(core.STR.tr).length} vs ${Object.keys(core.STR.en).length}`);

// constants survived the move
ck('planner constants exported', core.MINS_PER_STOP === 1.5 && core.MAX_WAIT_MIN === 240);
ck('guided constants exported', core.GUIDED_ARRIVE_M === 35 && core.GUIDED_BOARDED_M === 70);

// ── The actual point: plan a real trip with no webpage ─────────────────────
// This is the requirement in one block — init() + planTrips() under bare node,
// no DOM, no Leaflet, no map. If this passes, the app's logic is genuinely
// reusable outside the page.
console.log('\n── plans a real trip headlessly ──\n');

const schedule = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/schedule.json'), 'utf8'));
const stops = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/stops.json'), 'utf8'));

// Inject the data (no network); init() would otherwise self-fetch from Pages.
const ds = await core.init({ schedule, stops });
ck('init() accepts injected data with zero I/O', !!ds.schedule && !!ds.stops);
ck('init() builds the path cache from stops.json', ds.pathCache.length > 0, ds.pathCache.length + ' paths');
ck('getActiveSchedule() resolves a schedule for today', !!core.getActiveSchedule(),
   core.getActiveSchedule()?.id);
ck('getActiveRoutes() returns routes', Object.keys(core.getActiveRoutes()).length > 0,
   Object.keys(core.getActiveRoutes()).length + ' routes');

// Otogar → Halkbahçesi, the trip from the direction bug earlier in this project.
const ORIGIN = { lat: 40.1553, lng: 26.4211 };   // Otogar
const DEST   = { lat: 40.1467, lng: 26.4056 };   // Halk Bahçesi

// live:false keeps this deterministic and off the kentkart network; walkMatrix is
// stubbed to null so Valhalla isn't required either — planTrips then falls back to
// haversine × WALK_DETOUR_FACTOR, exactly as it does when Valhalla is unreachable.
const res = await core.planTrips(ORIGIN, DEST, {
  settings: { walkRadius: 800, walkSpeedMpm: 75 },
  live: false,
  walkMatrix: async () => null,
});

ck('planTrips returns a result object (not the cancelled null)', res && Array.isArray(res.list));
ck('planTrips finds at least one trip', res && res.list.length > 0, res ? res.list.length + ' trips' : 'null');
if (res?.list?.length) {
  const m = res.list[0];
  ck('trip has board/alight stop objects', !!m.board?.stopName && !!m.alight?.stopName,
     `${m.board?.stopName} → ${m.alight?.stopName}`);
  ck('trip carries a route code', !!(m.path?.displayRouteCode || m.isMultiLeg));
  ck('trips are ranked by total ETA', res.list.every((x, i, a) => i === 0 || a[i - 1]._eta <= x._eta));
  console.log('     e.g. ' + res.list.slice(0, 3).map(x =>
    (x.isMultiLeg ? '[transfer] ' : '[direct] ') +
    (x.path?.displayRouteCode || (x.leg1?.path?.displayRouteCode + '+' + x.leg2?.path?.displayRouteCode)) +
    '  ETA ' + Math.round(x._eta) + ' dk').join('\n     '));
}

// The LIVE refinement pass — the one planTrips path with no coverage before now.
// It is skipped entirely when live:false, which is exactly how a missing
// LIVE_RANK_MAX_FETCH shipped: every headless test passed while the real app threw
// "ReferenceError: LIVE_RANK_MAX_FETCH is not defined" on the first search. Stub
// fetchLive so this runs deterministically, with no kentkart network.
const seen = [];
const liveRes = await core.planTrips(ORIGIN, DEST, {
  settings: { walkRadius: 800, walkSpeedMpm: 75 },
  live: true,                                   // ← exercises the block that broke
  walkMatrix: async () => null,
  fetchLive: async (code, dir) => {
    seen.push(code + '/' + dir);
    return [];                                  // no buses out there → schedule fallback
  },
});
ck('planTrips live pass runs without throwing', !!liveRes && Array.isArray(liveRes.list),
   liveRes ? liveRes.list.length + ' trips' : String(liveRes));
ck('planTrips live pass actually queried live buses', seen.length > 0, seen.length + ' route/dir fetches');
ck('live fetches are capped by LIVE_RANK_MAX_FETCH', seen.length <= core.LIVE_RANK_MAX_FETCH,
   `${seen.length} <= ${core.LIVE_RANK_MAX_FETCH}`);
ck('live pass with no buses still yields schedule-based trips', !!liveRes && liveRes.list.length > 0);

// Cancellation must stay distinguishable from "no trips found".
const cancelled = await core.planTrips(ORIGIN, DEST, {
  settings: { walkRadius: 800, walkSpeedMpm: 75 }, live: false,
  walkMatrix: async () => null, isCancelled: () => true,
});
ck('planTrips returns null when cancelled (never conflated with empty)', cancelled === null);

// ── Arrive-by (backward) planning ────────────────────────────────────────────
console.log('\n── arrive-by (backward) planning ──\n');

// Backward-selection helpers: times [600, 660, 720] + 10 min travel → the bus
// is at the stop at 610 / 670 / 730.
ck('_latestBoardAt picks the latest bus inside the window',
   core._latestBoardAt([600, 660, 720], 10, 700, 0) === 670);
ck('_latestBoardAt respects the earliest (reachability) bound',
   core._latestBoardAt([600, 660, 720], 10, 700, 700) === null);
ck('_latestBoardAt is null when every bus misses the deadline',
   core._latestBoardAt([600], 0, 599, 0) === null);
ck('_earliestBoardAt finds the first catchable bus',
   core._earliestBoardAt([600, 660], 10, 615) === 670);
ck('_earliestBoardAt is null when the day is over',
   core._earliestBoardAt([600], 0, 601) === null);

const noNet = { settings: { walkRadius: 800, walkSpeedMpm: 75 }, live: false, walkMatrix: async () => null };
const NOW = 10 * 60, ARRIVE_BY = 20 * 60;   // fixed 10:00 → "be there by 20:00", deterministic

const back = await core.planTrips(ORIGIN, DEST, { ...noNet, nowMins: NOW, arriveByMins: ARRIVE_BY });
ck('arrive-by returns a result object', !!back && Array.isArray(back.list));
ck('arrive-by finds trips', !!back && back.list.length > 0, back ? back.list.length + ' trips' : 'null');
if (back?.list?.length) {
  ck('every arrive-by trip lands by the deadline',
     back.list.every(m => m._arriveAt <= ARRIVE_BY + 1e-9),
     back.list.map(m => Math.round(m._arriveAt)).join(','));
  ck('every arrive-by trip carries leave/board/arrive clocks',
     back.list.every(m => m._leaveAt != null && m._boardAt != null && m._arriveAt != null));
  ck('no arrive-by departure is in the past', back.list.every(m => m._leaveAt >= NOW - 1e-9));
  ck('_eta equals arrive − leave', back.list.every(m => Math.abs(m._eta - (m._arriveAt - m._leaveAt)) <= 0.51));
  console.log('     e.g. ' + back.list.slice(0, 3).map(x =>
    (x.isMultiLeg ? '[transfer] ' : '[direct] ') +
    (x.path?.displayRouteCode || (x.leg1?.path?.displayRouteCode + '+' + x.leg2?.path?.displayRouteCode)) +
    '  leave ' + Math.round(x._leaveAt) + ' → arrive ' + Math.round(x._arriveAt)).join('\n     '));
}

// Latest-bus selection: pushing the deadline 60 min earlier can only move the
// same direct trip's departure EARLIER (never later).
const backEarly = await core.planTrips(ORIGIN, DEST, { ...noNet, nowMins: NOW, arriveByMins: ARRIVE_BY - 60 });
{
  const key = m => m.path.displayRouteCode + '|' + m.path.direction;
  const late = new Map((back?.list || []).filter(m => !m.isMultiLeg).map(m => [key(m), m]));
  let compared = 0, monotone = true;
  for (const m of (backEarly?.list || []).filter(m => !m.isMultiLeg)) {
    const l = late.get(key(m));
    if (!l) continue;
    compared++;
    if (l._leaveAt < m._leaveAt - 1e-6) monotone = false;
  }
  ck('arrive-by picks the latest feasible bus (later deadline ⇒ same-or-later departure)',
     compared > 0 && monotone, compared + ' routes compared');
}

// Transfer chaining on an O/D pair that yields transfer options (YENİ HASTANE →
// FEN EDEBİYAT FAKÜLTESİ — a public-landmark pair with several transfer routes).
{
  const stopArr = Object.values(stops.stops).map(v => Array.isArray(v) ? v[1] : v);
  const byId = id => stopArr.find(s => String(s.stopId) === String(id));
  const YENIHASTANE = byId(447), FENED = byId(308);
  const xr = await core.planTrips({ lat: +YENIHASTANE.lat, lng: +YENIHASTANE.lng }, { lat: +FENED.lat, lng: +FENED.lng },
                                   { ...noNet, nowMins: NOW, arriveByMins: ARRIVE_BY });
  const xf = xr?.list?.find(m => m.isMultiLeg);
  ck('arrive-by finds a transfer trip on a transfer-bearing pair', !!xf,
     xr ? xr.list.length + ' trips, ' + xr.list.filter(m => m.isMultiLeg).length + ' transfers' : 'null');
  if (xf) {
    ck('transfer trip lands by the deadline', xf._arriveAt <= ARRIVE_BY + 1e-9, String(xf._arriveAt));
    ck('transfer trip carries the leg-2 board clock', xf._leg2BoardAt != null);
    const st1 = xf.leg1.path.busStopList || [];
    const bi = st1.findIndex(s => s.stopId === xf.leg1.board.stopId);
    const xi = st1.findIndex(s => s.stopId === xf.leg1.alight.stopId);
    const ride1 = core._rideMins(st1, bi, xi);
    const walkT = xf.leg2.transferWalkM / 75;
    ck('legs chain: leg1 arrival + transfer walk ≤ leg2 board',
       xf._boardAt + ride1 + walkT <= xf._leg2BoardAt + 0.51,
       `${(xf._boardAt + ride1 + walkT).toFixed(1)} vs ${xf._leg2BoardAt.toFixed(1)}`);
    ck('arrive-by leg 1 has no up-front wait (you leave just in time)', xf.leg1.wait === 0);
    ck('arrive-by transfer wait is culled at MAX_WAIT_MIN like forward mode',
       xr.list.filter(m => m.isMultiLeg).every(m => m.leg2.wait < core.MAX_WAIT_MIN));
  }
}

// Infeasible deadline (04:30) — empty result, NOT null (null means cancelled).
const none = await core.planTrips(ORIGIN, DEST, { ...noNet, nowMins: NOW, arriveByMins: 4 * 60 + 30 });
ck('infeasible deadline yields { list: [], relaxed: false }, not null',
   !!none && Array.isArray(none.list) && none.list.length === 0 && none.relaxed === false,
   JSON.stringify(none));

// Forward mode must be untouched when arriveByMins is absent/null.
const fwd1 = await core.planTrips(ORIGIN, DEST, { ...noNet, nowMins: NOW });
const fwd2 = await core.planTrips(ORIGIN, DEST, { ...noNet, nowMins: NOW, arriveByMins: null });
const sig = r => JSON.stringify(r.list.map(m => [m.isMultiLeg, m._eta, m._wait ?? m.leg1.wait]));
ck('forward result identical with arriveByMins omitted vs null', sig(fwd1) === sig(fwd2));
ck('forward trips carry no arrive-by clocks', fwd1.list.every(m => m._leaveAt == null && m._arriveAt == null));

console.log(`\n${fail ? '\x1b[31m' + fail + ' failed\x1b[0m, ' : ''}\x1b[32m${pass} passed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
