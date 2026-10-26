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
   JSON.stringify(core._nextTimes(['23:50', '00:20', '07:00'], 2, 23 * 60)) === JSON.stringify(['23:50', '00:20']));
ck('_nextTimes after midnight puts the early-morning run first',
   JSON.stringify(core._nextTimes(['23:50', '00:20', '07:00'], 2, 60)) === JSON.stringify(['07:00', '23:50']));

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
// Pinned to 10:00: near a route's end of service, a just-passed last bus is
// fetched on top of the cap (live-only, see "last bus still on the road"), which
// would make the cap check below depend on the clock CI happens to run at.
const seen = [];
const liveRes = await core.planTrips(ORIGIN, DEST, {
  settings: { walkRadius: 800, walkSpeedMpm: 75 },
  nowMins: 10 * 60,
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

// ── Shareable trips: buildTripFromSpec reconstructs the exact trip ──────────
console.log('\n── buildTripFromSpec (share links) ──\n');

// The share link pins a trip by identity; reconstruction must agree with what
// planTrips produced for the same inputs — byte-for-byte on the fields the UI
// renders. This parity check is what stops the two code paths from drifting.
{
  const specOf = m => m.isMultiLeg
    ? { legs: [
        { code: m.leg1.path.displayRouteCode, dir: m.leg1.path.direction, board: m.leg1.board.stopId, alight: m.leg1.alight.stopId },
        { code: m.leg2.path.displayRouteCode, dir: m.leg2.path.direction, board: m.leg2.board.stopId, alight: m.leg2.alight.stopId },
      ] }
    : { legs: [{ code: m.path.displayRouteCode, dir: m.path.direction, board: m.board.stopId, alight: m.alight.stopId }] };

  // Forward direct parity (Otogar → Halk Bahçesi, fixed 10:00).
  const fw = await core.planTrips(ORIGIN, DEST, { ...noNet, nowMins: NOW });
  const fd = fw.list.find(m => !m.isMultiLeg);
  ck('parity setup: forward plan has a direct trip', !!fd);
  if (fd) {
    const rb = core.buildTripFromSpec({ origin: ORIGIN, dest: DEST, ...specOf(fd) }, { ...noNet, nowMins: NOW });
    ck('direct rebuild: same route+direction', rb && rb.path.displayRouteCode === fd.path.displayRouteCode && rb.path.direction === fd.path.direction);
    ck('direct rebuild: same board/alight stops', rb && rb.board.stopId === fd.board.stopId && rb.alight.stopId === fd.alight.stopId);
    ck('direct rebuild: same wait and ETA', rb && rb._wait === fd._wait && rb._eta === fd._eta, rb ? `${rb._wait}/${rb._eta} vs ${fd._wait}/${fd._eta}` : 'null');
    ck('direct rebuild: same walks', rb && rb.walkB === fd.walkB && rb.walkA === fd.walkA);
    ck('direct rebuild: same last-bus flag', rb && rb._lastBus === fd._lastBus);
  }

  // Arrive-by parity, incl. the concrete clocks (the whole point of sharing).
  const bwPlan = await core.planTrips(ORIGIN, DEST, { ...noNet, nowMins: NOW, arriveByMins: ARRIVE_BY });
  const bd = bwPlan.list.find(m => !m.isMultiLeg);
  ck('parity setup: arrive-by plan has a direct trip', !!bd);
  if (bd) {
    const rb = core.buildTripFromSpec({ origin: ORIGIN, dest: DEST, ...specOf(bd) }, { ...noNet, nowMins: NOW, arriveByMins: ARRIVE_BY });
    ck('arrive-by rebuild: identical leave/board/arrive clocks',
       rb && rb._leaveAt === bd._leaveAt && rb._boardAt === bd._boardAt && rb._arriveAt === bd._arriveAt,
       rb ? `${rb._leaveAt}/${rb._boardAt}/${rb._arriveAt} vs ${bd._leaveAt}/${bd._boardAt}/${bd._arriveAt}` : 'null');
    ck('arrive-by rebuild: same ETA', rb && rb._eta === bd._eta);
  }

  // Transfer parity on the arrive-by YENİ HASTANE→FenEd plan (has transfers).
  const stopArr = Object.values(stops.stops).map(v => Array.isArray(v) ? v[1] : v);
  const byId = id => stopArr.find(s => String(s.stopId) === String(id));
  const YH = byId(447), FE = byId(308);
  const O2 = { lat: +YH.lat, lng: +YH.lng }, D2 = { lat: +FE.lat, lng: +FE.lng };
  const xp = await core.planTrips(O2, D2, { ...noNet, nowMins: NOW, arriveByMins: ARRIVE_BY });
  const xm = xp.list.find(m => m.isMultiLeg);
  ck('parity setup: transfer trip available', !!xm);
  if (xm) {
    const rb = core.buildTripFromSpec({ origin: O2, dest: D2, ...specOf(xm) }, { ...noNet, nowMins: NOW, arriveByMins: ARRIVE_BY });
    ck('transfer rebuild: same legs (routes, board/alight/transfer stops)',
       rb && rb.isMultiLeg
       && rb.leg1.path.displayRouteCode === xm.leg1.path.displayRouteCode
       && rb.leg2.path.displayRouteCode === xm.leg2.path.displayRouteCode
       && rb.leg1.board.stopId === xm.leg1.board.stopId
       && rb.leg1.alight.stopId === xm.leg1.alight.stopId
       && rb.leg2.board.stopId === xm.leg2.board.stopId
       && rb.leg2.alight.stopId === xm.leg2.alight.stopId);
    ck('transfer rebuild: identical clocks + waits',
       rb && rb._leaveAt === xm._leaveAt && rb._arriveAt === xm._arriveAt
       && rb.leg1.wait === xm.leg1.wait && rb.leg2.wait === xm.leg2.wait,
       rb ? `${rb._leaveAt}→${rb._arriveAt} vs ${xm._leaveAt}→${xm._arriveAt}` : 'null');
    ck('transfer rebuild: same ETA and transfer walk', rb && rb._eta === xm._eta && rb.leg2.transferWalkM === xm.leg2.transferWalkM);
  }

  // Broken specs must return null (never a half-built trip).
  ck('unknown route code → null',
     core.buildTripFromSpec({ origin: ORIGIN, dest: DEST, legs: [{ code: 'NOPE', dir: '0', board: 1, alight: 2 }] }, { ...noNet, nowMins: NOW }) === null);
  ck('alight before board → null', (() => {
    const fd2 = fw.list.find(m => !m.isMultiLeg);
    if (!fd2) return true;
    const s = specOf(fd2); [s.legs[0].board, s.legs[0].alight] = [s.legs[0].alight, s.legs[0].board];
    return core.buildTripFromSpec({ origin: ORIGIN, dest: DEST, ...s }, { ...noNet, nowMins: NOW }) === null;
  })());
  ck('empty legs → null', core.buildTripFromSpec({ origin: ORIGIN, dest: DEST, legs: [] }, noNet) === null);
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

// ── Last bus still on the road ───────────────────────────────────────────────
// A synthetic one-route network keeps this deterministic: T1 leaves stop a at
// 21:00 (its only run) and takes 10 min per stop, 30 min end to end.
console.log('\n── last bus still on the road ──\n');
{
  const mk = (id, i) => ({ stopId: id, stopName: 'S' + id, seq: String(i + 1),
    lat: String(40.10 + i * 0.0045), lng: '26.40',
    arrival_offset: String(i * 600), departure_offset: String(i * 600) });
  const T1 = { displayRouteCode: 'T1', direction: '0', busStopList: ['a', 'b', 'c', 'd'].map(mk), busList: [] };
  const entry = { name: 'T1 TEST', dir0: { label: '', times: ['21:00'] } };
  const dayData = { 'T1 TEST': entry };
  const at = s => ({ lat: +s.lat, lng: +s.lng });
  const O = at(T1.busStopList[1]), D = at(T1.busStopList[3]);   // board b (bus due 21:10), alight d
  const plan = (nowMins, fetchLive, live = true) => core.planTrips(O, D, {
    pathCache: [{ path: T1, route: {} }], dayData, nowMins, live, fetchLive,
    settings: { walkRadius: 800, walkSpeedMpm: 75 }, walkMatrix: async () => null,
  });
  const busAt = id => async () => [{ stopId: id, lat: 40.1, lng: 26.4, plateNumber: '17 X 1' }];

  // Planner: the schedule says the 21:10 bus has passed b, but live shows it still approaching.
  const late = await plan(21 * 60 + 20, busAt('a'));
  const lm = late?.list?.[0];
  ck('a late last bus that live shows approaching is still offered', !!lm && lm.path.displayRouteCode === 'T1',
     JSON.stringify(late?.list?.map(m => m.path?.displayRouteCode)));
  ck('…with its live wait and the last-bus flag', !!lm && lm._live && lm._lastBus && lm._wait <= 15,
     lm ? `wait ${lm._wait} live ${lm._live} last ${lm._lastBus}` : '');
  ck('no live bus out → the passed trip is dropped', (await plan(21 * 60 + 20, async () => []))?.list.length === 0);
  ck('live fetch failed → the passed trip is dropped', (await plan(21 * 60 + 20, async () => null))?.list.length === 0);
  ck('live off → the passed trip is dropped', (await plan(21 * 60 + 20, busAt('a'), false))?.list.length === 0);
  const asked = [];
  const long = await plan(23 * 60, async (c, d) => { asked.push(c); return busAt('a')(); });
  ck('a last bus long gone is neither fetched nor offered', long?.list.length === 0 && asked.length === 0,
     `${long?.list.length} trips, ${asked.length} fetches`);
  // A >4h gap before the NEXT bus today is not a passed last bus: no live-only rescue.
  entry.dir0.times = ['07:00', '21:00'];
  const gapAsked = [];
  const gap = await plan(12 * 60, async (c, d) => { gapAsked.push(c); return busAt('a')(); });
  entry.dir0.times = ['21:00'];
  ck('a long midday gap is not treated as a passed last bus', gap?.list.length === 0 && gapAsked.length === 0,
     `${gap?.list.length} trips, ${gapAsked.length} fetches`);

  // Seferler: which last trips may still be on the road.
  const onRoad = now => core.lastTripsOnRoad(entry, [T1], now);
  const r1 = onRoad(21 * 60 + 20);
  ck('last trip mid-run is on the road on schedule', r1.length === 1 && r1[0].time === '21:00' && r1[0].onSchedule === true,
     JSON.stringify(r1.map(o => [o.time, o.dir, o.onSchedule])));
  const r2 = onRoad(21 * 60 + 45);
  ck('past its run end but inside the late slack → live must decide', r2.length === 1 && r2[0].onSchedule === false);
  ck('past the late slack → not on the road', onRoad(22 * 60 + 5).length === 0);
  ck('last trip not departed yet → not reported', onRoad(20 * 60 + 50).length === 0);
  ck('an after-midnight last trip stays in the service-day frame',
     core.lastTripsOnRoad({ name: 'T1 TEST', dir0: { label: '', times: ['00:30'] } }, [T1], core._schedFrame(45))[0]?.onSchedule === true);
  ck('live bus out → running', core.lastBusRunning(r2[0], [{ stopId: 'c' }]) === true);
  ck('live says no bus → not running, even on schedule', core.lastBusRunning(r1[0], []) === false);
  ck('live unavailable → the schedule decides',
     core.lastBusRunning(r1[0], null) === true && core.lastBusRunning(r2[0], null) === false);
}

// ── Trips that start or end away from the terminals ──────────────────────────
// A timetable direction lists departures from its terminal and trips that
// start elsewhere (an evening section, a village trip) or turn back early.
// T2 runs MERKEZ → OKUL → KEPEZ TOKİ → KEPEZ MEYDAN → GAZİ OKULU, 10 min apart.
console.log('\n── trips placed on their path ──\n');
{
  ck('KEPEZ 144 TOKİ names KEPEZ TOKİ', core._stopNameScore('KEPEZ 144 TOKİ', 'KEPEZ TOKİ') > 0);
  ck('a cut-short word still names its stop', core._stopNameScore('KEPEZ 144 TOK', 'KEPEZ TOKİ') > 0);
  ck('spacing does not matter', core._stopNameScore('ESKİ HASTANE', 'ESKİHASTANE') === 3);
  ck('a shared word is not a match', core._stopNameScore('KEPEZ MEYDAN', 'BELEDİYE MEYDAN') === 0);
  ck('one generic word does not name a longer stop', core._stopNameScore('KEPEZ', 'KEPEZ ÇAMLIK ALTI') === 0);
  ck('a short stop name may be the whole word', core._stopNameScore('SSK', 'ESKİ SSK') > 0);
  ck('a stop name kentkart shortens still matches (SOSYAL BİL. MYO.)', core._stopNameScore('SOSYAL BİLİMLER MYO', 'SOSYAL BİL. MYO.') > 0);
  ck('a column word (VARIŞ, KALKIŞ) is not part of the name', core._stopNameScore('ELBİ KYK VARIŞ', 'ELBİ KYK') === 3);
  ck('one name inside the other outranks shared words', core._stopNameScore('İSKELE', 'İSKELE 2') === 2);
  ck('a short name is not found inside a longer word', core._stopNameScore('ADA', 'KADAYIF') === 0);
  ck('initials and one-letter stop words match nothing',
     core._stopNameScore('A B C', 'ADLİYE BARBAROS CUMA') === 0 && core._stopNameScore('ADLİYE', 'A BLOK') === 0);
  const names = ['MERKEZ', 'OKUL', 'KEPEZ TOKİ', 'KEPEZ MEYDAN', 'GAZİ OKULU'];
  const T2 = { displayRouteCode: 'T2', direction: '0', busList: [], busStopList: names.map((stopName, i) => ({
    stopId: 't' + i, stopName, seq: String(i + 1), lat: String(40.20 + i * 0.0045), lng: '26.40',
    arrival_offset: String(i * 600), departure_offset: String(i * 600) })) };
  const entry = { name: 'T2 TEST', dir0: { label: 'MERKEZ', times: ['08:00', '11:00'], trips: [
    { time: '09:00', from: 'KEPEZ 144 TOKİ', stops: [['KEPEZ MEYDAN', '09:10'], ['GAZİ OKULU', '09:30']] },
    { time: '10:00', from: 'ÇINARLI', stops: [['KEPEZ MEYDAN', '10:15'], ['GAZİ OKULU', '10:35']] },
    { time: '11:00', to: 'KEPEZ TOKİ' },
    { time: '12:00', from: 'ÇINARLI', stops: [] },
  ] } };
  const placed = core.schedTripsForPath(entry, T2);
  ck('each trip is placed at the stops it serves, a trip off the path is left out',
     JSON.stringify(placed.map(t => [t.time, t.start, t.end, t.mins])) ===
     JSON.stringify([['08:00', 0, 4, 480], ['09:00', 2, 4, 520], ['10:00', 3, 4, 585], ['11:00', 0, 2, 660]]),
     JSON.stringify(placed.map(t => [t.time, t.start, t.end, t.mins])));
  ck('only trips calling at both stops count',
     JSON.stringify([core._tripMinsAt(placed, 0, 4), core._tripMinsAt(placed, 3, 4), core._tripMinsAt(placed, 1, 2)]) ===
     JSON.stringify([[480], [480, 520, 585], [480, 660]]));
  ck('departures from the terminal are the plain times', JSON.stringify(core.schedTimesForPath(entry, T2)) === '["08:00","11:00"]');
  ck('the timetable lists every departure', JSON.stringify(core.schedDepartures(entry.dir0)) === '["08:00","09:00","10:00","11:00","12:00"]');
  const at = s => ({ lat: +s.lat, lng: +s.lng });
  const plan = (board, alight, nowMins) => core.planTrips(at(T2.busStopList[board]), at(T2.busStopList[alight]), {
    pathCache: [{ path: T2, route: {} }], dayData: { 'T2 TEST': entry }, nowMins, live: false,
    settings: { walkRadius: 300, walkSpeedMpm: 75 }, walkMatrix: async () => null });
  const atMerkez = await plan(0, 4, 8 * 60 + 30);
  ck('no bus is offered at the terminal for a trip that starts down the line', atMerkez?.list.length === 0,
     JSON.stringify(atMerkez?.list.map(m => m._wait)));
  const atMeydan = (await plan(3, 4, 8 * 60 + 50))?.list[0];
  ck('down the line the trip arrives on its own clock (09:10 at KEPEZ MEYDAN)', atMeydan?._wait === 20, String(atMeydan?._wait));
  // 11:00 turns back at KEPEZ TOKİ, a walk from KEPEZ MEYDAN: ride to there instead.
  const pastEnd = await plan(1, 3, 10 * 60 + 50);
  ck('a trip that turns back early is not offered beyond its end, only to where it turns back',
     JSON.stringify(pastEnd?.list.map(m => [m.alight.stopName, m._wait])) === '[["KEPEZ TOKİ",20]]',
     JSON.stringify(pastEnd?.list.map(m => [m.alight.stopName, m._wait])));
  // 11:00 turns back at KEPEZ TOKİ (11:20): it is off the road well before the full run would end.
  ck('the last trip ends where it turns back',
     core.lastTripsOnRoad(entry, [T2], 11 * 60 + 15)[0]?.onSchedule === true &&
     core.lastTripsOnRoad(entry, [T2], 11 * 60 + 25)[0]?.onSchedule === false);
  // A last trip from KEPEZ TOKİ is on the road from when it leaves there (12:00).
  const fromTokiLast = { name: 'T2 TEST', dir0: { label: 'MERKEZ', times: ['08:00'], trips: [{ time: '12:00', from: 'KEPEZ TOKİ', stops: [] }] } };
  ck('a last trip that starts down the line is on the road once it leaves its own first stop',
     core.lastTripsOnRoad(fromTokiLast, [T2], 11 * 60 + 50).length === 0 &&
     core.lastTripsOnRoad(fromTokiLast, [T2], 12 * 60 + 10)[0]?.onSchedule === true);
  // 12:00 from MERKEZ passes KEPEZ TOKİ at 12:20, after the 12:05 that starts there: 12:00 is the last on the road.
  const lastByRoad = { name: 'T2 TEST', dir0: { label: 'MERKEZ', times: ['12:00'], trips: [{ time: '12:05', from: 'KEPEZ TOKİ', stops: [] }] } };
  ck('the last trip is the one furthest behind on the road, not the latest printed time',
     JSON.stringify(core.lastTripsOnRoad(lastByRoad, [T2], 12 * 60 + 30).map(t => [t.time, t.onSchedule])) === '[["12:00",true]]',
     JSON.stringify(core.lastTripsOnRoad(lastByRoad, [T2], 12 * 60 + 30)));
  const campus = ['GAZİ OKULU', 'DARDANOS CAMİİ', 'JANDARMA', 'ÇOMÜDARDANOS'].map(stopName => ({ stopName }));
  ck('a trip end the path\'s own end also matches is that end, not an earlier stop',
     core._stopIndex(campus, 'DARDANOS', 0, true) === 3 && core._stopIndex(campus, 'DARDANOS') === 1);
  // ESKİ HASTANE is not on T2 but on another route, across the road from OKUL.
  const other = { displayRouteCode: 'T3', direction: '1', busStopList: [
    { stopId: 'o1', stopName: 'ESKİHASTANE', lat: String(40.2045 + 0.00018), lng: '26.40' },
    { stopId: 'o2', stopName: 'ÇINARLI', lat: '40.22', lng: '26.40' }] };
  const pathCache = [{ path: T2 }, { path: other }];
  const offPath = { name: 'T2 TEST', dir0: { label: 'MERKEZ', times: ['08:05'], trips: [
    { time: '08:05', to: 'GAZİ OKULU' }, { time: '08:05', to: 'KEPEZ TOKİ' },
    { time: '13:00', from: 'ESKİ HASTANE', stops: [['GAZİ OKULU', '13:40']] },
    { time: '14:00', from: 'ÇINARLI', stops: [['GAZİ OKULU', '14:40']] },
  ] } };
  ck('a trip leaves from the path\'s stop across the road from its own first stop; buses that leave together run as far as the furthest',
     JSON.stringify(core.schedTripsForPath(offPath, T2, pathCache).map(t => [t.time, t.start, t.end, t.mins])) ===
     JSON.stringify([['08:05', 0, 4, 485], ['13:00', 1, 4, 770]]),
     JSON.stringify(core.schedTripsForPath(offPath, T2, pathCache).map(t => [t.time, t.start, t.end, t.mins])));
  // 11K-E toward Gazi Okulu: no offsets for its first stops, then they restart near zero.
  const { rebaseOffsets } = await import('../scripts/fetch-stops.mjs');
  const restart = rebaseOffsets(['0', '0', '0', '5', '65'].map((arrival_offset, i) =>
    ({ seq: String(i + 1), arrival_offset, departure_offset: arrival_offset })));
  const travel = restart.map(s => core._travelToStopMins(s));
  ck('offsets that restart after untimed stops count from the last of them',
     JSON.stringify(travel.map(m => +m.toFixed(2))) === '[0,1.5,3,3.08,4.08]', JSON.stringify(travel));
  const timed = ['0', '60', '0', '200'].map((arrival_offset, i) => ({ seq: String(i + 1), arrival_offset }));
  ck('offsets that carry on after an untimed stop stay as kentkart gives them', JSON.stringify(rebaseOffsets(timed)) === JSON.stringify(timed));
}

console.log('\n── every leg counts only the trips that serve it ──\n');
{
  // T2: MERKEZ → OKUL → KEPEZ TOKİ → KEPEZ MEYDAN → GAZİ OKULU, 10 min apart.
  // T7: KEPEZ MEYDAN B (40 m from T2's KEPEZ MEYDAN) → ÇARŞI → LİSE → STADYUM, heading east.
  const mk = (code, names, pos) => ({ displayRouteCode: code, direction: '0', busList: [], busStopList: names.map((stopName, i) => ({
    stopId: code + i, stopName, seq: String(i + 1), lat: String(pos(i)[0]), lng: String(pos(i)[1]),
    arrival_offset: String(i * 600), departure_offset: String(i * 600) })) });
  const T2 = mk('T2', ['MERKEZ', 'OKUL', 'KEPEZ TOKİ', 'KEPEZ MEYDAN', 'GAZİ OKULU'], i => [40.20 + i * 0.0045, 26.40]);
  const T7 = mk('T7', ['KEPEZ MEYDAN B', 'ÇARŞI', 'LİSE', 'STADYUM'], j => [40.2135, 26.4005 + j * 0.006]);
  const at = s => ({ lat: +s.lat, lng: +s.lng });
  const settings = { walkRadius: 300, walkSpeedMpm: 75 }, pathCache = [{ path: T2, route: {} }, { path: T7, route: {} }];
  const plan = (o, d, dayData, nowMins, arriveByMins = null) => core.planTrips(at(o), at(d),
    { pathCache, dayData, nowMins, arriveByMins, live: false, settings, walkMatrix: async () => null });
  const spec = (o, d, legs, dayData, nowMins) => core.buildTripFromSpec({ origin: at(o), dest: at(d), legs }, { pathCache, dayData, nowMins, settings });
  const leg = (p, b, a) => ({ code: p.displayRouteCode, dir: '0', board: p.busStopList[b].stopId, alight: p.busStopList[a].stopId });
  const show = r => JSON.stringify(r?.list?.map(m => m.isMultiLeg ? ['X', m.leg1.wait, m.leg2.wait, m._eta, m._lastBus]
    : [m.path.displayRouteCode, m.alight.stopName, m._wait, m._eta, m._lastBus]));
  const [MERKEZ, OKUL, , MEYDAN, GAZI] = T2.busStopList, STADYUM = T7.busStopList[3];
  {
    // No trip calls at both OKUL and KEPEZ MEYDAN: 11:00 turns at KEPEZ TOKİ, 09:00 starts there.
    const day = { 'T2 A': { name: 'T2 A', dir0: { label: 'MERKEZ', times: ['11:00'], trips: [{ time: '11:00', to: 'KEPEZ TOKİ' },
      { time: '09:00', from: 'KEPEZ 144 TOKİ', stops: [['KEPEZ MEYDAN', '09:10'], ['GAZİ OKULU', '09:30']] }] } } };
    const r = await plan(OKUL, MEYDAN, day, 8 * 60);
    const pairs = res => JSON.stringify(res.list.map(m => [m.board.stopName, m.alight.stopName, m._wait]));
    // OKUL's only bus is the 11:00 to KEPEZ TOKİ (there 11:20, then a walk); walking to KEPEZ TOKİ for the 09:00 is 2 h sooner.
    ck('direct: a bus the nearest stops never see wins when it is 10+ min sooner', pairs(r) === '[["KEPEZ TOKİ","KEPEZ MEYDAN",51]]', pairs(r));
    ck('trip link: rebuilt as null when no trip calls at both stops', spec(OKUL, MEYDAN, [leg(T2, 1, 3)], day, 8 * 60) === null);
    // From OKUL the 08:10 short turn reaches KEPEZ TOKİ at 08:30, then a 9-minute walk: 08:39. A bus
    // from KEPEZ TOKİ at 08:20 is at KEPEZ MEYDAN at 08:30, 9 min sooner; at 08:15, 14 min sooner.
    const close = from => ({ 'T2 C': { name: 'T2 C', dir0: { label: 'MERKEZ', times: ['08:10'], trips: [{ time: '08:10', to: 'KEPEZ TOKİ' },
      { time: from, from: 'KEPEZ 144 TOKİ', stops: [] }] } } });
    const stays = await plan(OKUL, MEYDAN, close('08:20'), 8 * 60), moves = await plan(OKUL, MEYDAN, close('08:15'), 8 * 60);
    ck('direct: the nearest stops stay when the other bus saves under 10 min', pairs(stays) === '[["OKUL","KEPEZ TOKİ",20]]', pairs(stays));
    ck('direct: and move when it saves 10 min or more', pairs(moves) === '[["KEPEZ TOKİ","KEPEZ MEYDAN",6]]', pairs(moves));
    // Arrive by 08:45: the 08:00 short turn means leaving OKUL at 08:10; the 08:30 from KEPEZ TOKİ, leaving at 08:21.
    // At KEPEZ TOKİ the latest bus that still makes it counts (08:30), not the first (08:10).
    const leaveLater = { 'T2 D': { name: 'T2 D', dir0: { label: 'MERKEZ', times: ['08:00'], trips: [{ time: '08:00', to: 'KEPEZ TOKİ' },
      { time: '08:10', from: 'KEPEZ 144 TOKİ', stops: [] }, { time: '08:30', from: 'KEPEZ 144 TOKİ', stops: [] }] } } };
    const later = await core.planTrips(at(OKUL), at(MEYDAN), { pathCache, dayData: leaveLater, nowMins: 7 * 60 + 30,
      arriveByMins: 8 * 60 + 45, live: false, settings, walkMatrix: async () => null });
    ck('arrive-by: a bus the nearest stops never see wins when you can leave 10+ min later', pairs(later) === '[["KEPEZ TOKİ","KEPEZ MEYDAN",0]]', pairs(later));
    // The same bus loops back near the destination: alighting early and walking is 33 min sooner,
    // but the same bus always alights at the stop nearest the destination.
    const LOOP = mk('L1', ['A', 'B', 'C', 'X', 'Y', 'Z', 'D'], i => [[40.200, 26.40], [40.205, 26.40], [40.210, 26.40], [40.215, 26.42],
      [40.215, 26.44], [40.210, 26.44], [40.2136, 26.40]][i]);
    const loop = await core.planTrips(at(LOOP.busStopList[0]), at(LOOP.busStopList[6]), { pathCache: [{ path: LOOP, route: {} }],
      dayData: { 'L1 LOOP': { name: 'L1 LOOP', dir0: { label: 'A', times: ['08:00'] } } }, nowMins: 7 * 60 + 55, live: false, settings, walkMatrix: async () => null });
    ck('direct: the same bus keeps the nearest stops, however the route loops', pairs(loop) === '[["A","D",5]]', pairs(loop));
  }
  {
    // 08:00 is the last bus to reach GAZİ OKULU: 11:00 turns at KEPEZ TOKİ.
    const day = { 'T2 B': { name: 'T2 B', dir0: { label: 'MERKEZ', times: ['08:00', '11:00'], trips: [{ time: '11:00', to: 'KEPEZ TOKİ' }] } } };
    const r = await plan(MERKEZ, GAZI, day, 7 * 60 + 45);
    ck('direct: the last bus is judged on the trips that reach the alight stop', r.list[0]?._lastBus === true, show(r));
    const m = spec(MERKEZ, GAZI, [leg(T2, 0, 4)], day, 7 * 60 + 45);
    ck('trip link: likewise', m?._lastBus === true && m?._wait === 15, JSON.stringify(m && [m._wait, m._lastBus]));
  }
  // Transfer at KEPEZ MEYDAN. T2: 08:00 and 10:00 turn at OKUL, 09:00 runs through. T7: 09:40 turns at ÇARŞI, 10:40 runs through.
  const T2x = { name: 'T2 X', dir0: { label: 'MERKEZ', times: ['08:00', '09:00', '10:00'], trips: [{ time: '08:00', to: 'OKUL' }, { time: '10:00', to: 'OKUL' }] } };
  const T7x = { name: 'T7 X', dir0: { label: 'KEPEZ MEYDAN B', times: ['09:40', '10:40'], trips: [{ time: '09:40', to: 'ÇARŞI' }] } };
  {
    const day = { 'T2 X': T2x, 'T7 X': T7x };
    const x = (await plan(MERKEZ, STADYUM, day, 7 * 60 + 50)).list.find(m => m.isMultiLeg);
    ck('transfer: each leg waits for a bus that reaches its stops (09:00, then 10:40)',
       JSON.stringify(x && [x.leg1.wait, x.leg2.wait, x._eta, x._lastBus]) === '[70,69,200,true]', JSON.stringify(x && [x.leg1.wait, x.leg2.wait, x._eta, x._lastBus]));
    const xb = (await plan(MERKEZ, STADYUM, day, 7 * 60 + 50, 11 * 60 + 30)).list.find(m => m.isMultiLeg);
    ck('arrive-by transfer: leg 1 is the 09:00, leg 2 the 10:40', Math.round(xb?._boardAt) === 540 && Math.round(xb?._leg2BoardAt) === 640,
       JSON.stringify(xb && [xb._boardAt, xb._leg2BoardAt]));
    const m = spec(MERKEZ, STADYUM, [leg(T2, 0, 3), leg(T7, 0, 3)], day, 7 * 60 + 50);
    ck('trip link transfer: the same waits', m?.leg1.wait === 70 && m?.leg2.wait === 69, JSON.stringify(m && [m.leg1.wait, m.leg2.wait]));
    const noLeg1 = { 'T2 N': { name: 'T2 N', dir0: { label: 'MERKEZ', times: ['08:00'], trips: [{ time: '08:00', to: 'OKUL' }] } }, 'T7 X': T7x };
    ck('transfer: none when no leg-1 trip reaches the transfer stop', !(await plan(MERKEZ, STADYUM, noLeg1, 7 * 60 + 50)).list.some(m => m.isMultiLeg));
    const noLeg2 = { 'T2 X': T2x, 'T7 N': { name: 'T7 N', dir0: { label: 'KEPEZ MEYDAN B', times: ['09:40'], trips: [{ time: '09:40', to: 'ÇARŞI' }] } } };
    ck('transfer: none when no leg-2 trip reaches the alight stop', !(await plan(MERKEZ, STADYUM, noLeg2, 7 * 60 + 50)).list.some(m => m.isMultiLeg));
    // A short-turn 12:30 serves the board stop; the only trip to the transfer stop is tomorrow's 05:00.
    const overnight = { 'T2 O': { name: 'T2 O', dir0: { label: 'MERKEZ', times: ['05:00', '12:30'], trips: [{ time: '12:30', to: 'OKUL' }] } },
      'T7 O': { name: 'T7 O', dir0: { label: 'KEPEZ MEYDAN B', times: ['05:40'] } } };
    ck('transfer: no overnight leg-1 wait', !(await plan(MERKEZ, STADYUM, overnight, 12 * 60)).list.some(m => m.isMultiLeg));
    // Leg 1 (09:00) is the last T2 to reach KEPEZ MEYDAN; leg 2 is not the last (11:40 runs through).
    const legOneLast = { 'T2 X': T2x, 'T7 L': { name: 'T7 L', dir0: { label: 'KEPEZ MEYDAN B', times: ['09:40', '10:40', '11:40'], trips: [{ time: '09:40', to: 'ÇARŞI' }] } } };
    ck('transfer: leg 1\'s last bus is judged on trips reaching the transfer stop',
       (await plan(MERKEZ, STADYUM, legOneLast, 7 * 60 + 50)).list.find(m => m.isMultiLeg)?._lastBus === true);
    // Leg 1 is not the last (10:30 runs through); leg 2's 10:40 is the last to reach STADYUM, and 08:40 is gone by the transfer.
    const legTwoLast = { 'T2 Y': { name: 'T2 Y', dir0: { label: 'MERKEZ', times: ['08:00', '09:00', '10:30'], trips: [{ time: '08:00', to: 'OKUL' }] } },
      'T7 Y': { name: 'T7 Y', dir0: { label: 'KEPEZ MEYDAN B', times: ['08:40', '10:40', '11:40'], trips: [{ time: '11:40', to: 'ÇARŞI' }] } } };
    ck('transfer: leg 2\'s last bus is judged on trips reaching the alight stop, from the real leg-1 arrival',
       (await plan(MERKEZ, STADYUM, legTwoLast, 7 * 60 + 50)).list.find(m => m.isMultiLeg)?._lastBus === true);
  }
  const st = names => names.map(stopName => ({ stopName }));
  ck('a stop\'s whole name inside the timetable\'s names it (HÜSEYİN ELBİ YURDU ~ ELBİ KYK)',
     core._stopIndex(st(['ELBİ KYK', 'İSKELE']), 'HÜSEYİN ELBİ YURDU') === 0);
  const twin = st(['NUSRAT', 'MÜHENDİSLİK FAKÜLTESİ', 'MÜHENDİSLİK FAKÜLTESİ', 'ARDES YURT']);
  ck('a trip ends at the last of a run of same-named stops, and starts at the first',
     core._stopIndex(twin, 'MÜHENDİSLİK FAKÜLTESİ', 0, true) === 2 && core._stopIndex(twin, 'MÜHENDİSLİK FAKÜLTESİ') === 1);
  ck('a run does not jump over other stops', core._stopIndex(st(['OTOGAR', 'X', 'OTOGAR', 'Y']), 'OTOGAR', 0, true) === 0);
  const T9 = { displayRouteCode: 'T9', direction: '0', busStopList: twin.map((s, i) => ({ ...s, stopId: 'p' + i, seq: String(i + 1), arrival_offset: String(i * 600) })) };
  ck('placement: a trip to a stop the path names twice runs to the second',
     core.schedTripsForPath({ name: 'T9', dir0: { label: 'NUSRAT', times: ['08:00'], trips: [{ time: '08:00', to: 'MÜHENDİSLİK FAKÜLTESİ' }] } }, T9)[0]?.end === 2);
  // Across the road means a stop of exactly that name within TRANSFER_CROSS_ROAD_M.
  const mkp = (code, rows) => ({ displayRouteCode: code, direction: '0', busList: [], busStopList: rows.map(([stopName, lat, lng], i) => ({
    stopId: code + i, stopName, seq: String(i + 1), lat: String(lat), lng: String(lng), arrival_offset: String(i * 300) })) });
  const C4 = mkp('C4', [['BAHRİYE', 40.150, 26.400], ['HALKBAHÇESİ', 40.152, 26.400], ['İSKELE', 40.154, 26.400], ['ELBİ KYK', 40.156, 26.400]]);
  const evening = { name: 'C4', dir0: { label: 'BAHRİYE', times: ['18:00'], trips: [{ time: '19:00', from: 'ESKİ HASTANE', stops: [['İSKELE', '19:05']] }] } };
  const startWith = other => core.schedTripsForPath(evening, C4, [{ path: C4 }, { path: other }]).find(t => t.time === '19:00')?.start;
  ck('a same-named stop 255 m away is not across the road', startWith(mkp('C9', [['ESKİ HASTANE', 40.152, 26.403]])) === 2);
  ck('only an exactly named stop elsewhere is used across the road', startWith(mkp('C9', [['ESKİ HASTANE GİRİŞİ', 40.152, 26.4004]])) === 2);
  // Two stops of this path within reach: the trip starts at the nearer one.
  const C4twin = mkp('C4', [['BAHRİYE', 40.150, 26.400], ['HALKBAHÇESİ', 40.152, 26.400], ['HALKBAHÇESİ 2', 40.15205, 26.4004], ['ELBİ KYK', 40.156, 26.400]]);
  ck('across the road is the nearest stop of the path',
     core.schedTripsForPath(evening, C4twin, [{ path: C4twin }, { path: mkp('C9', [['ESKİHASTANE', 40.152, 26.4004]]) }]).find(t => t.time === '19:00')?.start === 2);
  // A trip's end is searched from where it starts: ANAFARTALAR KAMPÜSÜ is stop 1 and stop 3.
  const loop = mkp('C4', [['BAHRİYE', 40.150, 26.400], ['ANAFARTALAR KAMPÜSÜ', 40.152, 26.400], ['İSKELE', 40.154, 26.400],
    ['ANAFARTALAR KAMPÜSÜ', 40.156, 26.400], ['ELBİ KYK', 40.158, 26.400]]);
  const toCampus = { name: 'C4', dir0: { label: 'BAHRİYE', times: ['18:00'], trips: [{ time: '19:00', from: 'İSKELE', stops: [], to: 'ANAFARTALAR KAMPÜSÜ' }] } };
  ck('a trip ends at the first stop of its end name after where it starts',
     core.schedTripsForPath(toCampus, loop, [{ path: loop }]).find(t => t.time === '19:00')?.end === 3);
  // The planner places such trips with its own path cache: the 19:00 leaves HALKBAHÇESİ.
  const out = mkp('C4', [['ELBİ KYK', 40.156, 26.4004], ['ESKİHASTANE', 40.152, 26.4004], ['BADEMLİ', 40.148, 26.4004]]);
  const viaOther = await core.planTrips(at(C4.busStopList[1]), at(C4.busStopList[3]), { pathCache: [{ path: C4, route: {} }, { path: out, route: {} }],
    dayData: { C4: evening }, nowMins: 18 * 60 + 55, live: false, settings, walkMatrix: async () => null });
  ck('the planner boards a trip at the stop across the road from its first stop',
     viaOther.list.some(m => m.path === C4 && m.board.stopName === 'HALKBAHÇESİ'), show(viaOther));
}

console.log('\n── service day ──\n');
{
  const day = iso => { const t = core.todayParts(new Date(iso)); return JSON.stringify([t.mmdd, t.dayOfWeek, t.isWeekend, t.year]); };
  ck('before 04:00 the service day is still yesterday: Friday night\'s 00:30 bus runs on Friday\'s timetable',
     day('2026-10-31T00:30:00+03:00') === '["10-30",5,false,2026]' && day('2026-10-31T03:59:00+03:00') === '["10-30",5,false,2026]');
  ck('from 04:00 it is the calendar day', day('2026-10-31T04:00:00+03:00') === '["10-31",6,true,2026]');
  ck('New Year\'s night still belongs to 31 December', day('2027-01-01T01:00:00+03:00') === '["12-31",4,false,2026]');
  // Only an upcoming weekday timetable: before its date no timetable applies, never the weekend's.
  const upcoming = [{ id: 'weekend', kind: 'weekend' },
    { id: 'effective-weekday-2026-11-02', kind: 'effective-weekday', effectiveFrom: '11-02', year: 2026 }];
  ck('a weekday with only an upcoming weekday timetable has none, not the weekend\'s',
     core.pickActiveScheduleId(upcoming, { year: 2026, mmdd: '10-27', isWeekend: false }) === null &&
     core.scheduleForDay(upcoming, { year: 2026, mmdd: '10-27', isWeekend: false }) === null &&
     core.pickActiveScheduleId(upcoming, { year: 2026, mmdd: '11-02', isWeekend: false }) === 'effective-weekday-2026-11-02');
  // A timetable in force from 15 December 2026 stays in force in January.
  const winter = [{ id: 'weekday', kind: 'weekday', routes: { A: { name: 'A' } } },
    { id: 'effective-weekday-2026-12-15', kind: 'effective-weekday', effectiveFrom: '12-15', year: 2026, routes: { B: { name: 'B' } } },
    { id: 'recurring-5-friday', kind: 'recurring', weekdays: [5], effectiveFrom: '12-15', year: 2026, dates: ['12-15'], routes: { C: { name: 'C' } } }];
  const on = iso => core.scheduleForDay(winter, core.todayParts(new Date(iso)));
  ck('an effective-from timetable stays in force across New Year', on('2027-01-08T12:00:00+03:00')?.id === 'effective-weekday-2026-12-15' &&
     on('2026-12-14T12:00:00+03:00')?.id === 'weekday');
  ck('so does an effective-from Friday supplement', Object.keys(on('2027-01-08T12:00:00+03:00')?.routes || {}).join() === 'B,C' &&
     Object.keys(on('2026-12-11T12:00:00+03:00')?.routes || {}).join() === 'A');
  const lateFirst = [{ id: 'weekday', kind: 'weekday' }, { id: 'e-2026-12-15', kind: 'effective-weekday', effectiveFrom: '12-15', year: 2026 },
    { id: 'e-2027-01-04', kind: 'effective-weekday', effectiveFrom: '01-04', year: 2027 }];
  ck('the latest effective-from timetable in force wins across New Year',
     core.pickActiveScheduleId(lateFirst, core.todayParts(new Date('2027-01-08T12:00:00+03:00'))) === 'e-2027-01-04');
}

console.log(`\n${fail ? '\x1b[31m' + fail + ' failed\x1b[0m, ' : ''}\x1b[32m${pass} passed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
