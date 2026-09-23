// A cold load can finish stops.json before schedule.json. The shared trip must
// stay pending until the timetable arrives, then open the requested detail.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../ui.js', import.meta.url), 'utf8');
const start = source.indexOf('let _pendingStopDeepLink =');
const end = source.indexOf('// Build the share URL', start);
assert.ok(start >= 0 && end > start, 'trip-link UI functions found');

// Reproduce the URL opened by MacroDroid: its Open Website action encoded the
// link's already-encoded values a second time (%2C -> %252C, etc.).
const url = new URL('https://example.test/?trip=1');
for (const [key, value] of Object.entries({
  o: '40.15000%2C26.41000', d: '40.16000%2C26.42000', m: 'arrive', t: '08%3A55',
  l1: '1%7C0%7C101%7C102',
})) url.searchParams.set(key, value);
assert.match(url.search, /40\.15000%252C26\.41000/, 'test URL is double encoded');

const board = { stopId: 101, lat: 40.15, lng: 26.41 };
const alight = { stopId: 102, lat: 40.16, lng: 26.42 };
const pathCache = [{ path: { displayRouteCode: '1', direction: 0, busStopList: [board, alight] } }];
let schedule = null;
let rebuilt = 0;
let opened = 0;
let openedMatch = null;
const context = vm.createContext({
  window: { location: { search: url.search }, _map: {} }, URLSearchParams,
  allStops: new Map([[101, board], [102, alight]]), getPathCache: () => pathCache,
  getActiveSchedule: () => schedule, getActiveRoutes: () => schedule?.routes || {},
  document: {
    getElementById: () => ({ classList: { add() {} } }),
    querySelectorAll: () => [],
  },
  _schedFrame: n => n, _schedNow: () => 19 * 60, _syncPlanModeButtons() {},
  applyPoint(lat, lng, which) { context[which === 'origin' ? 'originClick' : 'destClick'] = { lat, lng }; },
  showScreen() {}, _walkDistGet() {}, _walkDistSet() {},
  _walkDistances: async (_point, stops) => new Map([...stops.keys()].map(id => [id, 100])),
  _walkMatrix() {},
  buildTripFromSpec(_spec, opts) {
    rebuilt++;
    assert.equal(opts.dayData, schedule.routes);
    assert.equal(opts.arriveByMins, 8 * 60 + 55, 'link keeps its arrival deadline');
    assert.equal(opts.nowMins, 4 * 60, 'expired link rebuilds from service-day start');
    return { trip: true };
  },
  setHint() {}, hidePlannerGuide() {}, renderPlannerResults() {}, expandPanel() {},
  showTripDetail(m) { assert.equal(m.trip, true); openedMatch = m; opened++; },
  SETTINGS: {}, t: key => key,
  planMode: 'depart', arriveByMins: null, planOffset: 0,
  originClick: null, destClick: null, currentMatches: [],
  _suppressAutoPlan: false,
  arriveActive: () => context.planMode === 'arrive' && context.arriveByMins != null,
  Date,
});
const guidedHelper = source.match(/const canStartGuidedTrip =[^;]+;/)?.[0];
assert.ok(guidedHelper, 'guided-trip policy helper found');
context.planningAhead = () => true;
vm.runInContext(guidedHelper, context);
vm.runInContext(source.slice(start, end), context);

vm.runInContext('applyDeepLink()', context);
assert.equal(vm.runInContext('_pendingTripDeepLink !== null', context), true,
  'trip link remains pending when timetable has not loaded');
assert.equal(rebuilt, 0);

schedule = { routes: { '1': {} } };
vm.runInContext('applyDeepLink()', context);
await new Promise(resolve => setImmediate(resolve));
assert.equal(rebuilt, 1, 'trip rebuilt after timetable loads');
assert.equal(opened, 1, 'trip detail opened');
assert.equal(openedMatch?._restoredFromTripLink, true,
  'restored trip is marked as safe to follow step by step');
assert.equal(vm.runInContext('canStartGuidedTrip(currentMatches[0])', context), true,
  'planning-ahead shared trip keeps guided mode available');
assert.equal(vm.runInContext('canStartGuidedTrip({})', context), false,
  'ordinary planning-ahead trip remains blocked from guided mode');
assert.equal(vm.runInContext('_pendingTripDeepLink', context), null);

console.log('trip link double-decode, cold-load, expired arrival restore, and guided mode: passed');
