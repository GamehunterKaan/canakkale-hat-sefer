// The AI grounding gate against a real PDF. Offline: the transcription is a
// controlled stand-in derived from the parser's verified reading.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { extractPdf, parsePages, routeHeading } from '../scripts/lib/schedule-parser.mjs';
import { aiParsePDF, checkAiRoutes } from '../scripts/lib/schedule-ai.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (e) { e.message = name + ': ' + e.message; throw e; }
}
const bytes = gunzipSync(readFileSync(new URL('./fixtures/schedules/weekday-2026-10-08.pdf.gz', import.meta.url)));
const pages = await extractPdf(bytes);
const parsed = parsePages(pages);
assert.deepEqual(parsed.diagnostics.errors, []);
const pagesOf = id => parsed.diagnostics.pages.filter(p => p.tables.some(t => t.route === id)).map(p => p.page);
// What a faithful transcription of this PDF looks like in the response schema.
const faithful = () => ({ routes: Object.values(parsed.routes).map(r => ({
  name: r.name, pages: pagesOf(routeHeading(r.name).id),
  directions: [r.dir0, r.dir1].filter(d => d.times.length).map(d => ({ terminal: d.label, times: [...d.times] })),
})) });
const route = (ai, id) => ai.routes.find(r => routeHeading(r.name).id === id);
const total = Object.keys(parsed.routes).length;

await test('faithful transcription passes and reproduces the parser output exactly', async () => {
  const result = checkAiRoutes(faithful(), pages, parsed);
  assert.deepEqual(result.errors, []);
  assert.equal(result.agreed, total);
  assert.deepEqual(result.routes, parsed.routes);
});
await test('an invented time is rejected', async () => {
  const ai = faithful();
  route(ai, 'Ç4').directions[0].times.push('03:33');
  assert.ok(checkAiRoutes(ai, pages, parsed).errors.some(e => /Ç4: 03:33 is not printed/.test(e)));
});
await test('a printed time in the wrong column is rejected by agreement', async () => {
  const ai = faithful(), [a, b] = route(ai, 'Ç4').directions;
  b.times.push(a.times.shift());
  const { errors } = checkAiRoutes(ai, pages, parsed);
  assert.deepEqual(errors, ["Ç4: AI disagrees with the parser's clean reading"]);
});
await test('dropping a route the parser found is rejected', async () => {
  const ai = faithful();
  ai.routes = ai.routes.filter(r => routeHeading(r.name).id !== 'Ç10');
  assert.ok(checkAiRoutes(ai, pages, parsed).errors.includes('AI omitted Ç10, which the parser found'));
});
await test('routes on a page the parser failed may differ; others must still agree', async () => {
  const page = pagesOf('Ç4')[0];
  const broken = { ...parsed, diagnostics: { ...parsed.diagnostics, errors: [`Page ${page}: cannot align columns`] } };
  const onPage = parsed.diagnostics.pages.find(p => p.page === page).tables.map(t => t.route);
  const ai = faithful();
  route(ai, 'Ç4').directions[0].times.pop();
  const result = checkAiRoutes(ai, pages, broken);
  assert.deepEqual(result.errors, []);
  assert.equal(result.agreed, total - new Set(onPage).size);
  // A route named in an error is excused, a code it merely starts with is not.
  const named = { ...parsed, diagnostics: { ...parsed.diagnostics, errors: ['Ç10 NUSRAT: a departure direction has no times'] } };
  const shifted = faithful();
  route(shifted, 'Ç10').directions[0].times.pop();
  route(shifted, 'Ç1').directions[0].times.pop();
  assert.deepEqual(checkAiRoutes(shifted, pages, named).errors, ["Ç1: AI disagrees with the parser's clean reading"]);
});
await test('a time used more often than printed, a bad clock or an unknown code is rejected', async () => {
  const page = [{ number:1, width:595, height:842, items:[{ text:'08:00', x:100, y:700, w:20, h:8 }] }];
  const twice = { routes:[1, 2].map(n => ({ name:`Ç${n} X`, pages:[1], directions:[{ terminal:'A', times:['08:00'] }] })) };
  assert.deepEqual(checkAiRoutes(twice, page).errors, ['08:00 is used more often than the PDF prints it']);
  const odd = { routes:[{ name:'Kalabaklı', pages:[1], directions:[{ terminal:'A', times:['08:00'] }] },
    { name:'Ç1 X', pages:[1], directions:[{ terminal:'A', times:['8:00'] }] }] };
  assert.deepEqual(checkAiRoutes(odd, page).errors, ['AI route has no recognizable code: Kalabaklı', 'Ç1: invalid clock time 8:00']);
});
await test('aiParsePDF grounds the transcription in the real PDF bytes', async () => {
  const ok = await aiParsePDF(bytes, parsed, { transcribePdf: async () => faithful() });
  assert.equal(ok.numPages, pages.length);
  assert.deepEqual(ok.routes, parsed.routes);
  const bad = faithful();
  route(bad, 'Ç1').directions[0].times.push('03:33');
  await assert.rejects(aiParsePDF(bytes, parsed, { transcribePdf: async () => bad }), e => e.rejected === true);
});
console.log('Schedule AI grounding: ' + passed + ' checks passed (offline).');
