// A cold load can finish stops.json before schedule.json. The shared trip must
// stay pending until the timetable arrives, then open the requested detail.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../ui.js', import.meta.url), 'utf8');
const start = source.indexOf('let _pendingStopDeepLink =');
const end = source.indexOf('// Build the share URL', start);
assert.ok(start >= 0 && end > start, 'trip-link UI functions found');

const url = new URL('https://example.test/?trip=1');
for (const [key, value] of Object.entries({
  o: '40.15000,26.41000', d: '40.16000,26.42000', m: 'arrive', t: '08:55',
  l1: '1|0|101|102',
})) url.searchParams.set(key, value);

const board = { stopId: 101, lat: 40.15, lng: 26.41 };
const alight = { stopId: 102, lat: 40.16, lng: 26.42 };
const pathCache = [{ path: { displayRouteCode: '1', direction: 0, busStopList: [board, alight] } }];
let schedule = null;
let rebuilt = 0;
let opened = 0;
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
  showTripDetail(m) { assert.equal(m.trip, true); opened++; },
  SETTINGS: {}, t: key => key,
  planMode: 'depart', arriveByMins: null, planOffset: 0,
  originClick: null, destClick: null, currentMatches: [],
  _suppressAutoPlan: false,
  arriveActive: () => context.planMode === 'arrive' && context.arriveByMins != null,
  Date,
});
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
assert.equal(vm.runInContext('_pendingTripDeepLink', context), null);

console.log('trip link cold-load order and expired arrival restore: passed');
