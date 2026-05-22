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

async function getPDFUrls() {
  const html = await fetchText(MUN_URL);
  // Parse each <a ... href="*.pdf" ...>TEXT</a> with its anchor text.
  // The page also lists holiday/special schedule PDFs (BAYRAM, AREFE, MEZARLIK
  // etc.) that we must NOT pick as the regular weekly schedule.
  const found = [];
  for (const m of html.matchAll(/<a[^>]*href="([^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, '').replace(/&#8217;/g, "'").trim().toUpperCase();
    const abs  = href.startsWith('http') ? href
      : 'https://ulasim.canakkale.bel.tr' + (href.startsWith('/') ? '' : '/') + href;
    found.push({ url: abs, text });
  }
  if (!found.length) throw new Error('No PDF links found on municipality page');

  // Match by link text. The regular schedules start with "HAFTA İÇİ" / "HAFTA SONU".
  // Holiday PDFs have date prefixes or BAYRAM/AREFE/MEZARLIK keywords.
  const isHoliday = t => /BAYRAM|AREFE|MEZARL|^\s*\d/.test(t);
  let wdUrl = null, weUrl = null;
  for (const { url, text } of found) {
    if (isHoliday(text)) continue;
    if (/^HAFTA\s*SONU/.test(text))                  weUrl = weUrl || url;
    else if (/^HAFTA\s*[İI]?[ÇC]?[İI]?/.test(text))  wdUrl = wdUrl || url;
  }
  // Fallbacks if link text didn't match anything sensible
  if (!wdUrl) wdUrl = found.find(f => !isHoliday(f.text))?.url || found[0].url;
  if (!weUrl) weUrl = found.filter(f => !isHoliday(f.text)).slice(-1)[0]?.url;

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
  console.log('Fetching PDF URLs…');
  const { wdUrl, weUrl } = await getPDFUrls();

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
