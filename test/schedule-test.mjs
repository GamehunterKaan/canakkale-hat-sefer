// Offline, actual PDF extraction plus source-layout and discovery regressions.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { extractPdf, parsePages, parsePDF, routeHeading } from '../scripts/lib/schedule-parser.mjs';
import { discoverPdfLinks, parseDates, requestBytes } from '../scripts/lib/schedule-source.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (e) { e.message = name + ': ' + e.message; throw e; }
}
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/schedules/sources.json', import.meta.url)));
const parsed = [], pages = [];
const counts = [
  { 'Ç1':[36,35], 'Ç2':[15,16], 'Ç3':[26,27], 'Ç5':[6,0], 'Ç7':[41,41], 'Ç8':[29,29], 'Ç9':[35,35],
    'Ç960':[33,33], 'ÇT3':[39,40], 'Ç11K':[25,25], 'Ç11K EKSPRES':[35,36], 'Ç11G':[55,51], 'ÇT1':[11,11], 'ÇT2':[1,1], 'Ç11Ç':[5,7] },
  { 'Ç1':[36,37], 'Ç2':[23,22], 'Ç3':[36,38], 'Ç5':[6,0], 'Ç7':[44,45], 'Ç8':[37,36], 'Ç9':[35,35],
    'Ç10':[23,19], 'Ç960':[36,36], 'ÇT3':[40,39], 'Ç11K':[31,31], 'Ç11K EKSPRES':[41,42], 'Ç11G':[24,25],
    'Ç11Ç':[6,7], 'ÇT1':[11,11], 'ÇT2':[1,1] },
  { 'Ç1':[23,24], 'Ç3':[27,29], 'Ç7':[20,22], 'Ç8':[28,29], 'Ç9':[35,35], 'ÇT3':[23,24],
    'Ç11K':[25,24], 'Ç11G':[48,46], 'ÇT1':[4,4], 'Ç11Ç':[5,8] },
];
// Weekday editions from 17 September on carry the note "22:05 (Ç3) SSK-HÜSEYİN
// ELBİ YURDU" in the Ç960 Nusrat column: a Ç3 trip, not a Ç960 departure.
counts[1]['Ç960'] = [36,35];
counts.push({ ...counts[1], 'Ç2':[29,30] });
counts.push({ 'Ç1':[26,26], 'Ç3':[26,26], 'Ç7':[25,26], 'Ç8':[18,18], 'Ç8 EKSPRES':[37,37],
  'Ç9':[35,35], 'Ç960':[25,25], 'ÇT3':[26,25], 'Ç11K':[19,17], 'Ç11K EKSPRES':[86,91],
  'Ç11G':[26,26], 'Ç11Ç':[6,8], 'ÇT1':[4,4] });
counts.push({ ...counts[3], 'ÇT3':[51,52] });
// October editions: the Ç4 page lists other routes' trips as note rows in the
// Hüseyin Elbi column ("07:30 - JANDARMA IŞIKLARINDAN- Ç960"), and the Ç11K page
// keeps 06:50, 07:50 and 08:30 as white text in empty Dardanos cells. Neither
// is a departure; renders and the audit of 26 October confirmed every cell.
counts.push({ 'Ç1':[36,37], 'Ç3':[36,37], 'Ç3 EKSPRES':[51,54], 'Ç4':[87,89], 'Ç5':[4,0],
  'Ç7':[41,43], 'Ç8':[37,36], 'Ç9':[35,35], 'Ç10':[23,19], 'Ç960':[35,34], 'ÇT3':[52,52],
  'Ç11K':[17,20], 'Ç11K EKSPRES':[58,62], 'Ç11G':[24,25], 'Ç11Ç':[7,7], 'ÇT1':[12,11], 'ÇT2':[1,1] });
// 8-EKIM-12 adds two note rows (07:20, 07:40) and a white 08:15 on the Ç4 page.
counts.push({ ...counts[6], 'Ç4':[86,89], 'Ç11K EKSPRES':[58,63] });
counts.push({ 'Ç4':[62,65] });
counts.push({ 'Ç11K EKSPRES':[76,81], 'Ç11K':[17,20], 'Ç11Ç':[7,7] });
// 20-EKIM-6: pages 6, 11, 12, 15 and 16 were checked against renders.
counts.push({ 'Ç1':[37,39], 'Ç3':[37,38], 'Ç3 EKSPRES':[40,42], 'Ç4':[88,91], 'Ç5':[4,0],
  'Ç7':[36,37], 'Ç8':[37,36], 'Ç9':[35,35], 'Ç10':[23,19], 'Ç960':[35,34], 'ÇT3':[49,49],
  'ÇT3 EKSPRES':[29,30], 'Ç11K':[17,20], 'Ç11K EKSPRES':[65,68], 'Ç11G':[24,25], 'Ç11Ç':[7,7],
  'ÇT1':[12,11], 'ÇT2':[1,1] });
// 20-EKIM-11: page 16 was checked cell by cell against its text layer. From this
// edition the Ç3 18:20 cell is white text, and Ç10 carries the wrapped note
// "16:55 ESKİ HASTANE-GÜZELYALI (Ç11G)", a Ç11G trip.
counts.push({ ...counts[10], 'Ç3':[36,37], 'Ç10':[23,17], 'Ç11K EKSPRES':[77,81], 'Ç11G':[24,26] });
// 26-EKIM and 28-EKIM-9: pages 16 and 17 were counted per column from the text
// layer. 28-EKIM-9's ÇT2 row ends in "14:00 BİTİŞ", the trip's end of service.
counts.push({ ...counts[11], 'Ç1':[31,33], 'ÇT3':[42,44], 'Ç11K':[20,23], 'Ç11K EKSPRES':[78,81] });
counts.push({ ...counts[12], 'ÇT1':[8,7], 'ÇT2':[1,1] });
// 31-EKIM-10, the October weekend layout: every page was audited against renders.
counts.push({ 'Ç1':[26,26], 'Ç3':[26,26], 'Ç3 EKSPRES':[30,30], 'Ç4':[42,42], 'Ç7':[21,22], 'Ç8':[37,36],
  'Ç9':[35,35], 'Ç960':[33,34], 'ÇT3':[26,26], 'Ç11K':[17,16], 'Ç11K EKSPRES':[60,59], 'Ç11G':[26,25],
  'ÇT1':[4,4], 'Ç11Ç':[7,8] });
// The Friday Kepez edition of 26 October: three pages, the express table on page 1.
counts.push({ 'Ç11K EKSPRES':[76,81], 'Ç11K':[17,20], 'Ç11Ç':[7,7] });
// The publisher's 19 September PDF lists Ç2 without a Ç2 table. The October
// weekend cover lists Ç4 EKSPRES while its table is headed Ç-4 ESENLER.
const coverOnly = { 4: ['Ç2'], 14: ['Ç4 EKSPRES'] }, tableOnly = { 14: ['Ç4'] };
const expectedIndexOnly = index => coverOnly[index] || [];
const getRoute = (result, id) => Object.values(result.routes).find(r => routeHeading(r.name).id === id);
// A direction's departures: those from its terminal and the trips that start at another stop.
const departures = d => [...new Set([...d.times, ...(d.trips || []).filter(t => t.from).map(t => t.time)])];
const startingAt = (d, from) => (d.trips || []).filter(t => t.from === from).map(t => t.time);
for (const [index, fixture] of fixtures.entries()) {
  await test(fixture.name + ' extraction and complete route/direction counts', async () => {
    const bytes = gunzipSync(readFileSync(new URL('./fixtures/schedules/' + fixture.name + '.pdf.gz', import.meta.url)));
    assert.equal(bytes.length, fixture.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.sha256);
    pages[index] = await extractPdf(bytes);
    parsed[index] = parsePages(pages[index]);
    assert.deepEqual(parsed[index].diagnostics.errors, []);
    assert.deepEqual(parsed[index].diagnostics.indexOnlyRoutes, expectedIndexOnly(index));
    if (parsed[index].diagnostics.expectedRoutes.length)
      assert.deepEqual([...parsed[index].diagnostics.expectedRoutes.filter(id => !expectedIndexOnly(index).includes(id)),
        ...tableOnly[index] || []].sort(), parsed[index].diagnostics.parsedRoutes);
    assert.deepEqual(Object.fromEntries(Object.values(parsed[index].routes).map(r =>
      [routeHeading(r.name).id, [departures(r.dir0).length, departures(r.dir1).length]])), counts[index]);
  });
  for (const [name, transform] of [
    ['reordered text', p => ({ ...p, items: [...p.items].reverse() })],
    ['scaled page and glyphs', p => ({ ...p, width:p.width * 1.7, height:p.height * 1.7,
      items:p.items.map(i => ({ ...i, x:i.x * 1.7, y:i.y * 1.7, w:i.w * 1.7, h:i.h * 1.7 })) })],
    ['dash, whitespace and clock typography', p => ({ ...p, items:p.items.map(i => ({ ...i,
      text:i.text.replace(/-/g, '–').replace(/^Ç(\d)/u, 'Ç – $1').replace(/(\d{1,2}):(\d{2})/g, '$1 . $2') })) })],
    ['split clock glyphs', p => ({ ...p, items:p.items.flatMap(i => {
      if (!/^\d{2}:\d{2}$/.test(i.text)) return [i];
      return [{ ...i, text:i.text.slice(0,3), w:i.w * 3/5 },
        { ...i, text:i.text.slice(3), x:i.x + i.w * 3/5, w:i.w * 2/5 }];
    }) })],
  ]) await test(fixture.name + ': ' + name, () => {
    const result = parsePages(pages[index].map(transform));
    assert.deepEqual(result.diagnostics.errors, []);
    assert.deepEqual(result.diagnostics.indexOnlyRoutes, expectedIndexOnly(index));
    assert.deepEqual(result.routes, parsed[index].routes);
  });
}
await test('Friday Kepez express retains both departure origins despite the small route caption', () => {
  const r = getRoute(parsed[9], 'Ç11K EKSPRES');
  assert.equal(r.dir0.label, 'DARDANOS');
  assert.equal(r.dir1.label, 'GAZİ OKULU');
  for (const t of ['08:05','12:25','19:35']) assert.ok(r.dir0.times.includes(t));
  for (const t of ['19:55','23:35']) assert.ok(startingAt(r.dir0, 'KEPEZ 144 TOK').includes(t), 'evening trips start at Kepez 144 TOKİ');
  // The page legend says Çınarlı trips do not call at the campus: these start in the village.
  assert.deepEqual(startingAt(r.dir0, 'ÇINARLI'), ['07:20','08:50']);
  assert.equal(r.dir0.times.includes('07:20'), false, 'a hidden 07:20 and a Çınarlı trip are not Dardanos departures');
  for (const t of ['07:30','07:40','14:40','19:35','00:00']) assert.ok(r.dir1.times.includes(t));
  assert.equal(r.dir0.times.includes('07:00'), false, 'Kepez intermediate-stop time is not a Dardanos departure');
  assert.equal(r.dir0.times.includes('00:00'), false, 'Gazi departure is not copied to Dardanos');
});
await test('a note wrapped under its time is read however tightly it sits between the rows beside it', () => {
  // Each note sits a little over half a row from the times of the columns beside it.
  assert.ok(getRoute(parsed[0], 'Ç11K EKSPRES').dir1.trips.some(t => t.time === '15:45' && t.note === 'KALABAKLI'));
  assert.ok(getRoute(parsed[2], 'Ç11K').dir1.trips.some(t => t.time === '16:50' && t.note === 'KALABAKLI'));
});
await test('a return trip whose KALKIŞ is printed VARIŞ fails instead of losing its direction', () => {
  const altered = structuredClone(pages[13]);
  for (const i of altered.find(p => p.number === 3).items.filter(i => !i.hidden && i.text === 'KALKIŞ' && i.x > 300)) i.text = 'VARIŞ';
  assert.ok(parsePages(altered).diagnostics.errors.includes('Page 3: Ç1 return trip after GAZİ MECLİSİ VARIŞ has no departure column'));
});
await test('ÇT2 departs Kepez 144 TOKİ wherever and however its direction caption is set', () => {
  const kepez = edit => {
    const altered = structuredClone(pages[13]);
    for (const i of altered.find(p => p.number === 21).items.filter(i => i.text === 'KEPEZ - KAMPÜS')) {
      const c = i.x + i.w / 2;
      edit(i);
      i.x = c - i.w / 2 + (i.shift || 0);
    }
    return getRoute(parsePages(altered), 'ÇT2').dir1.times;
  };
  for (const [name, edit] of [['12pt left', i => { i.shift = -12; }], ['20pt right', i => { i.shift = 20; }],
    ['in 8pt', i => { i.w *= 8 / i.h; i.h = 8; }], ['as 144 TOKİ - KAMPÜS', i => { i.w *= 17 / 14; i.text = '144 TOKİ - KAMPÜS'; }]])
    assert.deepEqual(kepez(edit), ['08:00'], name);
});
await test('Ç4 repeated wide terminal header preserves evening departures', () => {
  const r = getRoute(parsed[6], 'Ç4');
  assert.match(r.dir0.label, /HÜSEYİN ELBİ/);
  assert.deepEqual(r.dir0.times.filter(t => t >= '18:20'),
    '18:20 18:40 19:00 19:20 19:40 20:00 20:20 20:40 21:00 21:20 21:40 22:00'.split(' '));
  // In the evening the trips turn at Eski Hastane instead of Bahriye Üçok Caddesi.
  assert.deepEqual(r.dir0.trips.filter(t => t.to === 'ESKİ HASTANE').map(t => t.time),
    '18:20 18:40 19:00 19:20 19:40 20:00 20:20 20:40 21:00 21:20 21:40 22:00'.split(' '));
  assert.deepEqual(startingAt(r.dir1, 'ESKİ HASTANE'),
    '19:00 19:20 19:40 20:00 20:20 20:40 21:00 21:20 21:40 22:00 22:20'.split(' '));
  assert.equal(r.dir1.label, 'BAHRİYE ÜÇOK CADDESİ');
  assert.equal(r.dir1.times.some(t => t >= '19:00'), false, 'evening returns do not leave from Bahriye Üçok Caddesi');
  assert.equal(parsed[6].diagnostics.pages.find(p => p.page === 6).tables.length, 2);
});
// Use the repeated header's actual geometry, not a route-name exception.
const eveningHeader = () => pages[6].find(p => p.number === 6).items.find(i =>
  /YURT KALKIŞ/u.test(i.text) && i.y < pages[6][5].height / 2);
for (const [name, factor, offset] of [
  ['wider', 3, 0], ['shifted left', 1.7, -8], ['shifted right', 1.7, 8],
]) await test('repeated terminal caption ' + name + ' keeps the same departures', () => {
  const altered = structuredClone(pages[6]), header = eveningHeader();
  for (const i of altered.find(p => p.number === 6).items) {
    if (/HÜSEYİN ELBİ/u.test(i.text) && i.y > header.y && i.y < header.y + header.h * 2) {
      i.x += offset - i.w * (factor - 1) / 2;
      i.w *= factor;
    }
  }
  const result = parsePages(altered);
  assert.deepEqual(result.diagnostics.errors, []);
  assert.deepEqual(result.routes, parsed[6].routes);
});
for (const width of [35,70,120,170,240]) await test('an unnumbered title of width ' + width + ' beside a continuation fails explicitly', () => {
  const altered = structuredClone(pages[6]), header = eveningHeader();
  altered.find(p => p.number === 6).items.push({ text:'YENİ KÖY', x:60, y:header.y, w:width, h:header.h });
  const result = parsePages(altered);
  assert.ok(result.diagnostics.errors.some(e => /unknown unnumbered table: YENİ KÖY/u.test(e)));
  assert.equal(getRoute(result, 'Ç4').dir0.times.includes('22:00'), false);
});
await test('a continuation without a matching departure terminal is rejected', () => {
  const altered = structuredClone(pages[6]), header = eveningHeader();
  for (const i of altered.find(p => p.number === 6).items) {
    if (/HÜSEYİN ELBİ/u.test(i.text) && i.x < 200 && i.y > header.y && i.y < header.y + header.h * 2)
      i.text = 'BİLİNMEYEN TERMİNAL';
  }
  assert.ok(parsePages(altered).diagnostics.errors.some(e =>
    /unknown unnumbered table: BİLİNMEYEN TERMİNAL|untitled table cannot be matched to Ç4/u.test(e)));
});
await test('an invalid evening departure fails instead of disappearing', () => {
  const altered = structuredClone(pages[6]), header = eveningHeader();
  const cell = altered.find(p => p.number === 6).items.find(i => i.text === '22:00' && i.x < 200 && i.y < header.y);
  assert.ok(cell);
  cell.text = '25:00';
  assert.ok(parsePages(altered).diagnostics.errors.some(e => /invalid departure 25:00 for Ç4/u.test(e)));
});
await test('Kepez express evening section with an unmarked mirrored origin keeps both directions', () => {
  const r = getRoute(parsed[10], 'Ç11K EKSPRES');
  assert.equal(r.dir0.label, 'DARDANOS');
  assert.equal(r.dir1.label, 'GAZİ OKULU');
  // After 18:05 no bus leaves the campus: the evening trips start at Kepez 144
  // TOKİ, and Gazi Okulu's evening trips end there.
  assert.deepEqual(r.dir0.times.filter(t => t >= '18:00'), ['18:05']);
  assert.deepEqual(startingAt(r.dir0, 'KEPEZ 144 TOKİ'),
    '18:25 18:45 19:05 19:25 19:45 20:05 20:20 20:35 20:50 21:05 21:20 21:35 21:50 22:05 22:20 22:35 22:50 23:10 23:45'.split(' '));
  assert.deepEqual(r.dir1.times.filter(t => t >= '18:00'),
    '18:10 18:30 18:50 19:10 19:30 19:50 20:10 20:30 20:50 21:05 21:20 21:35 21:50 22:05 22:10 22:30 22:50 23:05 23:10 23:30 23:50'.split(' '));
  assert.deepEqual(r.dir1.trips.filter(t => t.to === 'KEPEZ 144 TOKİ').map(t => t.time),
    '19:10 19:30 19:50 20:10 20:30 20:50 21:05 21:20 21:35 21:50 22:05 22:10 22:30 22:50 23:05 23:10 23:30 23:50'.split(' '));
  const tables = parsed[10].diagnostics.pages.find(p => p.page === 16).tables;
  assert.deepEqual(tables.map(t => t.columns.map(c => c.label)), [['DARDANOS', 'GAZİ OKULU'], ['KEPEZ 144 TOKİ', 'GAZİ OKULU']]);
  // 46: a white 07:20 beside the visible "7:20 çınarlı" is not read.
  assert.deepEqual(tables.map(t => t.columns.map(c => c.times.length)), [[46, 50], [19, 18]]);
});
// The evening header has no KALKIŞ beside KEPEZ 144 TOKİ; geometry, not a name.
const kepezEvening = () => pages[10].find(p => p.number === 16).items.filter(i =>
  /^(?:KEPEZ|144 TOKİ)$/u.test(i.text) && i.y < 260 && i.y > 150);
await test('an evening origin whose terminal is not repeated at the far end fails explicitly', () => {
  const altered = structuredClone(pages[10]);
  const right = Math.max(...kepezEvening().map(i => i.x));
  for (const i of altered.find(p => p.number === 16).items)
    if (/^(?:KEPEZ|144 TOKİ)$/u.test(i.text) && i.y < 260 && i.y > 150 && i.x >= right - 10) i.text = 'DARDANOS';
  const result = parsePages(altered);
  assert.ok(result.diagnostics.errors.some(e => /Page 16: unknown unnumbered table: KEPEZ/u.test(e)));
  assert.equal(getRoute(result, 'Ç11K EKSPRES').dir0.times.includes('23:45'), false);
});
await test('an unnumbered title beside a mirrored-origin continuation still fails', () => {
  const altered = structuredClone(pages[10]), header = kepezEvening()[0];
  altered.find(p => p.number === 16).items.push({ text:'YENİ KÖY', x:60, y:header.y, w:50, h:header.h });
  const result = parsePages(altered);
  assert.ok(result.diagnostics.errors.some(e => /unknown unnumbered table: YENİ KÖY/u.test(e)));
});
// 20-EKIM-11 repeats the evening header on one line: a single wide "KEPEZ TOKİ"
// caption that starts left of the table edge, and no VARIŞ anywhere in the row.
const evening11 = () => pages[11].find(p => p.number === 16).items.filter(i => i.y > 198 && i.y < 205);
await test('one-line Kepez express evening header keeps its KEPEZ TOKİ origin', () => {
  const tables = parsed[11].diagnostics.pages.find(p => p.page === 16).tables;
  assert.deepEqual(tables.map(t => t.columns.map(c => c.label)), [['DARDANOS', 'GAZİ OKULU'], ['KEPEZ TOKİ', 'GAZİ OKULU']]);
  assert.deepEqual(tables[1].columns[0].times,
    '18:20 18:35 18:50 19:00 19:15 19:25 19:35 19:50 20:00 20:15 20:35 20:55 21:05 21:25 21:40 22:00 22:10 22:20 22:35 22:50 23:20 00:00'.split(' '));
  assert.deepEqual(tables[1].columns[1].times,
    '19:05 19:20 19:35 19:45 19:50 20:05 20:15 20:25 20:45 20:55 21:20 21:35 21:45 22:00 22:25 22:35 22:45 23:05 23:15 23:35 23:55'.split(' '));
  // 60: the centred banner "7:30 SSK'dan ÇINARLI" (bus 7 repositions from SSK)
  // is not a Gazi Okulu cell, even where its time falls in that column.
  assert.deepEqual(tables[0].columns.map(c => c.times.length), [55, 60]);
});
await test('the one-line origin caption excuses only itself, not a title beside it', () => {
  const altered = structuredClone(pages[11]), header = evening11()[0];
  altered.find(p => p.number === 16).items.push({ text:'YENİ KÖY', x:60, y:header.y, w:50, h:header.h });
  assert.ok(parsePages(altered).diagnostics.errors.some(e => /unknown unnumbered table: YENİ KÖY/u.test(e)));
});
await test('without a mirrored far-end terminal the one-line evening header fails explicitly', () => {
  const altered = structuredClone(pages[11]);
  for (const i of altered.find(p => p.number === 16).items)
    if (i.y > 198 && i.y < 205 && i.text === 'KEPEZ TOKİ' && i.x > 400) i.text = 'DARDANOS';
  const result = parsePages(altered);
  assert.ok(result.diagnostics.errors.some(e => /Page 16: unknown unnumbered table: KEPEZ TOKİ/u.test(e)));
  assert.equal(getRoute(result, 'Ç11K EKSPRES').dir0.times.includes('00:00'), false);
});
await test('a continuation origin departs only where the previous section departed, else fails loudly', () => {
  const unconfirmed = (result, origin) => {
    assert.ok(result.diagnostics.errors.includes(`Page 16: Ç11K EKSPRES origin ${origin} is not a confirmed departure`));
    const route = getRoute(result, 'Ç11K EKSPRES');
    assert.equal(route ? departures(route.dir0).includes('00:00') : false, false);
  };
  // The day section loses its DARDANOS caption. Its campus times then sit under
  // no departure header, so the day table fails instead of departing from GAZİ
  // OKULU alone, and the evening section has no table to continue.
  const noDayOrigin = structuredClone(pages[11]);
  const day = noDayOrigin.find(p => p.number === 16);
  day.items = day.items.filter(i => !(i.text === 'DARDANOS' && i.y > 750 && i.x < 160));
  unconfirmed(parsePages(noDayOrigin), 'KEPEZ MEYDAN');
  // The evening KALKIŞ moves one column left, onto the GAZİ OKULU arrival, where
  // the day section had no departures.
  const movedKalkis = structuredClone(pages[11]);
  for (const i of movedKalkis.find(p => p.number === 16).items.filter(i => i.y > 198 && i.y < 205)) {
    if (i.text === 'GAZİ OKULU KALKIŞ') i.text = 'GAZİ OKULU';
    else if (i.text === 'GAZİ OKULU') i.text = 'GAZİ OKULU KALKIŞ';
  }
  unconfirmed(parsePages(movedKalkis), 'KEPEZ TOKİ');
  // A table with its own route title is a new table, not a continuation: its
  // unmarked origin is not inferred from the section above, and the table
  // fails rather than publishing GAZİ OKULU without its KEPEZ TOKİ departures.
  const titled = structuredClone(pages[11]), header = evening11()[0];
  titled.find(p => p.number === 16).items.push({ text:'Ç-11K EKSPRES', x:60, y:header.y, w:50, h:header.h });
  unconfirmed(parsePages(titled), 'KEPEZ TOKİ');
});
// 26-EKIM prints KALKIŞ over both Dardanos columns of the day header: the far
// one is where the round trip ends. Its evening headers are fully labelled.
const evening12 = () => pages[12].find(p => p.number === 16).items.filter(i => i.y > 125 && i.y < 142);
await test('Kepez express round trip ending under KALKIŞ keeps two directions', () => {
  const page = n => parsed[12].diagnostics.pages.find(p => p.page === n).tables;
  assert.deepEqual(page(16).map(t => t.columns.map(c => c.label)), [['DARDANOS YERLEŞKE', 'GAZİ OKULU'], ['KEPEZ TOKİ', 'GAZİ OKULU']]);
  assert.deepEqual(page(16).map(t => t.columns.map(c => c.times.length)), [[55, 60], [9, 9]]);
  assert.deepEqual(page(16)[1].columns[0].times, '18:10 18:20 18:35 19:00 19:15 19:25 19:35 19:50 20:00'.split(' '));
  assert.deepEqual(page(16)[1].columns[1].times, '18:55 19:05 19:20 19:45 19:50 20:05 20:15 20:25 20:45'.split(' '));
  assert.deepEqual(page(17).map(t => t.columns.map(c => c.label)), [['KEPEZ TOKİ', 'GAZİ OKULU']]);
  assert.deepEqual(page(17)[0].columns[0].times,
    '20:15 20:35 20:55 21:05 21:15 21:25 21:40 22:00 22:10 22:20 22:35 22:50 23:20 00:00'.split(' '));
  assert.deepEqual(page(17)[0].columns[1].times,
    '20:55 21:20 21:35 21:45 22:00 22:25 22:35 22:45 23:05 23:15 23:35 23:55'.split(' '));
  // The far DARDANOS column holds trip ends, e.g. 08:05 after the 08:00 Kepez TOKİ pass.
  assert.equal(getRoute(parsed[12], 'Ç11K EKSPRES').dir0.times.includes('08:05'), false);
});
await test('a third KALKIŞ that does not return to the first terminal still fails', () => {
  const altered = structuredClone(pages[12]);
  for (const i of altered.find(p => p.number === 16).items)
    if (i.text === 'DARDANOS' && i.y > 755 && i.x > 400) i.text = 'İSKELE';
  assert.ok(parsePages(altered).diagnostics.errors.includes('Page 16: Ç11K EKSPRES has 3 departure columns'));
  // Nor when the repeated terminal is not the table's last column.
  const extra = structuredClone(pages[12]), far = extra.find(p => p.number === 16);
  const anchor = far.items.find(i => i.text === 'DARDANOS' && i.y > 755 && i.x > 400);
  far.items.push({ text:'SSK', x:anchor.x + 50, y:anchor.y, w:12, h:anchor.h });
  assert.ok(parsePages(extra).diagnostics.errors.includes('Page 16: Ç11K EKSPRES has 3 departure columns'));
});
for (const width of [35, 70, 120, 170, 240]) await test('a title of width ' + width + ' beside a fully labelled evening header fails', () => {
  const altered = structuredClone(pages[12]), header = evening12()[0];
  altered.find(p => p.number === 16).items.push({ text:'YENİ KÖY', x:60, y:header.y, w:width, h:header.h });
  assert.ok(parsePages(altered).diagnostics.errors.some(e => /unknown unnumbered table: YENİ KÖY/u.test(e)));
});
await test('Ç10 repeated sections follow terminal names when column order reverses', () => {
  const r = getRoute(parsed[1], 'Ç10');
  assert.match(r.dir0.label, /NUSRAT/);
  assert.match(r.dir1.label, /ARDES/);
  assert.deepEqual(r.dir0.times, '07:45 08:00 08:10 08:20 08:30 08:40 08:50 09:05 09:15 09:25 09:35 09:45 10:00 10:15 10:30 11:00 11:25 11:50 12:10 12:40 13:10 13:40 13:55'.split(' '));
  assert.deepEqual(r.dir1.times, '10:45 11:10 11:35 12:05 12:35 12:50 13:15 13:30 13:50 14:10 14:30 14:50 15:10 15:40 15:50 16:05 16:30 16:45 17:25'.split(' '));
});
await test('annotated departures remain; arrivals, end-of-service and village shuttle stay out', () => {
  assert.ok(getRoute(parsed[1], 'Ç11K EKSPRES').dir0.times.includes('07:50'));
  assert.deepEqual(getRoute(parsed[1], 'Ç11Ç').dir0.times, '07:30 07:40 12:45 15:15 16:55 17:45'.split(' '));
  assert.deepEqual(getRoute(parsed[1], 'Ç11Ç').dir1.times, '07:15 08:50 10:25 14:05 16:30 18:05 18:55'.split(' '));
  assert.deepEqual(getRoute(parsed[2], 'ÇT1').dir1.times, '07:55 08:45 16:10 17:10'.split(' '));
  for (const time of ['07:55','11:30','12:30','13:30','14:30']) assert.ok(getRoute(parsed[2], 'Ç11G').dir1.times.includes(time));
  assert.deepEqual(getRoute(parsed[2], 'Ç11Ç').dir1.times, '07:20 08:50 10:15 12:40 14:15 16:15 18:15 18:50'.split(' '));
  assert.deepEqual(getRoute(parsed[1], 'ÇT2').dir1.times, ['08:00']);
});
await test('missing extracted page is rejected even when its route is index-only', () => {
  const result = parsePages(pages[1].filter(p => p.number !== 10));
  assert.ok(result.diagnostics.errors.some(e => /PDF page 10 was not extracted/.test(e)));
  assert.deepEqual(result.diagnostics.indexOnlyRoutes, ['Ç10']);
});
await test('removed departure headings do not silently drop a route', () => {
  const altered = structuredClone(pages[1]);
  altered.find(p => p.number === 10).items = altered.find(p => p.number === 10).items.filter(i => !/KALKIŞ/u.test(i.text));
  assert.ok(parsePages(altered).diagnostics.errors.length);
});
await test('an unnumbered separate table is set aside or fails, never absorbed into the preceding route', () => {
  // A village line titled with its own terminal beside the page's route heading
  // is set aside, whatever the village is called (KALABAKLI, KALABAKLI KÖYÜ, ...).
  const renamed = structuredClone(pages[1]);
  for (const p of renamed) for (const i of p.items) i.text = i.text.replace('KALABAKLI', 'YENİ KÖY');
  const result = parsePages(renamed);
  assert.deepEqual(result.diagnostics.errors, []);
  assert.deepEqual(getRoute(result, 'Ç11Ç'), getRoute(parsed[1], 'Ç11Ç'));
  assert.ok(result.diagnostics.ignored.some(i => /Separate YENİ KÖY line without a route number/u.test(i.reason)));
  // A title that names none of the table's own terminals is a table the parser does not know.
  const foreign = structuredClone(pages[1]);
  for (const p of foreign) for (const i of p.items) if (i.text === 'KALABAKLI') i.text = 'YENİ KÖY';
  assert.ok(parsePages(foreign).diagnostics.errors.some(e => /unknown unnumbered table: YENİ KÖY/u.test(e)));
});
await test('scanned, empty and non-PDF inputs fail explicitly', async () => {
  assert.ok(parsePages([{ number:1, width:595, height:842, items:[] }]).diagnostics.errors.some(e => /scanned/.test(e)));
  assert.ok(parsePages([]).diagnostics.errors.length);
  await assert.rejects(parsePDF(Buffer.from('<html>Server error</html>')), /not a PDF/);
});
// A one-table timetable whose 07:00 departure cell is filled and set as asked.
function timetablePdf({ fill = null, colour = '0 0 0', font = 'F1' } = {}) {
  const ops = [], text = (x, y, s, f = 'F1', c = '0 0 0', size = 8) => ops.push(`BT /${f} ${size} Tf ${c} rg 1 0 0 1 ${x} ${y} Tm (${s}) Tj ET`);
  text(40, 498, 'Ç5 KEPEZ', 'F2');
  text(150, 498, 'KEPEZ KALKIS', 'F2'); text(260, 498, 'MERKEZ', 'F2'); text(360, 498, 'ESENLER KALKIS', 'F2');
  ['06:30', '07:00', '07:30'].forEach((t, r) => {
    const y = 480 - r * 14;
    if (t === '07:00' && fill) ops.push(`${fill} rg 146 ${y - 3} 60 13 re f`);
    t === '07:00' ? text(160, y, t, font, colour) : text(160, y, t);
    text(265, y, `0${6 + r}:40`.slice(-5)); text(375, y, `0${6 + r}:45`.slice(-5));
  });
  const content = ops.join('\n'), objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /TrueType /BaseFont /Calibri /Encoding /WinAnsiEncoding >>'];
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
await test('a departure is hidden only when it paints nothing a reader sees', async () => {
  const departures = async cell => (await parsePDF(timetablePdf(cell))).routes['Ç5 KEPEZ']?.dir0.times;
  assert.deepEqual(await departures({ colour:'1 1 1' }), ['06:30', '07:30'], 'white on white');
  assert.deepEqual(await departures({ fill:'0.7529 0 0', colour:'0.7529 0 0' }), ['06:30', '07:30'], 'dark red on dark red');
  // Black on a dark fill differs from it in colour, not much in brightness.
  for (const fill of ['0.7529 0 0', '0.5 0 0', '1 0 0'])
    assert.deepEqual(await departures({ fill }), ['06:30', '07:00', '07:30'], 'black on ' + fill);
  // pdf.js cannot draw a font that is neither embedded nor substituted.
  assert.deepEqual(await departures({ font:'F3' }), ['06:30', '07:00', '07:30'], 'Calibri, not embedded');
});
await test('a short legitimate timetable needs no historical page minimum', () => {
  const result = parsePages([pages[1].find(p => p.number === 10)]);
  assert.deepEqual(result.diagnostics.errors, []);
  assert.equal(Object.keys(result.routes).length, 1);
});
await test('impossible departure clocks fail instead of being dropped', () => {
  const altered = structuredClone(pages[1]);
  for (const i of altered.find(p => p.number === 10).items) i.text = i.text.replace('07:45', '27:45');
  assert.ok(parsePages(altered).diagnostics.errors.some(e => /invalid departure 27:45/.test(e)));
});

// The 26 October weekday leaves white digits in empty cells. A reader sees
// nothing there, so the parser reads nothing: the same Ç3 cell printed in
// black on 7 October is a departure.
await test('text that renders invisibly is not read; printed text is', () => {
  assert.equal(getRoute(parsed[12], 'Ç3').dir0.times.includes('18:20'), false);
  assert.equal(getRoute(parsed[6], 'Ç3').dir0.times.includes('18:20'), true);
  for (const t of ['06:50','07:50','08:30']) assert.equal(departures(getRoute(parsed[12], 'Ç11K').dir0).includes(t), false, t);
  assert.ok(parsed[12].diagnostics.ignored.some(i => i.page === 15 && i.reason === 'Invisible text is not read: 06:50, 07:50, 08:30'));
  // Visibility comes from the rendered page alone: hide the printed 18:20 and it is gone.
  const altered = structuredClone(pages[6]);
  altered.find(p => p.number === 4).items.filter(i => i.text === '18:20').sort((a, b) => a.x - b.x)[0].hidden = true;
  assert.equal(getRoute(parsePages(altered), 'Ç3').dir0.times.includes('18:20'), false);
});
await test('notes about other routes, service ends and trip banners are not departures', () => {
  // "07:30 - JANDARMA IŞIKLARINDAN- Ç960", "07:35 - ÇATALTEPELİLER- ÇT3", "07:00 Kepez meydandan 11-K Esenler"
  assert.deepEqual(getRoute(parsed[12], 'Ç4').dir0.times.filter(t => t < '08:30'), '07:45 07:51 07:57 08:03 08:09 08:15 08:21 08:27'.split(' '));
  assert.deepEqual(getRoute(parsed[8], 'Ç4').dir0.times.filter(t => t < '08:30'), '07:45 07:55 08:05 08:15 08:25'.split(' '));
  assert.equal(departures(getRoute(parsed[12], 'Ç960').dir1).includes('22:05'), false, '"22:05 (Ç3) SSK-HÜSEYİN ELBİ YURDU"');
  assert.equal(departures(getRoute(parsed[12], 'Ç10').dir0).includes('16:55'), false, '"16:55 ESKİ HASTANE-GÜZELYALI (Ç11G)"');
  // "14:00 BİTİŞ": BİTİŞ starts past the column edge but is the same cell.
  assert.deepEqual(departures(getRoute(parsed[13], 'ÇT2').dir1), ['08:00']);
  assert.ok(parsed[11].diagnostics.ignored.some(i => /Merged note row .*7:30 SSK'dan ÇINARLI/u.test(i.reason)));
});
await test('trips that start or end away from the terminal say where', () => {
  const express = getRoute(parsed[12], 'Ç11K EKSPRES');
  assert.equal(express.dir0.label, 'DARDANOS YERLEŞKE');
  // The page legend: Çınarlı and Kalabaklı trips do not call at the campus. 07:20
  // leaves the express route after Kepez Meydan; 08:50 has no express stops at all.
  assert.deepEqual(express.dir0.trips.filter(t => ['ÇINARLI','KALABAKLI'].includes(t.from)), [
    { time:'07:20', from:'ÇINARLI', stops:[['KEPEZ MEYDAN','07:30']], to:'KEPEZ MEYDAN' },
    { time:'08:50', from:'ÇINARLI', stops:[] },
    { time:'17:20', from:'KALABAKLI', stops:[['KEPEZ MEYDAN','17:30'],['GAZİ OKULU','17:55']] },
  ]);
  // From 18:10 no bus leaves the campus: the evening sections on pages 16-17
  // depart from Kepez TOKİ, and Gazi Okulu's evening trips end there.
  assert.deepEqual(startingAt(express.dir0, 'KEPEZ TOKİ'), ('18:10 18:20 18:35 19:00 19:15 19:25 19:35 19:50 20:00 ' +
    '20:15 20:35 20:55 21:05 21:15 21:25 21:40 22:00 22:10 22:20 22:35 22:50 23:20 00:00').split(' '));
  assert.equal(express.dir0.times.some(t => t >= '18:01'), false);
  // The evening header names Gazi Okulu's arrival without VARIŞ: still the trip's last stop.
  assert.deepEqual(express.dir0.trips.find(t => t.time === '18:10').stops, [['KEPEZ MEYDAN','18:20'], ['GAZİ OKULU','18:45']]);
  assert.deepEqual(express.dir1.trips.filter(t => t.to === 'KEPEZ TOKİ').map(t => t.time)[0], '18:55');
  // A destination mark on a real departure is kept as the timetable's note.
  assert.deepEqual(express.dir1.trips.find(t => t.time === '16:20'), { time:'16:20', to:'DARDANOS YERLEŞKE', note:'kalabaklı' });
  assert.deepEqual(startingAt(getRoute(parsed[12], 'Ç11K').dir0, 'ÇINARLI'), '07:20 08:50 10:10 14:50 16:30 18:10'.split(' '));
  // The weekend table has no campus column, so its Çınarlı marks stay notes on Kepez TOKİ departures.
  assert.deepEqual(getRoute(parsed[14], 'Ç11K').dir0.trips.map(t => [t.time, t.note, t.from]),
    '07:20 09:20 12:25 14:20 16:30 18:20 19:20'.split(' ').map(t => [t, 'çınarlı', undefined]));
});
await test('a typed comma clock is a departure; a comma list is not', () => {
  // Ç1's only 07:00 departure from Hüseyin Elbi Yurt.
  const altered = structuredClone(pages[12]), items = altered.find(p => p.number === 3).items;
  const cell = items.filter(i => i.text === '07:00').sort((a, b) => a.x - b.x)[0];
  cell.text = '07,00';
  assert.deepEqual(parsePages(altered).routes, parsed[12].routes);
  cell.text = '07, 00';
  assert.equal(getRoute(parsePages(altered), 'Ç1').dir0.times.includes('07:00'), false);
});
await test('trip notes are the cells\' own words, never a header', () => {
  for (const result of parsed) for (const route of Object.values(result.routes)) for (const d of [route.dir0, route.dir1])
    for (const trip of d.trips || []) assert.doesNotMatch(trip.note || '', /KALKI[ŞS]|VARI[ŞS]|HAREKET/u, route.name);
});
// Layout edits the publisher has made or is likely to make. Each must leave the
// routes unchanged or fail closed; a silent change is a bug.
const editProbes = [
  ['day origin printed without KALKIŞ while the closing column says KALKIŞ', 12, null, p => {
    for (const i of p.find(q => q.number === 16).items) if (i.text === 'KALKIŞ' && i.y > 600 && i.x < 300) i.text = '';
  }],
  ['closing arrival printed as KALKIŞ on a titled weekend table', 14, null, p => {
    for (const i of p.find(q => q.number === 11).items) i.text = i.text.replace('TOKİ VARIŞ', 'TOKİ KALKIŞ');
  }],
  ['origin without KALKIŞ and closing column without VARIŞ', 14, null, p => {
    for (const i of p.find(q => q.number === 11).items) i.text = i.text.replace(/^TOKİ (?:KALKIŞ|VARIŞ)$/u, 'TOKİ');
  }],
  ['express subtitle shifted along its line', 14, null, p => {
    for (const i of p.find(q => q.number === 4).items) if (i.text === 'EKSPRES') i.x += 12;
  }],
  ['shuttle title reworded', 12, null, p => {
    for (const i of p.find(q => q.number === 19).items) if (i.text === 'KALABAKLI') { i.text = 'KALABAKLI KÖYÜ'; i.w *= 1.6; }
  }],
  ['service-end word nudged further into the next column', 13, null, p => {
    for (const i of p.find(q => q.number === 21).items) if (i.text === 'BİTİŞ') i.x += 6;
  }],
  ['trip banners left-aligned in the departure column', 12, null, p => {
    const items = p.find(q => q.number === 16).items, x = items.find(i => i.text === '08:15').x;
    for (const i of items) if (/SSK'dan ÇINARLI/u.test(i.text)) i.x = x - 2;
  }],
  ['continuation note wrapped after its time', 12, null, p => {
    const items = p.find(q => q.number === 11).items;
    for (const i of items.filter(i => /^\d\d:\d\d Ç14 OLARAK$/u.test(i.text))) {
      items.push({ ...i, text:'Ç14 OLARAK', y:i.y - i.h * 1.15, x:i.x + 2, w:i.w * 0.6 });
      i.text = i.text.slice(0, 5); i.w *= 0.3;
    }
  }],
  ['two-line margin label on the first evening row, 12pt under the header', 14, null, p => {
    const items = p.find(q => q.number === 5).items;
    const header = items.find(i => i.text === 'YURT KALKIŞ' && i.y < 400), h = header.h;
    items.push({ text:'BAHRİYE', x:57, y:header.y - 12.4, w:30, h }, { text:'ÜÇOK CADDESİ', x:49, y:header.y - 20, w:40, h });
  }],
  ['vehicle duty label on the last row above an evening header', 15, null, p => {
    // "11-K / EKSPRES / 6.DOSYA" in the bus-number column, clear of the row's own times.
    const items = p.find(q => q.number === 2).items, header = items.find(i => i.text === '144 TOKİ KALKIŞ' && i.y < 200);
    items.push({ text:'11-K', x:60, y:header.y + 45, w:12, h:5.5 }, { text:'EKSPRES', x:56, y:header.y + 39, w:20, h:5.5 },
      { text:'6.DOSYA', x:57, y:header.y + 33, w:18, h:5.5 });
  }],
  ['vehicle duty label beside a repeated header', 12, null, p => {
    const items = p.find(q => q.number === 16).items, header = items.find(i => i.text === 'KALKIŞ' && i.y < 200);
    items.push({ text:'Ç4', x:100, y:header.y + 11, w:10, h:5.5 }, { text:'2. DOSYA', x:97, y:header.y + 5, w:22, h:5.5 });
  }],
  ['caption over the bus-number column and KALKIŞ over the closing arrival', 14, null, p => {
    const items = p.find(q => q.number === 11).items, header = items.find(i => i.text === 'TOKİ KALKIŞ');
    items.push({ text:'SIRA', x:136, y:header.y, w:14, h:header.h });
    for (const i of items) i.text = i.text.replace('TOKİ VARIŞ', 'TOKİ KALKIŞ');
  }],
  ['shuttle title with punctuation', 12, null, p => {
    for (const i of p.find(q => q.number === 19).items) if (i.text === 'KALABAKLI') i.text = 'KALABAKLI-2';
  }],
  ['half-loop origin loses KALKIŞ', 14, /Page 8: Ç9 origin OTOGAR is not a confirmed departure/, p => {
    for (const i of p.find(q => q.number === 8).items) if (i.x < 250) i.text = i.text.replace(/\s*KALKIŞ/u, '');
  }],
  ['express subtitle lost', 12, /Page 5: Ç3 ESENLER departure terminal ESKİ HASTANE matches no earlier/, p => {
    for (const i of p.find(q => q.number === 5).items) if (i.text === 'EKSPRES') i.text = '';
  }],
  ['heading band empty', 12, /Page 5: untitled table has no Ç3 table above it on this page/, p => {
    for (const i of p.find(q => q.number === 5).items) if (/^(?:Ç-3|EKSPRES)$/u.test(i.text)) i.text = '';
  }],
  ['captioned direction loses its origin name', 13, /Page 21: ÇT2 direction KEPEZ - KAMPÜS has no departure column/, p => {
    for (const i of p.find(q => q.number === 21).items) if (i.text === 'KEPEZ 144 TOKİ') i.text = '144 TOKİ';
  }],
  ['village legend wrapped over two lines', 15, null, p => {
    for (const { items } of p) for (const i of items.filter(i => /UĞRAMAMAKTADIR/u.test(i.text))) {
      items.push({ ...i, text:'ARAÇLAR YERLEŞKEYE UĞRAMAMAKTADIR.', y:i.y - i.h * 1.2, w:i.w * 0.4 });
      Object.assign(i, { text:'ÇINARLI / KALABAKLI SEFERLERİNİ GERÇEKLEŞTİREN', w:i.w * 0.55 });
    }
  }],
  ['village legend reworded past reading', 15, /Page 1: unreadable note about trips that skip a stop: ÇINARLI \/ KALABAKLI ARAÇLARI/, p => {
    for (const { items } of p) for (const i of items) i.text = i.text.replace(/SEFERLERİNİ GERÇEKLEŞTİREN ARAÇLAR YERLEŞKEYE UĞRAMAMAKTADIR/u, 'ARAÇLARI YERLEŞKEYE UĞRAMAZ');
  }],
  ['another route\'s note row beside stop times loses its route code', 8, /Page 1: Ç4 merged cell is neither a departure nor a trip note: 07:00 Kepez meydandan Esenler/, p => {
    for (const i of p[0].items) if (i.text === '07:00 Kepez meydandan 11-K Esenler') i.text = '07:00 Kepez meydandan Esenler';
  }],
  ['other routes\' trip note rows lose their route codes', 8, null, p => {
    for (const i of p[0].items) i.text = i.text.replace(/ çt-3$|(?<=okulundan) 11-K$/u, '');
  }],
  ['village trip note says where the trip comes from', 12, /Page 15: Ç11K departure note describes a trip from elsewhere: \d\d:\d\d çınarlıdan/, p => {
    const cell = p.find(q => q.number === 15).items.find(i => /^\d\d:\d\d çınarlı$/u.test(i.text));
    cell.text += 'dan';
  }],
  ['trip banner reworded to name one place', 11, /Page 16: Ç11K EKSPRES merged cell is neither a departure nor a trip note: 7:30 ÇINARLI KÖYÜ/, p => {
    for (const i of p.find(q => q.number === 16).items) if (i.text === "7:30 SSK'dan ÇINARLI") i.text = '7:30 ÇINARLI KÖYÜ';
  }],
  ['evening header printed without KALKIŞ', 12, /Page 16: Ç11K EKSPRES has a header without KALKIŞ between its rows: KEPEZ TOKİ/, p => {
    for (const i of p.find(q => q.number === 16).items) if (i.text === 'KALKIŞ' && i.y > 125 && i.y < 142) i.text = '';
  }],
  ['evening header printed with stop names alone', 12, /Page 16: Ç11K EKSPRES has a header without KALKIŞ between its rows: KEPEZ/, p => {
    for (const i of p.find(q => q.number === 16).items) if (/^(?:KALKIŞ|VARIŞ)$/u.test(i.text) && i.y > 125 && i.y < 142) i.text = '';
  }],
  ['evening header printed with its two terminals alone', 12, /Page 16: Ç11K EKSPRES has a header without KALKIŞ between its rows: KEPEZ TOKİ \| GAZİ OKULU$/, p => {
    for (const i of p.find(q => q.number === 16).items)
      if (i.y > 125 && i.y < 142 && !(i.y > 138 && (i.text === 'KEPEZ TOKİ' && i.x < 200 || i.text === 'GAZİ OKULU' && i.x > 300))) i.text = '';
  }],
  ['two-word stop note wrapped between the rows of its column', 1, null, p => {
    const note = p.find(q => q.number === 14).items.find(i => i.text === 'KEPEZ TOKİ');
    Object.assign(note, { text:'KEPEZ', y:note.y - 4.6, w:14 });
    p.find(q => q.number === 14).items.push({ ...note, text:'MEYDAN', x:note.x + 17.5, w:18 });
  }],
  ['stop names beside the times of one row', 12, null, p => {
    const items = p.find(q => q.number === 16).items, time = (x, y) => items.find(i => /^\d\d:\d\d$/.test(i.text) && i.x > x && i.x < x + 15 && y(i.y));
    const meydan = time(200, y => y > 400 && y < 500), iskele = time(385, y => Math.abs(y - meydan.y) < 1);
    for (const [cell, text] of [[meydan, 'KEPEZ'], [iskele, 'İSKELE']]) items.push({ ...cell, text, x:cell.x + cell.w + 4.5, w:24 });
  }],
  ['repeated terminal header printed without KALKIŞ', 6, /Page 6: Ç4 has a header without KALKIŞ between its rows/, p => {
    for (const i of p.find(q => q.number === 6).items) if (i.y > 175 && i.y < 190) i.text = i.text.replace(/\s*KALKIŞ$/u, '');
  }],
  ['turnaround printed KALKIŞ over its arrival and VARIŞ over its departure', 13, /Page 3: Ç1 turnaround at GAZİ MECLİSİ has KALKIŞ over its arrival/, p => {
    const items = p.find(q => q.number === 3).items;
    const arrival = items.find(i => i.text === 'VARIŞ' && i.x > 300 && i.x < 350), departure = items.find(i => i.text === 'KALKIŞ' && i.x > 350 && i.x < 420);
    [arrival.text, departure.text] = ['KALKIŞ', 'VARIŞ'];
  }],
  ['turnaround printed KALKIŞ over its arrival and nothing over its departure', 13, /Page 3: Ç1 turnaround at GAZİ MECLİSİ has KALKIŞ over its arrival/, p => {
    const items = p.find(q => q.number === 3).items;
    const arrival = items.find(i => i.text === 'VARIŞ' && i.x > 300 && i.x < 350), departure = items.find(i => i.text === 'KALKIŞ' && i.x > 350 && i.x < 420);
    [arrival.text, departure.text] = ['KALKIŞ', ''];
  }],
  ['an intermediate stop printed with VARIŞ', 13, null, p => {
    for (const i of p.find(q => q.number === 3).items) if (i.text === 'İSKELE' && i.x < 300) i.text = 'İSKELE VARIŞ';
  }],
  ['village legend wrapped inside its list of places', 15, null, p => {
    for (const { items } of p) for (const i of items.filter(i => /UĞRAMAMAKTADIR/u.test(i.text))) {
      items.push({ ...i, text:'KALABAKLI SEFERLERİNİ GERÇEKLEŞTİREN ARAÇLAR YERLEŞKEYE UĞRAMAMAKTADIR.', y:i.y - i.h * 1.2, w:i.w * 0.85 });
      Object.assign(i, { text:'ÇINARLI /', w:i.w * 0.12 });
    }
  }],
  ['footnote saying trips call at a stop', 8, null, p => {
    const { items } = p[0], last = items.reduce((a, b) => b.y < a.y ? b : a);
    items.push({ ...last, text:'AKŞAM SEFERLERİ ESKİ HASTANEYE UĞRAYACAKTIR.', y:last.y - 12, w:180 },
      { ...last, text:'BU SEFERLER KAMPÜSE UĞRAMAKTADIR.', y:last.y - 24, w:140 });
  }],
  ['trip banner spelled without its apostrophe', 11, null, p => {
    for (const i of p.find(q => q.number === 16).items) if (i.text === "7:30 SSK'dan ÇINARLI") i.text = '7:30 SSK dan ÇINARLI';
  }],
];
await test('every way of saying a trip comes from elsewhere fails the departure', () => {
  for (const note of ['kepezden', 'kampüsten', "Kepez'den", 'SSK dan', 'SSK HAREKET', 'SSK-ÇINARLI']) {
    const altered = structuredClone(pages[12]);
    const cell = altered.find(q => q.number === 15).items.find(i => /^\d\d:\d\d çınarlı$/u.test(i.text));
    cell.text = cell.text.slice(0, 5) + ' ' + note;
    assert.ok(parsePages(altered).diagnostics.errors.some(e => e.startsWith('Page 15: Ç11K departure note describes a trip from elsewhere')), note);
  }
});
await test('a departure note naming one place that ends like "from" (MEYDAN) is still a departure', () => {
  const altered = structuredClone(pages[12]);
  const cell = altered.find(q => q.number === 15).items.find(i => /^\d\d:\d\d çınarlı$/u.test(i.text));
  const time = cell.text.slice(0, 5);
  cell.text = time + ' Kepez Meydan';
  const result = parsePages(altered), r = getRoute(result, 'Ç11K');
  assert.deepEqual(result.diagnostics.errors, []);
  assert.ok([r.dir0, r.dir1].some(d => d.trips?.some(t => t.time === time && t.note === 'Kepez Meydan')));
});
for (const [name, index, failure, edit] of editProbes) await test('layout edit: ' + name, () => {
  const altered = structuredClone(pages[index]);
  edit(altered);
  const result = parsePages(altered);
  if (failure) assert.ok(result.diagnostics.errors.some(e => failure.test(e)), result.diagnostics.errors.join(' | ') || 'no error');
  else {
    assert.deepEqual(result.diagnostics.errors, []);
    assert.deepEqual(result.routes, parsed[index].routes);
  }
});

const baseHtml = '<a href="/weekday.pdf">HAFTA İÇİ SEFER SAATLERİ</a><a href="/weekend.pdf">HAFTA SONU SEFER SAATLERİ</a>';
await test('current municipality page discovers both Friday supplements and the future weekday PDF', () => {
  const html = gunzipSync(readFileSync(new URL('./fixtures/schedules/municipality-2026-10-07.html.gz', import.meta.url))).toString('utf8');
  const result = discoverPdfLinks(html);
  assert.deepEqual(result.errors, []);
  assert.equal(result.links.length, 5);
  assert.equal(result.links.find(s => s.kind === 'effective-weekday').effectiveFrom, '10-08');
  const recurring = result.links.filter(s => s.kind === 'recurring');
  assert.equal(recurring.length, 2);
  for (const link of recurring) assert.deepEqual(link.weekdays, [5]);
});
await test('all named weekdays, ranges, lists and filename fallback have explicit activation days', () => {
  for (const [day, index] of [['Pazar',0],['Pazartesi',1],['Salı',2],['Çarşamba',3],['Perşembe',4],['Cuma',5],['Cumartesi',6]]) {
    const result = discoverPdfLinks(baseHtml + '<a href="/route.pdf">Ç4 Hattı ' + day + ' Günü Sefer Saatleri</a>');
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.links[2].weekdays, [index]);
  }
  for (const [label, days] of [['Pazartesi-Cuma Sefer Saatleri',[1,2,3,4,5]],['Salı ve Cuma Günü Sefer Saatleri',[2,5]]]) {
    assert.deepEqual(discoverPdfLinks(baseHtml + '<a href="/route.pdf">' + label + '</a>').links[2].weekdays, days);
  }
  const filename = discoverPdfLinks(baseHtml + '<a href="/C4-HATTI-CUMA-SEFERLERI.pdf">PDF</a>');
  assert.deepEqual(filename.errors, []);
  assert.deepEqual(filename.links[2].weekdays, [5]);
  const market = discoverPdfLinks(baseHtml + '<a href="/route.pdf">Cuma Pazarı Hattı Sefer Saatleri</a>');
  assert.equal(market.links[2].kind, 'unknown', 'a market name does not imply Friday service');
});
await test('recurring service identity survives renamed PDFs and rejects contradictory weekday labels', () => {
  const html = baseHtml + '<a href="/friday.pdf">Ç4 Hattı Cuma Seferleri</a>';
  const renamed = discoverPdfLinks(html.replace('/friday.pdf','/14-EKIM-3.pdf')).links[2];
  assert.equal(discoverPdfLinks(html).links[2].id, renamed.id);
  assert.deepEqual(renamed.dates, [], 'a publication date in the URL does not restrict a weekly service');
  const effective = discoverPdfLinks(baseHtml + '<a href="/other.pdf">8 Ekim itibariyle Ç4 Hattı Cuma Seferleri</a>').links[2];
  assert.equal(effective.effectiveFrom, '10-08');
  const conflict = discoverPdfLinks(html + '<a href="/friday.pdf">Ç4 Hattı Perşembe Seferleri</a>');
  assert.ok(conflict.pageErrors.some(e => /Conflicting labels/.test(e)));
});
await test('HTML parsing handles attributes, entities, nested text, relative URLs and queries', () => {
  const result = discoverPdfLinks("<a class=x HREF='/new.PDF?v=2&amp;x=3#page=1'><b>HAFTA</b><br>İÇİ SEFER SAATLERİ</a>" +
    '<a href=//example.test/weekend.pdf><span>HAFTA SONU</span> SEFER SAATLERİ</a>', 'https://example.test/index');
  assert.deepEqual(result.errors, []);
  assert.equal(result.links[0].url, 'https://example.test/new.PDF?v=2&x=3');
  assert.equal(result.links[1].kind, 'weekend');
});
await test('renamed weekday PDF is discovered without filename or month assumptions', () => {
  const result = discoverPdfLinks(baseHtml.replace('/weekday.pdf', '/wp-content/uploads/2018/02/17-EYLUL-15.pdf'));
  assert.deepEqual(result.errors, []);
  assert.ok(result.links[0].url.endsWith('17-EYLUL-15.pdf'));
});
await test('duplicate identical links coalesce; conflicting or ambiguous sources fail', () => {
  assert.equal(discoverPdfLinks(baseHtml + baseHtml).links.length, 2);
  assert.ok(discoverPdfLinks(baseHtml + '<a href="/weekday.pdf">HAFTA SONU</a>').errors.length);
  assert.ok(discoverPdfLinks(baseHtml + '<a href="/other.pdf">HAFTA İÇİ</a>').errors.length);
  assert.ok(discoverPdfLinks('<a href="/weekday.pdf">HAFTA İÇİ</a>').errors.length);
  assert.ok(discoverPdfLinks(baseHtml + '<a href="/other.pdf">YENİ TARİFE</a>').errors.length);
  assert.ok(discoverPdfLinks(baseHtml + '<a href="/bayram.pdf">BAYRAM</a>').errors.length);
});
await test('date ranges, Turkish months, effective dates and invalid dates', () => {
  assert.deepEqual(parseDates('28–30 Ekim 2026').dates, ['10-28','10-29','10-30']);
  assert.deepEqual(parseDates('30 Nisan - 2 Mayıs 2026').dates, ['04-30','05-01','05-02']);
  assert.deepEqual(parseDates('01.06.2026'), { dates:['06-01'], year:2026 });
  assert.throws(() => parseDates('31 Şubat 2026'), /Invalid/);
  assert.deepEqual(parseDates('2026 Eylül'), { dates:[], year:2026 });
  assert.throws(() => parseDates('31.12.2026 - 01.01.2027'), /Ambiguous/);
  const result = discoverPdfLinks(baseHtml + '<a href="/changed.pdf">17 Eylül 2026 tarihinden itibaren hafta içi sefer saatleri</a>');
  assert.deepEqual(result.errors, []);
  assert.equal(result.links[2].effectiveFrom, '09-17');
  assert.equal(result.links[2].year, 2026);
  const invalid = discoverPdfLinks(baseHtml + '<a href="/special.pdf">31 Şubat 2026 Bayram Sefer Saatleri</a>');
  assert.ok(invalid.errors.length);
  const holiday = discoverPdfLinks(baseHtml + '<a href="/holiday.pdf">29 Ekim 2026 Bayram Hafta İçi Sefer Saatleri</a>');
  assert.deepEqual(holiday.errors, []);
  assert.equal(holiday.links[2].kind, 'special');
});
await test('timetable wording, week parts, exceptions and day lists keep their meaning', () => {
  const weekend = '<a href="/weekend.pdf">HAFTA SONU SEFER SAATLERİ</a>';
  const link = (label, href, html) => discoverPdfLinks(html + '<a href="' + href + '">' + label + '</a>');
  // TARİFESİ ("timetable") contains ARİFE but is no holiday eve.
  const winter = link('KIŞ TARİFESİ HAFTA İÇİ SEFER SAATLERİ', '/weekday.pdf', weekend);
  assert.deepEqual(winter.errors, []);
  assert.equal(winter.links[0].kind, 'weekday');
  assert.ok(link('YENİ TARİFE', '/26-EKIM.pdf', baseHtml).errors.includes('Unrecognized PDF schedule label: YENİ TARİFE'));
  // A city-wide week part that also names days stays that week part.
  const effective = link('2 Kasım Pazartesi itibariyle Hafta İçi Sefer Saatleri', '/n.pdf', baseHtml).links[2];
  assert.deepEqual([effective.kind, effective.effectiveFrom], ['effective-weekday', '11-02']);
  assert.equal(link('Hafta İçi (Pazartesi-Cuma) Sefer Saatleri', '/weekday.pdf', weekend).links[0].kind, 'weekday');
  assert.ok(link('Hafta İçi ve Cumartesi Sefer Saatleri', '/weekday.pdf', weekend).errors.some(e => /contradict the label's week part/.test(e)));
  // A route's own supplement runs on the days it names, except those it excepts.
  assert.deepEqual(link('Ç4 Hattı Hafta İçi (Cuma Hariç) Sefer Saatleri', '/x.pdf', baseHtml).links[2].weekdays, [1,2,3,4]);
  assert.deepEqual(link('Ç4 Hattı Hafta İçi Sefer Saatleri', '/x.pdf', baseHtml).links[2].weekdays, [1,2,3,4,5]);
  assert.ok(link('Ç4 Hattı Cuma Hariç Sefer Saatleri', '/x.pdf', baseHtml).errors.some(e => /Cannot tell which weekdays/.test(e)));
  // An exception covers every day joined before it, and a range.
  for (const days of ['Perşembe ve Cuma', 'Perşembe-Cuma', 'Perşembe, Cuma Günleri'])
    assert.deepEqual(link(`Ç4 Hattı Hafta İçi (${days} Hariç) Sefer Saatleri`, '/x.pdf', baseHtml).links[2].weekdays, [1,2,3], days);
  assert.deepEqual(link('Ç4 Hattı Pazartesi-Cuma (Çarşamba Hariç) Sefer Saatleri', '/x.pdf', baseHtml).links[2].weekdays, [1,2,4,5]);
  // A week part checks the days of whichever of text and file named it, and
  // a day it leaves out needs a schedule of its own.
  const contradicts = discoverPdfLinks('<a href="/HAFTA-ICI-VE-CUMARTESI-SEFER-SAATLERI.pdf">PDF</a>' + weekend);
  assert.ok(contradicts.errors.some(e => /contradict the label's week part/.test(e)));
  const noFriday = link('Hafta İçi (Cuma Hariç) Sefer Saatleri', '/weekday.pdf', weekend);
  assert.ok(noFriday.errors.some(e => /No schedule serves the weekdays the week part excepts/.test(e)));
  assert.deepEqual(link('Cuma Günü Sefer Saatleri', '/f.pdf',
    '<a href="/weekday.pdf">Hafta İçi (Cuma Hariç) Sefer Saatleri</a>' + weekend).errors, []);
  // "VE" joins days; a range may run into the next year; a school year is no date.
  assert.deepEqual(parseDates('28 ve 29 Ekim Sefer Saatleri').dates, ['10-28','10-29']);
  assert.deepEqual(parseDates('28, 29 ve 30 Ekim').dates, ['10-28','10-29','10-30']);
  assert.deepEqual(parseDates('30 Aralık - 2 Ocak').dates, ['01-01','01-02','12-30','12-31']);
  // One written year cannot date both sides of the year end.
  assert.throws(() => parseDates('30 Aralık - 2 Ocak 2027 Yılbaşı Sefer Saatleri'), /Ambiguous schedule years/);
  assert.throws(() => parseDates('31 Aralık ve 1 Ocak 2027'), /Ambiguous schedule years/);
  assert.deepEqual(parseDates('2026-2027 Hafta İçi'), { dates:[], year:null });
  // Holidays by name; a blank link is named by its title or file, never a crash.
  assert.equal(link('Yılbaşı Sefer Saatleri', '/1-OCAK.pdf', baseHtml).links[2].kind, 'special');
  assert.equal(link('Resmi Tatil Sefer Saatleri', '/23-NISAN.pdf', baseHtml).links[2].dates[0], '04-23');
  // A week part that mentions public holidays is still that week part.
  const holidays = discoverPdfLinks('<a href="/26-EKIM.pdf">HAFTA İÇİ (RESMİ TATİLLER HARİÇ) SEFER SAATLERİ</a>' +
    '<a href="/31-EKIM-10.pdf">HAFTA SONU VE RESMİ TATİL GÜNLERİ SEFER SAATLERİ</a>');
  assert.deepEqual([holidays.errors, holidays.links.map(l => l.kind)], [[], ['weekday', 'weekend']]);
  assert.ok(link('&nbsp;', '/y.pdf', baseHtml).errors.includes('Unrecognized PDF schedule label: y'));
  assert.equal(discoverPdfLinks(baseHtml + '<a href="/f.pdf" title="Ç4 Hattı Cuma Seferleri"> </a>').links[2].weekdays[0], 5);
});
await test('each label form keeps its kind, days and dates', () => {
  const link = (label, href) => {
    const result = discoverPdfLinks(baseHtml + '<a href="' + href + '">' + label + '</a>'), l = result.links.find(l => l.url.endsWith(href));
    return [l.kind, l.weekdays || l.dates, result.errors];
  };
  for (const [label, href, expected] of [
    // A route's own supplement: its route named as "HATTI", a "ÇT" code or a "11-K" code.
    ['KEPEZ HATTI HAFTA İÇİ SEFER SAATLERİ', '/k.pdf', ['recurring', [1,2,3,4,5], []]],
    ['ÇT3 HAFTA SONU SEFER SAATLERİ', '/c.pdf', ['recurring', [0,6], []]],
    ['11-K HAFTA İÇİ SEFER SAATLERİ', '/e.pdf', ['recurring', [1,2,3,4,5], []]],
    // Named days win over the week part; "dışında" excepts like "hariç"; "ile" joins.
    ['Ç4 Hattı Hafta İçi Cuma Günü Sefer Saatleri', '/x.pdf', ['recurring', [5], []]],
    ['Ç4 Hattı Hafta İçi Cuma Günleri Dışında Sefer Saatleri', '/x.pdf', ['recurring', [1,2,3,4], []]],
    ['Ç4 Hattı Hafta İçi Perşembe ile Cuma Hariç Sefer Saatleri', '/x.pdf', ['recurring', [1,2,3], []]],
    ['Ç4 Hattı Hafta İçi ve Cumartesi Sefer Saatleri', '/x.pdf',
      ['recurring', [], ["Ç4 Hattı Hafta İçi ve Cumartesi Sefer Saatleri: Named weekdays contradict the label's week part"]]],
    // Holidays by name, "tarife" for "sefer saatleri", and ranges within a month.
    ['Resmi Tatil Sefer Saatleri', '/23-NISAN.pdf', ['special', ['04-23'], []]],
    ['Zafer Günü Sefer Saatleri', '/30-AGUSTOS.pdf', ['special', ['08-30'], []]],
    ['Ç4 Hattı Cuma Tarifesi', '/t.pdf', ['recurring', [5], []]],
    ['28 Ekim Tarifesi', '/r.pdf', ['special', ['10-28'], []]],
    ['1 Kasım - 3 Kasım Sefer Saatleri', '/n.pdf', ['special', ['11-01','11-02','11-03'], []]],
    // A week part the link dates is that day's timetable, beside the regular one (27 Oct 2026).
    ['27 EKİM GÜNÜ HAFTA İÇİ SEFER SAATLERİ', '/27-EKIM-5.pdf', ['special', ['10-27'], []]],
    ['31 EKİM GÜNÜ HAFTA SONU SEFER SAATLERİ', '/31-EKIM-11.pdf', ['special', ['10-31'], []]],
  ]) assert.deepEqual(link(label, href), expected, label);
  for (const joined of ['28 ile 29 Ekim', '28 & 29 Ekim']) assert.deepEqual(parseDates(joined).dates, ['10-28','10-29'], joined);
  // An effective date without a year is its latest occurrence at most three months after it was found.
  const effectiveYear = (label, found) => discoverPdfLinks(baseHtml + '<a href="/e.pdf">' + label + '</a>', undefined, Date.parse(found))
    .links.find(l => l.url.endsWith('/e.pdf')).year;
  assert.equal(effectiveYear('15 Aralık itibariyle Hafta İçi Sefer Saatleri', '2026-12-01T12:00:00Z'), 2026);
  assert.equal(effectiveYear('15 Aralık itibariyle Hafta İçi Sefer Saatleri', '2027-06-20T12:00:00Z'), 2026, 'still in force half a year on');
  assert.equal(effectiveYear('15 Ocak itibariyle Hafta İçi Sefer Saatleri', '2026-12-20T12:00:00Z'), 2027, 'announced in December');
});
await test('fetch retries transient failures, bypasses caches and succeeds', async () => {
  let calls = 0;
  const waits = [];
  const bytes = await requestBytes('https://example.test/a', { sleep:async ms => { waits.push(ms); }, fetchImpl:async (_url, options) => {
    assert.equal(options.cache, 'no-store'); assert.equal(options.headers['Cache-Control'], 'no-cache');
    return ++calls < 3 ? new Response('', { status:503 }) : new Response('PDF bytes');
  } });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000,4000]);
  assert.equal(bytes.toString(), 'PDF bytes');
});
await test('network failures retain URL, retry count, nested connection causes and original error', async () => {
  const failures = [
    Object.assign(new Error('Connect Timeout Error'), { code:'UND_ERR_CONNECT_TIMEOUT' }),
    new AggregateError([Object.assign(new Error('connection refused'), { code:'ECONNREFUSED' }),
      Object.assign(new Error('network unreachable'), { code:'ENETUNREACH' })], ''),
  ];
  for (const cause of failures) {
    const original = new TypeError('fetch failed', { cause });
    let calls = 0;
    await assert.rejects(requestBytes('https://example.test/timetable', { sleep:async () => {},
      fetchImpl:async () => { calls++; throw original; } }), error => {
      assert.match(error.message, /https:\/\/example.test\/timetable/);
      assert.match(error.message, /after 3 attempts/);
      for (const e of cause.errors || [cause]) assert.ok(error.message.includes(e.code));
      assert.equal(error.cause, original);
      return true;
    });
    assert.equal(calls, 3);
  }
});
await test('404 and oversized bodies are not retried', async () => {
  for (const response of [() => new Response('', { status:404 }), () => new Response('123456')]) {
    let calls = 0;
    await assert.rejects(requestBytes('https://example.test/a', { maxBytes:5, sleep:async () => {},
      fetchImpl:async () => { calls++; return response(); } }));
    assert.equal(calls, 1);
  }
});
await test('timeouts include stalled body reads and bounded retries', async () => {
  let calls = 0;
  await assert.rejects(requestBytes('https://example.test/a', { attempts:2, timeoutMs:10, sleep:async () => {},
    fetchImpl:async () => { calls++; return new Response(new ReadableStream({ start() {} })); } }), /Timeout/);
  assert.equal(calls, 2);
});
console.log('Schedule parser/discovery: ' + passed + ' checks passed (' + fixtures.length + ' real PDFs; offline).');
