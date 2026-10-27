# ETA observation pilot

The Pi collects every public route (29 routes, 57 route/direction pairs; OGR
student routes are excluded like in the app), polling each only while it can have
buses (see Polling below). This first stage records
observations for evaluating better arrival estimates; it does not change the
website, train a prediction model, expose an HTTP server, or upload passenger GPS.
It uses Python 3.10+ and SQLite from the standard library, with no pip packages.

## Data quality

Kentkart supplies bus/trip IDs, positions, stop IDs, and route geometry. The
sampled bus records have no usable GPS fix timestamp (`timeDiff` is empty).
`received_ms` means when the collector received a response, not when the bus GPS
was measured. A repeated response is not proof that a vehicle position is fresh.

The collector stores changes in position and a cursor for each bus/path. It
records observed stop changes with lower/upper duration bounds from the polling
interval, rather than claiming exact physical arrivals. The first sighting of a
bus is censored: the collector does not know when it entered that stop.

Trip changes, backward progress, implausible GPS jumps, gaps over two minutes,
and prolonged unchanged positions reset the timing cursor. Missing IDs and
ambiguous repeated stop IDs are excluded. Changed route geometry gets a new
version. A jump across multiple stops remains one aggregate transition; no
individual segment times are invented. Later evaluation must establish the
meaning and freshness of Kentkart's `stopId` before treating these transitions
as training data. Slow real buses can also be excluded by these conservative
filters; the initial data is for auditing that tradeoff.

Failures in one direction do not prevent collection of the other direction.
Repeated failures back off that direction up to five minutes between attempts.
Failed or malformed responses leave timing cursors untouched. A gap on recovery
prevents the outage from becoming a travel-time sample.

## Polling

`windows.mjs` turns the day's timetable into one window per route direction, using
the app's own `core.js` with the site's `schedule.json` and `stops.json` (downloaded
hourly by `bus-eta-windows.timer`; the last good copy is kept). A window opens 15
minutes before the first departure and its clock part ends 15 minutes after the
last departure's scheduled arrival.

- Inside its window an idle route is probed every 60 seconds. A route with a bus at
  one of its stops is polled every 30 seconds until two polls in a row find none;
  a bus still running when the window closes is followed until then.
- Routes without a timetable that day are probed every 120 seconds during network
  hours (the span of all windows), and polled every 30 seconds while a bus is
  active: buses continue as such routes under other routes' timetables.
- Buses parked off the route (a stop ID not on its path) do not make it active.
- Polls ask for buses only (`resultType=010`, about 1 KB). Each route's stop list
  (`resultType=001`) is fetched when polling starts, hourly, when a new
  `path_code` appears, and at most every 10 minutes when a bus reports an unknown
  stop. `cycles.kind` records each request as `probe`, `fast` or `stops`.
- Without a timetable for today (missing, stale or unreadable `windows.json`) every
  route is polled by activity alone.

The journal gets a summary every five minutes plus a warning per failed request.

## Running locally

```powershell
python backend/collector.py --once
python backend/collector.py --status
python -m unittest discover -s test -p eta_collector_test.py -v
```

`--once` polls each route once, ignoring the timetable, and returns a failure
status if any request fails. `--status` reads the database without network access.
Repeat `--route` to collect more routes. Use `CODE:0` or `CODE:1` for a route
that exists in one direction only (Ç6 has no direction 1); a bare `CODE` uses
the `--direction` list. `node backend/windows.mjs <dir>` writes `<dir>/windows.json`;
pass it with `--windows`.

## Pi service

Copy `backend/` and `test/eta_collector_test.py` into `/home/pi/bus-eta/`, preserving
their relative paths. Install `backend/bus-eta.service`, `bus-eta-windows.service` and
`bus-eta-windows.timer` in
`/home/pi/.config/systemd/user/`. The default database is
`/home/pi/bus-eta/data/eta.sqlite3`, outside Jarvis and PiSecCam repositories.
Enable user lingering once if it is not already enabled:

```sh
sudo loginctl enable-linger pi
systemctl --user daemon-reload
systemctl --user enable --now bus-eta-windows.timer
systemctl --user start bus-eta-windows.service   # first windows.json
systemctl --user enable --now bus-eta.service
python3 ~/bus-eta/backend/collector.py --db ~/bus-eta/data/eta.sqlite3 --status
systemctl --user show bus-eta.service -p MemoryCurrent -p CPUUsageNSec -p CPUQuotaPerSecUSec -p MemoryMax
journalctl --user -u bus-eta.service -n 10 --no-pager
```

Stop collection with `systemctl --user disable --now bus-eta.service`; collected
data is retained. Restart it with `systemctl --user enable --now bus-eta.service`.

The service runs at low priority, with a ceiling of 5% of one CPU core and
96 MiB of process address space (`LimitAS`). It also sets `MemoryMax=96M` when
the memory cgroup controller is available; the pilot Pi has that controller
disabled, so `LimitAS` supplies the effective memory limit without kernel changes.
These are limits, not predicted resource use. Polling every route every 30 seconds
with full responses (28 KB each) was about 164k requests and 3 GiB a day; only
about a third of those polls found a bus on the route. SQLite writes are batched
per response.
Position observations and request diagnostics have a seven-day retention target.
Transition bounds are kept indefinitely: they are the running-time model's training
data, roughly 1.5 GB a year with indexes. Hourly pruning deletes in 5,000-row
transactions per table, repeating until the table is caught up. SQLite reuses freed
pages, so file size does not immediately shrink after cleanup.

After at least a week, assess missing/stale telemetry, segment coverage, daily
database growth, actual CPU/memory use, and predictions on later journeys against
the current estimator. A collection service running successfully is not evidence
that a learned estimator is already more accurate.

## Running-time model

`eta_model.py` learns segment running times from the collector database (read-only,
standard library only) and publishes them for the app every night:

```
segment minutes = base[segment] x dayFactors[day type][hour] x partFactors[weekday|weekend][part][hour]
```

- `base` is the time from reaching one stop to reaching the next, per route and
  direction, keyed by stop IDs. Transitions that jump several stops are shared
  across their segments; single-stop transitions alone overestimate short
  segments, because their quick traversals are the ones that skip a stop.
- `dayFactors` are city-wide hourly factors for Mon-Thu, Fri, Sat and Sun (service
  days: 00:00-03:59 belongs to the previous day). Mon-Thu behave alike; Friday
  midday and Saturday afternoon are distinct.
- `partFactors` are route-specific adjustments for each third of a trip, by
  weekday/weekend and hour.
- `elapsed[i]` is how long a bus has typically already been reported at stop `i`
  when someone looks (length-weighted: E[stay²] / 2E[stay]). It matters where stops
  are rarely reported and the stop ID stays unchanged for several stops.
- Every factor is observed/expected minutes shrunk towards 1 by `--prior-minutes`
  (default 30) of evidence, so thin cells fall back to the broader levels.
- Segments and stops with fewer than five samples export `null`; the app keeps
  using the timetable offset (and half of the current segment) for those.

### Accumulating data

All transitions are kept and every run learns from all of them. SQL groups them by
path span, day type, hour and recency first, so a run's memory and time grow with
the number of route segments rather than with the history. Per day type, the last
seven days carry at least 25% of the weight and older data shares the rest in
proportion to its size. While there is little history the recent days keep their
larger natural share; once older data outweighs them three to one, the 25% floor
lets changes such as roadworks show up within a week while old data keeps refining
the estimates.

### Nightly validation and publishing

`--publish REPO` runs after the service day ends (04:30, `bus-eta-model.timer`):

1. Each finished day of the last 28 that has not been checked yet is predicted with
   a model fitted only on the days before it, on a two-minute clock grid for every
   tracked bus, and compared with the app's timetable offsets (fetched from
   Kentkart). Per route results go into `data/model.sqlite3`, so each day is
   checked once.
2. A route direction gets `use: true` when the last 28 days hold at least 300
   predictions for buses 5-20 minutes away and the learned error is at most 90% of
   the timetable's. Every other route keeps the timetable.
3. The model is fitted on all data and committed as `data/segment-times.json` on
   top of `origin/main` in the clone at `REPO`, then pushed; a rejected push is
   rebased and retried. The clone belongs to the job: it is reset to `origin/main`
   on every run.

The checks cover continuously tracked buses only; buses held at a stop for over
two minutes or missing from the feed are excluded, so the errors are optimistic for
every method.

```powershell
python backend/eta_model.py --db backend/data/eta.sqlite3 --out segment-times.json  # fit only
python backend/eta_model.py --db backend/data/eta.sqlite3 --evaluate 14             # accuracy report
python -m unittest discover -s test -p "eta_*_test.py" -v
```

### Pi setup

The job pushes with the Pi's stored GitHub credentials, using its own clone:

```sh
git clone https://github.com/GamehunterKaan/canakkale-hat-sefer.git ~/bus-eta/repo
cp ~/bus-eta/backend/bus-eta-model.service ~/bus-eta/backend/bus-eta-model.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now bus-eta-model.timer
systemctl --user start bus-eta-model.service   # run once now
journalctl --user -u bus-eta-model.service -n 20 --no-pager
```

The first run checks every finished day still in the database, which takes a few
minutes; later runs check one day. The service runs at low priority with half a CPU
core and a 2 GiB address-space limit.
