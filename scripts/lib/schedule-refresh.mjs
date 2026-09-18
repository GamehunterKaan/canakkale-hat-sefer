import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parsePDF } from './schedule-parser.mjs';
import { discoverPdfLinks, requestBytes, MUNICIPALITY_URL, COLORS_URL } from './schedule-source.mjs';

const HEARTBEAT_MS = 12 * 60 * 60 * 1000;
const readJson = (path, warnings) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return null;
    if (e instanceof SyntaxError) { warnings.push('Saved JSON is invalid: ' + path); return null; }
    throw e;
  }
};
const stable = value => JSON.stringify(value, (key, item) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item);

export function sameSchedule(a, b) {
  const { fetchedAt: _a, ...left } = a || {};
  const { fetchedAt: _b, ...right } = b || {};
  return stable(left) === stable(right);
}

export function atomicWriteJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(data) + '\n', { flag: 'wx' }); renameSync(temp, path); }
  finally { try { unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}

export function validateBundle(schedules, links) {
  const errors = [];
  if (!schedules.length) errors.push('No schedules were produced');
  const ids = new Set();
  for (const schedule of schedules) {
    if (ids.has(schedule.id)) errors.push(`Duplicate schedule id: ${schedule.id}`);
    ids.add(schedule.id);
    if (!Object.keys(schedule.routes || {}).length) errors.push(`${schedule.id}: no routes`);
    for (const [key, route] of Object.entries(schedule.routes || {})) {
      let count = 0;
      for (const dir of ['dir0', 'dir1']) {
        const block = route[dir];
        if (!Array.isArray(block?.times)) { errors.push(`${schedule.id}/${key}/${dir}: missing times`); continue; }
        count += block.times.length;
        if (block.times.length && !block.label?.trim()) errors.push(`${schedule.id}/${key}/${dir}: missing terminal`);
        if (block.times.some(t => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t))) errors.push(`${schedule.id}/${key}/${dir}: invalid clock time`);
      }
      if (!count) errors.push(`${schedule.id}/${key}: no departures`);
    }
  }
  for (const link of links) if (!schedules.some(s => s.id === link.id && s.url === link.url))
    errors.push(`${link.id}: advertised PDF did not produce a schedule`);
  return errors;
}

export async function refreshSchedules({ outputDir = 'data', diagnosticsDir = 'tmp/schedule-parser/last-refresh',
  fetchBytes = requestBytes, parsePdf = parsePDF, now = Date.now(), log = console.log } = {}) {
  const schedulePath = join(outputDir, 'schedule.json'), statusPath = join(outputDir, 'schedule-status.json');
  const report = { checkedAt: now, sourcePage: MUNICIPALITY_URL, sources: [], errors: [], warnings: [] };
  const previous = readJson(schedulePath, report.warnings), oldStatus = readJson(statusPath, report.warnings);
  let links = [], schedules = [], changed = false;
  mkdirSync(diagnosticsDir, { recursive: true });
  try {
    const html = await fetchBytes(MUNICIPALITY_URL, { maxBytes: 3 * 1024 * 1024 });
    const discovery = discoverPdfLinks(html.toString('utf8'));
    links = discovery.links;
    report.ignoredLinks = discovery.ignored;
    report.sources = links.map(({ id, label, url }) => ({ id, label, url }));
    if (discovery.errors.length) throw new Error(discovery.errors.join('\n'));
    for (let index = 0; index < links.length; index++) {
      const link = links[index];
      log(`Checking ${link.label}: ${link.url}`);
      try {
        const bytes = await fetchBytes(link.url);
        const hash = createHash('sha256').update(bytes).digest('hex');
        report.sources[index].sha256 = hash;
        // CI uploads source evidence on failure, including PDFs that are later replaced.
        writeFileSync(join(diagnosticsDir, `source-${index + 1}.pdf`), bytes);
        const parsed = await parsePdf(bytes);
        report.sources[index].diagnostics = parsed.diagnostics;
        if (!parsed.diagnostics || parsed.diagnostics.errors.length)
          throw new Error(parsed.diagnostics?.errors.join('\n') || 'Parser did not produce a completeness report');
        if (parsed.diagnostics.indexOnlyRoutes?.length)
          report.sources[index].indexOnlyRoutes = parsed.diagnostics.indexOnlyRoutes;
        const schedule = { ...link, source: { sha256: hash, pages: parsed.numPages }, routes: parsed.routes };
        const errors = validateBundle([schedule], [link]);
        if (errors.length) throw new Error(errors.join('\n'));
        schedules.push(schedule);
        report.sources[index].state = 'ok';
        for (const warning of parsed.diagnostics.warnings || []) report.warnings.push(`${link.id}: ${warning}`);
        for (const ignored of parsed.diagnostics.ignored || []) report.warnings.push(`${link.id}: page ${ignored.page}: ${ignored.reason}`);
        log(`  ${Object.keys(parsed.routes).length} timetable routes parsed`);
      } catch (e) {
        report.sources[index].state = 'error';
        report.errors.push(`${link.id}: ${e.message}`);
        let saved = previous?.schedules?.find(s => s.id === link.id && s.kind === link.kind &&
          (['weekday', 'weekend'].includes(link.kind) || stable(s.dates) === stable(link.dates) && s.year === link.year));
        // Upgrade legacy cached output once with the new parser. Its source
        // remains explicitly old; this must never mark the new PDF verified.
        if (saved?.url && !saved.source && !saved.unavailable) {
          try {
            const bytes = await fetchBytes(saved.url), parsed = await parsePdf(bytes);
            writeFileSync(join(diagnosticsDir, 'fallback-' + (index + 1) + '.pdf'), bytes);
            report.sources[index].fallback = { url:saved.url, diagnostics:parsed.diagnostics };
            const rebuilt = { ...saved, routes:parsed.routes, source:{
              sha256:createHash('sha256').update(bytes).digest('hex'), pages:parsed.numPages,
            } };
            if (!parsed.diagnostics || parsed.diagnostics.errors.length || validateBundle([rebuilt], [saved]).length)
              throw new Error('Saved source did not pass current validation');
            saved = rebuilt;
          } catch (error) { report.warnings.push('Could not reparse saved ' + link.id + ': ' + error.message); }
        }
        // Each advertised service remains represented. A new, unreadable
        // special must not silently fall through to regular weekday times.
        schedules.push(saved || { ...link, unavailable: true, routes: {} });
      }
    }
    let routes = previous?.routes || [];
    try {
      const data = JSON.parse((await fetchBytes(COLORS_URL, { maxBytes: 2 * 1024 * 1024 })).toString('utf8'));
      if (!Array.isArray(data.routeList) || !data.routeList.length) throw new Error('Empty route colors');
      routes = data.routeList;
    } catch (e) { report.warnings.push(`Using saved route colors: ${e.message}`); }
    const next = { schedules, routes, fetchedAt: now };
    if (!previous || !sameSchedule(previous, next)) { atomicWriteJson(schedulePath, next); changed = true; }
  } catch (e) {
    if (!report.errors.length) report.errors.push(e.message);
  }
  const ok = !report.errors.length;
  const dataFetchedAt = changed ? now : previous?.fetchedAt || null;
  const status = {
    version: 1, state: ok ? 'ok' : 'error', checkedAt: now,
    lastSuccessAt: ok ? now : oldStatus?.lastSuccessAt || null,
    dataFetchedAt, sourcePage: MUNICIPALITY_URL,
    sources: report.sources.length ? report.sources.map(({ id, label, url, sha256, state, indexOnlyRoutes }) =>
      ({ id, label, url, ...(sha256 ? { sha256 } : {}), ...(state ? { state } : {}), ...(indexOnlyRoutes?.length ? { indexOnlyRoutes } : {}) }))
      : oldStatus?.sources || (previous?.schedules || []).map(({ id, label, url }) => ({ id, label, url })),
    errors: report.errors,
  };
  const content = value => {
    const { checkedAt, lastSuccessAt, ...rest } = value || {};
    return stable(rest);
  };
  const statusChanged = !oldStatus || content(oldStatus) !== content(status) || now - oldStatus.checkedAt >= HEARTBEAT_MS;
  if (statusChanged) atomicWriteJson(statusPath, status);
  atomicWriteJson(join(diagnosticsDir, 'report.json'), report);
  log(ok ? changed ? 'Schedule data updated.' : 'Schedule data unchanged; verification succeeded.' :
    'Some schedules failed verification. Failed services retain their last good data; verified services update independently.');
  return { ok, changed, statusChanged, report, status: statusChanged ? status : oldStatus };
}
