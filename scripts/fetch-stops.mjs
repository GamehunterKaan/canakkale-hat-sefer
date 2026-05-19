/**
 * Fetches all kentkart route/stop/path data and writes stops.json.
 * Runs in GitHub Actions daily at midnight Turkey time.
 */

import { writeFileSync } from 'fs';

const API    = 'https://service.kentkart.com/rl1/';
const REGION = '007';
const QS     = `region=${REGION}&lang=tr&authType=4&resultType=111`;

async function main() {
  // 1. Route list (with colors and display codes)
  console.log('Fetching route list…');
  const nr = await fetch(`${API}web/nearest/find?${QS}`);
  const nd = await nr.json();
  const routes = nd.routeList || [];
  console.log(`  → ${routes.length} routes`);

  // 2. Fetch all path info (stops + polyline) for every route × direction
  const total   = routes.length * 2;
  let   done    = 0;
  const fetches = routes.flatMap(route =>
    ['0', '1'].map(dir =>
      fetch(`${API}web/pathInfo?${QS}&displayRouteCode=${encodeURIComponent(route.displayRouteCode)}&direction=${dir}`)
        .then(r => r.json())
        .catch(() => null)
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
      const { busList: _buses, ...pathWithoutBuses } = path;
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

  writeFileSync('data/stops.json', JSON.stringify(out));
  console.log('✅ stops.json written');
}

main().catch(e => { console.error(e); process.exit(1); });
