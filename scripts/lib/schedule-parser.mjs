import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fileURLToPath } from 'node:url';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;
const fonts = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url));

export const clean = text => String(text || '').normalize('NFKC')
  .replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim();
export const fold = text => clean(text).toLocaleUpperCase('tr')
  .replace(/[ÇĞİÖŞÜ]/g, c => ({ Ç:'C', Ğ:'G', İ:'I', Ö:'O', Ş:'S', Ü:'U' })[c]);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] || 7;
const centre = item => item.x + item.w / 2;
const hasTime = text => /\d{1,2}\s*[:.]\s*\d{2}/.test(text);
const departure = text => /(?:^|\s)(?:KALKIS|HAREKET)(?:\s+SAAT[IILERI]*)?\s*:?$/.test(fold(text)) && !hasTime(text);
const note = text => /(?:OLARAK|DEVAM|BITIS|BASLAYACAK|SEFER YOK|IPTAL)/.test(fold(text));
const serialTime = time => { const [h, m] = time.split(':').map(Number); return h * 60 + m + (h < 4 ? 1440 : 0); };

export function routeHeading(text) {
  const s = clean(text).toLocaleUpperCase('tr');
  const m = s.match(/^(?:[ÇC]\s*-?\s*(T\s*-?\s*)?(\d{1,3})([A-ZÇĞİÖŞÜ]{0,4})|(\d{1,3})\s*-?\s*([ÇGK])|(?:(960)))(?=$|\s|[-/:])/u);
  if (!m || /^\s*-\s*\d/.test(s.slice(m[0].length)) || /\s\d+[A-Z]$/.test(s) || note(s) || /DOSYA/.test(fold(s))) return null;
  const code = m[6] ? 'Ç960' : m[4] ? `Ç${m[4]}${m[5]}` : `Ç${m[1] ? 'T' : ''}${m[2]}${m[3]}`;
  const rest = s.slice(m[0].length).replace(/^\s*[/:-]\s*/, '').trim();
  const express = /EKSPRES|EXPRESS?|\bEKS\b/.test(fold(rest));
  return { code, id: code + (express ? ' EKSPRES' : ''), name: [code, rest].filter(Boolean).join(' ') };
}

function leadingTime(text) {
  const m = clean(text).match(/^(\d{1,2})\s*[:.]\s*(\d{2})(?!\d)/);
  if (!m) return null;
  return { time: `${m[1].padStart(2, '0')}:${m[2]}`, length: m[0].length,
    valid: +m[1] < 24 && +m[2] < 60, annotation: note(text) };
}

// Text order is not reading order in a PDF. Join fragments by their baseline
// and bounding boxes; retain column gaps so different cells cannot be joined.
function preparePage(page) {
  const targetWidth = page.width > page.height ? 842 : 595;
  const scale = targetWidth / page.width;
  const items = page.items.filter(i => clean(i.text)).map(i => ({
    text: clean(i.text), x: i.x * scale, y: i.y * scale,
    w: i.w * scale, h: Math.max(1, i.h * scale),
  })).sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const item of items) {
    const line = lines.find(l => Math.abs(l.y - item.y) <= Math.min(l.h, item.h) * 0.22);
    if (line) line.items.push(item);
    else lines.push({ y: item.y, h: item.h, items: [item] });
  }
  const joined = [];
  for (const line of lines) {
    const row = line.items.sort((a, b) => a.x - b.x);
    let prev;
    for (const item of row) {
      const gap = prev ? item.x - prev.x - prev.w : Infinity;
      if (prev && gap >= -0.5 && gap <= Math.min(prev.h, item.h) * 0.38) {
        prev.text = clean(prev.text + (gap > Math.min(prev.h, item.h) * 0.12 ? ' ' : '') + item.text);
        prev.w = item.x + item.w - prev.x;
      } else { prev = { ...item }; joined.push(prev); }
    }
  }
  return { ...page, width: targetWidth, height: page.height * scale, items: joined };
}

export async function extractPdf(bytes) {
  if (!Buffer.from(bytes).subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('Response is not a PDF');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true,
    isEvalSupported: false, standardFontDataUrl: fonts });
  let pdf;
  try {
    pdf = await task.promise;
    if (pdf.numPages > 100) throw new Error(`Unexpected PDF size: ${pdf.numPages} pages`);
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      pages.push({ number, width: viewport.width, height: viewport.height,
        items: tc.items.filter(i => i.str?.trim()).map(i => {
          const tr = pdfjs.Util.transform(viewport.transform, i.transform);
          return { text: i.str, x: tr[4], y: viewport.height - tr[5], w: i.width, h: i.height };
        }) });
      page.cleanup();
    }
    return pages;
  } finally { await (pdf ? pdf.destroy() : task.destroy()); }
}

function markerGroups(items) {
  const groups = [];
  for (const item of items.filter(i => departure(i.text)).sort((a, b) => b.y - a.y || a.x - b.x)) {
    const group = groups.find(g => Math.abs(g.y - item.y) <= Math.max(10, Math.min(g.h, item.h) * 2));
    if (group) group.markers.push(item);
    else groups.push({ y: item.y, h: item.h, markers: [item] });
  }
  return groups.sort((a, b) => b.y - a.y);
}

function headerColumns(items, group, route, width) {
  const h = median(group.markers.map(i => i.h));
  const minY = Math.min(...group.markers.map(i => i.y));
  const maxY = Math.max(...group.markers.map(i => i.y));
  const candidates = items.filter(i => i.y >= minY - h * 0.5 && i.y <= maxY + h * 3 &&
    !hasTime(i.text) && !/^\d+$/.test(i.text) && !routeHeading(i.text) &&
    i.w < width * 0.3 && !/^(?:BLD|DOSYA|SAYFA)|DONEMI|HAFTA|KAMPUS\s*-\s*KEPEZ|KEPEZ\s*-\s*KAMPUS/.test(fold(i.text)) &&
    (!route || centre(i) > route.x + route.w));
  const cols = group.markers.map(marker => ({ x: centre(marker), items: [marker], departure: true }));
  for (const item of candidates.filter(i => !group.markers.includes(i))) {
    const col = cols.filter(c => Math.abs(c.x - centre(item)) <= h * 2.3)
      .sort((a, b) => Math.abs(a.x - centre(item)) - Math.abs(b.x - centre(item)))[0];
    if (col) col.items.push(item);
    else cols.push({ x: centre(item), items: [item], departure: false });
  }
  cols.sort((a, b) => a.x - b.x);
  for (let i = 0; i < cols.length; i++) {
    const col = cols[i];
    const ordered = col.items.sort((a, b) => b.y - a.y || a.x - b.x);
    col.label = clean(ordered.map(it => it.text.replace(/(?:KALKI[ŞS]|HAREKET)(?:\s+SAAT[İI])?\s*:?$/iu, '').trim()).filter(Boolean).join(' '));
    const gapLeft = i ? col.x - cols[i - 1].x : (cols[i + 1]?.x - col.x || 100);
    const gapRight = i + 1 < cols.length ? cols[i + 1].x - col.x : gapLeft;
    col.left = col.x - gapLeft / 2;
    col.right = col.x + gapRight / 2;
  }
  return cols;
}

const terminalKey = text => fold(text).replace(/YURDU|YURT|DURAGI|DURAK|KALKIS|HAREKET/g, '').replace(/[^A-Z0-9]/g, '');
function matchesTerminal(a, b) {
  const x = terminalKey(a), y = terminalKey(b);
  return x && y && (x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x))));
}

function mergeTable(route, table, errors) {
  const cols = table.columns.filter(c => c.departure);
  if (cols.length > 2 || cols.length === 0) { errors.push(`Page ${table.page}: ${route.name} has ${cols.length} departure columns`); return; }
  let assignment;
  if (!route.tables.length) assignment = cols.map((_, i) => i);
  else {
    const known = cols.map(c => route.directions.findIndex(d => d.labels.some(label => matchesTerminal(label, c.label))));
    if (known.some(i => i >= 0)) {
      assignment = known.map((i, j) => i >= 0 ? i : 1 - known[1 - j]);
    } else if (cols.length === 1 && !route.directions[1].labels.length) assignment = [1];
    else { errors.push(`Page ${table.page}: cannot align ${route.name} departure terminals (${cols.map(c => c.label).join(', ')})`); return; }
  }
  if (assignment.length === 2 && assignment[0] === assignment[1]) {
    errors.push(`Page ${table.page}: both ${route.name} columns map to the same direction`); return;
  }
  for (let i = 0; i < cols.length; i++) {
    const dir = route.directions[assignment[i]], col = cols[i];
    if (!dir) { errors.push(`Page ${table.page}: unknown direction for ${route.name}`); continue; }
    if (col.label && !dir.labels.includes(col.label)) dir.labels.push(col.label);
    for (const time of col.times) dir.times.add(time);
  }
  route.tables.push(table);
}

export function parsePages(rawPages) {
  if (rawPages.some(p => !(p.width > 0 && p.height > 0) || p.items.some(i =>
    ![i.x, i.y, i.w, i.h].every(Number.isFinite)))) throw new Error('Invalid PDF text geometry');
  const pages = rawPages.map(preparePage);
  const diagnostics = { pages: [], expectedRoutes: [], parsedRoutes: [], errors: [], warnings: [], ignored: [] };
  const routes = new Map();
  const manifest = new Map();
  const namedManifest = new Set();
  let lastRoute = null;
  for (const page of pages) {
    const { items } = page;
    const groups = markerGroups(items);
    const timeItems = items.filter(i => leadingTime(i.text));
    const report = { page: page.number, markers: groups.reduce((n, g) => n + g.markers.length, 0), tables: [] };
    diagnostics.pages.push(report);
    const coverRoutes = items.map(i => routeHeading(i.text)).filter(Boolean);
    if (!groups.length) {
      if (coverRoutes.length >= 3 && !timeItems.length) {
        coverRoutes.forEach(r => manifest.set(r.id, r.name));
        items.filter(i => !routeHeading(i.text) && /^[A-ZÇĞİÖŞÜ ]{4,}$/u.test(i.text) &&
          !/DONEMI|HAFTA|TOPLU|HATLAR|TARIH|SEFER|OGRENCI/.test(fold(i.text)))
          .forEach(i => namedManifest.add(fold(i.text)));
        report.kind = 'index';
      } else if (/OGR[12]|OGRENCI/.test(fold(items.map(i => i.text).join(' ')))) {
        report.kind = 'school-services';
        diagnostics.ignored.push({ page: page.number, reason: 'School services have day-specific conditions; use the source PDF.' });
      } else if (!items.length) diagnostics.errors.push(`Page ${page.number}: no extractable text (scanned or unreadable PDF)`);
      else if (timeItems.length) diagnostics.errors.push(`Page ${page.number}: ${timeItems.length} time cells without recognizable departure headings`);
      else report.kind = 'text';
      continue;
    }
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi], h = median(group.markers.map(i => i.h));
      const firstX = Math.min(...group.markers.map(centre));
      const nearby = items.filter(i => i.y <= group.y + h * 8 && i.y >= group.y - h * 2 &&
        i.x < firstX - h && routeHeading(i.text) && i.h >= h * 0.55 &&
        !items.some(t => leadingTime(t.text) && Math.abs(t.y - i.y) < h * 0.5));
      nearby.sort((a, b) => Math.abs(a.y - group.y) - Math.abs(b.y - group.y) || a.x - b.x);
      const routeItem = nearby[0];
      let routeCell = routeItem;
      let heading = routeItem && routeHeading(routeItem.text);
      if (heading) {
        const extra = items.filter(i => Math.abs(i.x - routeItem.x) < h * 4 &&
          i.y < routeItem.y + h * 0.3 && i.y > routeItem.y - h * 3 &&
          (i.x > routeItem.x + routeItem.w || i.y < routeItem.y - h * 0.4) &&
          centre(i) < firstX - h && !hasTime(i.text) && !routeHeading(i.text) &&
          !/\d|DOSYA|BLD|KALKIS|VARIS|HAREKET/.test(fold(i.text)))
          .sort((a, b) => b.y - a.y);
        heading = routeHeading([heading.name, ...extra.map(i => i.text)].join(' '));
        routeCell = { ...routeItem, w: Math.max(routeItem.x + routeItem.w, ...extra.map(i => i.x + i.w)) - routeItem.x };
        lastRoute = heading;
      } else {
        const otherTitle = items.find(i => i.x < firstX - h * 3 && Math.abs(i.y - group.y) < h * 2 &&
          /^[A-Z ]{4,}$/.test(fold(i.text)) && !departure(i.text) && !/BLD|DOSYA/.test(fold(i.text)));
        if (otherTitle) {
          // This village shuttle has no route identifier in the city network.
          // An unfamiliar title must never be swallowed into the preceding route.
          if (fold(otherTitle.text) === 'KALABAKLI') diagnostics.ignored.push({ page: page.number, reason: 'Separate Kalabaklı shuttle; use the source PDF.' });
          else diagnostics.errors.push(`Page ${page.number}: unknown unnumbered table: ${otherTitle.text}`);
          continue;
        }
        heading = lastRoute;
      }
      if (!heading) { diagnostics.errors.push(`Page ${page.number}: departure table has no identifiable route`); continue; }
      const columns = headerColumns(items, group, routeCell, page.width);
      if (!routeItem && !columns.some(c => c.departure && routes.get(heading.id)?.directions.some(d =>
        d.labels.some(label => matchesTerminal(label, c.label))))) {
        diagnostics.errors.push(`Page ${page.number}: untitled table cannot be matched to ${heading.id}`);
        continue;
      }
      // A labelled origin may omit KALKIŞ in a two-direction table. Only infer
      // it when the source explicitly labels both trip directions above it.
      if (columns.filter(c => c.departure).length === 1 && items.some(i => /KAMPUS\s*-\s*KEPEZ/.test(fold(i.text))) &&
          items.some(i => /KEPEZ\s*-\s*KAMPUS/.test(fold(i.text)))) {
        const implicit = columns.find(c => !c.departure && /KEPEZ.*TOKI/.test(fold(c.label)) && !/VARIS/.test(fold(c.label)));
        if (implicit) implicit.departure = true;
      }
      // Some editions omit KALKIŞ at the first origin. Infer it only from
      // reciprocal, explicitly labelled arrivals for BOTH endpoints.
      if (columns.filter(c => c.departure).length === 1) {
        const known = columns.find(c => c.departure);
        const arrivals = columns.filter(c => /VARIS/.test(fold(c.label)));
        const arrivalName = c => fold(c.label).replace(/VARIS/g, '').trim();
        if (arrivals.some(c => matchesTerminal(arrivalName(c), known.label))) {
          const implicit = columns.filter(c => !c.departure && !/VARIS/.test(fold(c.label)) &&
            arrivals.some(a => matchesTerminal(arrivalName(a), c.label)));
          if (implicit.length === 1) implicit[0].departure = true;
        }
      }
      columns.forEach(c => { c.times = []; });
      const bottom = gi + 1 < groups.length ? groups[gi + 1].y + median(groups[gi + 1].markers.map(i => i.h)) * 2.2 : 0;
      const top = Math.min(...group.markers.map(i => i.y)) - h * 0.5;
      for (const item of timeItems.filter(i => i.y < top && i.y > bottom)) {
        const parsed = leadingTime(item.text);
        const x = item.x + item.w * Math.min(1, parsed.length / item.text.length) / 2;
        const col = columns.find(c => x >= c.left && x < c.right);
        if (!col?.departure || parsed.annotation) continue;
        const row = items.filter(i => i.x >= col.left && i.x < col.right && Math.abs(i.y - item.y) < h * 0.6).map(i => i.text).join(' ');
        if (note(row)) continue;
        if (!parsed.valid) diagnostics.errors.push(`Page ${page.number}: invalid departure ${parsed.time} for ${heading.id}`);
        else col.times.push(parsed.time);
      }
      const table = { page: page.number, route: heading.id, headers: columns.map(c => c.label), columns: columns.filter(c => c.departure).map(c => ({
        departure: true, label: c.label, times: c.times, x: Math.round(c.x * 100) / 100,
      })) };
      if (!table.columns.some(c => c.times.length)) diagnostics.errors.push(`Page ${page.number}: ${heading.id} table has no departures`);
      if (table.columns.some(c => !c.label)) diagnostics.errors.push(`Page ${page.number}: ${heading.id} departure terminal is missing`);
      report.tables.push(table);
      if (!routes.has(heading.id)) routes.set(heading.id, { ...heading, tables: [], directions: [
        { labels: [], times: new Set() }, { labels: [], times: new Set() },
      ] });
      mergeTable(routes.get(heading.id), table, diagnostics.errors);
    }
  }
  for (const label of namedManifest) {
    const route = [...routes.values()].find(r => fold(r.name).includes(label));
    if (route) manifest.set(route.id, route.name);
    else diagnostics.errors.push(`Route ${label} is listed in the PDF index but was not parsed`);
  }
  diagnostics.expectedRoutes = [...manifest.keys()].sort();
  diagnostics.parsedRoutes = [...routes.keys()].sort();
  for (const id of manifest.keys()) if (!routes.has(id)) diagnostics.errors.push(`Route ${id} is listed in the PDF index but was not parsed`);
  for (const id of routes.keys()) if (manifest.size && !manifest.has(id)) diagnostics.errors.push(`Parsed route ${id} is absent from the PDF index`);
  if (!routes.size) diagnostics.errors.push('No timetable routes were parsed');
  const result = {};
  for (const route of routes.values()) {
    if (route.directions.some(d => d.labels.length && !d.times.size))
      diagnostics.errors.push(`${route.name}: a departure direction has no times`);
    // The cover gives the complete name when a coloured table heading wraps.
    const name = manifest.get(route.id) || route.name;
    result[name] = { name, ...Object.fromEntries(route.directions.map((d, i) => ['dir' + i, {
      label: d.labels[0] || '', times: [...d.times].sort((a, b) => serialTime(a) - serialTime(b)),
    }])) };
  }
  return { routes: result, numPages: pages.length, diagnostics };
}

export async function parsePDF(bytes) { return parsePages(await extractPdf(bytes)); }
