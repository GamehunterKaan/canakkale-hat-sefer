// Refresh transactions and the visible stale-data contract. Entirely offline.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import vm from 'node:vm';
import { refreshSchedules, sameSchedule } from '../scripts/lib/schedule-refresh.mjs';
import { parsePDF } from '../scripts/lib/schedule-parser.mjs';
import { MUNICIPALITY_URL, COLORS_URL } from '../scripts/lib/schedule-source.mjs';
import { scheduleHealth, STR, pickActiveScheduleId } from '../core.js';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (e) { e.message = name + ': ' + e.message; throw e; }
}
const root = mkdtempSync(join(tmpdir(), 'bus-schedule-test-'));
const now = Date.UTC(2026, 8, 18, 12);
const oldUrl = 'https://example.test/old.pdf', newUrl = 'https://example.test/new.pdf';
const weekendUrl = 'https://example.test/weekend.pdf', specialUrl = 'https://example.test/special.pdf';
const page = (weekday = oldUrl, special = false) =>
  '<a href="' + weekday + '">Hafta İçi Sefer Saatleri</a>' +
  '<a href="' + weekendUrl + '">Hafta Sonu Sefer Saatleri</a>' +
  (special ? '<a href="' + specialUrl + '">29 Ekim 2026 Bayram Sefer Saatleri</a>' : '');
const valid = () => ({ numPages:1, diagnostics:{ errors:[], ignored:[] },
  routes:{ 'Ç1 MERKEZ':{ name:'Ç1 MERKEZ', dir0:{ label:'MERKEZ', times:['08:00','09:00'] }, dir1:{ label:'KAMPÜS', times:['08:30'] } } } });
let caseIndex = 0;
function harness() {
  const dir = join(root, String(caseIndex++));
  const state = { html:page(), pdf:'%PDF-test', fail:null, parsed:valid() };
  const options = { outputDir:join(dir, 'data'), diagnosticsDir:join(dir, 'diagnostics'), now, log() {},
    fetchBytes:async url => {
      if (state.fail === url) throw new Error('Injected fetch failure');
      if (url === MUNICIPALITY_URL) return Buffer.from(state.html);
      if (url === COLORS_URL) return Buffer.from('{"routeList":[{"displayRouteCode":"1","routeColor":"ffffff"}]}');
      return Buffer.from(state.pdf);
    }, parsePdf:async () => structuredClone(state.parsed) };
  const run = extra => refreshSchedules({ ...options, ...extra });
  const bytes = () => readFileSync(join(options.outputDir, 'schedule.json'), 'utf8');
  return { dir, state, options, run, bytes };
}
try {
  await test('URL changes and same-URL content replacements are both detected', async () => {
    const h = harness();
    assert.equal((await h.run()).changed, true);
    h.state.html = page(newUrl);
    assert.equal((await h.run({ now:now + 1 })).changed, true);
    assert.equal(JSON.parse(h.bytes()).schedules[0].url, newUrl);
    const before = JSON.parse(h.bytes()).schedules[0].source.sha256;
    h.state.pdf += '\nreplacement';
    h.state.parsed.routes['Ç1 MERKEZ'].dir0.times.push('10:00');
    assert.equal((await h.run({ now:now + 2 })).changed, true);
    assert.notEqual(JSON.parse(h.bytes()).schedules[0].source.sha256, before);
    assert.ok(JSON.parse(h.bytes()).schedules[0].routes['Ç1 MERKEZ'].dir0.times.includes('10:00'));
  });
  await test('index-only route in a real PDF updates the timetable without a warning banner', async () => {
    const h = harness();
    await h.run();
    const currentUrl = 'https://example.test/19-EYLUL-5.pdf';
    const pdf = gunzipSync(readFileSync(new URL('./fixtures/schedules/weekend-2026-09-19.pdf.gz', import.meta.url)));
    h.state.html = page().replace(weekendUrl, currentUrl);
    const fetchBytes = h.options.fetchBytes, parsePdf = h.options.parsePdf;
    let currentBytes = pdf;
    h.options.fetchBytes = url => url === currentUrl ? currentBytes : fetchBytes(url);
    h.options.parsePdf = bytes => bytes.length > 1000 ? parsePDF(bytes) : parsePdf(bytes);
    const first = await h.run({ now:now + 1 });
    const data = JSON.parse(h.bytes());
    assert.equal(first.ok, true);
    assert.equal(first.status.state, 'ok');
    assert.deepEqual(first.status.errors, []);
    assert.deepEqual(first.status.sources[1].indexOnlyRoutes, ['Ç2']);
    assert.ok(first.report.warnings.some(w => /Ç2.*no timetable table/.test(w)));
    assert.equal(data.schedules[1].url, currentUrl);
    assert.equal(Object.keys(data.schedules[1].routes).length, 13);
    assert.equal(Object.keys(data.schedules[1].routes).some(name => name.startsWith('Ç2 ')), false);
    assert.equal(scheduleHealth(first.status, data, now + 1), null);
    // A changed file with the same omission must follow the same general rule.
    currentBytes = Buffer.concat([pdf, Buffer.from('\n% revised')]);
    const second = await h.run({ now:now + 2 });
    assert.equal(second.ok, true);
    assert.notEqual(second.status.sources[1].sha256, first.status.sources[1].sha256);
    assert.deepEqual(second.status.sources[1].indexOnlyRoutes, ['Ç2']);
  });
  await test('no-change verification preserves timetable timestamp and emits bounded heartbeat', async () => {
    const h = harness();
    await h.run();
    const before = h.bytes();
    const result = await h.run({ now:now + 3600000 });
    assert.equal(result.changed, false);
    assert.equal(result.statusChanged, false);
    assert.equal(h.bytes(), before);
    const heartbeat = await h.run({ now:now + 12 * 3600000 });
    assert.equal(heartbeat.statusChanged, true);
    assert.equal(heartbeat.status.checkedAt, now + 12 * 3600000);
    assert.equal(h.bytes(), before);
  });
  for (const failure of ['download','parser','invalid clock','missing direction','no diagnostics','discovery','no links'])
    await test(failure + ' keeps last good JSON and publishes failure status', async () => {
      const h = harness();
      await h.run();
      const before = h.bytes();
      h.state.html = page(newUrl);
      if (failure === 'download') h.state.fail = newUrl;
      if (failure === 'parser') h.state.parsed.diagnostics.errors.push('Route missing from source index');
      if (failure === 'invalid clock') h.state.parsed.routes['Ç1 MERKEZ'].dir0.times = ['25:00'];
      if (failure === 'missing direction') delete h.state.parsed.routes['Ç1 MERKEZ'].dir1;
      if (failure === 'no diagnostics') delete h.state.parsed.diagnostics;
      if (failure === 'discovery') h.state.fail = MUNICIPALITY_URL;
      if (failure === 'no links') h.state.html = '<html>Maintenance</html>';
      const result = await h.run({ now:now + 1000 });
      assert.equal(result.ok, false);
      assert.equal(result.changed, false);
      assert.equal(h.bytes(), before);
      assert.equal(result.status.state, 'error');
      assert.equal(result.status.dataFetchedAt, now);
      assert.equal(result.status.lastSuccessAt, now);
      assert.ok(result.status.errors.length);
      assert.equal(scheduleHealth(result.status, JSON.parse(before), now + 1000), 'failed');
      if (!['discovery','no links'].includes(failure)) assert.equal(result.status.sources[0].url, newUrl);
      assert.ok(readdirSync(h.options.diagnosticsDir).includes('report.json'));
      assert.ok(readdirSync(h.options.outputDir).every(name => !name.endsWith('.tmp')));
    });
  await test('one failed PDF cannot freeze independently verified services', async () => {
    const h = harness();
    await h.run();
    const oldWeekend = JSON.parse(h.bytes()).schedules[1];
    h.state.html = page(newUrl);
    h.state.fail = weekendUrl;
    const result = await h.run({ now:now + 1000 });
    assert.equal(result.ok, false);
    assert.equal(result.changed, true);
    assert.equal(JSON.parse(h.bytes()).schedules[0].url, newUrl);
    assert.deepEqual(JSON.parse(h.bytes()).schedules[1], oldWeekend);
    assert.equal(result.status.sources[1].state, 'error');
  });
  await test('regular schedule fallback survives a date change in the filename', async () => {
    const h = harness();
    const old = 'https://example.test/12-EYLUL-11.pdf', next = 'https://example.test/19-EYLUL-5.pdf';
    h.state.html = page().replace(weekendUrl, old);
    await h.run();
    const saved = JSON.parse(h.bytes()).schedules[1];
    h.state.html = page().replace(weekendUrl, next);
    h.state.fail = next;
    const result = await h.run({ now:now + 1000 });
    assert.equal(result.ok, false);
    assert.deepEqual(JSON.parse(h.bytes()).schedules[1], saved);
    assert.equal(result.status.sources[1].url, next);
  });
  await test('legacy fallback is reparsed once without marking the new source verified', async () => {
    const h = harness();
    await h.run();
    const legacy = JSON.parse(h.bytes());
    delete legacy.schedules[0].source;
    writeFileSync(join(h.options.outputDir, 'schedule.json'), JSON.stringify(legacy));
    h.state.html = page(newUrl);
    h.state.fail = newUrl;
    h.state.parsed.routes['Ç1 MERKEZ'].dir0.times.push('10:00');
    const result = await h.run({ now:now + 1000 });
    assert.equal(result.ok, false);
    const saved = JSON.parse(h.bytes()).schedules[0];
    assert.equal(saved.url, oldUrl);
    assert.ok(saved.source.sha256);
    assert.ok(saved.routes['Ç1 MERKEZ'].dir0.times.includes('10:00'));
    assert.equal(result.status.sources[0].url, newUrl);
    assert.equal(result.status.sources[0].state, 'error');
  });
  await test('unreadable new special stays visible and cannot select regular weekday times', async () => {
    const h = harness();
    await h.run();
    h.state.html = page(oldUrl, true);
    h.state.fail = specialUrl;
    const result = await h.run({ now:now + 1000 });
    assert.equal(result.ok, false);
    const schedules = JSON.parse(h.bytes()).schedules;
    const active = schedules.find(s => s.id === pickActiveScheduleId(schedules, { year:2026, mmdd:'10-29', isWeekend:false }));
    assert.equal(active.url, specialUrl);
    assert.equal(active.unavailable, true);
    assert.deepEqual(active.routes, {});
  });
  await test('failure recovery clears warning even when timetable bytes did not change', async () => {
    const h = harness();
    await h.run();
    h.state.fail = oldUrl;
    await h.run({ now:now + 1 });
    h.state.fail = null;
    const result = await h.run({ now:now + 2 });
    assert.equal(result.changed, false);
    assert.equal(result.statusChanged, true);
    assert.equal(result.status.state, 'ok');
    assert.equal(scheduleHealth(result.status, JSON.parse(h.bytes()), now + 2), null);
  });
  await test('route color outage does not block a valid timetable update', async () => {
    const h = harness();
    await h.run();
    h.state.fail = COLORS_URL;
    h.state.html = page(newUrl);
    const result = await h.run({ now:now + 1 });
    assert.equal(result.ok, true);
    assert.equal(JSON.parse(h.bytes()).routes[0].displayRouteCode, '1');
    assert.ok(result.report.warnings.length);
  });
  await test('corrupt saved JSON can be recovered by a verified fetch', async () => {
    const h = harness();
    await h.run();
    for (const name of ['schedule.json','schedule-status.json']) writeFileSync(join(h.options.outputDir, name), '{broken');
    assert.equal((await h.run()).ok, true);
    assert.equal(JSON.parse(h.bytes()).schedules.length, 2);
  });
  await test('content comparison ignores only build timestamp and object key order', () => {
    assert.ok(sameSchedule({ fetchedAt:1, schedules:[], routes:[] }, { routes:[], schedules:[], fetchedAt:2 }));
    assert.ok(!sameSchedule({ schedules:[{ url:oldUrl }] }, { schedules:[{ url:newUrl }] }));
  });
  await test('freshness tracks verification, stops warning on success, and detects stale clients', () => {
    const good = { version:1, state:'ok', checkedAt:now, dataFetchedAt:now - 100000000 };
    assert.equal(scheduleHealth(good, { fetchedAt:good.dataFetchedAt }, now), null);
    assert.equal(scheduleHealth(good, { fetchedAt:good.dataFetchedAt }, now + 49 * 3600000), 'overdue');
    assert.equal(scheduleHealth(good, { fetchedAt:1 }, now), 'outdated');
    assert.equal(scheduleHealth(null, {}, now), 'unknown');
    assert.equal(scheduleHealth({ ...good, checkedAt:now + 3600000 }, {}, now), 'unknown');
  });

  // Run the actual browser status functions against a tiny DOM, with network
  // and storage controlled. No Leaflet or external network is involved.
  class Element {
    children = []; hidden = false;
    replaceChildren() { this.children = []; }
    appendChild(child) { this.children.push(child); }
  }
  const banner = new Element(), storage = new Map();
  let data = { fetchedAt:now }, responseStatus, networkError = false, refreshCalls = 0;
  const context = vm.createContext({
    document:{ getElementById:() => banner, createElement:() => new Element() },
    localStorage:{ getItem:k => storage.get(k), setItem:(k,v) => storage.set(k,v) },
    getSchedule:() => data, scheduleHealth:(s,d) => scheduleHealth(s,d,now),
    STATUS_CACHE_KEY:'status', AbortController, setTimeout, clearTimeout, Date,
    t:key => STR.tr[key],
    fetch:async (_url, options) => {
      assert.equal(options.cache, 'no-store');
      if (networkError) throw new Error('offline');
      return { ok:true, json:async () => responseStatus };
    },
    refreshScheduleInBackground:async () => { refreshCalls++; },
  });
  const source = readFileSync(new URL('../ui.js', import.meta.url), 'utf8');
  const start = source.indexOf('let scheduleStatus = null;');
  const end = source.indexOf('// Fetch the freshest schedule.json', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  await test('app shows current PDF on failed refresh with unchanged cached schedule', async () => {
    responseStatus = { version:1, state:'error', checkedAt:now, dataFetchedAt:now,
      sources:[{ label:'Hafta İçi', url:newUrl }, { label:'unsafe', url:'javascript:alert(1)' }] };
    await vm.runInContext('loadScheduleStatus()', context);
    assert.equal(banner.hidden, false);
    assert.equal(banner.children[0].textContent, STR.tr.schedHealthFailed);
    assert.ok(banner.children.some(c => c.href === newUrl));
    assert.ok(banner.children.every(c => c.href !== 'javascript:alert(1)'));
    assert.equal(data.fetchedAt, now);
  });
  await test('app hides warning after recovery and retains aged status offline', async () => {
    responseStatus = { version:1, state:'ok', checkedAt:now, dataFetchedAt:now, sources:[] };
    await vm.runInContext('loadScheduleStatus()', context);
    assert.equal(banner.hidden, true);
    responseStatus = { ...responseStatus, checkedAt:now - 49 * 3600000 };
    await vm.runInContext('loadScheduleStatus()', context);
    networkError = true;
    await vm.runInContext('loadScheduleStatus()', context);
    assert.equal(banner.hidden, false);
    assert.equal(banner.children[0].textContent, STR.tr.schedHealthOverdue);
  });
  await test('fresh server status triggers retry when client timetable is old', async () => {
    networkError = false;
    responseStatus = { version:1, state:'ok', checkedAt:now, dataFetchedAt:now, sources:[] };
    data = { fetchedAt:now - 1 };
    await vm.runInContext('loadScheduleStatus()', context);
    assert.equal(refreshCalls, 1);
    assert.equal(banner.children[0].textContent, STR.tr.schedHealthOutdated);
    responseStatus = { ...responseStatus, state:'error' };
    await vm.runInContext('loadScheduleStatus()', context);
    assert.equal(refreshCalls, 2, 'failed weekend status must not block a newer valid weekday');
    assert.equal(banner.children[0].textContent, STR.tr.schedHealthFailed);
  });
} finally {
  // mkdtemp owns this exact directory; never remove a computed repo path.
  rmSync(root, { recursive:true, force:true });
}
console.log('Schedule refresh/status: ' + passed + ' checks passed (offline).');
