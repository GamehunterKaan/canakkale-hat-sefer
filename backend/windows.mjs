#!/usr/bin/env node
// Polling windows for the ETA collector, from the app's own timetable logic.
//
//   node windows.mjs <dir>
//
// Downloads core.js (saved as core.mjs), schedule.json and stops.json from the site into <dir>
// (keeping the last good copy of each when a download fails) and writes
// <dir>/windows.json for the current service day:
//   {day, unavailable, windows: {"Ç1|0": {start, end}}, network: {start, end}}
// A route's window opens LEAD_MIN before its first departure and its clock
// part ends TAIL_MIN after the last departure's scheduled arrival. Routes
// without a timetable today are absent; the collector probes them during
// `network`, the span of all windows.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

const SITE = 'https://17hatsefer.kaangultekin.net/';
const FILES = { 'core.mjs': 'core.js', 'schedule.json': 'data/schedule.json', 'stops.json': 'data/stops.json' };
const LEAD_MIN = 15;
const TAIL_MIN = 15;

function writeAtomic(path, text) {
  writeFileSync(path + '.tmp', text);
  renameSync(path + '.tmp', path);
}

async function refresh(dir) {
  for (const [name, url] of Object.entries(FILES)) {
    try {
      const response = await fetch(SITE + url + '?_=' + Date.now(), { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (name.endsWith('.json')) JSON.parse(text);
      writeAtomic(join(dir, name), text);
    } catch (e) {
      console.error(`kept the last copy of ${name}: ${e.message}`);
    }
  }
}

// `core` is the app's core.js module. Times are service-day minutes (after
// midnight continues past 1440), counted from the service day's local midnight.
export function computeWindows(core, schedules, stops, now = new Date()) {
  const today = core.todayParts(now);
  const midnight = Date.parse(`${today.ymd}T00:00:00+03:00`);
  const day = core.scheduleForDay(schedules, today);
  if (!day || day.unavailable) return { day: today.ymd, unavailable: true, windows: {}, network: null };
  const windows = {};
  for (const { path } of stops.paths) {
    const code = path.displayRouteCode;
    const entry = core.findSchedEntry(day.routes || {}, code);
    const times = entry ? core.schedTimesForPath(entry, path).map(core._tmMin) : [];
    if (!times.length) continue;
    const list = path.busStopList || [];
    const tripMin = (+list.at(-1)?.arrival_offset || 0) / 60 || Math.max(0, list.length - 1) * core.MINS_PER_STOP;
    windows[`${code}|${path.direction}`] = {
      start: midnight + (Math.min(...times) - LEAD_MIN) * 60000,
      end: midnight + (Math.max(...times) + tripMin + TAIL_MIN) * 60000,
    };
  }
  const spans = Object.values(windows);
  const network = spans.length ? { start: Math.min(...spans.map(w => w.start)), end: Math.max(...spans.map(w => w.end)) } : null;
  return { day: today.ymd, unavailable: false, windows, network };
}

async function main(dir) {
  mkdirSync(dir, { recursive: true });
  await refresh(dir);
  const core = await import(pathToFileURL(join(dir, 'core.mjs')).href);
  const schedules = JSON.parse(readFileSync(join(dir, 'schedule.json'), 'utf8')).schedules;
  const stops = JSON.parse(readFileSync(join(dir, 'stops.json'), 'utf8'));
  const result = { generatedAt: Date.now(), ...computeWindows(core, schedules, stops) };
  writeAtomic(join(dir, 'windows.json'), JSON.stringify(result));
  console.log(`${result.day}: ${result.unavailable ? 'timetable unavailable' : Object.keys(result.windows).length + ' scheduled route directions'}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) { console.error('usage: node windows.mjs <dir>'); process.exit(2); }
  main(process.argv[2]).catch(e => { console.error(e); process.exit(1); });
}
