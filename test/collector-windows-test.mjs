// Polling windows for the ETA collector (backend/windows.mjs), from the repo's own timetable data.
import { readFileSync } from 'fs';
import * as core from '../core.js';
import { computeWindows } from '../backend/windows.mjs';

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) { failed++; console.log(`FAIL ${name} ${detail}`); } };
const schedules = JSON.parse(readFileSync(new URL('../data/schedule.json', import.meta.url), 'utf8')).schedules;
const stops = JSON.parse(readFileSync(new URL('../data/stops.json', import.meta.url), 'utf8'));
const local = (iso) => Date.parse(iso + '+03:00');

const tuesday = computeWindows(core, schedules, stops, new Date(local('2026-10-27T12:00:00')));
const c1 = tuesday.windows['Ç1|0'];
check('a scheduled route has a window', !!c1 && !tuesday.unavailable);
check('the window opens 15 minutes before the first departure', c1 && (c1.start - local('2026-10-27T07:00:00')) === -15 * 60000,
  c1 && new Date(c1.start).toISOString());
check('the window lasts past the last departure by the trip length', c1 && c1.end > local('2026-10-28T00:00:00') + 15 * 60000);
check('routes without a timetable have no window', !('Ç2|0' in tuesday.windows) && !('Ç14|1' in tuesday.windows));
check('network hours span every window', Object.values(tuesday.windows).every(w => w.start >= tuesday.network.start && w.end <= tuesday.network.end));

// 02:00 still belongs to the previous service day.
const early = computeWindows(core, schedules, stops, new Date(local('2026-10-28T02:00:00')));
check('after midnight counts as the previous service day', early.day === '2026-10-27', early.day);

const unreadable = computeWindows(core, schedules.map(s => ({ ...s, unavailable: true })), stops, new Date(local('2026-10-27T12:00:00')));
check('an unreadable timetable is reported, not guessed', unreadable.unavailable && !Object.keys(unreadable.windows).length);

console.log(failed ? `${failed} failed` : 'collector windows: 7 checks passed');
process.exit(failed ? 1 : 0);
