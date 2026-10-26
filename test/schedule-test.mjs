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
counts.push({ ...counts[1], 'Ç2':[29,30] });
counts.push({ 'Ç1':[26,26], 'Ç3':[26,26], 'Ç7':[25,26], 'Ç8':[18,18], 'Ç8 EKSPRES':[37,37],
  'Ç9':[35,35], 'Ç960':[25,25], 'ÇT3':[26,25], 'Ç11K':[19,17], 'Ç11K EKSPRES':[86,91],
  'Ç11G':[26,26], 'Ç11Ç':[6,8], 'ÇT1':[4,4] });
counts.push({ ...counts[3], 'ÇT3':[51,52] });
counts.push({ 'Ç1':[36,37], 'Ç3':[36,37], 'Ç3 EKSPRES':[51,54], 'Ç4':[90,89], 'Ç5':[4,0],
  'Ç7':[41,43], 'Ç8':[37,36], 'Ç9':[35,35], 'Ç10':[23,19], 'Ç960':[35,35], 'ÇT3':[52,52],
  'Ç11K':[20,20], 'Ç11K EKSPRES':[58,62], 'Ç11G':[24,25], 'Ç11Ç':[7,7], 'ÇT1':[12,11], 'ÇT2':[1,1] });
counts.push({ ...counts[6], 'Ç4':[93,89], 'Ç11K EKSPRES':[58,63] });
counts.push({ 'Ç4':[66,65] });
counts.push({ 'Ç11K EKSPRES':[76,81], 'Ç11K':[20,20], 'Ç11Ç':[7,7] });
// 20-EKIM-6: pages 6, 11, 12, 15 and 16 were checked against renders. Known
// pre-existing extras: Ç4 dir0 07:00/07:30/07:35 (note rows), Ç960 dir1 22:05
// (a Ç3 note) and Ç11K dir0 06:50/07:50/08:30 (hidden text in blank cells).
counts.push({ 'Ç1':[37,39], 'Ç3':[37,38], 'Ç3 EKSPRES':[40,42], 'Ç4':[92,91], 'Ç5':[4,0],
  'Ç7':[36,37], 'Ç8':[37,36], 'Ç9':[35,35], 'Ç10':[23,19], 'Ç960':[35,35], 'ÇT3':[49,49],
  'ÇT3 EKSPRES':[29,30], 'Ç11K':[20,20], 'Ç11K EKSPRES':[65,68], 'Ç11G':[24,25], 'Ç11Ç':[7,7],
  'ÇT1':[12,11], 'ÇT2':[1,1] });
// 20-EKIM-11: page 16 was checked cell by cell against its text layer. Only the
// Ç11K express evening section differs from the previous parser's reading.
counts.push({ ...counts[10], 'Ç3':[37,37], 'Ç10':[24,17], 'Ç11K EKSPRES':[77,81], 'Ç11G':[24,26] });
// 26-EKIM and 28-EKIM-9: pages 16 and 17 were counted per column from the text
// layer. Only the Ç11K express table differs from the previous parser's reading.
counts.push({ ...counts[11], 'Ç1':[31,33], 'ÇT3':[42,44], 'Ç11K':[23,23], 'Ç11K EKSPRES':[78,81] });
counts.push({ ...counts[12], 'ÇT1':[8,7], 'ÇT2':[1,2] });
// The publisher's 19 September PDF lists Ç2 without a Ç2 table.
const expectedIndexOnly = index => index === 4 ? ['Ç2'] : [];
const getRoute = (result, id) => Object.values(result.routes).find(r => routeHeading(r.name).id === id);
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
      assert.deepEqual(parsed[index].diagnostics.expectedRoutes.filter(id => index !== 4 || id !== 'Ç2'), parsed[index].diagnostics.parsedRoutes);
    assert.deepEqual(Object.fromEntries(Object.values(parsed[index].routes).map(r =>
      [routeHeading(r.name).id, [r.dir0.times.length, r.dir1.times.length]])), counts[index]);
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
  for (const t of ['07:20','08:05','12:25','19:35','19:55','23:35']) assert.ok(r.dir0.times.includes(t));
  for (const t of ['07:30','07:40','14:40','19:35','00:00']) assert.ok(r.dir1.times.includes(t));
  assert.equal(r.dir0.times.includes('07:00'), false, 'Kepez intermediate-stop time is not a Dardanos departure');
  assert.equal(r.dir0.times.includes('00:00'), false, 'Gazi departure is not copied to Dardanos');
});
await test('Ç4 repeated wide terminal header preserves evening departures', () => {
  const r = getRoute(parsed[6], 'Ç4');
  assert.match(r.dir0.label, /HÜSEYİN ELBİ/);
  assert.deepEqual(r.dir0.times.filter(t => t >= '18:20'),
    '18:20 18:40 19:00 19:20 19:40 20:00 20:20 20:40 21:00 21:20 21:40 22:00'.split(' '));
  assert.deepEqual(r.dir1.times.filter(t => t >= '19:00'),
    '19:00 19:20 19:40 20:00 20:20 20:40 21:00 21:20 21:40 22:00 22:20'.split(' '));
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
  assert.deepEqual(r.dir0.times.filter(t => t >= '18:00'),
    '18:05 18:25 18:45 19:05 19:25 19:45 20:05 20:20 20:35 20:50 21:05 21:20 21:35 21:50 22:05 22:20 22:35 22:50 23:10 23:45'.split(' '));
  assert.deepEqual(r.dir1.times.filter(t => t >= '18:00'),
    '18:10 18:30 18:50 19:10 19:30 19:50 20:10 20:30 20:50 21:05 21:20 21:35 21:50 22:05 22:10 22:30 22:50 23:05 23:10 23:30 23:50'.split(' '));
  const tables = parsed[10].diagnostics.pages.find(p => p.page === 16).tables;
  assert.deepEqual(tables.map(t => t.columns.map(c => c.label)), [['DARDANOS', 'GAZİ OKULU'], ['KEPEZ 144 TOKİ', 'GAZİ OKULU']]);
  assert.deepEqual(tables.map(t => t.columns.map(c => c.times.length)), [[47, 50], [19, 18]]);
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
  assert.deepEqual(tables[0].columns.map(c => c.times.length), [55, 61]);
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
  const eveningOrigin = result => result.diagnostics.pages.find(p => p.page === 16).tables[1]?.columns.map(c => c.label);
  const unconfirmed = result => {
    assert.ok(result.diagnostics.errors.includes('Page 16: Ç11K EKSPRES origin KEPEZ TOKİ is not a confirmed departure'));
    assert.equal(getRoute(result, 'Ç11K EKSPRES')?.dir0.times.includes('00:00') ?? false, false);
  };
  // The day section loses its DARDANOS caption, so it departs from GAZİ OKULU alone.
  const noDayOrigin = structuredClone(pages[11]);
  const day = noDayOrigin.find(p => p.number === 16);
  day.items = day.items.filter(i => !(i.text === 'DARDANOS' && i.y > 750 && i.x < 160));
  unconfirmed(parsePages(noDayOrigin));
  // The evening KALKIŞ moves one column left, onto the GAZİ OKULU arrival, where
  // the day section had no departures.
  const movedKalkis = structuredClone(pages[11]);
  for (const i of movedKalkis.find(p => p.number === 16).items.filter(i => i.y > 198 && i.y < 205)) {
    if (i.text === 'GAZİ OKULU KALKIŞ') i.text = 'GAZİ OKULU';
    else if (i.text === 'GAZİ OKULU') i.text = 'GAZİ OKULU KALKIŞ';
  }
  unconfirmed(parsePages(movedKalkis));
  // A table with its own route title is a new table, not a continuation.
  const titled = structuredClone(pages[11]), header = evening11()[0];
  titled.find(p => p.number === 16).items.push({ text:'Ç-11K EKSPRES', x:60, y:header.y, w:50, h:header.h });
  assert.deepEqual(eveningOrigin(parsePages(titled)), ['GAZİ OKULU']);
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
await test('unknown separate table cannot be absorbed into preceding route', () => {
  const altered = structuredClone(pages[1]);
  for (const p of altered) for (const i of p.items) i.text = i.text.replace('KALABAKLI', 'YENİ KÖY');
  assert.ok(parsePages(altered).diagnostics.errors.some(e => /unknown unnumbered/.test(e)));
});
await test('scanned, empty and non-PDF inputs fail explicitly', async () => {
  assert.ok(parsePages([{ number:1, width:595, height:842, items:[] }]).diagnostics.errors.some(e => /scanned/.test(e)));
  assert.ok(parsePages([]).diagnostics.errors.length);
  await assert.rejects(parsePDF(Buffer.from('<html>Server error</html>')), /not a PDF/);
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
