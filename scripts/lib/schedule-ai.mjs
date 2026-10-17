/** Claude transcription of a timetable PDF the parser rejected. The reading is
 * never trusted on its own: checkAiRoutes grounds it in the PDF text layer and
 * in the parser's clean tables before it may be published as unverified data. */
import Anthropic from '@anthropic-ai/sdk';
import { clean, extractPdf, preparePage, routeHeading, serialTime } from './schedule-parser.mjs';

const MODEL = 'claude-opus-5-5';
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['routes'],
  properties: { routes: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['name', 'pages', 'directions'],
    properties: {
      name: { type: 'string' },
      pages: { type: 'array', items: { type: 'integer' } },
      directions: { type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['terminal', 'times'],
        properties: { terminal: { type: 'string' }, times: { type: 'array', items: { type: 'string' } } },
      } },
    },
  } } },
};
const PROMPT = `This PDF is a municipal bus timetable from Çanakkale, Turkey. Transcribe the departure times of every route timetable table.

- One entry per route. A route's tables can continue across sections and pages; merge them and list every page (1-based) where the route has a table.
- \`name\` starts with the route code exactly as printed (Ç1, Ç11K, ÇT3, Ç960, ...) followed by the route title. An express variant is a separate route and keeps EKSPRES in its name.
- One direction per departure column, i.e. the columns headed KALKIŞ or HAREKET; at most two directions per route, one per origin terminal. \`terminal\` is that column's terminal name. Arrival (VARIŞ) columns are not departures. An origin column that omits the KALKIŞ word is still a departure column when the table labels its reciprocal arrival.
- Times as zero-padded 24-hour HH:MM, exactly as printed. Never compute, infer or fill in a time that is not printed.
- Leave out a time whose cell, or that column's cell in the same row, says it is not a normal departure: service end (bitiş), cancellation (iptal, sefer yok), or a start/continuation note (başlayacak, devam, ... olarak). Keep times that only name a stop variant, such as 08:50-ESENLER.
- Skip cover/index pages, student or school services (ÖĞR), and the separate Kalabaklı shuttle.`;

async function transcribe(bytes, client = new Anthropic()) {
  const message = await client.beta.messages.stream({
    model: MODEL, max_tokens: 64000,
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(bytes).toString('base64') } },
      { type: 'text', text: PROMPT },
    ] }],
  }).finalMessage();
  if (message.stop_reason !== 'end_turn') throw new Error(`transcription stopped: ${message.stop_reason}`);
  return JSON.parse(message.content.find(block => block.type === 'text').text);
}

function printedTimes(page) {
  const counts = new Map();
  for (const item of preparePage(page).items)
    for (const m of item.text.matchAll(/(?<!\d)(\d{1,2})\s*[:.]\s*(\d{2})(?!\d)/g)) {
      const time = `${m[1].padStart(2, '0')}:${m[2]}`;
      counts.set(time, (counts.get(time) || 0) + 1);
    }
  return counts;
}

// Gates, in order: every time is printed on the route's pages, no time is used
// more often than the whole PDF prints it, every route the parser found is
// present, and routes the parser read without any error agree exactly.
export function checkAiRoutes(ai, pages, parsed) {
  const errors = [], routes = {}, byId = new Map();
  const perPage = new Map(pages.map(page => [page.number, printedTimes(page)]));
  const remaining = new Map();
  for (const counts of perPage.values()) for (const [time, n] of counts) remaining.set(time, (remaining.get(time) || 0) + n);
  for (const route of ai.routes) {
    const heading = routeHeading(route.name);
    if (!heading) { errors.push(`AI route has no recognizable code: ${route.name}`); continue; }
    if (byId.has(heading.id)) { errors.push(`AI listed ${heading.id} twice`); continue; }
    if (!route.directions.length || route.directions.length > 2) { errors.push(`${heading.id}: ${route.directions.length} directions`); continue; }
    const dirs = [];
    for (const direction of route.directions) {
      const times = [...new Set(direction.times)];
      for (const time of times) {
        if (!CLOCK.test(time)) { errors.push(`${heading.id}: invalid clock time ${time}`); continue; }
        if (!route.pages.some(n => perPage.get(n)?.has(time))) errors.push(`${heading.id}: ${time} is not printed on page(s) ${route.pages.join(', ')}`);
        remaining.set(time, (remaining.get(time) || 0) - 1);
        if (remaining.get(time) === -1) errors.push(`${time} is used more often than the PDF prints it`);
      }
      dirs.push({ label: clean(direction.terminal), times: times.filter(t => CLOCK.test(t)).sort((a, b) => serialTime(a) - serialTime(b)) });
    }
    const name = clean(route.name);
    routes[name] = { name, dir0: dirs[0], dir1: dirs[1] || { label: '', times: [] } };
    byId.set(heading.id, routes[name]);
  }
  if (!byId.size) errors.push('AI transcribed no routes');
  let agreed = 0;
  const diagnostics = parsed?.diagnostics || { errors: [], pages: [] };
  const brokenPages = new Set(diagnostics.errors.flatMap(e => [...e.matchAll(/\bpage (\d+)/gi)].map(m => +m[1])));
  const implicated = id => {
    const code = new RegExp(`${id.split(' ')[0]}(?![0-9A-ZÇĞİÖŞÜ])`, 'u');
    return diagnostics.errors.some(e => code.test(e.toLocaleUpperCase('tr'))) ||
      diagnostics.pages.some(p => brokenPages.has(p.page) && p.tables.some(t => t.route === id));
  };
  const key = route => [route.dir0, route.dir1].map(d => d.times.join(' ')).sort().join(' | ');
  for (const route of Object.values(parsed?.routes || {})) {
    const id = routeHeading(route.name)?.id;
    if (!id) continue;
    if (!byId.has(id)) errors.push(`AI omitted ${id}, which the parser found`);
    else if (implicated(id)) continue;
    else if (key(route) !== key(byId.get(id))) errors.push(`${id}: AI disagrees with the parser's clean reading`);
    else agreed++;
  }
  return { routes, errors, agreed };
}

export async function aiParsePDF(bytes, parsed, { transcribePdf = transcribe } = {}) {
  const pages = await extractPdf(bytes);
  const { routes, errors, agreed } = checkAiRoutes(await transcribePdf(bytes), pages, parsed);
  if (errors.length) throw Object.assign(new Error(errors.join('\n')), { rejected: true });
  return { routes, numPages: pages.length, agreed };
}
