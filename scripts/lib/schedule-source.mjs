import { parse } from 'parse5';
import { clean, fold } from './schedule-parser.mjs';

export const MUNICIPALITY_URL = 'https://ulasim.canakkale.bel.tr/rehber/hatlar-otobus-saatleri/';
export const COLORS_URL = 'https://service.kentkart.com/rl1/web/nearest/find?region=007&lang=tr&authType=4&resultType=111';
const MONTHS = { OCAK:1, SUBAT:2, MART:3, NISAN:4, MAYIS:5, HAZIRAN:6,
  TEMMUZ:7, AGUSTOS:8, EYLUL:9, EKIM:10, KASIM:11, ARALIK:12 };
const monthPattern = Object.keys(MONTHS).join('|');

export function parseDates(text) {
  const s = fold(text), dates = new Set();
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
    const end = new Date(Date.UTC(year || 2000, MONTHS[m[4]] - 1, +m[3]));
    add(+m[1], MONTHS[m[2]]); add(+m[3], MONTHS[m[4]]);
    if (end < start || (end - start) / 86400000 > 62) throw new Error('Ambiguous schedule date range');
    for (const day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1)) add(day.getUTCDate(), day.getUTCMonth() + 1);
  }
  const list = new RegExp(`(?<!\\d)((?:\\d{1,2}[ ,\\-]+)*\\d{1,2})[ -]+(${monthPattern})\\b`, 'g');
  for (const m of s.matchAll(list)) {
    const days = m[1].split(/[ ,\-]+/).map(Number);
    if (days.length === 2 && /-/.test(m[1]) && days[1] >= days[0]) {
      for (let d = days[0]; d <= days[1]; d++) add(d, MONTHS[m[2]]);
    } else days.forEach(d => add(d, MONTHS[m[2]]));
  }
  for (const m of s.matchAll(/\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b/g)) add(+m[1], +m[2]);
  return { dates: [...dates].sort(), year };
}

function classification(text) {
  const s = fold(text).replace(/[-_]/g, ' ');
  if (/MEZARLIK|KUTUPHANE/.test(s)) return 'ignore';
  if (/BAYRAM|AR[EI]FE/.test(s)) return 'special';
  const family = /HAFTA\s*SONU/.test(s) ? 'weekend' : /HAFTA\s*ICI/.test(s) ? 'weekday' : null;
  if (family) return (/ITIBAR(?:EN|I?YLE|I?YLA)/.test(s) ? 'effective-' : '') + family;
  if (/^\d/.test(s) && /SEFER|SAAT/.test(s)) return 'special';
  return 'unknown';
}

function nodeText(node) {
  if (node.nodeName === '#text') return node.value;
  if (node.tagName === 'br') return ' ';
  if (['script', 'style'].includes(node.tagName)) return '';
  return (node.childNodes || []).map(nodeText).join('');
}

export function discoverPdfLinks(html, baseUrl = MUNICIPALITY_URL) {
  const links = [], seen = new Map(), errors = [], ignored = [];
  const visit = node => {
    if (node.tagName === 'a') {
      const attrs = Object.fromEntries(node.attrs.map(a => [a.name, a.value]));
      let url;
      try { url = new URL(attrs.href, baseUrl); } catch {}
      if (url && /^https?:$/.test(url.protocol) && /\.pdf$/i.test(url.pathname)) {
        url.hash = '';
        let basename = url.pathname.split('/').pop();
        try { basename = decodeURIComponent(basename); } catch { errors.push(`Malformed PDF URL: ${url.href}`); }
        basename = basename.replace(/\.pdf$/i, '').replace(/_/g, ' ');
        const text = clean(nodeText(node) || attrs.title || basename);
        const kind = classification(text) === 'unknown' ? classification(basename) : classification(text);
        if (kind === 'ignore') ignored.push({ url: url.href, label: text, reason: 'Separate cemetery/library service' });
        else {
          let dates = [], year = null;
          try {
            ({ dates, year } = parseDates(text));
            if (!dates.length) ({ dates, year } = parseDates(basename));
          } catch (error) { errors.push(`${text}: ${error.message}`); }
          const first = dates[0];
          const prefix = kind === 'special' ? (/AR[EI]FE/.test(fold(text)) ? 'arefe' : /BAYRAM/.test(fold(text)) ? 'bayram' : 'special') : kind;
          const id = ['weekday', 'weekend'].includes(kind) ? kind : `${prefix}-${year || 'x'}-${first || basename}`;
          const label = text.replace(/\s*(?:GÜN[UÜ]\s+)?(?:TOPLU\s+TA[ŞS]IMA\s+)?SEFER\s+SAATLER[İI]\s*$/iu, '').trim() || text;
          const link = { id, label: label.split(/\s+/).map(w => w[0].toLocaleUpperCase('tr') + w.slice(1).toLocaleLowerCase('tr')).join(' '),
            kind, dates, year, effectiveFrom: kind.startsWith('effective-') ? first || null : null, url: url.href };
          if (kind === 'unknown') errors.push(`Unrecognized PDF schedule label: ${text}`);
          if (kind.startsWith('effective-') && !first) errors.push(`Effective schedule has no valid date: ${text}`);
          if (kind === 'special' && !first) errors.push(`Special schedule has no valid date: ${text}`);
          const previous = seen.get(url.href);
          if (!previous) { links.push(link); seen.set(url.href, link); }
          else if (previous.kind !== kind || JSON.stringify(previous.dates) !== JSON.stringify(dates)) errors.push(`Conflicting labels for PDF: ${url.href}`);
        }
      }
    }
    for (const child of node.childNodes || []) visit(child);
  };
  visit(parse(html));
  if (!links.length) errors.push('No usable schedule PDF links found');
  for (const family of ['weekday', 'weekend']) if (!links.some(l => l.kind === family || l.kind === 'effective-' + family))
    errors.push(`Municipality page is missing its ${family} schedule`);
  const ids = new Set();
  for (const link of links) {
    if (ids.has(link.id)) errors.push(`More than one PDF claims schedule ${link.id}`);
    ids.add(link.id);
  }
  const order = { weekday:0, weekend:1, special:2, 'effective-weekday':3, 'effective-weekend':4 };
  links.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.id.localeCompare(b.id));
  return { links, errors, ignored };
}

export async function requestBytes(url, { fetchImpl = fetch, attempts = 3, timeoutMs = 20000,
  maxBytes = 20 * 1024 * 1024, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    let timer;
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
    await sleep(250 * 2 ** attempt);
  }
  throw last;
}
