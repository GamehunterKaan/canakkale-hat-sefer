import { parse } from 'parse5';
import { clean, fold } from './schedule-parser.mjs';

export const MUNICIPALITY_URL = 'https://ulasim.canakkale.bel.tr/rehber/hatlar-otobus-saatleri/';
export const COLORS_URL = 'https://service.kentkart.com/rl1/web/nearest/find?region=007&lang=tr&authType=4&resultType=111';
const MONTHS = { OCAK:1, SUBAT:2, MART:3, NISAN:4, MAYIS:5, HAZIRAN:6,
  TEMMUZ:7, AGUSTOS:8, EYLUL:9, EKIM:10, KASIM:11, ARALIK:12 };
const monthPattern = Object.keys(MONTHS).join('|');
const WEEKDAYS = { PAZAR:0, PAZARTESI:1, SALI:2, CARSAMBA:3, PERSEMBE:4, CUMA:5, CUMARTESI:6 };
const FAMILY_DAYS = { weekday: [1, 2, 3, 4, 5], weekend: [0, 6] };
const familyOf = text => { const s = fold(text).replace(/[-_]/g, ' '); return /HAFTA\s*SONU/.test(s) ? 'weekend' : /HAFTA\s*ICI/.test(s) ? 'weekday' : null; };
// A route's own supplement names its route: "Ç4 HATTI", "KEPEZ HATTI", "ÇT-3".
const namesRoute = s => /(?:^|[^A-Z0-9])(?:C\s*T?\s*\d{1,3}[A-Z]?|\d{1,3}\s*[KG])(?![A-Z0-9])|\bHATTI?\b/.test(s);
// Whole holiday words: TARİFESİ ("timetable") contains ARİFE but is no holiday eve.
// "Resmi tatil" alone names a holiday; a week part that mentions it ("hafta
// sonu ve resmi tatil günleri", "resmi tatiller hariç") is still that week part.
const HOLIDAY = /\bBAYRAM|\bAR[EI]FE(?:SI)?\b|\bYILBASI\b|\bZAFER/;
const isHoliday = text => HOLIDAY.test(text) || /\bRESMI\s+TATIL/.test(text) && !familyOf(text);

// The weekdays a label names, ranges ("Pazartesi-Cuma") included, and the ones
// it excepts ("Cuma hariç", "Cuma günleri dışında"). A run of days joined by
// "-", ",", "&", "ve" or "ile" is named or excepted as a whole: "Perşembe ve
// Cuma hariç" excepts both.
function namedWeekdays(text) {
  const s = fold(text).replace(/_/g, ' ');
  if (!/GUN|SEFER|SAAT|TARIFE/.test(s)) return { days: [], excepted: [] };
  const matches = [...s.matchAll(/\b(PAZARTESI|SALI|CARSAMBA|PERSEMBE|CUMARTESI|CUMA|PAZAR)\b/g)]
    .filter(m => !(m[1] === 'CUMA' && /^\s+PAZARI\b/.test(s.slice(m.index + m[0].length))));
  const days = new Set(), excepted = new Set();
  let run = [];
  for (const [i, m] of matches.entries()) {
    const end = m.index + m[0].length, next = matches[i + 1], gap = next ? s.slice(end, next.index) : '';
    run.push(WEEKDAYS[m[1]]);
    if (next && /^\s*-\s*$/.test(gap))
      for (let day = (WEEKDAYS[m[1]] + 1) % 7; day !== WEEKDAYS[next[1]]; day = (day + 1) % 7) run.push(day);
    if (next && /^\s*(?:GUNU|GUNLERI)?\s*(?:[-,&]|\bVE\b|\bILE\b)\s*$/.test(gap)) continue;
    const into = /^\s*(?:GUNU|GUNLERI)?\s*(?:HARIC|DISINDA)/.test(s.slice(end)) ? excepted : days;
    for (const day of run) into.add(day);
    run = [];
  }
  return { days: [...days].sort(), excepted: [...excepted].sort() };
}

// The days a recurring service runs: the days it names, else its week part's
// days, without the days it excepts. A label whose days contradict its own
// week part ("HAFTA İÇİ VE CUMARTESİ"), or that only excepts days, is unclear.
function serviceDays(text) {
  const { days, excepted } = namedWeekdays(text), base = FAMILY_DAYS[familyOf(text)];
  if (base && days.some(day => !base.includes(day))) throw new Error('Named weekdays contradict the label\'s week part');
  const run = (days.length ? days : base || []).filter(day => !excepted.includes(day));
  if (!run.length) throw new Error('Cannot tell which weekdays the schedule runs');
  return run;
}

export function parseDates(text) {
  // A season or school year ("2026-2027") is not a schedule date.
  const s = fold(text).replace(/\b(20\d{2})\s*[-/]\s*(20\d{2})\b/g, (span, a, b) => +b === +a + 1 ? ' ' : span), dates = new Set();
  const year = +(s.match(/\b(20\d{2})\b/)?.[1] || 0) || null;
  if (new Set([...s.matchAll(/\b20\d{2}\b/g)].map(m => m[0])).size > 1)
    throw new Error('Ambiguous schedule years');
  const add = (d, m) => {
    const date = new Date(Date.UTC(year || 2000, m - 1, d));
    if (d < 1 || m < 1 || m > 12 || date.getUTCDate() !== d || date.getUTCMonth() + 1 !== m)
      throw new Error(`Invalid schedule date: ${d}/${m}`);
    dates.add(`${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  };
  const range = new RegExp(`(\\d{1,2})\\s+(${monthPattern})\\s*-\\s*(\\d{1,2})\\s+(${monthPattern})`, 'g');
  for (const m of s.matchAll(range)) {
    const start = new Date(Date.UTC(year || 2000, MONTHS[m[2]] - 1, +m[1]));
    // A range ending in an earlier month ends in the next year: "30 Aralık - 2 Ocak".
    const end = new Date(Date.UTC((year || 2000) + (MONTHS[m[4]] < MONTHS[m[2]] ? 1 : 0), MONTHS[m[4]] - 1, +m[3]));
    add(+m[1], MONTHS[m[2]]); add(+m[3], MONTHS[m[4]]);
    if (end < start || (end - start) / 86400000 > 62) throw new Error('Ambiguous schedule date range');
    for (const day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1)) add(day.getUTCDate(), day.getUTCMonth() + 1);
  }
  // Day lists may be joined by commas, dashes or "VE"/"İLE": "28 ve 29 Ekim".
  const list = new RegExp(`(?<!\\d)((?:\\d{1,2}(?:[ ,&\\-]+|\\s+(?:VE|ILE)\\s+))*\\d{1,2})[ -]+(${monthPattern})\\b`, 'g');
  for (const m of s.matchAll(list)) {
    const days = m[1].split(/\D+/).filter(Boolean).map(Number);
    if (days.length === 2 && /-/.test(m[1]) && days[1] >= days[0]) {
      for (let d = days[0]; d <= days[1]; d++) add(d, MONTHS[m[2]]);
    } else days.forEach(d => add(d, MONTHS[m[2]]));
  }
  for (const m of s.matchAll(/\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b/g)) add(+m[1], +m[2]);
  // One written year cannot date both sides of a year end ("30 Aralık - 2 Ocak 2027").
  if (year && [...dates].some(d => d.startsWith('01-')) && [...dates].some(d => d.startsWith('12-')))
    throw new Error('Ambiguous schedule years');
  return { dates: [...dates].sort(), year };
}

function classification(text) {
  const s = fold(text).replace(/[-_]/g, ' ');
  if (/MEZARLIK|KUTUPHANE/.test(s)) return 'ignore';
  if (isHoliday(s)) return 'special';
  const family = familyOf(text), { days, excepted } = namedWeekdays(text);
  // Only a route's own supplement is limited to days. A city-wide week part
  // that also names days ("HAFTA İÇİ (PAZARTESİ-CUMA)", "2 Kasım Pazartesi
  // itibariyle hafta içi") is still that week part.
  if (namesRoute(s) && (days.length || excepted.length || family)) return 'recurring';
  if (family) return (/ITIBAR(?:EN|I?YLE|I?YLA)/.test(s) ? 'effective-' : '') + family;
  if (days.length || excepted.length) return 'recurring';
  if (/^\d/.test(s) && /SEFER|SAAT|TARIFE/.test(s)) return 'special';
  return 'unknown';
}

function nodeText(node) {
  if (node.nodeName === '#text') return node.value;
  if (node.tagName === 'br') return ' ';
  if (['script', 'style'].includes(node.tagName)) return '';
  return (node.childNodes || []).map(nodeText).join('');
}

export function discoverPdfLinks(html, baseUrl = MUNICIPALITY_URL, now = Date.now()) {
  const links = [], seen = new Map(), errors = [], pageErrors = [], sourceErrors = [], ignored = [], exceptions = [];
  const pageError = message => { errors.push(message); pageErrors.push(message); };
  const sourceError = (url, message) => { errors.push(message); sourceErrors.push({ url, message }); };
  const visit = node => {
    if (node.tagName === 'a') {
      const attrs = Object.fromEntries(node.attrs.map(a => [a.name, a.value]));
      let url;
      try { url = new URL(attrs.href, baseUrl); } catch {}
      if (url && /^https?:$/.test(url.protocol) && /\.pdf$/i.test(url.pathname)) {
        url.hash = '';
        let basename = url.pathname.split('/').pop();
        try { basename = decodeURIComponent(basename); } catch { sourceError(url.href, `Malformed PDF URL: ${url.href}`); }
        basename = basename.replace(/\.pdf$/i, '').replace(/_/g, ' ');
        // A blank link (whitespace, &nbsp;) is named by its title, then its file.
        const text = clean(nodeText(node)) || clean(attrs.title) || clean(basename);
        const textKind = classification(text);
        // "27 Ekim günü hafta içi": a week part its link dates (not from a
        // date on, "itibariyle") is that day's timetable, like "28 Ekim günü".
        // A file name's date stays its publication date.
        let dated = false;
        try { dated = ['weekday', 'weekend'].includes(textKind) && parseDates(text).dates.length > 0; } catch {}
        const kind = dated ? 'special' : textKind === 'unknown' ? classification(basename) : textKind;
        if (kind === 'ignore') ignored.push({ url: url.href, label: text, reason: 'Separate cemetery/library service' });
        else {
          const recurringText = textKind === 'recurring' ? text : basename;
          let weekdays = [];
          if (kind === 'recurring') {
            try { weekdays = serviceDays(recurringText); } catch (error) { sourceError(url.href, `${text}: ${error.message}`); }
          }
          const isEffective = kind.startsWith('effective-') || kind === 'recurring' && /ITIBAR(?:EN|I?YLE|I?YLA)/.test(fold(recurringText));
          let dates = [], year = null;
          try {
            ({ dates, year } = parseDates(text));
            // A dated filename can be the publication date of a weekly PDF.
            // Only an explicit effective-from label gives it an activation date.
            if (!dates.length && (kind !== 'recurring' || isEffective)) ({ dates, year } = parseDates(basename));
          } catch (error) { sourceError(url.href, `${text}: ${error.message}`); }
          const first = dates[0];
          // An effective-from date without a year is its latest occurrence at
          // most three months after the day it was found: announced shortly
          // before, and in force for good after, across New Year.
          if (isEffective && first && !year) {
            const [m, d] = first.split('-').map(Number), y = new Date(now).getUTCFullYear();
            year = [y + 1, y, y - 1].find(at => Date.UTC(at, m - 1, d) <= now + 92 * 86400000);
          }
          const prefix = kind === 'special' ? (/\bAR[EI]FE(?:SI)?\b/.test(fold(text)) ? 'arefe' : /\bBAYRAM/.test(fold(text)) ? 'bayram' : 'special') : kind;
          const id = ['weekday', 'weekend'].includes(kind) ? kind : kind === 'recurring' ?
            `recurring-${weekdays.join('')}-${fold(recurringText).replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '')}` :
            `${prefix}-${year || 'x'}-${first || basename}`;
          const label = text.replace(/\s*(?:GÜN[UÜ]\s+)?(?:TOPLU\s+TA[ŞS]IMA\s+)?SEFER\s+SAATLER[İI]\s*$/iu, '').trim() || text;
          const link = { id, label: label.split(/\s+/).filter(Boolean).map(w => w[0].toLocaleUpperCase('tr') + w.slice(1).toLocaleLowerCase('tr')).join(' '),
            kind, dates, year, effectiveFrom: isEffective ? first || null : null, url: url.href,
            ...(kind === 'recurring' ? { weekdays } : {}) };
          if (kind === 'unknown') sourceError(url.href, `Unrecognized PDF schedule label: ${text}`);
          // "HAFTA İÇİ VE CUMARTESİ": the week part would silently drop Saturday.
          // Read the days from whichever of the text and the file gave the kind.
          const family = FAMILY_DAYS[kind.replace('effective-', '')];
          const named = family ? namedWeekdays(textKind === 'unknown' ? basename : text) : null;
          if (named?.days.some(day => !family.includes(day)))
            sourceError(url.href, `${text}: Named weekdays contradict the label's week part`);
          if (named?.excepted.length) exceptions.push({ url: url.href, text, days: named.excepted });
          if (isEffective && !first) sourceError(url.href, `Effective schedule has no valid date: ${text}`);
          if (kind === 'special' && !first) sourceError(url.href, `Special schedule has no valid date: ${text}`);
          const previous = seen.get(url.href);
          if (!previous) { links.push(link); seen.set(url.href, link); }
          else if (previous.kind !== kind || JSON.stringify(previous.dates) !== JSON.stringify(dates) ||
              JSON.stringify(previous.weekdays) !== JSON.stringify(link.weekdays)) sourceError(url.href, `Conflicting labels for PDF: ${url.href}`);
        }
      }
    }
    for (const child of node.childNodes || []) visit(child);
  };
  visit(parse(html));
  if (!links.length) pageError('No usable schedule PDF links found');
  for (const family of ['weekday', 'weekend']) if (!links.some(l => l.kind === family || l.kind === 'effective-' + family))
    pageError(`Municipality page is missing its ${family} schedule`);
  // "HAFTA İÇİ (CUMA HARİÇ)": a week part that leaves a day out needs a schedule for that day.
  for (const { url, text, days } of exceptions)
    if (days.some(day => !links.some(l => l.weekdays?.includes(day))))
      sourceError(url, `${text}: No schedule serves the weekdays the week part excepts`);
  // Two PDFs claiming one service ("27 Ekim günü hafta içi" read as the
  // weekday) are both in doubt; the other services are not.
  for (const link of links) if (links.some(other => other !== link && other.id === link.id))
    sourceError(link.url, `More than one PDF claims schedule ${link.id}`);
  const order = { weekday:0, weekend:1, special:2, 'effective-weekday':3, 'effective-weekend':4, recurring:5 };
  links.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.id.localeCompare(b.id));
  return { links, errors, pageErrors, sourceErrors, ignored };
}

function requestErrorDetails(error) {
  const details = [], seen = new Set();
  const visit = e => {
    if (!e || seen.has(e)) return;
    seen.add(e);
    if (e.message || e.code) details.push([e.code, e.message].filter(Boolean).join(': '));
    visit(e.cause);
    for (const child of e.errors || []) visit(child);
  };
  visit(error);
  return [...new Set(details)].join('; ') || String(error);
}

export async function requestBytes(url, { fetchImpl = fetch, attempts = 3, timeoutMs = 20000,
  retryDelayMs = 2000, maxBytes = 20 * 1024 * 1024, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let last, tried = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    let timer;
    tried++;
    try {
      const operation = (async () => {
        const response = await fetchImpl(url, { signal: controller.signal, cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'CanakkaleHatSefer/1.0 schedule-check' } });
        if (!response.ok) {
          const error = new Error(`HTTP ${response.status} fetching ${url}`);
          error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          await response.body?.cancel().catch(() => {});
          throw error;
        }
        const oversized = () => Object.assign(new Error(`Response exceeds ${maxBytes} bytes: ${url}`), { retryable: false });
        if (+response.headers.get('content-length') > maxBytes) { controller.abort(); throw oversized(); }
        const chunks = []; let size = 0;
        const reader = response.body?.getReader();
        if (!reader) throw new Error(`Empty response: ${url}`);
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > maxBytes) { controller.abort(); throw oversized(); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        return Buffer.concat(chunks, size);
      })();
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error(`Timeout fetching ${url}`)); }, timeoutMs);
      })]);
    } catch (error) {
      last = error;
      if (error.retryable === false || attempt === attempts - 1) break;
    } finally { clearTimeout(timer); }
    await sleep(retryDelayMs * 2 ** attempt);
  }
  throw new Error(`Failed to fetch ${url} after ${tried} attempt${tried === 1 ? '' : 's'}: ${requestErrorDetails(last)}`, { cause:last });
}
