# ETA observation pilot

The Pi collects every public route (29 routes, 57 route/direction pairs; OGR
student routes are excluded like in the app) every 30 seconds. This first stage records
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

## Running locally

```powershell
python backend/collector.py --once
python backend/collector.py --status
python -m unittest discover -s test -p eta_collector_test.py -v
```

`--once` performs two real Kentkart requests and returns a failure status if
either direction fails. `--status` reads the database without network access.
Repeat `--route` to collect more routes. Use `CODE:0` or `CODE:1` for a route
that exists in one direction only (Ç6 has no direction 1); a bare `CODE` uses
the `--direction` list. The journal gets one summary line per sweep plus a
warning per failed request; per-request detail is in the `cycles` table.

## Pi service

Copy `backend/` and `test/eta_collector_test.py` into `/home/pi/bus-eta/`, preserving
their relative paths. Install `backend/bus-eta.service` in
`/home/pi/.config/systemd/user/`. The default database is
`/home/pi/bus-eta/data/eta.sqlite3`, outside Jarvis and PiSecCam repositories.
Enable user lingering once if it is not already enabled:

```sh
sudo loginctl enable-linger pi
systemctl --user daemon-reload
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
These are limits, not predicted resource use. Each measured pair
of responses was about 55 KB: polling every 30 seconds is approximately
150 MiB/day of uncompressed incoming data. A sequential sweep of all public
routes measured about 1.1 MB and 20 seconds of request time (2026-10-17), or
roughly 3 GiB/day at a 30-second interval. SQLite writes are batched per response.
Position observations and request diagnostics have a seven-day retention target;
transition bounds have a thirty-day target. Hourly pruning deletes in 5,000-row
transactions per table, repeating until the table is caught up. SQLite reuses freed
pages, so file size does not immediately shrink after cleanup.

After at least a week, assess missing/stale telemetry, segment coverage, daily
database growth, actual CPU/memory use, and predictions on later journeys against
the current estimator. A collection service running successfully is not evidence
that a learned estimator is already more accurate.
