/**
 * Fetches the municipality's PDF timetables and parses them into schedule.json.
 * Runs in GitHub Actions daily at midnight Turkey time.
 */

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';

const __dir  = dirname(fileURLToPath(import.meta.url));
const workerPath = join(__dir, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = 'file://' + workerPath;

const MUN_URL = 'https://ulasim.canakkale.bel.tr/rehber/hatlar-otobus-saatleri/';

// Real network timetables span many pages (one table block per route — the
// live weekday/weekend PDFs are 14–18 pages). One-off shuttle notices like
// "KÜTÜPHANE SEFERLERİ" are tiny 1–2 page PDFs that parse into a route or two
// and pollute the Seferler tabs. Skip PDFs below this page count.
const MIN_PDF_PAGES = 6;

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.text();
}

async function fetchBinary(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.arrayBuffer();
}

// ── PDF URL discovery ─────────────────────────────────────────────────────────

const TR_MONTHS = {
  OCAK:'01', ŞUBAT:'02', SUBAT:'02', MART:'03', NİSAN:'04', NISAN:'04',
  MAYIS:'05', HAZİRAN:'06', HAZIRAN:'06', TEMMUZ:'07', AĞUSTOS:'08', AGUSTOS:'08',
  EYLÜL:'09', EYLUL:'09', EKİM:'10', EKIM:'10', KASIM:'11', ARALIK:'12',
};
const MONTH_ALT = Object.keys(TR_MONTHS).join('|');

// Parse all date markers out of an uppercased blob (link text + normalised
// URL basename — many municipality URLs encode the date but the visible text
// doesn't, e.g. "KURBAN BAYRAMI" linking to "27-28-29-30-MAYIS-BAYRAM-1.pdf").
// Returns Set<'MM-DD'> of every day mentioned. Supports:
//   "26 MAYIS"                 → {05-26}
//   "27-28-29 MAYIS"           → {05-27, 05-28, 05-29}
//   "27 28 29 30 MAYIS"        → {05-27..05-30}  (URL hyphens normalised to spaces)
//   "27, 28, 29 MAYIS"         → {05-27, 05-28, 05-29}
//   "27 MAYIS - 29 MAYIS"      → {05-27, 05-28, 05-29}
function parseDateSet(text) {
  const out = new Set();
  // Form: "DD MONTH - DD MONTH" (range with the month repeated on both sides).
  for (const m of text.matchAll(new RegExp(`(\\d{1,2})\\s+(${MONTH_ALT})\\s*[-–]\\s*(\\d{1,2})\\s+(${MONTH_ALT})`, 'g'))) {
    const m1 = TR_MONTHS[m[2]], m2 = TR_MONTHS[m[4]];
    if (m1 !== m2) continue; // cross-month ranges are rare; skip
    const a = parseInt(m[1], 10), b = parseInt(m[3], 10);
    for (let d = Math.min(a,b); d <= Math.max(a,b); d++) out.add(`${m1}-${String(d).padStart(2,'0')}`);
  }
  // Form: "DD[-DD[-DD…]] MONTH" — list/range of days + trailing month.
  // Separator can be hyphen, en-dash, comma, or whitespace (URLs use hyphens,
  // text uses commas or hyphens, normalised URLs use spaces).
  for (const m of text.matchAll(new RegExp(`((?:\\d{1,2}[\\s\\-–,]+)+\\d{1,2})\\s+(${MONTH_ALT})`, 'g'))) {
    const mm = TR_MONTHS[m[2]];
    const days = m[1].split(/[\s\-–,]+/).map(s => parseInt(s, 10)).filter(Number.isFinite);
    if (days.length >= 2) {
      // No comma → treat as a contiguous range; comma present → discrete days.
      if (!/,/.test(m[1])) {
        for (let d = Math.min(...days); d <= Math.max(...days); d++) out.add(`${mm}-${String(d).padStart(2,'0')}`);
      } else {
        for (const d of days) out.add(`${mm}-${String(d).padStart(2,'0')}`);
      }
    }
  }
  // Form: single "DD MONTH" (anything not already consumed by the iterators above).
  for (const m of text.matchAll(new RegExp(`(\\d{1,2})\\s+(${MONTH_ALT})`, 'g'))) {
    const mm = TR_MONTHS[m[2]];
    out.add(`${mm}-${String(parseInt(m[1],10)).padStart(2,'0')}`);
  }
  return out;
}

function classifyLink(text) {
  // Mezarlık (graveyard) services are a parallel network, never a substitute
  // for the daily schedule — ignore entirely.
  if (/MEZARL/.test(text)) return 'ignore';
  // "X İTİBARİYLE HAFTA …" / "X ITIBARIYLE HAFTA …" — schedule effective from
  // a given date onwards. Resolved later against today's date.
  if (/[İI]T[İI]BAR[İI]YLE/.test(text)) {
    if (/HAFTA\s*SONU/.test(text)) return 'effective-weekend';
    if (/HAFTA\s*[İI]?[ÇC]?[İI]?/.test(text)) return 'effective-weekday';
    return 'ignore';
  }
  if (/^HAFTA\s*SONU/.test(text)) return 'weekend';
  if (/^HAFTA\s*[İI]?[ÇC]?[İI]?/.test(text)) return 'weekday';
  if (/BAYRAM|AREFE/.test(text) || /^\s*\d/.test(text)) return 'special';
  return 'unknown';
}

function specialPriority(text) {
  if (/AREFE/.test(text))  return 0;
  if (/BAYRAM/.test(text)) return 1;
  return 2;
}

function minDate(set) {
  let min = null;
  for (const d of set) if (min === null || d < min) min = d;
  return min;
}

// today: {ymd: 'YYYY-MM-DD', mmdd: 'MM-DD', year: 2026, isWeekend: boolean}
function todayInTurkey(overrideYmd) {
  let y, m, d;
  if (overrideYmd) {
    [y, m, d] = overrideYmd.split('-').map(Number);
  } else {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const get = k => parts.find(p => p.type === k).value;
    y = +get('year'); m = +get('month'); d = +get('day');
  }
  // Day-of-week independent of host TZ: use UTC noon of that date.
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // 0=Sun..6=Sat
  return {
    ymd:  `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`,
    mmdd: `${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`,
    year: y,
    isWeekend: dow === 0 || dow === 6,
  };
}

// Title-case a Turkish string respecting Turkish locale rules (İ vs I, etc.)
function titleCaseTr(s) {
  return s.split(/\s+/).filter(Boolean).map(w =>
    w.charAt(0).toLocaleUpperCase('tr') + w.slice(1).toLocaleLowerCase('tr')
  ).join(' ');
}

// Build the tab label directly from the municipality link text — strip the
// boilerplate suffixes the page appends to every PDF name and title-case the
// rest. Keeps labels in sync with whatever the municipality publishes without
// hardcoding any keyword-specific phrasing.
function labelFor(link) {
  let t = link.text
    // Drop the "GÜNÜ TOPLU TAŞIMA SEFER SAATLERİ" / "TOPLU TAŞIMA SEFER
    // SAATLERİ" / "SEFER SAATLERİ" trailers in any combination.
    .replace(/\s*(?:GÜN[UÜ]\s+)?(?:TOPLU\s+TA[ŞS]IMA\s+)?SEFER\s+SAATLER[İI]\s*$/u, '')
    .trim();
  if (!t) t = link.text;
  return titleCaseTr(t);
}

function idFor(link) {
  const first = minDate(link.dates);
  if (link.kind === 'weekday') return 'weekday';
  if (link.kind === 'weekend') return 'weekend';
  if (link.kind === 'effective-weekend') return `effective-weekend-${first || 'x'}`;
  if (link.kind === 'effective-weekday') return `effective-weekday-${first || 'x'}`;
  if (/AREFE/.test(link.text))  return `arefe-${first || 'x'}`;
  if (/BAYRAM/.test(link.text)) return `bayram-${first || 'x'}`;
  return `special-${first || link.url.split('/').pop().replace(/\.pdf$/i,'')}`;
}

async function getPdfLinks() {
  const html = await fetchText(MUN_URL);
  const links = [];
  for (const m of html.matchAll(/<a[^>]*href="([^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, '').replace(/&#8217;/g, "'").trim().toUpperCase();
    const url  = href.startsWith('http') ? href
      : 'https://ulasim.canakkale.bel.tr' + (href.startsWith('/') ? '' : '/') + href;
    // URL basename (without extension), hyphens turned into spaces, uppercased.
    // Many links carry the date only in the filename, e.g. KURBAN BAYRAMI →
    // 27-28-29-30-MAYIS-BAYRAM-1.pdf. Feed both to the date parser.
    const base = decodeURIComponent(url.split('/').pop() || '')
      .replace(/\.pdf$/i, '').replace(/[-_]/g, ' ').toUpperCase();
    const yearMatch = (text + ' ' + base).match(/\b(20\d{2})\b/);
    const dates = parseDateSet(text + ' ' + base);
    const kind = classifyLink(text);
    const link = {
      url, text, base, kind, dates, year: yearMatch ? parseInt(yearMatch[1], 10) : null,
    };
    link.id    = idFor(link);
    link.label = labelFor(link);
    link.effectiveFrom = kind.startsWith('effective-') ? minDate(dates) : null;
    links.push(link);
  }
  if (!links.length) throw new Error('No PDF links found on municipality page');
  return links;
}

function sortSchedules(a, b) {
  const order = { weekday: 0, weekend: 1, special: 2, 'effective-weekday': 3, 'effective-weekend': 4 };
  const oa = order[a.kind] ?? 9, ob = order[b.kind] ?? 9;
  if (oa !== ob) return oa - ob;
  const sa = minDate(new Set(a.dates)) || '99-99';
  const sb = minDate(new Set(b.dates)) || '99-99';
  return sa.localeCompare(sb);
}

// ── PDF parser (ported from index.html) ──────────────────────────────────────

async function parsePDF(buffer) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer), disableFontFace: true }).promise;
  if (pdf.numPages < MIN_PDF_PAGES) return { routes: {}, numPages: pdf.numPages, skipped: true };
  const routeMap = {};
  const ROUTE_RE  = /^(Ç\d+[A-ZÇŞĞÜÖİ]*|ÇT\d+|\d+[ÇGK]|960)/;
  const TIME_RE   = /^\d{2}:\d{2}$/;
  const DEPART_RE = /^(KALKIŞ|.*\sKALKIŞ|HAREKET|.*\sHAREKET)$/i;
  const KEYWORD_RE= /KALKIŞ|HAREKET|VARIŞ/i;
  // A departure-column marker is a bare "… KALKIŞ/HAREKET" header. Notes like
  // "07:40 - SSK HAREKET" also match DEPART_RE but carry a TIME — they're per-trip
  // annotations, not columns. Treating them as columns invents a fake departure
  // column that shifts the dir0/dir1 split and leaks intermediate-stop columns
  // into the times (e.g. Ç11K EKSPRES showing 77 times). Exclude time-bearing ones.
  const isDeptCol = it => DEPART_RE.test(it.text) && !/\d{1,2}:\d{2}/.test(it.text);
  // Footnote / annotation words that never appear in real route names. Lines
  // like "Ç1 OLARAK BAŞLAYACAKTIR" (will start as Ç1) match ROUTE_RE but are
  // notes, not routes; if we accept them they steal times from the route above.
  const NOT_A_ROUTE = /\b(OLARAK|BAŞLAYACAK|DEVAM\s*EDECEK|EDECEKTIR|YAPILACAK|GEÇERL[İI]|İPTAL|YOK|TATİL|GÜZERGAH)\b/i;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const tc   = await page.getTextContent();

    const allItems = [];
    for (const item of tc.items) {
      const s = item.str.trim();
      if (s) allItems.push({ x: item.transform[4], y: item.transform[5], text: s });
    }

    const yBuckets = new Map();
    for (const it of allItems) {
      const y = Math.round(it.y / 5) * 5;
      if (!yBuckets.has(y)) yBuckets.set(y, []);
      yBuckets.get(y).push(it);
    }
    const rows = [...yBuckets.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([y, items]) => ({ y, items: items.sort((a, b) => a.x - b.x) }));

    // Find all route headers on this page (dedup by code, validate with dept markers)
    const routeHeaders = [];
    const seenCodes   = new Set();
    for (const { y, items } of rows) {
      const text = items.map(i => i.text).join(' ');
      if (!ROUTE_RE.test(text)) continue;
      if (NOT_A_ROUTE.test(text)) continue;
      const code = text.split(/\s+/)[0];
      if (seenCodes.has(code)) continue;
      const hasDept  = allItems.some(it => DEPART_RE.test(it.text) && Math.abs(it.y - y) <= 150);
      if (!hasDept) continue;
      const hasDosya = allItems.some(it => /DOSYA/i.test(it.text) && it.y < y && it.y > y - 30);
      if (hasDosya) continue;
      seenCodes.add(code);
      routeHeaders.push({ y, firstWord: code });
    }
    if (!routeHeaders.length) continue;

    for (let ri = 0; ri < routeHeaders.length; ri++) {
      const headerY    = routeHeaders[ri].y;
      const routeCode  = routeHeaders[ri].firstWord;
      const bandBottom = ri + 1 < routeHeaders.length ? routeHeaders[ri + 1].y : 0;
      const band       = allItems.filter(it => it.y <= headerY + 15 && it.y > bandBottom);

      // Route name
      const routeItem = band
        .filter(i => Math.abs(i.y - headerY) <= 8 && ROUTE_RE.test(i.text))
        .sort((a, b) => a.x - b.x)[0];
      const riX   = routeItem?.x ?? 80;
      const line2 = band
        .filter(i => Math.abs(i.x - riX) < 30 &&
                     i.y < headerY - 2 && i.y > headerY - 22 &&
                     !TIME_RE.test(i.text) && !ROUTE_RE.test(i.text) &&
                     !/KALKIŞ|VARIŞ|HAREKET|DÖNÜŞ|GİDİŞ|DURAK|DURAĞ/i.test(i.text))
        .sort((a, b) => b.y - a.y).map(i => i.text.trim()).filter(Boolean);
      const routeName = [(routeItem?.text || routeCode), ...line2].join(' ').trim();
      const mapKey    = routeName.split(/\s+/).slice(0, 3).join(' ');

      // Departure markers
      let deptItems = band
        .filter(it => isDeptCol(it) && Math.abs(it.y - headerY) <= 150)
        .sort((a, b) => a.x - b.x);
      const deduped = [];
      for (const d of deptItems) {
        if (!deduped.some(e => Math.abs(e.x - d.x) < 20)) deduped.push(d);
      }
      deptItems = deduped;
      if (deptItems.length < 2) {
        const fb = band.filter(it => isDeptCol(it)).sort((a, b) => a.x - b.x);
        const fb2 = [];
        for (const d of fb) {
          if (!fb2.some(e => Math.abs(e.x - d.x) < 20)) fb2.push(d);
        }
        if (fb2.length >= 2) deptItems = fb2;
        else if (fb2.length === 1 && deptItems.length === 0) deptItems = fb2;
      }

      function deptLabel(kItem) {
        const selfPart = kItem.text.replace(/\s*(KALKIŞ|HAREKET)\s*$/i, '').trim();
        const above = band
          .filter(i => Math.abs(i.x - kItem.x) < 30 && i.y > kItem.y &&
                       Math.abs(i.y - headerY) <= 120 &&
                       !KEYWORD_RE.test(i.text) && !TIME_RE.test(i.text))
          .sort((a, b) => b.y - a.y);
        const sp = TIME_RE.test(selfPart) ? '' : selfPart;
        let label = [...above.map(i => i.text.trim()), sp].filter(Boolean).join(' ');
        // Bare "KALKIŞ" marker whose terminal name sits as a separate item to its
        // LEFT on the same row (weekend Ç9: "OTOGAR" @x179 … "KALKIŞ" @x224, vs
        // weekday's combined "OTOGAR KALKIŞ" item). Without this the direction
        // parses its times but has no label, breaking direction matching + the
        // Seferler header. Only fills an otherwise-empty label, never overwrites.
        if (!label) {
          const sameRowLeft = band
            .filter(i => Math.abs(i.y - kItem.y) <= 4 && i.x < kItem.x && i.x > kItem.x - 80 &&
                         !KEYWORD_RE.test(i.text) && !TIME_RE.test(i.text) && !ROUTE_RE.test(i.text))
            .sort((a, b) => b.x - a.x);
          if (sameRowLeft.length) label = sameRowLeft[0].text.trim();
        }
        return label;
      }

      // Snap each KALKIŞ marker to the x where its HH:MM values actually stack.
      // A combined header item ("GÜZELYALI KALKIŞ") has its left edge a few pt
      // off from the time column beneath it (weekend Ç11G: header x128 vs times
      // x149), which the tight ±20 tolerance below would otherwise miss entirely
      // — leaving that whole direction empty. Columns sit ≥50pt apart, so the
      // nearest dense time-cluster within 28pt of a marker is unambiguously that
      // marker's own column; snapping to it keeps the tolerance tight and honest.
      const timeXs = band.filter(it => /^\d{1,2}:\d{2}\b/.test(it.text)).map(it => it.x);
      const snapCol = x => {
        const near = timeXs.filter(tx => Math.abs(tx - x) <= 28).sort((a, b) => a - b);
        return near.length ? near[Math.floor(near.length / 2)] : x;
      };
      const deptColXs = deptItems.map(d => snapCol(d.x));

      let splitX = null, dir0Lbl = '', dir1Lbl = '';
      if (deptItems.length >= 2) {
        splitX  = (deptColXs[0] + deptColXs[1]) / 2;
        dir0Lbl = deptLabel(deptItems[0]);
        dir1Lbl = deptLabel(deptItems[1]);
      } else if (deptItems.length === 1) {
        dir0Lbl = deptLabel(deptItems[0]);
      }

      // Assign times by column: each deptItem defines a departure column.
      // Only include times whose X falls within 20pt of a departure-column X.
      // This is column-based matching, not fuzzy radius — VARIŞ/intermediate
      // columns are naturally excluded because they have no KALKIŞ marker. The
      // filter applies whenever ≥1 column was found (not only ≥2): a single-
      // terminal loop like Ç5 has one KALKIŞ column (NUSRAT YURDU) sharing the
      // band with EĞİTİM FAKÜLTESİ pass-through and NUSRAT YURDU VARIŞ columns;
      // without the filter those arrival/pass-through times leak in as fake
      // departures (Ç5 showed 18 "departures" when only 7 are real).
      //
      // A departure time can be glued to a route-variant annotation inside one
      // text item — "12:45 -" / "07:45- iskele" / "16:55-Kalabaklı hareket" —
      // because the "- Çınarlı/iskele/…" suffix is printed right after the time
      // and shifts it a few pt left of the column. Match a LEADING HH:MM (not the
      // whole item) so these variant departures aren't dropped, while the column-
      // proximity gate still excludes genuine notes parked away from any column
      // ("07:40 - SSK HAREKET" at its own annotation X).
      const dir0 = new Set(), dir1 = new Set();
      for (const it of band) {
        const tm = it.text.match(/^(\d{1,2}:\d{2})\b/);
        if (!tm) continue;
        if (deptColXs.length && !deptColXs.some(cx => Math.abs(cx - it.x) <= 20)) continue;
        const time = tm[1].length === 4 ? '0' + tm[1] : tm[1];
        (splitX !== null && it.x >= splitX ? dir1 : dir0).add(time);
      }

      if (!routeMap[mapKey])
        routeMap[mapKey] = { name: routeName,
          dir0: { label: '', times: new Set() },
          dir1: { label: '', times: new Set() } };
      const entry = routeMap[mapKey];
      if (!entry.dir0.label) entry.dir0.label = dir0Lbl;
      if (!entry.dir1.label) entry.dir1.label = dir1Lbl;
      for (const t of dir0) entry.dir0.times.add(t);
      for (const t of dir1) entry.dir1.times.add(t);
    }
  }

  // Serialise — sort times chronologically
  const toM = t => { const [h, mn] = t.split(':').map(Number); return (h < 4 ? h*60+1440 : h*60) + mn; };
  const result = {};
  for (const [, { name, dir0, dir1 }] of Object.entries(routeMap)) {
    if (/ÖĞRENCİ|öğrenci|\bOGR\b|\bDOSYA\b/i.test(name)) continue; // also drop dosya-label false positives
    result[name.split(/\s+/).slice(0, 3).join(' ')] = {
      name,
      dir0: { label: dir0.label, times: [...dir0.times].sort((a, b) => toM(a) - toM(b)) },
      dir1: { label: dir1.label, times: [...dir1.times].sort((a, b) => toM(a) - toM(b)) },
    };
  }
  return { routes: result, numPages: pdf.numPages, skipped: false };
}

// ── Parse validation / drift guard ───────────────────────────────────────────
// The municipality occasionally restructures a PDF; when that happens the parser
// can silently yield empty/partial schedules. Without a guard, writeFileSync
// would overwrite the last-good schedule.json with garbage and ship it to users.
// These checks fail the run (exit 1) on a material regression so the last good
// committed data is kept and the Actions run goes red instead.
const MIN_REGULAR_ROUTES = 8;   // weekday/weekend PDFs serve far more than this
const MIN_REGULAR_TIMES  = 40;  // …and far more departure times
const DRIFT_DROP_RATIO   = 0.5; // new < 50% of last run's route count = drift
const REGULAR_KINDS = new Set(['weekday', 'weekend', 'effective-weekday', 'effective-weekend']);

function scheduleStats(s) {
  const routes = Object.values(s.routes || {});
  let totalTimes = 0, emptyRoutes = 0, badTimes = 0;
  for (const r of routes) {
    const n = (r.dir0?.times?.length || 0) + (r.dir1?.times?.length || 0);
    totalTimes += n;
    if (n === 0) emptyRoutes++;
    for (const dir of ['dir0', 'dir1']) for (const t of r[dir]?.times || [])
      if (!/^\d{1,2}:\d{2}$/.test(t)) badTimes++;
  }
  return { routeCount: routes.length, totalTimes, emptyRoutes, badTimes };
}

// Returns { fatal: string[], warn: string[] }. `links` are the filtered schedule
// links advertised on the page; `prev` is the previous schedule.json (or null).
function validateOutput(schedules, links, prev, quiet) {
  const fatal = [], warn = [];
  // (1) Every regular schedule the page advertised must have produced data.
  const builtIds = new Set(schedules.map(s => s.id));
  for (const l of links)
    if (REGULAR_KINDS.has(l.kind) && !builtIds.has(l.id))
      fatal.push(`regular schedule "${l.id}" (${l.label}) advertised but produced no data`);

  // (2) Per-schedule sanity + drift vs the previous run (matched by id).
  const prevById = new Map((prev?.schedules || []).map(s => [s.id, s]));
  for (const s of schedules) {
    const st = scheduleStats(s);
    const tag = `[${s.kind}] ${s.id}`;
    if (!quiet) console.log(`  ${tag}: ${st.routeCount} routes, ${st.totalTimes} times` + (st.emptyRoutes ? `, ${st.emptyRoutes} empty` : ''));
    if (st.badTimes) fatal.push(`${tag}: ${st.badTimes} malformed time value(s)`);
    if (REGULAR_KINDS.has(s.kind)) {
      if (st.routeCount < MIN_REGULAR_ROUTES) fatal.push(`${tag}: only ${st.routeCount} routes (expected ≥ ${MIN_REGULAR_ROUTES})`);
      if (st.totalTimes < MIN_REGULAR_TIMES)  fatal.push(`${tag}: only ${st.totalTimes} departure times (expected ≥ ${MIN_REGULAR_TIMES})`);
    } else if (st.routeCount === 0) {
      fatal.push(`${tag}: parsed 0 routes`);
    }
    if (st.routeCount && st.emptyRoutes / st.routeCount > 0.4)
      warn.push(`${tag}: ${st.emptyRoutes}/${st.routeCount} routes have no times (column matching may be off)`);
    const p = prevById.get(s.id);
    if (p) {
      const pc = scheduleStats(p).routeCount;
      if (pc > 0 && st.routeCount < pc * DRIFT_DROP_RATIO)
        fatal.push(`${tag}: route count dropped ${pc} → ${st.routeCount} vs last run (possible PDF format drift)`);
    }
  }
  return { fatal, warn };
}

// ── Self-test (no network/PDF): node scripts/fetch-schedule.mjs --self-test ──
function selfTest() {
  let pass = 0, fail = 0;
  const ck = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n); } };
  const route = (t0, t1) => ({ name: 'X', dir0: { label: '', times: t0 }, dir1: { label: '', times: t1 } });
  const manyRoutes = n => Object.fromEntries(Array.from({ length: n }, (_, i) => ['R' + i, route(['08:00','09:00','10:00','11:00','12:00','13:00'], ['08:30'])]));
  const mk = (kind, routes) => ({ id: kind, kind, label: kind, routes });
  const v = (s, l, p) => validateOutput(s, l, p, true);
  const wlink = [{ kind: 'weekday', id: 'weekday', label: 'w' }];

  ck('healthy weekday → no fatal',        v([mk('weekday', manyRoutes(12))], wlink, null).fatal.length === 0);
  ck('thin weekday (few routes) → fatal', v([mk('weekday', manyRoutes(3))],  wlink, null).fatal.length > 0);
  ck('advertised regular missing → fatal',v([], wlink, null).fatal.some(f => /produced no data/.test(f)));
  ck('route-count drop vs prev → drift',  v([mk('weekday', manyRoutes(8))], wlink, { schedules: [mk('weekday', manyRoutes(20))] }).fatal.some(f => /drift/.test(f)));
  ck('malformed time → fatal',            v([mk('weekday', { ...manyRoutes(12), BAD: route(['8:0am'], []) })], wlink, null).fatal.some(f => /malformed/.test(f)));
  ck('small special schedule → ok',       v([mk('special', manyRoutes(2))], [{ kind: 'special', id: 'special', label: 's' }], null).fatal.length === 0);
  ck('empty special → fatal',             v([mk('special', {})], [{ kind: 'special', id: 'special', label: 's' }], null).fatal.length > 0);
  ck('many empty routes → warn',          v([mk('weekday', { ...manyRoutes(8), E1: route([], []), E2: route([], []), E3: route([], []), E4: route([], []), E5: route([], []), E6: route([], []) })], wlink, null).warn.length > 0);

  console.log(`self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  console.log('Fetching PDF URLs…');
  const all = await getPdfLinks();
  const links = all.filter(l => l.kind !== 'ignore' && l.kind !== 'unknown')
                   .sort(sortSchedules);
  console.log(`Found ${all.length} link(s), ${links.length} usable schedule(s) after filtering:`);
  for (const l of links) {
    console.log(`  [${l.kind}] ${l.id}  "${l.label}"  dates={${[...l.dates].join(',')}}  ${l.url}`);
  }

  // Previous run's output — used for both fast-skip and the drift guard.
  let prev = null;
  try { prev = JSON.parse(readFileSync('data/schedule.json', 'utf8')); } catch {}

  // Fast-skip: if the sorted URL list matches the previous run, nothing changed.
  // Compare against both the schedules we kept AND the small PDFs we skipped, so
  // a page-skipped PDF (e.g. the library shuttle) doesn't force a re-parse forever.
  const urlList = links.map(l => l.url).sort();
  if (prev) {
    const prevUrls = [...(prev.schedules || []).map(s => s.url), ...(prev.skippedUrls || [])].sort();
    if (prevUrls.length === urlList.length && prevUrls.every((u, i) => u === urlList[i])) {
      console.log('PDF URL list unchanged since last run — skipping parse.');
      return;
    }
  }

  console.log('Downloading & parsing each PDF…');
  const schedules = [];
  const skippedUrls = [];
  for (const link of links) {
    console.log(`  → ${link.label} (${link.id})`);
    try {
      const buf = await fetchBinary(link.url);
      const { routes, numPages, skipped } = await parsePDF(buf);
      if (skipped) {
        console.log(`    skipped: only ${numPages} page(s) (< ${MIN_PDF_PAGES}) — likely a special shuttle notice, not a network timetable`);
        skippedUrls.push(link.url);
        continue;
      }
      console.log(`    parsed ${Object.keys(routes).length} routes`);
      schedules.push({
        id: link.id, label: link.label, kind: link.kind,
        dates: [...link.dates], year: link.year, effectiveFrom: link.effectiveFrom,
        url: link.url, routes,
      });
    } catch (e) {
      console.warn(`    skipped: ${e.message}`);
    }
  }

  // ── Validate before overwriting the last-good data ──────────────────────────
  console.log('Validating parsed output…');
  const { fatal, warn } = validateOutput(schedules, links, prev);
  for (const w of warn) console.warn('  ⚠ ' + w);
  if (fatal.length) {
    console.error('\n❌ Validation failed — keeping the last good schedule.json:');
    for (const f of fatal) console.error('   • ' + f);
    if (!process.argv.includes('--force')) {
      console.error('\n   The municipality PDF layout likely changed. Inspect the parse, fix it,');
      console.error('   or re-run with --force if this reduction is genuinely correct.');
      process.exit(1);
    }
    console.warn('⚠ --force given: writing despite validation failures.');
  }

  // Fetch kentkart route list for colors (used by Seferler tab badges)
  console.log('Fetching kentkart route colors…');
  let routes = [];
  try {
    const kr = await fetch('https://service.kentkart.com/rl1/web/nearest/find?region=007&lang=tr&authType=4&resultType=111');
    const kd = await kr.json();
    routes = kd.routeList || [];
    console.log(`  → ${routes.length} routes`);
  } catch (e) { console.warn('  kentkart fetch failed:', e.message); }

  const out = { schedules, routes, fetchedAt: Date.now() };
  if (skippedUrls.length) out.skippedUrls = skippedUrls; // remembered so fast-skip stays accurate
  writeFileSync('data/schedule.json', JSON.stringify(out));
  console.log(`✅ schedule.json written (${schedules.length} schedules${skippedUrls.length ? `, ${skippedUrls.length} skipped` : ''})`);
}

main().catch(e => { console.error(e); process.exit(1); });
