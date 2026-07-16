// ─────────────────────────────────────────────────────────────────────────────
// Trip-planner test suite.
//
//   Run:  node test/planner-test.mjs           (assertions + full result dump)
//         node test/planner-test.mjs --quiet   (assertions only; exit 1 on fail)
//
// It exercises the REAL planner (imported from core.js) against the committed
// data/stops.json + data/schedule.json. It used to mirror the logic; that copy
// silently drifted, so the whole planner now comes straight from core.
//
// Coverage:
//   • Pure helpers (deterministic, no network): _travelToStopMins, _rideMins,
//     _waitFromTimes, _isLastSefer, _liveBoardWaitMins — incl. offset fallbacks,
//     monotonicity guard, reachability grace, last-bus detection.
//   • Schedule helpers (schedCodeNorm / findSchedEntry / pickSchedDir /
//     schedTimesForPath) incl. the departure-terminal direction mapping.
//   • Data integrity of the committed JSON (coords, GTFS offset monotonicity,
//     HH:MM schedule times).
//   • planTrips structural invariants on real O/D pairs (≤5 results, sane ETAs,
//     rank ordering, no same-route transfers, walk-radius for comfy trips). Uses
//     Valhalla when online, haversine fallback offline.
//
// Edit PAIRS / TIMES near the bottom to test other origins/destinations/times.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Everything the planner does now comes from the REAL core.js. This file used
// to MIRROR it — hand-copied planTrips + helpers dating from when the code lived
// inline in index.html — which meant the suite tested a copy that could (and
// did) drift from the shipped code: the mirrored pickSchedDir had rotted to a
// pre-fix version disagreeing with core on 8 of 28 paths, and a mutation to
// findSchedEntry sailed through green. Importing closes that gap. The helpers
// are pure (dayData/entry/stops/settings are all passed in), so no page, no
// Leaflet; planTrips still hits Valhalla for walk distances (haversine fallback
// offline), so this stays the network-dependent step.
import {
  schedCodeNorm, findSchedEntry, pickSchedDir, schedTimesForPath,
  planTrips as corePlanTrips, buildGuidedSteps,
  haversine, _travelToStopMins, _rideMins, _waitFromTimes, _isLastSefer,
  _liveBoardWaitMins, withinM, movedPast,
  MINS_PER_STOP, MAX_WAIT_MIN, TRANSFER_WALK_MAX_M, TRANSFER_PENALTY_MIN,
  WALK_RELAX_MULT, MAX_NEAR_STOPS, TRANSFER_ETA_TOLERANCE_MIN,
  TRANSFER_CROSS_ROAD_M, REACH_GRACE_MIN, WALK_DETOUR_FACTOR,
  GUIDED_ARRIVE_M, GUIDED_BOARDED_M,
} from '../core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stopsData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/stops.json'), 'utf8'));
const scheduleData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/schedule.json'), 'utf8'));

// ── Stops index ──────────────────────────────────────────────────────────────
const stopArr = Object.values(stopsData.stops).map(v => Array.isArray(v) ? v[1] : v);
const byId = id => stopArr.find(s => String(s.stopId) === String(id));
const pathCache = stopsData.paths.map(pe => ({ path: pe.path, route: pe.route || {} }));

// ── Settings (match the app defaults) ────────────────────────────────────────
const SETTINGS = { walkRadius: 900, walkSpeedMpm: 72 };

// ── Active-schedule selection — mirror of getActiveSchedule()/pickActiveScheduleId
function todayParts() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = k => parts.find(p => p.type === k).value;
  const y = +get('year'), m = +get('month'), d = +get('day');
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return { mmdd: `${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`, year: y, isWeekend: dow === 0 || dow === 6 };
}
function pickActiveScheduleId(schedules, today) {
  if (!schedules?.length) return null;
  const specials = schedules.filter(s => s.kind === 'special').filter(s => s.year == null || s.year === today.year)
    .filter(s => Array.isArray(s.dates) && s.dates.includes(today.mmdd))
    .sort((a, b) => { const pri = id => /arefe/.test(id) ? 0 : /bayram/.test(id) ? 1 : 2; const pa = pri(a.id), pb = pri(b.id); if (pa !== pb) return pa - pb; return a.dates.length - b.dates.length; });
  if (specials.length) return specials[0].id;
  const wantKind = today.isWeekend ? 'effective-weekend' : 'effective-weekday';
  const eff = schedules.filter(s => s.kind === wantKind).filter(s => s.year == null || s.year === today.year)
    .filter(s => s.effectiveFrom && s.effectiveFrom <= today.mmdd).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  if (eff.length) return eff[0].id;
  const reg = schedules.find(s => s.kind === (today.isWeekend ? 'weekend' : 'weekday'));
  return reg?.id || schedules[0].id;
}
function getActiveSchedule() {
  const id = pickActiveScheduleId(scheduleData.schedules, todayParts());
  return scheduleData.schedules.find(s => s.id === id) || scheduleData.schedules.find(s => s.kind === 'weekday') || scheduleData.schedules[0];
}
const getActiveRoutes = () => getActiveSchedule()?.routes || {};

// (schedCodeNorm / findSchedEntry / pickSchedDir / schedTimesForPath are imported
//  from core.js at the top of this file — no local copy to keep in sync.)

// ── PLANNER — thin adapter over core.planTrips ───────────────────────────────
// planTrips, its walk matrix, reachable-stop collection, and direct+transfer
// ranking are all core's now. The two call sites below plan by wall-clock
// minute at the shipped default settings, offline-deterministic (live pass off,
// so no kentkart fetch); walk distances still go to Valhalla with a haversine
// fallback, which is what keeps this the network-dependent test step.
const planTrips = (origin, dest, nowMins) =>
  corePlanTrips(origin, dest, {
    pathCache, dayData: getActiveRoutes(), settings: SETTINGS,
    nowMins, live: false,
  });

// ── GUIDED "START TRIP" — core.buildGuidedSteps at the default walk speed ─────
// (withinM / movedPast / GUIDED_* are imported from core.js.) The wrapper just
// pins the walkSpeedMpm the shipped call site passes, so the two call sites read
// buildGuidedStepsSync(m, O, D) unchanged.
const buildGuidedStepsSync = (m, origin, dest) =>
  buildGuidedSteps(m, origin, dest, { walkSpeedMpm: SETTINGS.walkSpeedMpm });

// ── Test config — ONLY the pairs actually tested during development ──────────
const STOPS = {
  Otogar:  368,  // OTOGAR
  Faculty: 304,  // MÜHENDİSLİK FAKÜLTESİ (campus)
  FenEd:   308,  // FEN EDEBİYAT FAKÜLTESİ
  Iskele:  18,   // İSKELE
  Hastane: 447,  // YENİ HASTANE
};
const PAIRS = [
  ['Otogar',  'Hastane'],
  ['Faculty', 'Hastane'],
  ['Iskele',  'Hastane'],
  ['Hastane', 'Iskele'],
  ['Hastane', 'FenEd'],
];
const TIMES = [
  ['08:30',  8*60 + 30],
  ['12:00', 12*60],
  ['17:00', 17*60],
  ['18:00', 18*60],
  ['21:17', 21*60 + 17],
];

// core.planTrips candidate shape: direct trips carry path/board/alight; transfers
// carry leg1/leg2. codeOf collapses both to the "A" / "A+B" label the dump used.
const codeOf = m => m.isMultiLeg
  ? m.leg1.path.displayRouteCode + '+' + m.leg2.path.displayRouteCode
  : m.path.displayRouteCode;

function fmtTrip(m) {
  if (m.isMultiLeg)
    return `[transfer] ${codeOf(m).padEnd(12)} board ${String(m.leg1.walkB).padStart(4)}m · transfer ${String(m.leg2.transferWalkM).padStart(3)}m (${m.leg1.alight.stopName}→${m.leg2.board.stopName}) · destwalk ${String(m.leg2.walkA).padStart(4)}m · ETA ${m._eta} dk`;
  return `[direct]   ${(codeOf(m)+' d'+m.path.direction).padEnd(12)} board ${String(m.walkB).padStart(4)}m (${m.board.stopName}) · destwalk ${String(m.walkA).padStart(4)}m (${m.alight.stopName}) · ETA ${m._eta} dk`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ASSERTION HARNESS
// ─────────────────────────────────────────────────────────────────────────────
let PASS = 0, FAIL = 0;
const RED = s => '\x1b[31m' + s + '\x1b[0m', GRN = s => '\x1b[32m' + s + '\x1b[0m';
function check(name, cond, detail = '') {
  if (cond) { PASS++; }
  else { FAIL++; console.log('   ' + RED('✗') + ' ' + name + (detail ? '  → ' + detail : '')); }
}
const eq     = (n, got, want)            => check(n, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const approx = (n, got, want, tol = 0.02)=> check(n, Math.abs(got - want) <= tol, `got ${got} want≈${want}`);
const section = t => console.log('\n── ' + t + ' ──');

// ── _travelToStopMins: terminal→stop minutes from GTFS arrival_offset (sec) ──
function testTravelToStopMins() {
  section('_travelToStopMins (terminal → stop minutes)');
  eq('terminal (seq1, offset 0) → 0',        _travelToStopMins({ seq: '1', arrival_offset: '0' }), 0);
  approx('arrival_offset 300s → 5 min',      _travelToStopMins({ seq: '4', arrival_offset: '300' }), 5);
  approx('arrival_offset 90s → 1.5 min',     _travelToStopMins({ seq: '3', arrival_offset: '90' }), 1.5);
  eq('missing offset → (seq-1)×1.5 fallback', _travelToStopMins({ seq: '5', arrival_offset: '0' }), 6);
  eq('no fields at all → 0',                  _travelToStopMins({}), 0);
  eq('null stop → 0',                         _travelToStopMins(null), 0);
}

// ── _rideMins: board.departure → alight.arrival, with monotonic guard/fallback ──
function testRideMins() {
  section('_rideMins (board→alight ride minutes, GTFS offsets)');
  const R = [
    { stopId: 'a', seq: '1', arrival_offset: '0',    departure_offset: '0'    }, // 0 terminal
    { stopId: 'b', seq: '2', arrival_offset: '120',  departure_offset: '150'  }, // 1
    { stopId: 'c', seq: '3', arrival_offset: '600',  departure_offset: '620'  }, // 2
    { stopId: 'd', seq: '4', arrival_offset: '700',  departure_offset: '0'    }, // 3 dep missing, arr present
    { stopId: 'e', seq: '5', arrival_offset: '0',    departure_offset: '0'    }, // 4 data gap (both 0)
    { stopId: 'f', seq: '6', arrival_offset: '1500', departure_offset: '1510' }, // 5
  ];
  approx('b→c uses dep[b]→arr[c]: (600-150)/60', _rideMins(R, 1, 2), 7.5);
  approx('terminal a→c (dep 0 valid at idx0)',   _rideMins(R, 0, 2), 10);
  eq('same index → 0',                            _rideMins(R, 2, 2), 0);
  approx('board dep missing → uses arr[board]',   _rideMins(R, 3, 5), (1500 - 700) / 60); // 13.33
  approx('alight offset missing → flat fallback', _rideMins(R, 1, 4), (4 - 1) * 1.5);     // 4.5
  approx('board gap (non-terminal) → fallback',   _rideMins(R, 4, 5), (5 - 4) * 1.5);     // 1.5
  // Non-monotonic (alight arrives "before" board departs) → flat fallback, never negative.
  const NM = [{ arrival_offset: '0', departure_offset: '0' }, { arrival_offset: '500', departure_offset: '600' }, { arrival_offset: '550', departure_offset: '560' }];
  approx('non-monotonic offsets → flat fallback', _rideMins(NM, 1, 2), 1.5);
  check('ride time is never negative', _rideMins(NM, 1, 2) >= 0);
}

// ── _waitFromTimes: next-departure wait, terminal-departure minutes ──
function testWaitFromTimes() {
  section('_waitFromTimes (next-departure wait)');
  const T = [600, 660, 720]; // 10:00, 11:00, 12:00
  eq('next after 630 → 30',          _waitFromTimes(T, 0, 630), 30);
  eq('exactly at a departure → 0',   _waitFromTimes(T, 0, 600), 0);
  eq('all gone → wrap to tomorrow',  _waitFromTimes(T, 0, 730), 600 + 1440 - 730); // 1310
  eq('travel offset shifts board',   _waitFromTimes([600], 10, 605), 5);           // bus reaches stop at 610
  eq('empty schedule → 20 sentinel', _waitFromTimes([], 0, 600), 20);
}

// ── _isLastSefer: is the caught departure the day's last? ──
function testIsLastSefer() {
  section('_isLastSefer (last-bus / son sefer)');
  const T = [600, 660, 720, 780];
  eq('catches the last → true',                _isLastSefer(T, 0, 775), true);
  eq('catches a mid one (later exists) → false', _isLastSefer(T, 0, 655), false);
  eq('catches first of many → false',          _isLastSefer(T, 0, 590), false);
  eq('all gone (wraps) → false',               _isLastSefer(T, 0, 781), false);
  eq('single departure, still ahead → true',   _isLastSefer([600], 0, 500), true);
  eq('travel offset, single → true',           _isLastSefer([600], 30, 620), true); // reaches stop 630≥620
  eq('empty schedule → false',                 _isLastSefer([], 0, 600), false);
}

// ── _liveBoardWaitMins: soonest catchable live bus (reachability + min) ──
function testLiveBoardWait() {
  section('_liveBoardWaitMins (live ranking, reachability grace)');
  const stops = [
    { stopId: 's0', seq: '1', arrival_offset: '0',    departure_offset: '0'    },
    { stopId: 's1', seq: '2', arrival_offset: '120',  departure_offset: '130'  },
    { stopId: 's2', seq: '3', arrival_offset: '300',  departure_offset: '310'  },
    { stopId: 's3', seq: '4', arrival_offset: '600',  departure_offset: '610'  }, // board
    { stopId: 's4', seq: '5', arrival_offset: '900',  departure_offset: '910'  },
    { stopId: 's5', seq: '6', arrival_offset: '1200', departure_offset: '1210' },
  ];
  const B = 3;
  // s1 reaches board in (600-130)/60 = 7.83; s2 in (600-310)/60 = 4.83.
  approx('reachable bus → wait ≈ arrival-arriveAtStop', _liveBoardWaitMins(stops, B, [{ stopId: 's1' }], 0, 5), 7.833 - 5);
  check('reachable bus beats a 12-min schedule', Math.min(12, _liveBoardWaitMins(stops, B, [{ stopId: 's1' }], 0, 5)) < 12);
  check('unreachable bus (arrives before walk-grace) → Infinity', _liveBoardWaitMins(stops, B, [{ stopId: 's2' }], 0, 10) === Infinity);
  check('schedule kept when live Infinity', Math.min(8, _liveBoardWaitMins(stops, B, [{ stopId: 's2' }], 0, 10)) === 8);
  check('within-grace late arrival still catchable (wait 0)', _liveBoardWaitMins(stops, B, [{ stopId: 's1' }], 0, 9.833) === 0);
  check('bus already past board → ignored', _liveBoardWaitMins(stops, B, [{ stopId: 's4' }], 0, 5) === Infinity);
  check('bus AT board stop (seq==board) → not approaching', _liveBoardWaitMins(stops, B, [{ stopId: 's3' }], 0, 5) === Infinity);
  approx('multiple buses → soonest reachable wins', _liveBoardWaitMins(stops, B, [{ stopId: 's1' }, { stopId: 's2' }], 0, 0), 4.833);
  check('no buses → Infinity', _liveBoardWaitMins(stops, B, [], 0, 5) === Infinity);
  check('boardIdx -1 (board not on path) → Infinity', _liveBoardWaitMins(stops, -1, [{ stopId: 's1' }], 0, 5) === Infinity);
}

// ── Schedule code/route helpers ──
function testScheduleHelpers() {
  section('schedule helpers');
  eq("schedCodeNorm strips Ç before digit (Ç960→960)", schedCodeNorm('Ç960'), '960');
  eq("schedCodeNorm strips Ç before digit (Ç11K→11K)", schedCodeNorm('Ç11K'), '11K');
  eq("schedCodeNorm keeps Ç before letter (ÇT3)",       schedCodeNorm('ÇT3'), 'ÇT3');
  eq("schedCodeNorm lowercases→upper (ç1→1)... ",       schedCodeNorm('ç1'), '1');
  eq("schedCodeNorm no-Ç passthrough (960)",            schedCodeNorm('960'), '960');

  const dayData = getActiveRoutes();
  check('active schedule has route entries', Object.keys(dayData).length > 0, `${Object.keys(dayData).length} entries`);

  // What the PDF actually covers: the first token of each schedule key, normalised.
  // Derived straight from the data — NOT via findSchedEntry, which is the thing
  // under test here.
  const schedBases = new Set(Object.keys(dayData).map(k => schedCodeNorm(k.split(' ')[0])));
  // A path is COVERABLE when the PDF ships a block for its code — or, for the
  // "-E" express convention, for its base code (11K-E ↔ "Ç11K KEPEZ EKSPRES").
  const coverable = code => {
    const n = schedCodeNorm(code);
    return schedBases.has(n) || (/-E$/.test(n) && schedBases.has(n.replace(/-E$/, '')));
  };

  // The contract findSchedEntry can actually be held to: resolve EVERY path the
  // PDF has a block for. How much of the network the PDF covers is a property of
  // the SOURCE (it lists ~14 route families; kentkart ships ~57 paths, the rest
  // being routes and phantom express variants the PDF never had), so asserting a
  // percentage of it measured the data, not the code — and sat one path from the
  // line, flapping red on unrelated transit-data updates.
  const unresolved = [];
  let covered = 0, resolved = 0, total = 0;
  for (const pe of pathCache) {
    const code = pe.path.displayRouteCode;
    if (!code || /^OGR|^ÖĞ/i.test(code)) continue;
    total++;
    const e = findSchedEntry(dayData, code);
    if (e) { resolved++; const times = schedTimesForPath(e, pe.path); check('schedTimesForPath returns array for ' + code, Array.isArray(times)); }
    if (coverable(code)) { covered++; if (!e) unresolved.push(code); }
  }
  check('findSchedEntry resolves every path the PDF has a block for',
    unresolved.length === 0,
    unresolved.length ? 'missed: ' + [...new Set(unresolved)].join(', ') : `${covered} coverable paths`);
  console.log(`   coverage: ${resolved}/${total} paths carry a timetable; ${total - resolved} are routes/express variants absent from the PDF`);

  // Phantom express variants (Ç1EKS, Ç9EKS, ÇT3E …) must resolve to NOTHING.
  // Per the operator only 11K's EKSPRES is a real service with its own block;
  // the others don't run at all. Teaching findSchedEntry the "EKS" suffix would
  // make them fall back to their base route's block (candidates[0]) and print the
  // REGULAR bus's departure times for a service that doesn't exist — planTrips
  // drops them as ghost routes precisely because they have no entry. This guards
  // that "fix" from ever being made.
  const ghostExpress = [...new Set(pathCache.map(pe => pe.path.displayRouteCode)
    .filter(c => c && /(EKS|E)$/.test(schedCodeNorm(c)) && !coverable(c)))];
  const ghostWithTimes = ghostExpress.filter(c => findSchedEntry(dayData, c) != null);
  check('phantom express variants inherit no timetable',
    ghostWithTimes.length === 0,
    ghostWithTimes.length ? 'wrongly resolved: ' + ghostWithTimes.join(', ') : `${ghostExpress.length} checked: ${ghostExpress.join(' ')}`);
  // The one real express keeps working — proof the guard above didn't just
  // blanket-break express matching.
  check('11K-E still resolves to the real EKSPRES block',
    /EKSPRES/i.test(Object.keys(dayData).find(k => dayData[k] === findSchedEntry(dayData, '11K-E')) || ''));

  // ── pickSchedDir ──────────────────────────────────────────────────────────
  // Nothing here used to cover it: schedTimesForPath silently falls back to
  // MERGING both blocks when pickSchedDir returns null, so a completely broken
  // pickSchedDir still produced a plausible time array and every assertion
  // passed. These lock the two cases core.js documents. PDF blocks are labelled
  // by their DEPARTURE terminal, so a path's block is the one whose label matches
  // where it STARTS — and kk's dirN is NOT always the PDF's dirN (Ç7 inverts,
  // which is exactly what the endpoint scoring exists to get right).
  const normStr = s => (s || '').toUpperCase().replace(/[^A-ZÇĞIİÖŞÜ0-9]/g, '');
  const blockLabelFor = (code, startsAt) => {
    const pe = pathCache.find(pe => pe.path.displayRouteCode === code
      && normStr((pe.path.busStopList || [])[0]?.stopName).startsWith(startsAt));
    if (!pe) return '(no such path)';
    const e = findSchedEntry(dayData, code);
    return normStr(e?.[pickSchedDir(e, pe.path)]?.label);
  };
  check('pickSchedDir: Ç9 departing OTOGAR takes the OTOGAR block',
    blockLabelFor('Ç9', 'OTOGAR') === 'OTOGAR', blockLabelFor('Ç9', 'OTOGAR'));
  check('pickSchedDir: Ç7 departing PARK17 takes the PARK 17 block (kk dir0 ↔ PDF dir1)',
    blockLabelFor('Ç7', 'PARK17').startsWith('PARK17'), blockLabelFor('Ç7', 'PARK17'));
  // Ç3 regression: its "SSK" label is 3 chars. While the label floor was 4 that
  // block scored 0 against both endpoints, Ç3 tied, and the tie-break gave the
  // ARDES-YURDU-departing path the SSK (opposite direction) timetable.
  check('pickSchedDir: Ç3 departing ARDES YURDU takes the ARDES YURDU block, not SSK',
    blockLabelFor('Ç3', 'ELBİKYK').startsWith('ARDESYURDU'), blockLabelFor('Ç3', 'ELBİKYK'));

  // The invariant the algorithm is built on: scoring both endpoints symmetrically
  // means the two kk directions agree on orientation, so a route's two paths can
  // never land on the SAME block (which would give one direction the other's
  // times — exactly the Ç3 failure above).
  const collapsed = [];
  for (const code of new Set(pathCache.map(pe => pe.path.displayRouteCode))) {
    const e = findSchedEntry(dayData, code);
    if (!e || !(e.dir0?.times?.length && e.dir1?.times?.length)) continue;
    const ps = pathCache.filter(pe => pe.path.displayRouteCode === code);
    if (ps.length !== 2) continue;
    const [a, b] = ps.map(pe => pickSchedDir(e, pe.path));
    if (a === b) collapsed.push(`${code}→${a}`);
  }
  check('pickSchedDir: a route\'s two directions never collapse onto one block',
    collapsed.length === 0, collapsed.join(', '));
}

// ── Detour-factored haversine fallback (used when Valhalla is unavailable) ──
function testWalkFallback() {
  section('walk-distance fallback (detour factor)');
  check('factor is a realistic 1.2–1.6', WALK_DETOUR_FACTOR >= 1.2 && WALK_DETOUR_FACTOR <= 1.6, `${WALK_DETOUR_FACTOR}`);
  // ~1 km straight line between two Çanakkale-ish points; factored ≥ raw.
  const raw = haversine(40.1553, 26.4142, 40.1643, 26.4142); // ~1 km due north
  const factored = raw * WALK_DETOUR_FACTOR;
  check('factored fallback ≥ raw haversine', factored >= raw, `${Math.round(factored)} vs ${Math.round(raw)}`);
  approx('factored = raw × factor', factored, raw * 1.35, 0.001);
}

// ── Guided "Start Trip" pure helpers ──
function testGuidedHelpers() {
  section('guided trip (buildGuidedSteps / thresholds)');
  // A real path with enough stops for a board→alight ride.
  const pe = pathCache.find(p => (p.path.busStopList || []).length >= 6);
  const st = pe.path.busStopList;
  const board = st[0], alight = st[4];
  const O = { lat: 40.15, lng: 26.41 }, D = { lat: 40.16, lng: 26.42 };

  // Direct: WALK, WAIT, RIDE, WALK, ARRIVED
  const direct = { path: pe.path, route: pe.route, board, alight, walkB: 200, walkA: 150, sc: 4, buses: [] };
  const ds = buildGuidedStepsSync(direct, O, D);
  eq('direct → 5 steps', ds.length, 5);
  eq('direct step types', ds.map(s => s.type).join(','), 'WALK,WAIT,RIDE,WALK,ARRIVED');
  eq('first WALK starts at origin', ds[0].from.lat, O.lat);
  eq('last WALK ends at dest', ds[3].to.lat, D.lat);
  eq('WAIT boards the board stop', ds[1].boardId, board.stopId);
  eq('RIDE alights the alight stop', ds[2].alightId, alight.stopId);

  // Multi-leg: WALK, WAIT, RIDE, TRANSFER, WAIT, RIDE, WALK, ARRIVED
  const ml = {
    isMultiLeg: true, _eta: 30,
    leg1: { path: pe.path, route: pe.route, board: st[0], alight: st[2], walkB: 200, sc: 2, wait: 5, ride: 4, buses: [] },
    leg2: { path: pe.path, route: pe.route, board: st[2], alight: st[5], walkA: 100, sc: 3, wait: 6, ride: 5, buses: [], transferWalkM: 0, transferWalkMins: 0 },
  };
  const ms = buildGuidedStepsSync(ml, O, D);
  eq('multi-leg → 8 steps', ms.length, 8);
  eq('multi-leg step types', ms.map(s => s.type).join(','), 'WALK,WAIT,RIDE,TRANSFER,WAIT,RIDE,WALK,ARRIVED');
  check('same-stop transfer flagged', ms[3].sameStop === true);

  // withinM: at the stop = within; ~1 km away = not.
  const sLat = parseFloat(board.lat), sLng = parseFloat(board.lng);
  check('within 35 m of the stop itself', withinM({ lat: sLat, lng: sLng }, board, GUIDED_ARRIVE_M));
  check('not within 35 m from 1 km away', !withinM({ lat: sLat + 0.009, lng: sLng }, board, GUIDED_ARRIVE_M));

  // movedPast: at the stop = not moved; near the next stop = moved (boarded).
  check('not boarded while at the stop', !movedPast({ lat: sLat, lng: sLng }, board, st[1], GUIDED_BOARDED_M));
  const nLat = parseFloat(st[1].lat), nLng = parseFloat(st[1].lng);
  check('boarded when near the next stop', movedPast({ lat: nLat, lng: nLng }, board, st[1], GUIDED_BOARDED_M));
}

// ── Data integrity of the committed JSON the planner relies on ──
function testDataIntegrity() {
  section('data integrity (stops.json / schedule.json)');
  let badCoord = 0, badOffsetMonotonic = 0, pathsWithOffsets = 0;
  for (const pe of pathCache) {
    const st = pe.path.busStopList || [];
    for (const s of st) if (!(isFinite(+s.lat) && isFinite(+s.lng) && +s.lat !== 0)) badCoord++;
    // arrival_offset must be non-decreasing along the trip (it's cumulative seconds).
    const offs = st.map(s => +s.arrival_offset);
    if (offs.some(o => o > 0)) pathsWithOffsets++;
    for (let i = 1; i < offs.length; i++) if (offs[i] > 0 && offs[i - 1] > 0 && offs[i] < offs[i - 1]) badOffsetMonotonic++;
  }
  check('all bus-stop coordinates are valid', badCoord === 0, `${badCoord} bad coords`);
  // kentkart ships a few non-monotonic offsets (data noise); _rideMins guards
  // against them with a flat-estimate fallback, so a small count is tolerated —
  // this is a regression guard against the data pipeline degrading wholesale.
  check('GTFS offset monotonicity violations stay rare (≤5)', badOffsetMonotonic <= 5, `${badOffsetMonotonic} violations`);
  check('a meaningful number of paths carry GTFS offsets (≥20)', pathsWithOffsets >= 20, `${pathsWithOffsets}/${pathCache.length} paths`);

  // Schedule times are valid HH:MM across every schedule/route/direction.
  let badTime = 0, timeCount = 0;
  for (const sched of scheduleData.schedules || []) {
    for (const entry of Object.values(sched.routes || {})) {
      for (const dir of ['dir0', 'dir1']) {
        for (const tm of entry[dir]?.times || []) { timeCount++; if (!/^\d{1,2}:\d{2}$/.test(tm)) badTime++; }
      }
    }
  }
  check('all schedule times are HH:MM', badTime === 0, `${badTime}/${timeCount} malformed`);
}

// ── Planner structural invariants on real data (uses Valhalla; haversine fallback offline) ──
async function testPlannerInvariants() {
  section('planTrips structural invariants (real data)');
  const W = SETTINGS.walkRadius;
  const rank = m => m._eta + (m.isMultiLeg ? TRANSFER_PENALTY_MIN : 0);
  let scenarios = 0, tripsSeen = 0;
  for (const [a, b] of PAIRS) {
    for (const mins of [8 * 60 + 30, 17 * 60]) {
      const { list, relaxed } = await planTrips(byId(STOPS[a]), byId(STOPS[b]), mins);
      scenarios++;
      const tag = `${a}→${b}`;
      check(`${tag}: returns ≤5 trips`, Array.isArray(list) && list.length <= 5, `len ${list.length}`);
      let prevRank = -Infinity, sorted = true;
      for (const m of list) {
        tripsSeen++;
        if (!(Number.isFinite(m._eta) && m._eta > 0 && m._eta < 300)) check(`${tag}: sane ETA`, false, `eta ${m._eta}`);
        if (rank(m) < prevRank - 0.001) sorted = false;
        prevRank = rank(m);
        if (m.isMultiLeg) {
          check(`${tag}: transfer legs differ (${codeOf(m)})`,
            m.leg1.path.displayRouteCode !== m.leg2.path.displayRouteCode);
        } else {
          check(`${tag}: direct board≠alight (${codeOf(m)})`, m.board.stopName !== m.alight.stopName);
        }
        if (!relaxed) check(`${tag}: comfy trip within walk radius`, m._maxWalk <= W, `maxWalk ${Math.round(m._maxWalk)}`);
      }
      if (list.length) check(`${tag}: list sorted by rank`, sorted);
    }
  }
  check('exercised all scenarios', scenarios === PAIRS.length * 2, `${scenarios}`);
  check('found trips for at least some scenarios', tripsSeen > 0, `${tripsSeen} trips`);
}

// ── Eyeball dump (kept for manual confirmation; full result lists) ──
async function printResults() {
  const active = getActiveSchedule();
  console.log('\nActive schedule:', active.id, '(' + (active.label || '') + ')  —  walkRadius', SETTINGS.walkRadius + 'm, speed', SETTINGS.walkSpeedMpm + 'm/min\n');
  for (const [a, b] of PAIRS) {
    const oName = byId(STOPS[a]).stopName, dName = byId(STOPS[b]).stopName;
    console.log('══════════════════════════════════════════════════════════════════════');
    console.log(`${a} → ${b}    (${oName} → ${dName})`);
    console.log('══════════════════════════════════════════════════════════════════════');
    for (const [label, mins] of TIMES) {
      const r = await planTrips(byId(STOPS[a]), byId(STOPS[b]), mins);
      const tag = r.relaxed ? '  ⚠ long-walk fallback (nothing within walking radius)' : '';
      console.log(`\n  ── ${label}${tag}`);
      if (!r.list.length) { console.log('     (no trips found)'); continue; }
      r.list.forEach((m, i) => console.log(`     ${i+1}. ` + fmtTrip(m)));
    }
    console.log('');
  }
}

async function main() {
  console.log('UNIT TESTS (deterministic, no network)');
  testTravelToStopMins();
  testRideMins();
  testWaitFromTimes();
  testIsLastSefer();
  testLiveBoardWait();
  testScheduleHelpers();
  testWalkFallback();
  testGuidedHelpers();
  testDataIntegrity();
  await testPlannerInvariants();

  console.log('\n' + (FAIL ? RED(`${FAIL} failed`) + ', ' : '') + GRN(`${PASS} passed`));
  if (FAIL) process.exitCode = 1;

  // Full result dump for manual inspection unless --quiet.
  if (!process.argv.includes('--quiet')) await printResults();
}
main();
