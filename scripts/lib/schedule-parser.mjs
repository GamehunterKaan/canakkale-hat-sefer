import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fileURLToPath } from 'node:url';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;
const fonts = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url));

// Cell geometry is compared against every nearby cell, so the pure text
// helpers see the same strings thousands of times per page: remember them.
const remember = fn => { const seen = new Map(); return text => seen.has(text) ? seen.get(text) : seen.set(text, fn(text)).get(text); };
export const clean = remember(text => String(text || '').normalize('NFKC')
  .replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim());
export const fold = remember(text => clean(text).toLocaleUpperCase('tr')
  .replace(/[ÇĞİÖŞÜ]/g, c => ({ Ç:'C', Ğ:'G', İ:'I', Ö:'O', Ş:'S', Ü:'U' })[c]));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] || 7;
const centre = item => item.x + item.w / 2;
// A clock reads 07:45, 7.45 or a typed 07,45 (a comma without spaces, unlike a list).
const hasTime = text => /\d{1,2}(?:\s*[:.]\s*|,)\d{2}/.test(text);
const departure = text => /(?:^|\s)(?:KALKIS|HAREKET)(?:\s+SAAT[IILERI]*)?\s*:?$/.test(fold(text)) && !hasTime(text);
const note = text => /(?:OLARAK|DEVAM|BITIS|BASLAYACAK|SEFER YOK|IPTAL|ITIBAR|SADECE)/.test(fold(text));
// Route codes named in free text: Ç960, ÇT-3, (Ç11G), 11-K.
const routeKey = code => fold(code).replace(/[^A-Z0-9]/g, '').replace(/^C/, '');
const namesOtherRoute = (text, code) => [...fold(text).matchAll(/(?<![A-Z0-9])(C\s*-?\s*(?:T\s*-?\s*)?\d{1,3}[A-Z]?|\d{1,3}\s*-\s*[KGC])(?![A-Z0-9])/g)]
  .some(m => routeKey(m[1]) !== routeKey(code));
// A stop as riders know it: a column label without its KALKIŞ/VARIŞ marker.
const stopName = label => clean(String(label || '').replace(/(?:^|\s)(?:VARI[ŞS]|KALKI[ŞS]|HAREKET)(?=\s|$)/giu, ' '));
// The timetable's own words after a departure time ("çınarlı", "-SSK"), kept for riders.
const annotation = text => clean(text).replace(/^[\s\-–—.,:;/()]+|[\s\-–—.,:;/()]+$/gu, '');
// Words that describe a trip between places or from one: "SSK-ÇINARLI",
// "SSK'dan ÇINARLI", "SSK dan", "Kepez meydandan", "kepezden", "kampüsten",
// "SSK HAREKET". A departure's own note names one place ("çınarlı", "SSK",
// "iskele"); MEYDAN alone is a place.
const describesTrip = text =>
  /[A-Z]{2,}\s*-\s*[A-Z]{2,}|[A-Z]['’\s]\s*[DT][AE]N\b|[A-Z]{2,}[AEIOUBCDGJLMNRVZ]D[AE]N\b|[A-Z]{2,}[CFHKPST]T[AE]N\b|\b(?:HAREKET|KALKIS)\b/.test(fold(text));
function textLines(items) {
  const lines = [];
  for (const i of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines.find(l => Math.abs(l.y - i.y) < Math.min(l.h, i.h) * 0.5);
    if (line) line.items.push(i); else lines.push({ y: i.y, h: i.h, items: [i] });
  }
  return lines.map(l => l.items.sort((a, b) => a.x - b.x).map(i => i.text).join(' '));
}
// A page legend such as "ÇINARLI / KALABAKLI SEFERLERİNİ GERÇEKLEŞTİREN ARAÇLAR
// YERLEŞKEYE UĞRAMAMAKTADIR" says which annotated trips skip which terminal.
function legendOf(text) {
  const m = fold(text).match(/^(.+?)\s*SEFERLERI(?:NI)?\s+(?:GERCEKLESTIREN|YAPAN)\s+ARACLAR\s+(.+?)\s+UGRAMA(?:MAKTADIR|Z|YACAKTIR)/);
  if (!m) return null;
  const places = m[1].split(/\s*(?:[/,&]|\bVE\b)\s*/).map(p => p.trim()).filter(p => p.length >= 3);
  return places.length ? { places, skipped: m[2].trim().replace(/Y?[EA]$/, '') } : null;
}
// A direction caption names the two ends of a trip: "KAMPÜS - KEPEZ", "144
// TOKİ - KAMPÜS". A route path listing every stop ("GAZİ OKULU - İSKELE - … -
// DARDANOS") is not one, and neither is a span of times.
const directionCaption = text => {
  const m = clean(text).match(/^([^-]{3,}?)\s+-\s+([^-]{3,})$/u);
  return m && /\p{L}{3}/u.test(m[1]) && /\p{L}{3}/u.test(m[2]) ? m : null;
};
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

// A cell's words continue on its baseline after a word gap, even past the
// column edge ("14:00 BİTİŞ"), and on wrapped lines below it that hold no
// times and stay within its column ("07:45" over "çınarlı"). A row-wide
// banner below, or the next section's header, is not part of the cell. Its
// annotation is judged on all of it.
function cellText(items, cell, h, col, bottom) {
  const parts = [cell.text];
  let end = cell.x + cell.w;
  for (const i of items.filter(i => i !== cell && Math.abs(i.y - cell.y) < h * 0.6 && i.x >= end - 1).sort((a, b) => a.x - b.x)) {
    if (leadingTime(i.text) || i.x - end > h * 2) break;
    parts.push(i.text);
    end = i.x + i.w;
  }
  for (let line = cell; ;) {
    const near = items.filter(i => i.y > bottom && i.y < line.y - line.h * 0.3 && line.y - i.y <= Math.max(line.h, i.h) * 1.6 &&
      !/KALKIS|VARIS|HAREKET/.test(fold(i.text)) &&
      i.x < end && i.x + i.w > cell.x && i.x >= Math.min(cell.x, col.left) - h && i.x + i.w <= Math.max(end, col.right) + h);
    if (!near.length) break;
    const y = Math.max(...near.map(i => i.y)), below = near.filter(i => y - i.y < h * 0.3);
    // A line level with a row of times, or near a time in this cell's own
    // column, is the next row. A wrapped line sits between the rows of the
    // columns beside it ("17:20" over "kalabaklı" in a two-line cell).
    if (items.some(t => leadingTime(t.text) && Math.abs(t.y - y) < h * (t.x < end && t.x + t.w > cell.x ? 0.6 : 0.3))) break;
    parts.push(...below.sort((a, b) => a.x - b.x).map(i => i.text));
    line = below[0];
  }
  return clean(parts.join(' '));
}

const leadingTime = remember(text => {
  const m = clean(text).match(/^(\d{1,2})(?:\s*[:.]\s*|,)(\d{2})(?!\d)/);
  if (!m) return null;
  return { time: `${m[1].padStart(2, '0')}:${m[2]}`, length: m[0].length,
    valid: +m[1] < 24 && +m[2] < 60, annotation: note(text) };
});

// Text order is not reading order in a PDF. Join fragments by their baseline
// and bounding boxes; retain column gaps so different cells cannot be joined.
function preparePage(page) {
  const targetWidth = page.width > page.height ? 842 : 595;
  const scale = targetWidth / page.width;
  const items = page.items.filter(i => clean(i.text) && !i.hidden).map(i => ({
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

// The text layer can hold text no reader sees, such as white digits left in a
// white cell. Render the page and measure, for each glyph box, the share of
// pixels whose colour clearly differs from the box's background, its most
// common colour. Colour, not brightness: black text on a dark red cell
// differs from it in red alone. Readable text covers over a tenth of its box
// at this scale; hidden text covers none of it.
const INK_SCALE = 2;
async function inkMeter(pdf, page) {
  const viewport = page.getViewport({ scale: INK_SCALE });
  const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
  const { canvas, context } = pdf.canvasFactory.create(width, height);
  let data;
  try {
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    await page.render({ canvasContext: context, viewport }).promise;
    ({ data } = context.getImageData(0, 0, width, height));
  } finally { pdf.canvasFactory.destroy({ canvas, context }); }
  // x and baseline y in unscaled viewport units (y down from the top).
  return (x, y, w, h) => {
    const box = [], colours = new Map();
    for (let py = Math.max(0, Math.floor((y - h * 0.8) * INK_SCALE)); py < Math.min(height, Math.ceil((y - h * 0.05) * INK_SCALE)); py++)
      for (let px = Math.max(0, Math.floor(x * INK_SCALE) + 1); px < Math.min(width, Math.ceil((x + w) * INK_SCALE) - 1); px++) {
        const k = (py * width + px) * 4, colour = data[k] << 16 | data[k + 1] << 8 | data[k + 2];
        box.push(k);
        colours.set(colour, (colours.get(colour) || 0) + 1);
      }
    if (box.length < 4) return 1;
    const background = [...colours].reduce((a, b) => b[1] > a[1] ? b : a)[0];
    const [r, g, b] = [background >> 16, background >> 8 & 255, background & 255];
    return box.filter(k => Math.max(Math.abs(data[k] - r), Math.abs(data[k + 1] - g), Math.abs(data[k + 2] - b)) > 64).length / box.length;
  };
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
      const ink = await inkMeter(pdf, page);
      // pdf.js draws nothing in a font the PDF does not embed and it has no
      // substitute for (Calibri, Tahoma): its text cannot be measured, so it counts as seen.
      const drawn = font => !(page.commonObjs.has(font) && page.commonObjs.get(font).missingFile);
      pages.push({ number, width: viewport.width, height: viewport.height,
        items: tc.items.filter(i => i.str?.trim()).map(i => {
          const tr = pdfjs.Util.transform(viewport.transform, i.transform);
          const item = { text: i.str, x: tr[4], y: viewport.height - tr[5], w: i.width, h: i.height };
          // Text under 2pt (sheet names in a footer) is too small to read.
          return i.height < 2 || drawn(i.fontName) && ink(tr[4], tr[5], i.width, i.height) < 0.02 ? { ...item, hidden: true } : item;
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

// The preceding section ends at the next header's top line. KALKIŞ may be the
// middle line of a wrapped header, so a data row can lie within 2.2 lines of it.
function headerTop(items, group) {
  const h = median(group.markers.map(i => i.h)), maxY = Math.max(...group.markers.map(i => i.y));
  const lines = items.filter(i => i.y >= maxY && i.y <= maxY + h * 2.2 && !leadingTime(i.text) && !/^\d+$/.test(i.text));
  return Math.min(group.y + h * 2.2, Math.max(maxY, ...lines.map(i => i.y)) + h * 0.5);
}

// A header cell may wrap below its KALKIŞ line; the header ends at the first
// time row, not at the marker baseline.
function headerColumns(items, group, route, width, floor) {
  const h = median(group.markers.map(i => i.h));
  const minY = Math.min(...group.markers.map(i => i.y));
  const maxY = Math.max(...group.markers.map(i => i.y));
  const candidates = items.filter(i => i.y >= Math.min(minY - h * 0.5, floor) && i.y <= maxY + h * 3 &&
    i.h >= h * 0.55 &&
    !hasTime(i.text) && !/^\d+$/.test(i.text) && !routeHeading(i.text) &&
    i.w < width * 0.3 && !/^(?:BLD|DOSYA|SAYFA)|DONEMI|HAFTA/.test(fold(i.text)) && !directionCaption(i.text) &&
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

// A two-direction table starts at one terminal and its last column returns
// there. When both outer columns name the same terminal around a KALKIŞ
// column, the left one is the unmarked origin and the right one its arrival.
function mirroredOrigin(columns) {
  const first = columns[0], last = columns[columns.length - 1];
  if (columns.length < 3 || first.departure || last.departure || !first.label ||
      /VARIS/.test(fold(first.label)) || !columns.slice(1, -1).some(c => c.departure)) return null;
  return terminalKey(first.label) === terminalKey(last.label.replace(/VARI[ŞS]/giu, '')) ? first : null;
}

function mergeTable(route, table, errors, departing) {
  const cols = table.columns.filter(c => c.departure);
  if (cols.length > 2 || cols.length === 0) { errors.push(`Page ${table.page}: ${route.name} has ${cols.length} departure columns`); return; }
  let assignment;
  if (!route.tables.length) assignment = cols.map((_, i) => i);
  else {
    const known = cols.map(c => route.directions.findIndex(d => d.labels.some(label => matchesTerminal(label, c.label))));
    if (known.some(i => i >= 0)) {
      assignment = known.map((i, j) => i >= 0 ? i : 1 - known[1 - j]);
      // A terminal no earlier table named may start a direction beside the
      // route's own table on the same page (an evening section from an
      // intermediate terminal). On a later page it means another route whose
      // title was lost: refuse to pool its times into a labelled direction.
      const pooled = assignment.find((d, j) => known[j] < 0 && route.directions[d].labels.length);
      if (pooled !== undefined && !route.tables.some(t => t.page === table.page)) {
        errors.push(`Page ${table.page}: ${route.name} departure terminal ${cols[assignment.indexOf(pooled)].label} matches no earlier ${route.name} table`);
        return;
      }
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
    dir.cells.push(...departing[i].cells.map(cell => ({ ...cell, label: col.label, end: departing[i].end })));
  }
  route.tables.push(table);
}

export function parsePages(rawPages) {
  if (rawPages.some(p => !(p.width > 0 && p.height > 0) || p.items.some(i =>
    ![i.x, i.y, i.w, i.h].every(Number.isFinite)))) throw new Error('Invalid PDF text geometry');
  const pages = rawPages.map(preparePage);
  const diagnostics = { pages: [], expectedRoutes: [], parsedRoutes: [], indexOnlyRoutes: [],
    errors: [], warnings: [], ignored: [] };
  for (const page of rawPages) {
    const hidden = page.items.filter(i => i.hidden && leadingTime(i.text)).map(i => clean(i.text));
    if (hidden.length) diagnostics.ignored.push({ page: page.number, reason: `Invisible text is not read: ${hidden.join(', ')}` });
  }
  const pageNumbers = pages.map(page => page.number);
  for (let number = Math.min(...pageNumbers); number < Math.max(...pageNumbers); number++)
    if (!pageNumbers.includes(number)) diagnostics.errors.push(`PDF page ${number} was not extracted`);
  const routes = new Map();
  const legends = [];
  const manifest = new Map();
  const namedManifest = new Set();
  let lastRoute = null;
  for (const page of pages) {
    const { items } = page;
    // A legend may wrap; its verb ("UĞRAMAMAKTADIR", not "UĞRAMAKTADIR")
    // ends its last line, and a line ending in a list separator ("ÇINARLI /")
    // continues on the next. An unreadable sentence about skipped stops would
    // publish village trips as departures from the terminal they skip: fail.
    const lines = textLines(items);
    lines.forEach((line, k) => {
      if (!/UGRAMA(?!K)|UGRAMI/.test(fold(line))) return;
      const continued = n => /(?:[/,&-]|\bVE|\bILE)$/.test(fold(lines[k - n] || ''));
      const legend = [1, 2, 3].map(n => !continued(n) && legendOf(lines.slice(Math.max(0, k + 1 - n), k + 1).join(' '))).find(Boolean);
      if (legend) legends.push(legend);
      else diagnostics.errors.push(`Page ${page.number}: unreadable note about trips that skip a stop: ${line}`);
    });
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
      const bottom = gi + 1 < groups.length ? headerTop(items, groups[gi + 1]) : 0;
      const top = Math.min(...group.markers.map(i => i.y)) - h * 0.5;
      const body = timeItems.filter(i => i.y < top && i.y > bottom);
      const floor = body.length ? Math.max(...body.map(i => i.y)) + h * 0.5 : top;
      const timeX = t => t.x + t.w * Math.min(1, leadingTime(t.text).length / t.text.length) / 2;
      const hasTimes = c => body.some(t => timeX(t) >= c.left && timeX(t) < c.right);
      // A table's columns are its data. A header word left of the first column
      // with times beneath it (a heading qualifier, a margin label) is no stop.
      const dataColumns = cols => {
        while (cols.length > 2 && !cols[0].departure && !hasTimes(cols[0])) {
          cols.shift();
          cols[0].left = cols[0].x - (cols[1].x - cols[0].x) / 2;
        }
        return cols;
      };
      let columns;
      // A route title sits in the header band. A code with time rows between
      // it and this header belongs to the previous section's body, and a code
      // stacked over a vehicle duty ("11-K" / "EKSPRES" / "7.DOSYA") is a label.
      const markerTop = Math.max(...group.markers.map(i => i.y));
      const stack = i => {
        const lines = [];
        for (let line = i; ;) {
          const near = items.filter(s => s.y < line.y - line.h * 0.3 && line.y - s.y <= Math.max(line.h, s.h) * 1.6 &&
            s.x < i.x + i.w && s.x + s.w > i.x);
          if (!near.length) return lines;
          const y = Math.max(...near.map(s => s.y));
          if (timeItems.some(t => Math.abs(t.y - y) < h * 0.6)) return lines;
          line = near.find(s => s.y === y);
          lines.push(...near.filter(s => y - s.y < h * 0.3));
        }
      };
      const nearby = items.filter(i => i.y <= group.y + h * 8 && i.y >= group.y - h * 2 &&
        i.x < firstX - h && routeHeading(i.text) && i.h >= h * 0.55 &&
        !items.some(t => leadingTime(t.text) && Math.abs(t.y - i.y) < h * 0.5) &&
        !timeItems.some(t => t.y < i.y - h * 0.5 && t.y > markerTop + h * 0.5) &&
        !stack(i).some(s => /DOSYA/.test(fold(s.text))));
      nearby.sort((a, b) => Math.abs(a.y - group.y) - Math.abs(b.y - group.y) || a.x - b.x);
      const routeItem = nearby[0];
      let routeCell = routeItem;
      let heading = routeItem && routeHeading(routeItem.text), edge = null;
      if (heading) {
        // The heading cell is the code plus the words that follow it on its
        // line after a word gap, and the lines centred under it (EKSPRES,
        // ESENLER). Joining by the gap and the shared centre, not by distance
        // from the code's left edge, keeps a wider code or subtitle from
        // turning a qualifier into a phantom column or dropping EKSPRES.
        // A word with times beneath it is a column caption, never part of the title.
        const word = i => centre(i) < firstX - h && !hasTime(i.text) && !routeHeading(i.text) &&
          !/\d|DOSYA|BLD|KALKIS|VARIS|HAREKET/.test(fold(i.text)) &&
          !body.some(t => timeX(t) >= i.x && timeX(t) <= i.x + i.w);
        const extra = items.filter(i => i !== routeItem && word(i) && Math.abs(i.x - routeItem.x) < h * 4 &&
          i.y < routeItem.y + h * 0.3 && i.y > routeItem.y - h * 3 &&
          (i.x > routeItem.x + routeItem.w || i.y < routeItem.y - h * 0.4));
        for (let grown = true; grown;) {
          grown = false;
          const cell = [routeItem, ...extra];
          const left = Math.min(...cell.map(i => i.x)), right = Math.max(...cell.map(i => i.x + i.w));
          const lowest = cell.reduce((a, b) => (b.y < a.y ? b : a));
          for (const i of items) {
            if (cell.includes(i) || !word(i)) continue;
            const sameLine = Math.abs(i.y - routeItem.y) < routeItem.h * 0.5 && i.x >= right - 1 && i.x - right < routeItem.h * 3;
            const under = i.y < lowest.y - lowest.h * 0.3 && lowest.y - i.y <= Math.max(lowest.h, i.h) * 1.6 &&
              Math.abs(centre(i) - (left + right) / 2) < Math.max(i.w, right - left) / 2;
            if (sameLine || under) { extra.push(i); grown = true; break; }
          }
        }
        extra.sort((a, b) => Math.abs(a.y - b.y) < Math.min(a.h, b.h) * 0.5 ? a.x - b.x : b.y - a.y);
        heading = routeHeading([heading.name, ...extra.map(i => i.text)].join(' '));
        routeCell = { ...routeItem, w: Math.max(routeItem.x + routeItem.w, ...extra.map(i => i.x + i.w)) - routeItem.x };
        lastRoute = heading;
      } else {
        // A wide terminal caption may start left of its departure marker.
        // Exempt it only when its centre is in the header area AND its name
        // matches a known terminal. Width alone must not hide a new title.
        // A mirrored origin column with this table's times beneath it, not
        // the first KALKIŞ, is the table's left edge.
        const knownTerminals = routes.get(lastRoute?.id)?.directions.flatMap(d => d.labels) || [];
        columns = dataColumns(headerColumns(items, group, null, page.width, floor));
        const mirrored = mirroredOrigin(columns);
        const origin = edge = mirrored && body.some(t => centre(t) >= mirrored.left && centre(t) < mirrored.right) ? mirrored : null;
        const left = origin ? origin.x : firstX;
        // A wide caption over a departure column (or the origin) can start
        // well left of that column's centre. Lying wholly inside the column's
        // span makes it that column's heading; a title starts left of the table,
        // beside the header and never on a time row (a margin label such as
        // "BAHRİYE ÜÇOK CADDESİ" belongs to its trip), and may hold any words.
        const otherTitle = items.find(i => i.x < left - h * 3 && Math.abs(i.y - group.y) < h * 2 &&
          !body.some(t => Math.abs(t.y - i.y) < h) &&
          /[A-Z]{4,}/.test(fold(i.text)) && !hasTime(i.text) && !departure(i.text) && !/BLD|DOSYA/.test(fold(i.text)) &&
          !columns.some(c => (c.departure || c === origin) && i.x >= c.left && i.x + i.w <= c.right) &&
          !(centre(i) >= left - h * 3 && knownTerminals.some(label => matchesTerminal(label, i.text))));
        if (otherTitle) {
          // A title aligned with the page's numbered route heading that names
          // one of this table's own departure terminals heads a separate line
          // without a route number (the Kalabaklı village shuttle). Any other
          // unfamiliar title must never be swallowed into the preceding route.
          if (columns.some(c => c.departure && matchesTerminal(c.label, otherTitle.text)) &&
              items.some(r => r !== otherTitle && routeHeading(r.text) && Math.abs(r.x - otherTitle.x) < h))
            diagnostics.ignored.push({ page: page.number, reason: `Separate ${otherTitle.text} line without a route number; use the source PDF.` });
          else diagnostics.errors.push(`Page ${page.number}: unknown unnumbered table: ${otherTitle.text}`);
          continue;
        }
        heading = lastRoute;
      }
      if (!heading) { diagnostics.errors.push(`Page ${page.number}: departure table has no identifiable route`); continue; }
      // An untitled header repeats a table above it on the same page. On a new
      // page, a missing title is a lost heading, not a continuation: routes
      // that share a terminal (Ç1, Ç3, Ç3 EKSPRES) must not absorb each other.
      if (!routeItem && !report.tables.some(t => t.route === heading.id)) {
        diagnostics.errors.push(`Page ${page.number}: untitled table has no ${heading.id} table above it on this page`);
        continue;
      }
      columns ||= dataColumns(headerColumns(items, group, routeCell, page.width, floor));
      // A round trip ends where it began. Some editions print KALKIŞ over that
      // final arrival: the last column, repeating the terminal of the first
      // column with times beneath it, is the trip's end however it is labelled,
      // and that first column is the trip's origin.
      const first = columns[0], last = columns.at(-1);
      if (columns.length >= 3 && last.departure && columns.filter(c => c.departure).length >= 2 &&
          terminalKey(first.label) === terminalKey(last.label) && hasTimes(first)) {
        last.departure = false;
        first.departure = true;
      }
      if (!routeItem && !columns.some(c => c.departure && routes.get(heading.id)?.directions.some(d =>
        d.labels.some(label => matchesTerminal(label, c.label))))) {
        diagnostics.errors.push(`Page ${page.number}: untitled table cannot be matched to ${heading.id}`);
        continue;
      }
      // A labelled origin may omit KALKIŞ in a two-direction table. Only infer
      // it when the source explicitly labels both trip directions above it: a
      // caption "A - B" over the columns of one direction, with times under
      // them but no KALKIŞ, makes its first column that names A the origin. A
      // caption need not be centred: it covers a column it overlaps by a line.
      if (columns.filter(c => c.departure).length === 1) {
        for (const caption of items.filter(i => i.y > markerTop - h && i.y < markerTop + h * 6 && directionCaption(i.text))) {
          const under = columns.filter(c => Math.min(c.right, caption.x + caption.w) - Math.max(c.left, caption.x) > Math.min(h, (c.right - c.left) / 2));
          if (under.length < 2 || under.some(c => c.departure)) continue;
          const implicit = under.find(c => !/VARIS/.test(fold(c.label)) && matchesTerminal(c.label, directionCaption(caption.text)[1]));
          if (implicit && hasTimes(implicit)) implicit.departure = true;
          // A captioned direction with times but no departure column would be
          // published without that direction. Fail instead.
          else if (under.some(hasTimes))
            diagnostics.errors.push(`Page ${page.number}: ${heading.id} direction ${clean(caption.text)} has no departure column`);
        }
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
          else if (implicit.length > 1)
            diagnostics.errors.push(`Page ${page.number}: ambiguous reciprocal departure origin for ${heading.id}`);
          // The other endpoint's arrival may be labelled by position only:
          // the last column repeats the first column's terminal.
          else if (!arrivals.some(c => !matchesTerminal(arrivalName(c), known.label))) {
            const origin = mirroredOrigin(columns);
            if (origin) origin.departure = true;
          }
        }
      }
      // An untitled continuation repeats the previous section's columns. If
      // that section departed from two columns, and this header's mirrored
      // origin and its single KALKIŞ sit in those same two columns, the origin
      // still departs, even when the repeated header names no VARIŞ at all.
      if (!routeItem && columns.filter(c => c.departure).length === 1) {
        const previous = report.tables.findLast(t => t.route === heading.id);
        const origin = mirroredOrigin(columns), known = columns.find(c => c.departure);
        const under = col => previous.columns.filter(c => c.x >= col.left && c.x < col.right).length === 1;
        if (origin && previous && under(origin) && under(known)) origin.departure = true;
      }
      // Times under a column left of the first departure belong to an origin
      // that no rule confirmed (titled or not). Fail rather than publish the
      // table without that direction.
      const unconfirmed = columns.slice(0, Math.max(0, columns.findIndex(c => c.departure))).find(hasTimes);
      if (unconfirmed) {
        diagnostics.errors.push(`Page ${page.number}: ${heading.id} origin ${unconfirmed.label} is not a confirmed departure`);
        continue;
      }
      // Times after the arrival at the other terminal are a return trip. With
      // no departure column leading it (its KALKIŞ printed VARIŞ), fail rather
      // than publish the table without that direction.
      if (columns.filter(c => c.departure).length === 1) {
        const at = columns.findIndex(c => c.departure);
        const turn = columns.findIndex((c, j) => j > at && /VARIS/.test(fold(c.label)) &&
          !matchesTerminal(fold(c.label).replace(/VARIS/g, '').trim(), columns[at].label));
        if (turn >= 0 && columns.slice(turn + 1).some(hasTimes)) {
          diagnostics.errors.push(`Page ${page.number}: ${heading.id} return trip after ${clean(columns[turn].label)} has no departure column`);
          continue;
        }
      }
      // A turnaround prints its stop twice: the arrival, then the departure.
      // KALKIŞ over the first of the pair (the second printed VARIŞ or
      // unmarked) would publish the arrival times as departures: fail.
      const swapped = columns.find((c, j) => c.departure && columns[j + 1] && !columns[j + 1].departure &&
        hasTimes(columns[j + 1]) && matchesTerminal(stopName(c.label), stopName(columns[j + 1].label)));
      if (swapped) {
        diagnostics.errors.push(`Page ${page.number}: ${heading.id} turnaround at ${stopName(swapped.label)} has KALKIŞ over its arrival`);
        continue;
      }
      // A line between the rows naming this table's stops in two columns is
      // the header of a section whose KALKIŞ was not printed. Its rows would
      // join this table under this header's terminals: fail.
      const rowsTop = Math.max(...body.map(t => t.y)), rowsBottom = Math.min(...body.map(t => t.y));
      const named = items.filter(i => i.y < rowsTop - h * 0.6 && i.y > rowsBottom + h * 0.6 && !hasTime(i.text) &&
        !body.some(t => Math.abs(t.y - i.y) < h * 0.6) && columns.some(c => matchesTerminal(stopName(c.label), i.text)));
      const subheader = named.find(i => new Set(named.filter(j => Math.abs(j.y - i.y) < h * 0.5)
        .map(j => columns.find(c => centre(j) >= c.left && centre(j) < c.right)).filter(Boolean)).size >= 2);
      if (subheader) {
        diagnostics.errors.push(`Page ${page.number}: ${heading.id} has a header without KALKIŞ between its rows: ${
          named.filter(j => Math.abs(j.y - subheader.y) < h * 0.5).sort((a, b) => a.x - b.x).map(j => j.text).join(' | ')}`);
        continue;
      }
      columns.forEach(c => { c.times = []; c.cells = []; });
      const columnOf = i => columns.find(c => timeX(i) >= c.left && timeX(i) < c.right);
      // A time item wider than its column is a merged cell spanning several.
      const banner = i => { const c = columnOf(i); return !c || i.w > c.right - c.left; };
      for (const item of body) {
        const parsed = leadingTime(item.text);
        const col = columnOf(item);
        if (!col?.departure || parsed.annotation) continue;
        const row = items.filter(i => i.x >= col.left && i.x < col.right && Math.abs(i.y - item.y) < h * 0.6).map(i => i.text).join(' ');
        if (note(row)) continue;
        const text = cellText(items, item, h, col, bottom);
        const skip = reason => diagnostics.ignored.push({ page: page.number, reason: `${reason}: ${text}` });
        // A time captioned with another route's code describes that route's
        // trip ("07:30 - JANDARMA IŞIKLARINDAN- Ç960"), not a departure here.
        if (note(text) || namesOtherRoute(text.slice(parsed.length), heading.code)) { skip(`Note is not a ${heading.id} departure`); continue; }
        // A merged cell with no stop times beside it, only other merged cells,
        // is a banner about a trip ("7:30 SSK'dan ÇINARLI", "07:45 SSK-ÇINARLI"),
        // wherever its centred time happens to fall. Any other merged cell may
        // be another trip's note row that lost its route code ("07:00 Kepez
        // meydandan 11-K Esenler", beside stop times) or a departure whose note
        // ran out of its cell: fail rather than guess.
        if (banner(item)) {
          if (describesTrip(text.slice(parsed.length)) && !body.some(i => i !== item && !banner(i) && Math.abs(i.y - item.y) < h * 0.6))
            skip(`Merged note row is not a ${heading.id} departure`);
          else diagnostics.errors.push(`Page ${page.number}: ${heading.id} merged cell is neither a departure nor a trip note: ${text}`);
          continue;
        }
        // A note saying the trip comes from elsewhere is not a departure here.
        if (describesTrip(text.slice(parsed.length))) {
          diagnostics.errors.push(`Page ${page.number}: ${heading.id} departure note describes a trip from elsewhere: ${text}`);
          continue;
        }
        if (!parsed.valid) { diagnostics.errors.push(`Page ${page.number}: invalid departure ${parsed.time} for ${heading.id}`); continue; }
        col.times.push(parsed.time);
        // The trip's later stops are the timed cells of its row up to the
        // section's end: the turnaround's arrival column (VARIŞ, or the same
        // terminal printed before its KALKIŞ), else the next KALKIŞ itself.
        const at = columns.indexOf(col), next = columns.findIndex((c, j) => j > at && c.departure);
        const arrival = next > at + 1 && (/VARIS/.test(fold(columns[next - 1].label)) ||
          matchesTerminal(stopName(columns[next - 1].label), stopName(columns[next].label)));
        const end = next < 0 ? columns.length - 1 : arrival ? next - 1 : next;
        const stops = [];
        for (let j = at + 1; j <= end; j++) {
          const cell = body.find(t => timeX(t) >= columns[j].left && timeX(t) < columns[j].right &&
            Math.abs(t.y - item.y) < h * 0.8 && leadingTime(t.text).valid);
          if (cell && columns[j].label) stops.push([stopName(columns[j].label), leadingTime(cell.text).time]);
        }
        col.end = stopName(columns[end].label);
        col.cells.push({ time: parsed.time, note: annotation(text.slice(parsed.length)), stops,
          reachesEnd: stops.at(-1)?.[0] === col.end });
      }
      const departing = columns.filter(c => c.departure);
      const table = { page: page.number, route: heading.id, headers: columns.map(c => c.label), columns: departing.map(c => ({
        departure: true, label: c.label, times: c.times, x: Math.round(c.x * 100) / 100,
      })) };
      if (!table.columns.some(c => c.times.length)) diagnostics.errors.push(`Page ${page.number}: ${heading.id} table has no departures`);
      if (table.columns.some(c => !c.label)) diagnostics.errors.push(`Page ${page.number}: ${heading.id} departure terminal is missing`);
      report.tables.push(table);
      if (!routes.has(heading.id)) routes.set(heading.id, { ...heading, tables: [], directions: [
        { labels: [], times: new Set(), cells: [] }, { labels: [], times: new Set(), cells: [] },
      ] });
      mergeTable(routes.get(heading.id), table, diagnostics.errors, departing);
    }
  }
  for (const label of namedManifest) {
    const route = [...routes.values()].find(r => fold(r.name).includes(label));
    if (route) manifest.set(route.id, route.name);
    else diagnostics.warnings.push(`Route ${label} is listed in the PDF index but has no timetable table`);
  }
  diagnostics.expectedRoutes = [...manifest.keys()].sort();
  diagnostics.parsedRoutes = [...routes.keys()].sort();
  // The cover may be copied from another edition. Publish every real table
  // that parsed cleanly, while retaining index-only entries as diagnostics.
  for (const id of manifest.keys()) if (!routes.has(id)) {
    diagnostics.indexOnlyRoutes.push(id);
    diagnostics.warnings.push(`Route ${id} is listed in the PDF index but has no timetable table`);
  }
  for (const id of routes.keys()) if (manifest.size && !manifest.has(id))
    diagnostics.warnings.push(`Parsed route ${id} is absent from the PDF index`);
  if (!routes.size) diagnostics.errors.push('No timetable routes were parsed');
  // A legend's terminal also covers a shorter column label for it, when
  // another header joins both ("DARDANOS" is the "DARDANOS YERLEŞKE").
  const headers = diagnostics.pages.flatMap(p => p.tables.flatMap(t => t.headers)).filter(Boolean);
  const skipsTerminal = (label, note) => legends.some(l => l.places.some(p => matchesTerminal(p, note)) &&
    [label, ...headers.filter(H => matchesTerminal(H, label))].some(H => matchesTerminal(H, l.skipped)));
  const result = {};
  for (const route of routes.values()) {
    if (route.directions.some(d => d.labels.length && !d.times.size))
      diagnostics.errors.push(`${route.name}: a departure direction has no times`);
    // The cover gives the complete name when a coloured table heading wraps.
    const name = manifest.get(route.id) || route.name;
    result[name] = { name, ...Object.fromEntries(route.directions.map((d, i) => ['dir' + i, publish(d)])) };
  }
  // A direction lists the departures from its terminal. Trips that start at
  // another terminal (a later section's KALKIŞ, or a village the page legend
  // says skips this terminal) are listed with their stops instead, and when
  // the direction's sections end at different stops every trip names its end,
  // so a rider is never shown a bus where none calls.
  function publish(d) {
    // The direction's terminal is where most of its departures leave from,
    // not whichever section happens to come first.
    const share = new Map();
    for (const cell of d.cells) {
      const key = d.labels.find(l => matchesTerminal(l, cell.label)) ?? cell.label;
      share.set(key, (share.get(key) || 0) + 1);
    }
    const label = [...share].sort((a, b) => b[1] - a[1])[0]?.[0] ?? (d.labels[0] || '');
    const times = new Set(), trips = new Map(), ends = [];
    for (const { end } of d.cells) if (end && !ends.some(e => matchesTerminal(e, end))) ends.push(end);
    for (const cell of d.cells) {
      const village = cell.note && skipsTerminal(cell.label, cell.note) ? cell.note.toLocaleUpperCase('tr') : null;
      const from = village || (!matchesTerminal(cell.label, label) ? stopName(cell.label) : null);
      // A trip from elsewhere that leaves the route ends at its last timed stop.
      const to = from && cell.stops.length && !cell.reachesEnd ? cell.stops.at(-1)[0] : ends.length > 1 ? cell.end : null;
      // A trip cannot end where it starts: another route's table was pooled in.
      if (to && matchesTerminal(to, from || label)) diagnostics.errors.push(`${label}: the ${cell.time} trip ends where it starts`);
      if (!from) times.add(cell.time);
      const trip = { time: cell.time, ...(from && { from, stops: cell.stops }), ...(to && { to }),
        ...(cell.note && !village && { note: cell.note }) };
      if (from || to || trip.note) trips.set(JSON.stringify(trip), trip);
    }
    return { label, times: [...times].sort((a, b) => serialTime(a) - serialTime(b)),
      ...(trips.size && { trips: [...trips.values()].sort((a, b) => serialTime(a.time) - serialTime(b.time)) }) };
  }
  return { routes: result, numPages: pages.length, diagnostics };
}

export async function parsePDF(bytes) { return parsePages(await extractPdf(bytes)); }
