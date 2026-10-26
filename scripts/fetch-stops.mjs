/**
 * Fetches all kentkart route/stop/path data and writes stops.json.
 * Runs in GitHub Actions every hour; the file changes only when kentkart's data does.
 */

import { writeFileSync, readFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { _travelToStopMins } from '../core.js';

const API    = 'https://service.kentkart.com/rl1/';
const REGION = '007';
const QS     = `region=${REGION}&lang=tr&authType=4&resultType=111`;

// A failed request is retried, then fails the run: the previous stops.json stays
// in place rather than silently losing that route's path. kentkart answers through
// Cloudflare, which caches each response for 12 s: a retry must bypass that cache,
// or every attempt receives the same broken copy.
async function getJson(url, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(attempt === 1 ? url : `${url}&_=${Date.now()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      // kentkart occasionally sends broken UTF-8 (a stop named "KAMPÜS��"): retry instead of storing it.
      if (text.includes('�')) throw new Error('garbled text in response');
      return JSON.parse(text);
    } catch (e) {
      if (attempt >= tries) throw new Error(`${url}: ${e.message}`);
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
}

// kentkart can time a path from one of its later stops: 11K-E toward Gazi Okulu
// gives its first stops no offset (seconds after the path's first stop), then
// restarts near zero. Count such offsets from the last untimed stop, at the
// app's own estimate for it, so a bus never reaches a stop before the one
// ahead of it.
export function rebaseOffsets(stops) {
  let shift = 0;
  return stops.map((stop, i) => {
    const before = stops[i - 1], arr = +stop.arrival_offset;
    if (i > 1 && arr > 0 && !(+before.arrival_offset > 0) && arr < _travelToStopMins(before) * 60)
      shift = _travelToStopMins(before) * 60;
    if (!shift || !(arr > 0)) return stop;
    return { ...stop, arrival_offset: String(arr + shift),
      ...(+stop.departure_offset > 0 && { departure_offset: String(+stop.departure_offset + shift) }) };
  });
}

async function main() {
  // 1. Route list (with colors and display codes)
  console.log('Fetching route list…');
  const nd = await getJson(`${API}web/nearest/find?${QS}`);
  const routes = nd.routeList || [];
  if (!routes.length) throw new Error('kentkart returned no routes');
  console.log(`  → ${routes.length} routes`);

  // Paths are always fetched: kentkart changes a route's stops (re-routes, new
  // stops) without changing the route list.

  // 2. Fetch all path info (stops + polyline) for every route × direction
  const total   = routes.length * 2;
  let   done    = 0;
  const fetches = routes.flatMap(route =>
    ['0', '1'].map(dir =>
      getJson(`${API}web/pathInfo?${QS}&displayRouteCode=${encodeURIComponent(route.displayRouteCode)}&direction=${dir}`)
        .then(data => {
          // Code 3 ("Sonuç Bulunamadı") is a direction that doesn't exist, e.g. Ç6 has no direction 1.
          const code = String(data?.result?.code);
          if (code !== '0' && code !== '3') throw new Error(`${route.displayRouteCode}/${dir}: kentkart result ${code}`);
          return data;
        })
        .finally(() => { done++; process.stdout.write(`\r  ${done}/${total} paths`); })
    )
  );

  const results = await Promise.all(fetches);
  console.log('');

  // 3. Build the same data structures the app uses, minus live bus positions
  const paths       = [];
  const allStops    = new Map();
  const stopToRoutes = new Map();

  for (let i = 0; i < results.length; i++) {
    const data  = results[i];
    if (!data?.pathList) continue;
    const route = routes[Math.floor(i / 2)];

    for (const path of data.pathList) {
      // Strip live bus data — positions change every minute, no point caching
      const { busList: _buses, ...rest } = path;
      // busOnStop is live (a bus is at that stop now); keeping it would rewrite the file every run.
      const pathWithoutBuses = { ...rest, busStopList: rebaseOffsets((rest.busStopList || []).map(({ busOnStop: _live, ...stop }) => stop)) };
      paths.push({ path: pathWithoutBuses, route });

      for (const s of path.busStopList || []) {
        if (!allStops.has(s.stopId)) {
          allStops.set(s.stopId, {
            stopId:   s.stopId,
            stopName: s.stopName,
            lat:      parseFloat(s.lat),
            lng:      parseFloat(s.lng),
          });
        }
        if (!stopToRoutes.has(s.stopId)) stopToRoutes.set(s.stopId, []);
        const list = stopToRoutes.get(s.stopId);
        if (!list.find(e => e.routeCode === route.displayRouteCode && e.direction === path.direction)) {
          list.push({
            routeCode:  route.displayRouteCode,
            direction:  path.direction,
            seq:        parseInt(s.seq) || 0,
            routeColor: route.routeColor || 'aaaaaa',
            routeName:  route.name || path.headSign,
            headSign:   path.headSign,
          });
        }
      }
    }
  }

  console.log(`Stops: ${allStops.size}, Paths: ${paths.length}`);

  const out = {
    routes,
    paths,
    stops:        [...allStops.entries()],
    stopToRoutes: [...stopToRoutes.entries()],
    fetchedAt:    Date.now(),
  };

  try {
    const prev = JSON.parse(readFileSync('data/stops.json', 'utf8'));
    if (JSON.stringify({ ...prev, fetchedAt: 0 }) === JSON.stringify({ ...out, fetchedAt: 0 })) {
      console.log('stops.json unchanged');
      return;
    }
  } catch {}
  writeFileSync('data/stops.json', JSON.stringify(out));
  console.log('✅ stops.json written');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(e => { console.error(e); process.exit(1); });
