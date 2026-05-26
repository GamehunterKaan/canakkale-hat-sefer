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

async function getPDFUrls(today) {
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
    links.push({
      url, text, base,
      kind:  classifyLink(text),
      dates: parseDateSet(text + ' ' + base),
      year:  yearMatch ? parseInt(yearMatch[1], 10) : null,
    });
  }
  if (!links.length) throw new Error('No PDF links found on municipality page');

  // Regular slots (first match wins)
  let wdUrl = links.find(l => l.kind === 'weekday')?.url || null;
  let weUrl = links.find(l => l.kind === 'weekend')?.url || null;

  // Effective-from overrides: "31 MAYIS İTİBARİYLE HAFTA SONU" replaces the
  // regular weekend slot on/after May 31. Pick the most recent effective date
  // that is still <= today, in case the page lists several future cutovers.
  const applyEffective = (kind, slotSetter) => {
    const candidates = links
      .filter(l => l.kind === kind)
      .filter(l => l.year === null || l.year === today.year)
      .map(l => ({ link: l, start: minDate(l.dates) }))
      .filter(c => c.start && c.start <= today.mmdd)
      .sort((a, b) => b.start.localeCompare(a.start));
    if (candidates.length) {
      const w = candidates[0];
      console.log(`Effective-from override: "${w.link.text}" (start=${w.start}) replaces ${kind === 'effective-weekend' ? 'weekend' : 'weekday'}.`);
      slotSetter(w.link.url);
    }
  };
  applyEffective('effective-weekend', u => { weUrl = u; });
  applyEffective('effective-weekday', u => { wdUrl = u; });

  // Today-matching specials (Arefe / Bayram / dated one-offs)
  const matchingSpecials = links
    .filter(l => l.kind === 'special')
    .filter(l => l.year === null || l.year === today.year)
    .filter(l => l.dates.has(today.mmdd))
    .sort((a, b) => {
      const pa = specialPriority(a.text), pb = specialPriority(b.text);
      if (pa !== pb) return pa - pb;
      // Single-date match beats a range that contains today.
      return a.dates.size - b.dates.size;
    });

  console.log(`Today (Europe/Istanbul): ${today.ymd} (${today.isWeekend ? 'weekend' : 'weekday'})`);
  console.log(`Found ${links.length} PDF links — ${matchingSpecials.length} special(s) match today`);
  for (const s of matchingSpecials) {
    console.log(`  match: "${s.text}" (dates=${[...s.dates].join(',')}, year=${s.year ?? 'n/a'})`);
  }

  if (matchingSpecials.length) {
    const winner = matchingSpecials[0];
    if (today.isWeekend) {
      console.log(`Substituting "${winner.text}" for weekend schedule.`);
      weUrl = winner.url;
    } else {
      console.log(`Substituting "${winner.text}" for weekday schedule.`);
      wdUrl = winner.url;
    }
  }

  // Final fallback if the page somehow had no regular weekly PDF
  if (!wdUrl) wdUrl = links.find(l => l.kind !== 'special' && l.kind !== 'ignore')?.url || links[0].url;
  if (!weUrl) weUrl = links.filter(l => l.kind !== 'special' && l.kind !== 'ignore').slice(-1)[0]?.url || null;

  console.log('Weekday PDF:', wdUrl);
  console.log('Weekend PDF:', weUrl);
  return { wdUrl, weUrl };
}

// ── PDF parser (ported from index.html) ──────────────────────────────────────

async function parsePDF(buffer) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer), disableFontFace: true }).promise;
  const routeMap = {};
  const ROUTE_RE  = /^(Ç\d+[A-ZÇŞĞÜÖİ]*|ÇT\d+|\d+[ÇGK]|960)/;
  const TIME_RE   = /^\d{2}:\d{2}$/;
  const DEPART_RE = /^(KALKIŞ|.*\sKALKIŞ|HAREKET|.*\sHAREKET)$/i;
  const KEYWORD_RE= /KALKIŞ|HAREKET|VARIŞ/i;
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
        .filter(it => DEPART_RE.test(it.text) && Math.abs(it.y - headerY) <= 150)
        .sort((a, b) => a.x - b.x);
      const deduped = [];
      for (const d of deptItems) {
        if (!deduped.some(e => Math.abs(e.x - d.x) < 20)) deduped.push(d);
      }
      deptItems = deduped;
      if (deptItems.length < 2) {
        const fb = band.filter(it => DEPART_RE.test(it.text)).sort((a, b) => a.x - b.x);
        const fb2 = [];
        for (const d of fb) {
          if (!fb2.some(e => Math.abs(e.x - d.x) < 20)) fb2.push(d);
        }
        if (fb2.length >= 2) deptItems = fb2;
        else if (fb2.length === 1 && deptItems.length === 0) deptItems = fb2;
      }

      function labelFor(kItem) {
        const selfPart = kItem.text.replace(/\s*(KALKIŞ|HAREKET)\s*$/i, '').trim();
        const above = band
          .filter(i => Math.abs(i.x - kItem.x) < 30 && i.y > kItem.y &&
                       Math.abs(i.y - headerY) <= 120 &&
                       !KEYWORD_RE.test(i.text) && !TIME_RE.test(i.text))
          .sort((a, b) => b.y - a.y);
        const sp = TIME_RE.test(selfPart) ? '' : selfPart;
        return [...above.map(i => i.text.trim()), sp].filter(Boolean).join(' ');
      }

      let splitX = null, dir0Lbl = '', dir1Lbl = '';
      if (deptItems.length >= 2) {
        splitX  = (deptItems[0].x + deptItems[1].x) / 2;
        dir0Lbl = labelFor(deptItems[0]);
        dir1Lbl = labelFor(deptItems[1]);
      } else if (deptItems.length === 1) {
        dir0Lbl = labelFor(deptItems[0]);
      }

      // Assign times by column: each deptItem defines a departure column.
      // Only include times whose X falls within 20pt of a departure-column X.
      // This is column-based matching, not fuzzy radius — VARIŞ/intermediate
      // columns are naturally excluded because they have no KALKIŞ marker.
      const deptColXs = deptItems.map(d => d.x);
      const dir0 = new Set(), dir1 = new Set();
      for (const it of band) {
        if (!TIME_RE.test(it.text)) continue;
        if (deptItems.length >= 2 && !deptColXs.some(cx => Math.abs(cx - it.x) <= 20)) continue;
        (splitX !== null && it.x >= splitX ? dir1 : dir0).add(it.text);
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
  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // CLI override: --date=YYYY-MM-DD lets you reproduce any day's pick locally
  // without waiting for the calendar. Omit to use real Istanbul-local today.
  const dateArg = process.argv.find(a => a.startsWith('--date='));
  const today   = todayInTurkey(dateArg ? dateArg.slice('--date='.length) : null);

  console.log('Fetching PDF URLs…');
  const { wdUrl, weUrl } = await getPDFUrls(today);

  // Fast-skip: if URLs match the previous run's, the PDFs haven't been
  // re-uploaded and there's nothing to do. Lets us run the workflow hourly
  // without re-parsing the same data.
  try {
    const prev = JSON.parse(readFileSync('data/schedule.json', 'utf8'));
    if (prev.wdUrl === wdUrl && prev.weUrl === weUrl) {
      console.log('PDFs unchanged since last run — skipping parse.');
      return;
    }
  } catch {}

  console.log('Downloading PDFs…');
  const [wdBuf, weBuf] = await Promise.all([
    fetchBinary(wdUrl),
    weUrl ? fetchBinary(weUrl) : Promise.resolve(null),
  ]);

  console.log('Parsing weekday PDF…');
  const weekday = await parsePDF(wdBuf);
  console.log(`  → ${Object.keys(weekday).length} routes`);

  console.log('Parsing weekend PDF…');
  const weekend = weBuf ? await parsePDF(weBuf) : {};
  console.log(`  → ${Object.keys(weekend).length} routes`);

  // Fetch kentkart route list for colors (used by Seferler tab badges)
  console.log('Fetching kentkart route colors…');
  let routes = [];
  try {
    const kr = await fetch('https://service.kentkart.com/rl1/web/nearest/find?region=007&lang=tr&authType=4&resultType=111');
    const kd = await kr.json();
    routes = kd.routeList || [];
    console.log(`  → ${routes.length} routes`);
  } catch (e) { console.warn('  kentkart fetch failed:', e.message); }

  const out = { weekday, weekend, routes, fetchedAt: Date.now(), wdUrl, weUrl };
  writeFileSync('data/schedule.json', JSON.stringify(out));
  console.log('✅ schedule.json written');
}

main().catch(e => { console.error(e); process.exit(1); });
