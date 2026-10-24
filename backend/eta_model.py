#!/usr/bin/env python3
"""Learn bus running times per route segment, day type and hour, and publish them nightly.

Reads the ETA collector's database without changing it. A stored transition is
the time from a bus reaching one observed stop to reaching the next observed
stop. Transitions are grouped in SQL by path span, day type, hour and recency,
so the fit stays the same size however much history accumulates. Spans that
skip stops are shared across their segments; using only single-stop spans would
overestimate quick segments, whose fast traversals are the ones that skip.

segment minutes = base x (weekday|weekend, hour) x (day type, hour) x (route part, weekday|weekend, hour)

Day types are Mon-Thu, Fri, Sat and Sun; parts are thirds of a trip. Each factor
is observed/expected minutes in its cell, shrunk towards 1 by --prior-minutes of
evidence. Per day type, the last seven days carry at least a quarter of the
weight and all older data shares the rest, so recent changes show up quickly
while old data keeps contributing.

--publish predicts each finished day from a model fitted only on the days before
it, fits the model on everything, marks the routes that beat the timetable over
the last four weeks, and commits the model to the repository.
"""

import argparse
import calendar
import collections
import json
import math
from pathlib import Path
import sqlite3
import subprocess
import sys
import time

TZ_MS = 3 * 3600_000                 # Türkiye has no daylight saving time
SERVICE_DAY_SHIFT_MS = 4 * 3600_000  # 00:00-03:59 belongs to the previous service day
DAY_MS = 86_400_000
DAY_TYPES = ("Mon-Thu", "Fri", "Sat", "Sun")
DAY_TYPE_OF_DOW = (0, 0, 0, 0, 1, 2, 3)
PARTS = 3
MAX_HOP = 8
LEVELS = ("week", "daytype", "part")
MIN_SAMPLES = 5
RECENT_DAYS = 7
RECENT_SHARE = 0.25
GATE_DAYS = 28
GATE_POINTS = 300
GATE_RATIO = 0.9  # learned times must have at most 90% of the timetable's error
MODEL_FILE = "data/segment-times.json"
APP = "app (timetable offsets)"

Span = collections.namedtuple("Span", "v bus a b minutes start seen hi")
Group = collections.namedtuple("Group", "v a b day_type hour recent n minutes squares")
_slots = {}

_START = "received_ms - 15000 - (duration_low_ms + duration_high_ms) / 2"  # ms the bus reached from_idx
AGGREGATE = f"""
SELECT version, from_idx, to_idx, day_type, hour, recent, COUNT(*), SUM(m), SUM(m * m) FROM (
    SELECT version, from_idx, to_idx, (duration_low_ms + duration_high_ms) / 120000.0 AS m,
           CASE CAST(strftime('%w', s / 1000.0, 'unixepoch', '{(TZ_MS - SERVICE_DAY_SHIFT_MS) // 3600_000:+d} hours') AS INTEGER)
                WHEN 5 THEN 1 WHEN 6 THEN 2 WHEN 0 THEN 3 ELSE 0 END AS day_type,
           CAST(strftime('%H', s / 1000.0, 'unixepoch', '{TZ_MS // 3600_000:+d} hours') AS INTEGER) AS hour,
           s >= :recent_from AS recent
    FROM (SELECT *, {_START} AS s FROM transitions)
    WHERE to_idx > from_idx AND to_idx - from_idx <= :max_hop AND s < :until
)
GROUP BY version, from_idx, to_idx, day_type, hour, recent
"""
STATE = """
CREATE TABLE IF NOT EXISTS validated (day TEXT PRIMARY KEY, at_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS validation (
  day TEXT NOT NULL, route TEXT NOT NULL, points INTEGER NOT NULL,
  app_abs REAL NOT NULL, model_abs REAL NOT NULL, app_sooner INTEGER NOT NULL, model_sooner INTEGER NOT NULL,
  PRIMARY KEY (day, route)
);
"""


def service_slot(ms):
    """(day type of the service day: 0 Mon-Thu, 1 Fri, 2 Sat, 3 Sun; local clock hour)."""
    bucket = int(ms // 3_600_000)
    if bucket not in _slots:
        dow = time.gmtime((bucket * 3_600_000 + TZ_MS - SERVICE_DAY_SHIFT_MS) / 1000).tm_wday
        _slots[bucket] = (DAY_TYPE_OF_DOW[dow], time.gmtime((bucket * 3_600_000 + TZ_MS) / 1000).tm_hour)
    return _slots[bucket]


def service_day(ms):
    return time.strftime("%Y-%m-%d", time.gmtime((ms + TZ_MS - SERVICE_DAY_SHIFT_MS) / 1000))


def day_start(day):
    """04:00 local time on that service day, in ms."""
    return calendar.timegm(time.strptime(day, "%Y-%m-%d")) * 1000 + SERVICE_DAY_SHIFT_MS - TZ_MS


def level_key(level, rd, part, day_type, hour):
    if level == "week":
        return day_type >= 2, hour
    if level == "daytype":
        return day_type, hour
    return rd, part, day_type >= 2, hour


def connect(path):
    return sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)


def load_paths(db):
    return {v: {"rd": f"{route}|{direction}", "stops": json.loads(stops), "last_seen": seen}
            for v, route, direction, stops, seen in
            db.execute("SELECT version, route, direction, stops_json, last_seen_ms FROM paths")}


def aggregate(db, recent_from, until=2**62):
    """Transitions starting before `until`, grouped; those starting from `recent_from` on are recent."""
    return [Group(*row) for row in db.execute(AGGREGATE, {"recent_from": recent_from, "until": until, "max_hop": MAX_HOP})]


def spans_between(db, start, end):
    """Raw transitions received in [start, end), for following individual buses."""
    return [Span(v, bus, a, b, (lo + hi) / 120000, seen - 15000 - (lo + hi) / 2, seen, hi)
            for seen, v, bus, a, b, lo, hi in db.execute(
                "SELECT received_ms, version, bus_id, from_idx, to_idx, duration_low_ms, duration_high_ms "
                "FROM transitions WHERE received_ms >= ? AND received_ms < ?", (start, end))]


def current_versions(paths):
    """Latest path version per route|direction."""
    latest = {}
    for v, p in paths.items():
        if p["rd"] not in latest or p["last_seen"] > paths[latest[p["rd"]]]["last_seen"]:
            latest[p["rd"]] = v
    return latest


def recency_weights(groups, share=RECENT_SHARE):
    """Per day type: the recent days carry at least `share` of the weight, older data the rest.

    Within each side, weight follows the number of samples. With little history the
    recent days keep their larger natural share. Weights average 1 per sample, so the
    shrinkage prior keeps its meaning.
    """
    counts = collections.defaultdict(lambda: [0, 0])
    for g in groups:
        counts[g.day_type][g.recent] += g.n
    weights = {}
    for day_type, (older, recent) in counts.items():
        total = older + recent
        part = 1.0 if not older else 0.0 if not recent else max(share, recent / total)
        weights[(day_type, 1)] = part * total / recent if recent else 0.0
        weights[(day_type, 0)] = (1 - part) * total / older if older else 0.0
    return weights


class Model:
    def __init__(self, paths, prior_minutes=30.0, levels=LEVELS, recent_share=RECENT_SHARE):
        self.paths, self.prior, self.levels, self.recent_share = paths, prior_minutes, tuple(levels), recent_share
        self.keys = {v: [(p["rd"], s["id"], t["id"]) for s, t in zip(p["stops"], p["stops"][1:])]
                     for v, p in paths.items()}
        self.theta, self.samples, self.part, self._cache = {}, collections.Counter(), {}, {}
        self.elapsed, self.stays, self.recency = {}, collections.Counter(), {}
        self.factors = {level: {} for level in self.levels}

    def fit(self, groups, rounds=4):
        groups = [g for g in groups if g.v in self.paths]
        weight = recency_weights(groups, self.recent_share)
        w = [weight[(g.day_type, g.recent)] for g in groups]
        seg = [self.keys[g.v][g.a:g.b] for g in groups]
        theta = collections.defaultdict(lambda: 1.0)
        num, den = collections.defaultdict(float), collections.defaultdict(float)
        for g, keys, wg in zip(groups, seg, w):
            if len(keys) == 1:
                num[keys[0]] += wg * g.minutes
                den[keys[0]] += wg * g.n
        theta.update({k: num[k] / den[k] for k in num if den[k] > 0})
        for _ in range(20):  # base minutes alone: share multi-stop spans by current estimates
            theta = self._update_theta(groups, seg, w, theta, [[1.0] * len(k) for k in seg])
        self._assign_parts(theta)

        ctx = [[tuple(level_key(lv, k[0], self.part.get(k, 0), g.day_type, g.hour) for lv in self.levels) for k in keys]
               for g, keys in zip(groups, seg)]
        for _ in range(rounds):
            mult = [[self._mult(c) for c in row] for row in ctx]
            theta = self._update_theta(groups, seg, w, theta, mult)
            for li, level in enumerate(self.levels):
                mult = [[self._mult(c) for c in row] for row in ctx]
                obs, exp = collections.defaultdict(float), collections.defaultdict(float)
                for g, keys, wg, row, ms in zip(groups, seg, w, ctx, mult):
                    expected = [theta[k] * m for k, m in zip(keys, ms)]
                    tot = sum(expected) or 1.0
                    for c, e in zip(row, expected):
                        own = self.factors[level].get(c[li], 1.0)
                        obs[c[li]] += wg * g.minutes * e / tot
                        exp[c[li]] += wg * g.n * e / own
                self.factors[level] = {c: (obs[c] + self.prior) / (exp[c] + self.prior) for c in obs}
        self.theta = dict(theta)
        for g, keys in zip(groups, seg):
            for k in keys:
                self.samples[k] += g.n
        # A bus stays reported at a stop until the next stop change, which can be several stops
        # later where stops are rarely reported. Someone looking at a random moment more often
        # lands in a long stay, so the expected time already spent is E[stay^2] / (2 E[stay]).
        square, linear = collections.defaultdict(float), collections.defaultdict(float)
        for g, keys, wg, row in zip(groups, seg, w, ctx):
            m = self._mult(row[0])  # stays in base units, like theta
            square[keys[0][:2]] += wg * g.squares / (m * m)
            linear[keys[0][:2]] += wg * g.minutes / m
            self.stays[keys[0][:2]] += g.n
        self.elapsed = {stop: square[stop] / (2 * linear[stop]) for stop in linear if linear[stop] > 0}
        counts = collections.defaultdict(lambda: [0, 0])
        for g in groups:
            counts[g.day_type][g.recent] += g.n
        self.recency = {DAY_TYPES[d]: {"recentShare": round(weight[(d, 1)] * recent / (older + recent), 3),
                                       "recentSamples": recent, "olderSamples": older}
                        for d, (older, recent) in sorted(counts.items())}
        return self

    def _mult(self, c):
        m = 1.0
        for level, key in zip(self.levels, c):
            m *= self.factors[level].get(key, 1.0)
        return m

    @staticmethod
    def _update_theta(groups, seg, w, theta, mult):
        num, den = collections.defaultdict(float), collections.defaultdict(float)
        for g, keys, wg, ms in zip(groups, seg, w, mult):
            expected = [theta[k] * m for k, m in zip(keys, ms)]
            tot = sum(expected) or 1.0
            for k, m, e in zip(keys, ms, expected):
                num[k] += wg * g.minutes * e / tot
                den[k] += wg * g.n * m
        new = collections.defaultdict(lambda: 1.0)
        new.update({k: num[k] / den[k] for k in num if den[k] > 0})
        return new

    def _assign_parts(self, theta):
        # Equal thirds of each path's base time; the newest path version decides shared segments.
        for v in sorted(self.paths, key=lambda v: self.paths[v]["last_seen"]):
            keys = self.keys[v]
            total, cum = sum(theta[k] for k in keys) or 1.0, 0.0
            for k in keys:
                self.part[k] = min(PARTS - 1, int(PARTS * (cum + theta[k] / 2) / total))
                cum += theta[k]

    def multiplier(self, key, ms):
        slot = service_slot(ms)
        cached = self._cache.get((key, slot))
        if cached is None:
            cached = self._cache[(key, slot)] = self._mult(tuple(
                level_key(lv, key[0], self.part.get(key, 0), *slot) for lv in self.levels))
        return cached

    def _base(self, key, k, fallback):
        if self.samples[key] >= MIN_SAMPLES:
            return self.theta[key]
        return fallback[k] if fallback else 1.5

    def cumulative(self, v, i, ms, live=True, fallback=None, until=math.inf):
        """Predicted minutes from now to reaching each later stop, for a bus last reported at stop i.

        A live bus has already spent part of its stay at stop i: subtract the learned elapsed
        stay, or half of the first segment where the stop has too few samples.
        """
        keys, total = self.keys[v], 0.0
        if i >= len(keys):
            return
        if live:
            stop = keys[i][:2]
            elapsed = self.elapsed[stop] if self.stays[stop] >= MIN_SAMPLES else self._base(keys[i], i, fallback) / 2
            total = -elapsed * self.multiplier(keys[i], ms)
        for k in range(i, len(keys)):
            if total > until:
                return
            total += self._base(keys[k], k, fallback) * self.multiplier(keys[k], ms + max(0.0, total) * 60000)
            yield k + 1, max(0.0, total)

    def export(self, validation=None):
        def f(level, key):
            return self.factors.get(level, {}).get(key, 1.0)
        routes = {}
        for rd, v in sorted(current_versions(self.paths).items()):
            keys = self.keys[v]
            base = [round(self.theta[k], 3) if self.samples[k] >= MIN_SAMPLES else None for k in keys]
            if not any(base):
                continue
            routes[rd] = {
                "stops": [s["id"] for s in self.paths[v]["stops"]],
                "base": base,
                "elapsed": [round(self.elapsed[k[:2]], 3) if self.stays[k[:2]] >= MIN_SAMPLES else None for k in keys],
                "part": [self.part.get(k, 0) for k in keys],
                "partFactors": {name: [[round(f("part", (rd, p, weekend, h)), 3) for h in range(24)]
                                       for p in range(PARTS)] for name, weekend in (("weekday", False), ("weekend", True))},
            }
            if validation is not None:
                routes[rd]["use"] = bool(validation.get(rd, {}).get("use"))
                if rd in validation:
                    routes[rd]["validation"] = validation[rd]
        return {
            "generatedAt": int(time.time() * 1000), "priorMinutes": self.prior, "recency": self.recency,
            "formula": "segment k minutes = base[k] * dayFactors[day type][hour] * partFactors[weekday|weekend][part[k]][hour]; "
                       "a live bus reported at stop i has already spent elapsed[i] times the same factors; "
                       "routes with use=false keep the timetable",
            "timeKeys": "day type of the service day (00:00-03:59 counts as the previous day): Mon-Thu, Fri, Sat, Sun; "
                        "weekend = Sat and Sun; hour = local clock hour when the bus reaches the segment",
            "dayFactors": {name: [round(f("week", (t >= 2, h)) * f("daytype", (t, h)), 3) for h in range(24)]
                           for t, name in enumerate(DAY_TYPES)},
            "routes": routes,
        }


def ride_sched(stops, i, j):
    """Mirror of core.js _rideMins: GTFS offsets, else 1.5 min per stop."""
    arr = stops[j]["arr"]
    dep = stops[i]["dep"] or stops[i]["arr"]
    if arr > 0 and arr > dep and (dep > 0 or i == 0):
        return (arr - dep) / 60
    return max(0, j - i) * 1.5


def chains(spans):
    """Consecutive stop arrivals of one bus: [(stop idx, reached ms, first seen there ms)]."""
    by_bus = collections.defaultdict(list)
    for s in spans:
        by_bus[(s.v, s.bus)].append(s)
    out = []
    for (v, _), rows in by_bus.items():
        rows.sort(key=lambda s: s.seen)
        cur, prev = [], None
        for s in rows:
            # s.seen - s.hi is the last poll at s.a; it must fall just before prev reached s.a.
            if prev is not None and s.a == prev.b and 0 < prev.seen - (s.seen - s.hi) <= 120_000:
                cur[-1] = (prev.b, (prev.seen + s.seen - s.hi) / 2, prev.seen)
            else:
                if len(cur) > 1:
                    out.append((v, cur))
                cur = []
            cur.append((s.b, s.seen - 15000, s.seen))
            prev = s
        if len(cur) > 1:
            out.append((v, cur))
    return out


class Scores:
    def __init__(self):
        self.acc = collections.defaultdict(lambda: [0, 0.0, 0.0, 0, 0])

    def add(self, keys, error):
        for key in keys:
            a = self.acc[key]
            a[0] += 1; a[1] += abs(error); a[2] += error; a[3] += error > 2; a[4] += error < -2

    def row(self, key):
        n, ae, e, sooner, later = self.acc[key]
        return (n, ae / n, e / n, sooner / n, later / n) if n else (0, math.nan, math.nan, math.nan, math.nan)


def horizon(minutes):
    return "0-5" if minutes < 5 else "5-10" if minutes < 10 else "10-20" if minutes < 20 else "20-40"


def score(models, paths, offsets, spans, scores, step_ms=120_000):
    """Compare predictions with actual arrivals of the tracked buses in `spans`.

    Prediction times lie on a fixed clock grid, like riders checking at random moments.
    """
    current = set(current_versions(paths).values())
    for v, entries in chains(spans):
        if v not in current or v not in offsets:
            continue
        stops, rd = offsets[v], paths[v]["rd"]
        fallback = [max(0, (stops[k + 1]["arr"] - stops[k]["arr"]) / 60) or 1.5 for k in range(len(stops) - 1)]
        at = {idx: reached for idx, reached, _ in entries}
        for (i, _, seen), (_, next_reached, _) in zip(entries, entries[1:]):
            for t in range(-(-int(seen) // step_ms) * step_ms, int(next_reached), step_ms):
                day_type = DAY_TYPES[service_slot(t)[0]]
                preds = {name: dict(m.cumulative(v, i, t, fallback=fallback, until=60)) for name, m in models.items()}
                for j, reached in at.items():
                    actual = (reached - t) / 60000
                    if j <= i or actual > 40 or any(j not in p for p in preds.values()):
                        continue
                    keys = [("all", horizon(actual))]
                    if 5 <= actual < 20:
                        keys += [("days", day_type), ("route", rd)]
                    shown = {APP: ride_sched(stops, i, j), **{name: p[j] for name, p in preds.items()}}
                    for name, p in shown.items():
                        scores[name].add(keys + [("shown", horizon(p) if p < 40 else "40+")], p - actual)


def fit_before(db, paths, day, prior_minutes=30.0, **kw):
    """A model fitted only on transitions before `day`, its last week counted as recent."""
    start = day_start(day)
    return Model(paths, prior_minutes, **kw).fit(aggregate(db, start - RECENT_DAYS * DAY_MS, until=start))


def finished_days(db, today, count):
    """Service days with data among the `count` days before `today`, oldest first."""
    days = []
    for k in range(count, 0, -1):
        start = day_start(today) - k * DAY_MS
        if db.execute("SELECT 1 FROM transitions WHERE received_ms >= ? AND received_ms < ? LIMIT 1",
                      (start, start + DAY_MS)).fetchone():
            days.append(service_day(start))
    return days


def evaluate(db, paths, offsets, days, variants, log=print):
    """Predict each day from a model fitted on the days before it."""
    scores = {name: Scores() for name in (APP, *variants)}
    for day in days:
        models = {name: fit_before(db, paths, day, **cfg) for name, cfg in variants.items()}
        start = day_start(day)
        score(models, paths, offsets, spans_between(db, start, start + DAY_MS), scores)
        log(f"  {day}: predicted from earlier days")
    return scores


def gate(state, today):
    """Per route|direction over the last GATE_DAYS days: use learned times when they clearly beat the timetable."""
    since = service_day(day_start(today) - GATE_DAYS * DAY_MS)
    out = {}
    for route, days, n, app, model, app_sooner, model_sooner in state.execute(
            "SELECT route, COUNT(*), SUM(points), SUM(app_abs), SUM(model_abs), SUM(app_sooner), SUM(model_sooner) "
            "FROM validation WHERE day >= ? AND day < ? GROUP BY route", (since, today)):
        if not n:
            continue
        out[route] = {"days": days, "points": n, "appMae": round(app / n, 2), "modelMae": round(model / n, 2),
                      "appSooner": round(app_sooner / n, 3), "modelSooner": round(model_sooner / n, 3),
                      "use": n >= GATE_POINTS and model <= GATE_RATIO * app}
    return out


def publish(repo, text, day):
    """Commit the model on top of origin/main and push it. The clone belongs to this job."""
    def git(*args, check=True):
        return subprocess.run(["git", "-C", str(repo), *args], check=check, capture_output=True, text=True)
    git("fetch", "--quiet", "origin")
    git("reset", "--hard", "--quiet", "origin/main")
    target = Path(repo) / MODEL_FILE
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8", newline="\n")
    if not git("status", "--porcelain", "--", MODEL_FILE).stdout.strip():
        return False
    git("add", "--", MODEL_FILE)
    git("commit", "--quiet", "-m", f"chore: update segment times {day}")
    for _ in range(3):
        if git("push", "--quiet", "origin", "HEAD:main", check=False).returncode == 0:
            return True
        git("pull", "--rebase", "--quiet", "origin", "main")  # someone pushed in between
    raise RuntimeError("push to origin/main was rejected three times")


def nightly(db_path, state_path, repo, prior_minutes=30.0, now_ms=None, offsets=None):
    """Validate finished days not yet checked, fit on everything, gate routes, publish."""
    today = service_day(time.time() * 1000 if now_ms is None else now_ms)
    db = connect(db_path)
    state = sqlite3.connect(state_path)
    try:
        state.executescript(STATE)
        paths = load_paths(db)
        offsets = fetch_offsets(paths) if offsets is None else offsets
        done = {d for (d,) in state.execute("SELECT day FROM validated")}
        for day in finished_days(db, today, GATE_DAYS):
            if day in done:
                continue
            scores = evaluate(db, paths, offsets, [day], {"model": {"prior_minutes": prior_minutes}}, log=print)
            rows = [(day, key[1], a[0], a[1], scores["model"].acc[key][1], a[3], scores["model"].acc[key][3])
                    for key, a in scores[APP].acc.items() if key[0] == "route"]
            with state:
                state.executemany("INSERT OR REPLACE INTO validation VALUES (?,?,?,?,?,?,?)", rows)
                state.execute("INSERT OR REPLACE INTO validated VALUES (?,?)", (day, int(time.time() * 1000)))
        checked = gate(state, today)
        model = Model(paths, prior_minutes).fit(aggregate(db, day_start(today) - RECENT_DAYS * DAY_MS))
        text = json.dumps(model.export(checked), ensure_ascii=False, separators=(",", ":"))
        pushed = publish(repo, text, today)
        used = sorted(rd for rd, r in checked.items() if r["use"])
        print(f"{today}: learned times for {len(used)} of {len(checked)} validated route directions; "
              f"{'pushed' if pushed else 'unchanged'}; recency {json.dumps(model.recency)}")
        return pushed
    finally:
        db.close()
        state.close()


def fetch_offsets(paths, tries=3):
    """Current timetable offsets per path version, from the same Kentkart endpoint the collector polls."""
    sys.path.insert(0, str(Path(__file__).parent))
    import collector
    out = {}
    for rd, v in current_versions(paths).items():
        route, direction = rd.split("|")
        for attempt in range(tries):
            try:
                payload, _ = collector.fetch_payload(route, direction, 10)
                break
            except Exception as exc:
                if attempt == tries - 1:
                    raise RuntimeError(f"timetable offsets for {rd}: {type(exc).__name__}: {exc}") from exc
                time.sleep(5)
        for p in payload.get("pathList") or []:
            stops = p.get("busStopList") or []
            if [str(s.get("stopId")) for s in stops] == [s["id"] for s in paths[v]["stops"]]:
                out[v] = [{"arr": int(s.get("arrival_offset") or 0), "dep": int(s.get("departure_offset") or 0)} for s in stops]
        time.sleep(0.2)
    return out


def report(scores):
    names = list(scores)
    line = lambda r: f"MAE {r[1]:4.2f}  bias {r[2]:+5.2f}  sooner {r[3]:4.0%}  later {r[4]:4.0%}"
    print("\nerror = predicted - actual minutes; 'sooner' = the bus came >2 min before the shown time")
    for h in ("0-5", "5-10", "10-20", "20-40"):
        print(f" bus actually {h} min away (n={scores[APP].row(('all', h))[0]})")
        for name in names:
            print(f"   {name:26} {line(scores[name].row(('all', h)))}")
    print("\n calibration by shown time (bias > 0: buses come sooner than shown)")
    for h in ("0-5", "5-10", "10-20", "20-40"):
        print(f" shown {h} min")
        for name in names:
            print(f"   {name:26} {line(scores[name].row(('shown', h)))}")
    print("\n MAE by day type, buses 5-20 min away: " + " / ".join(names))
    for day_type in DAY_TYPES:
        print(f"   {day_type:8} n={scores[APP].row(('days', day_type))[0]:7}  "
              + "  ".join(f"{scores[name].row(('days', day_type))[1]:4.2f}" for name in names))
    print(f"\n per route, buses 5-20 min away: MAE and sooner, app -> {names[-1]}")
    routes = sorted({k[1] for k in scores[APP].acc if k[0] == "route"}, key=lambda rd: -scores[APP].row(("route", rd))[0])
    for rd in routes:
        a, m = scores[APP].row(("route", rd)), scores[names[-1]].row(("route", rd))
        print(f"   {rd:9} n={a[0]:6}  MAE {a[1]:4.2f} -> {m[1]:4.2f}   sooner {a[3]:4.0%} -> {m[3]:4.0%}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", type=Path, default=Path(__file__).parent / "data" / "eta.sqlite3")
    parser.add_argument("--out", type=Path, help="Write the model fitted on all data as JSON.")
    parser.add_argument("--evaluate", type=int, metavar="DAYS",
                        help="Predict each of the last DAYS finished days from the days before it and compare with "
                             "the app's timetable offsets (fetches current offsets).")
    parser.add_argument("--publish", type=Path, metavar="REPO",
                        help="Nightly run: validate new days, fit, mark routes that beat the timetable, "
                             f"commit {MODEL_FILE} in this clone and push it.")
    parser.add_argument("--state", type=Path, default=Path(__file__).parent / "data" / "model.sqlite3",
                        help="Validation history kept by --publish.")
    parser.add_argument("--prior-minutes", type=float, default=30.0)
    args = parser.parse_args()
    if not (args.out or args.evaluate or args.publish):
        parser.error("nothing to do: pass --out, --evaluate or --publish")
    if args.publish:
        nightly(args.db, args.state, args.publish, args.prior_minutes)
        return 0
    db = connect(args.db)
    try:
        paths = load_paths(db)
        today = service_day(time.time() * 1000)
        if args.evaluate:
            variants = {"base times only": {"levels": (), "prior_minutes": args.prior_minutes},
                        "model": {"prior_minutes": args.prior_minutes}}
            report(evaluate(db, paths, fetch_offsets(paths), finished_days(db, today, args.evaluate), variants))
        if args.out:
            model = Model(paths, prior_minutes=args.prior_minutes).fit(aggregate(db, day_start(today) - RECENT_DAYS * DAY_MS))
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(json.dumps(model.export(), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            print(f"wrote {args.out} ({args.out.stat().st_size} bytes)")
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
