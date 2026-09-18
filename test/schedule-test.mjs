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
// The publisher's 19 September PDF really lists Ç2 without a Ç2 table.
// Preserve it as a failing-source fixture, never weaken coverage to accept it.
const expectedErrors = index => index === 4 ? ['Route Ç2 is listed in the PDF index but was not parsed'] : [];
const getRoute = (result, id) => Object.values(result.routes).find(r => routeHeading(r.name).id === id);
for (const [index, fixture] of fixtures.entries()) {
  await test(fixture.name + ' extraction and complete route/direction counts', async () => {
    const bytes = gunzipSync(readFileSync(new URL('./fixtures/schedules/' + fixture.name + '.pdf.gz', import.meta.url)));
    assert.equal(bytes.length, fixture.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.sha256);
    pages[index] = await extractPdf(bytes);
    parsed[index] = parsePages(pages[index]);
    assert.deepEqual(parsed[index].diagnostics.errors, expectedErrors(index));
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
    assert.deepEqual(result.diagnostics.errors, expectedErrors(index));
    assert.deepEqual(result.routes, parsed[index].routes);
  });
}
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
await test('missing whole route/page is rejected against PDF index', () => {
  const result = parsePages(pages[1].filter(p => p.number !== 10));
  assert.ok(result.diagnostics.errors.some(e => /Ç10.*not parsed/.test(e)));
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
  const bytes = await requestBytes('https://example.test/a', { sleep:async () => {}, fetchImpl:async (_url, options) => {
    assert.equal(options.cache, 'no-store'); assert.equal(options.headers['Cache-Control'], 'no-cache');
    return ++calls < 3 ? new Response('', { status:503 }) : new Response('PDF bytes');
  } });
  assert.equal(calls, 3);
  assert.equal(bytes.toString(), 'PDF bytes');
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
