#!/usr/bin/env python3
"""Collect bus observations for an ETA pilot; never changes passenger ETAs."""

import argparse
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import signal
import sqlite3
import threading
import time
import urllib.parse
import urllib.request

API = "https://service.kentkart.com/rl1/web/pathInfo"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_GAP_MS = 120_000
MAX_SPEED_MPS = 45
PRUNE_BATCH = 5000
SCHEMA = """
CREATE TABLE IF NOT EXISTS paths (
  version TEXT PRIMARY KEY, route TEXT NOT NULL, direction TEXT NOT NULL,
  path_code TEXT NOT NULL, stops_json TEXT NOT NULL, last_seen_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cursors (
  version TEXT NOT NULL, bus_id TEXT NOT NULL, trip_id TEXT NOT NULL,
  stop_idx INTEGER NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
  last_seen_ms INTEGER NOT NULL, last_motion_ms INTEGER NOT NULL,
  enter_low_ms INTEGER, enter_high_ms INTEGER,
  PRIMARY KEY (version, bus_id)
);
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY, received_ms INTEGER NOT NULL, version TEXT NOT NULL,
  bus_id TEXT NOT NULL, trip_id TEXT NOT NULL, stop_idx INTEGER NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL, reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS observations_time ON observations(received_ms);
CREATE TABLE IF NOT EXISTS transitions (
  id INTEGER PRIMARY KEY, received_ms INTEGER NOT NULL, version TEXT NOT NULL,
  bus_id TEXT NOT NULL, trip_id TEXT NOT NULL,
  from_idx INTEGER NOT NULL, to_idx INTEGER NOT NULL,
  duration_low_ms INTEGER NOT NULL, duration_high_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS transitions_time ON transitions(received_ms);
CREATE INDEX IF NOT EXISTS transitions_segment
  ON transitions(version, from_idx, to_idx);
CREATE TABLE IF NOT EXISTS cycles (
  id INTEGER PRIMARY KEY, received_ms INTEGER NOT NULL,
  route TEXT NOT NULL, direction TEXT NOT NULL, ok INTEGER NOT NULL,
  response_bytes INTEGER NOT NULL, elapsed_ms INTEGER NOT NULL,
  observations INTEGER NOT NULL, transitions INTEGER NOT NULL,
  ignored INTEGER NOT NULL, error TEXT
);
CREATE INDEX IF NOT EXISTS cycles_time ON cycles(received_ms);
"""


def connect(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=NORMAL")
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript(SCHEMA)
    return db


def distance_m(lat1, lng1, lat2, lng2):
    r1, r2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((r2 - r1) / 2) ** 2
    a += math.cos(r1) * math.cos(r2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    return 6_371_000 * 2 * math.asin(min(1, math.sqrt(a)))


def coordinate(value, lower, upper):
    number = float(value)
    if not math.isfinite(number) or not lower <= number <= upper:
        raise ValueError("invalid coordinate")
    return round(number, 6)


def normalized_path(path, route, direction):
    if str(path.get("displayRouteCode", "")) != route or str(path.get("direction", "")) != direction:
        return None
    stops = []
    for stop in path.get("busStopList") or []:
        seq = int(stop["seq"])
        stop_id = str(stop.get("stopId") or "")
        if seq < 1 or not stop_id:
            raise ValueError("invalid stop identity")
        stops.append({"seq": seq, "id": stop_id,
                      "lat": coordinate(stop["lat"], 39.95, 40.25),
                      "lng": coordinate(stop["lng"], 26.30, 26.55)})
    stops.sort(key=lambda s: s["seq"])
    if len(stops) < 2 or len({s["seq"] for s in stops}) != len(stops):
        raise ValueError("invalid stop sequence")
    code = str(path.get("path_code") or "")
    encoded = json.dumps([route, direction, code, stops], ensure_ascii=False, separators=(",", ":"))
    version = hashlib.sha256(encoded.encode()).hexdigest()[:24]
    return version, code, stops


def ingest(db, payload, route, direction, received_ms):
    """Record receipt times, not claimed GPS fix times or exact stop arrivals.

    A stop change is bracketed by consecutive polls. Transition durations retain
    both bounds. First sightings and questionable movement cannot train a model.
    Call inside a transaction, so a malformed source cannot publish partial data.
    """
    result = payload.get("result")
    if not isinstance(result, dict) or str(result.get("code")) != "0":
        raise ValueError("Kentkart did not report success")
    paths = payload.get("pathList")
    if not isinstance(paths, list):
        raise ValueError("missing pathList")
    counts = {"observations": 0, "transitions": 0, "ignored": 0}
    matched = 0
    for path in paths:
        normalized = normalized_path(path, route, direction)
        if normalized is None:
            continue
        matched += 1
        version, code, stops = normalized
        db.execute("INSERT INTO paths VALUES (?,?,?,?,?,?) ON CONFLICT(version) DO UPDATE SET last_seen_ms=excluded.last_seen_ms",
                   (version, route, direction, code, json.dumps(stops), received_ms))
        indices = {}
        for idx, stop in enumerate(stops):
            indices.setdefault(stop["id"], []).append(idx)
        buses = path.get("busList") or []
        if not isinstance(buses, list):
            raise ValueError("invalid busList")
        seen_bus_ids = set()
        for bus in buses:
            bus_id, trip_id = str(bus.get("busId") or ""), str(bus.get("tripId") or "")
            choices = indices.get(str(bus.get("stopId") or ""), [])
            # Repeated stop IDs on loops need a route-progress resolver first.
            if not bus_id or not trip_id or len(choices) != 1 or bus_id in seen_bus_ids:
                counts["ignored"] += 1
                continue
            seen_bus_ids.add(bus_id)
            try:
                lat = coordinate(bus["lat"], 39.95, 40.25)
                lng = coordinate(bus["lng"], 26.30, 26.55)
            except (KeyError, TypeError, ValueError):
                counts["ignored"] += 1
                continue
            idx = choices[0]
            old = db.execute("SELECT * FROM cursors WHERE version=? AND bus_id=?", (version, bus_id)).fetchone()
            reason, low, high, motion = "first_seen", None, None, received_ms
            if old is not None:
                gap = received_ms - old["last_seen_ms"]
                if gap <= 0:
                    counts["ignored"] += 1
                    continue
                moved = distance_m(old["lat"], old["lng"], lat, lng)
                if old["trip_id"] != trip_id:
                    reason = "trip_changed"
                elif gap > MAX_GAP_MS:
                    reason = "observation_gap"
                elif moved / (gap / 1000) > MAX_SPEED_MPS:
                    reason = "position_jump"
                elif idx < old["stop_idx"]:
                    reason = "backward_progress"
                elif received_ms - old["last_motion_ms"] > MAX_GAP_MS:
                    # Repeated coordinates can mean a stopped bus OR stale telemetry.
                    # Keep the observation but exclude the ambiguous duration.
                    reason = "stationary_or_stale"
                elif idx == old["stop_idx"]:
                    reason = "position" if (lat, lng) != (old["lat"], old["lng"]) else "unchanged"
                    low, high = old["enter_low_ms"], old["enter_high_ms"]
                    motion = received_ms if moved >= 5 else old["last_motion_ms"]
                else:
                    reason = "stop_changed"
                    low, high = old["last_seen_ms"], received_ms
                    if old["enter_low_ms"] is not None:
                        duration_low = max(0, low - old["enter_high_ms"])
                        duration_high = high - old["enter_low_ms"]
                        if 0 < duration_high <= 20 * 60_000:
                            db.execute("INSERT INTO transitions(received_ms,version,bus_id,trip_id,from_idx,to_idx,duration_low_ms,duration_high_ms) VALUES (?,?,?,?,?,?,?,?)",
                                       (received_ms, version, bus_id, trip_id, old["stop_idx"], idx, duration_low, duration_high))
                            counts["transitions"] += 1
                # Preserve an old motion timestamp only within the same, valid stop.
            if reason != "unchanged":
                db.execute("INSERT INTO observations(received_ms,version,bus_id,trip_id,stop_idx,lat,lng,reason) VALUES (?,?,?,?,?,?,?,?)",
                           (received_ms, version, bus_id, trip_id, idx, lat, lng, reason))
                counts["observations"] += 1
            db.execute("INSERT OR REPLACE INTO cursors VALUES (?,?,?,?,?,?,?,?,?,?)",
                       (version, bus_id, trip_id, idx, lat, lng, received_ms, motion, low, high))
    if not matched:
        raise ValueError("no matching route and direction")
    return counts


def fetch_payload(route, direction, timeout):
    query = urllib.parse.urlencode({"region": "007", "lang": "tr", "authType": "4",
                                  "resultType": "111", "displayRouteCode": route,
                                  "direction": direction, "_": int(time.time() * 1000)})
    req = urllib.request.Request(API + "?" + query, headers={
        "User-Agent": "17hatsefer-eta-pilot/1.0", "Accept": "application/json",
        "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        raw = response.read(MAX_RESPONSE_BYTES + 1)
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ValueError("response exceeds 2 MiB")
    return json.loads(raw), len(raw)


def collect_once(db, targets, timeout, stop=None, retry_state=None):
    """Poll each (route, direction) target; returns the number of successes."""
    successes, failures_total, sweep_started = 0, 0, time.monotonic()
    totals = {"observations": 0, "transitions": 0, "ignored": 0, "bytes": 0}
    for route, direction in targets:
        if stop is not None and stop.is_set():
            break
        key = (route, direction)
        previous_retry = (retry_state or {}).get(key, (0, 0))
        if retry_state is not None and time.monotonic() < previous_retry[1]:
            continue
        started = time.monotonic()
        size, error = 0, None
        counts = {"observations": 0, "transitions": 0, "ignored": 0}
        try:
            payload, size = fetch_payload(route, direction, timeout)
            received_ms = int(time.time() * 1000)
            with db:
                counts = ingest(db, payload, route, direction, received_ms)
            successes += 1
        except Exception as exc:
            received_ms = int(time.time() * 1000)
            error = f"{type(exc).__name__}: {exc}"[:300]
            failures_total += 1
        if retry_state is not None:
            failures = previous_retry[0] + 1 if error else 0
            delay = min(300, 30 * 2 ** min(failures - 1, 4)) if failures else 0
            retry_state[key] = (failures, time.monotonic() + delay)
        elapsed = round((time.monotonic() - started) * 1000)
        with db:
            db.execute("INSERT INTO cycles(received_ms,route,direction,ok,response_bytes,elapsed_ms,observations,transitions,ignored,error) VALUES (?,?,?,?,?,?,?,?,?,?)",
                       (received_ms, route, direction, int(error is None), size, elapsed,
                        counts["observations"], counts["transitions"], counts["ignored"], error))
        for name, value in counts.items():
            totals[name] += value
        totals["bytes"] += size
        # Per-request detail lives in the cycles table; only failures go to the journal.
        if error:
            logging.warning(json.dumps({"route": route, "direction": direction, "elapsed_ms": elapsed, "error": error}, ensure_ascii=False))
    logging.info(json.dumps({"ok": successes, "failed": failures_total, **totals,
                             "elapsed_ms": round((time.monotonic() - sweep_started) * 1000)}))
    return successes


def prune(db, now_ms, sample_days, transition_days):
    # Bounded batches avoid a large blocking cleanup on the Pi's storage. Repeat
    # until caught up: with many routes, hourly inserts can exceed one batch.
    for table, days, column in (("observations", sample_days, "received_ms"),
                                ("cycles", sample_days, "received_ms"),
                                ("transitions", transition_days, "received_ms"),
                                ("cursors", 1, "last_seen_ms")):
        cutoff = now_ms - days * 86_400_000
        deleted = PRUNE_BATCH
        while deleted == PRUNE_BATCH:
            with db:
                deleted = db.execute(f"DELETE FROM {table} WHERE rowid IN (SELECT rowid FROM {table} WHERE {column}<? LIMIT {PRUNE_BATCH})", (cutoff,)).rowcount
    with db:
        db.execute("DELETE FROM paths WHERE last_seen_ms<? AND version NOT IN (SELECT version FROM transitions) AND version NOT IN (SELECT version FROM observations) AND version NOT IN (SELECT version FROM cursors)",
                   (now_ms - transition_days * 86_400_000,))
    db.execute("PRAGMA wal_checkpoint(PASSIVE)")


def status(path):
    path = Path(path).resolve()
    db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        latest = [dict(r) for r in db.execute("SELECT c.* FROM cycles c JOIN (SELECT route,direction,MAX(id) id FROM cycles GROUP BY route,direction) latest ON c.id=latest.id")]
        counts = {table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                  for table in ("observations", "transitions", "paths", "cursors", "cycles")}
        result = {"database": str(path), "counts": counts, "latest_cycles": latest,
                  "database_bytes": sum(p.stat().st_size for p in (path, Path(str(path) + "-wal"), Path(str(path) + "-shm")) if p.exists()),
                  "timing_kind": "observed_stop_changes", "passenger_etas_changed": False}
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=Path(__file__).parent / "data" / "eta.sqlite3")
    parser.add_argument("--route", action="append",
                        help="Route code, or CODE:DIR for a one-direction route; repeat for more routes. Default: Ç1.")
    parser.add_argument("--direction", action="append", choices=("0", "1"))
    parser.add_argument("--interval", type=float, default=30)
    parser.add_argument("--timeout", type=float, default=10)
    parser.add_argument("--sample-days", type=int, default=7)
    parser.add_argument("--transition-days", type=int, default=30)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--status", action="store_true", help="Read collection status without network requests.")
    args = parser.parse_args()
    if args.status:
        status(args.db)
        return 0
    if (not math.isfinite(args.interval) or args.interval < 30
            or not math.isfinite(args.timeout) or not 0 < args.timeout <= 10
            or min(args.sample_days, args.transition_days) < 1):
        parser.error("interval must be >=30 seconds, timeout <=10 seconds, and retention >=1 day")
    os.umask(0o077)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda _sig, _frame: stop.set())
    db = connect(args.db)
    directions = list(dict.fromkeys(args.direction or ["0", "1"]))
    targets = []
    for spec in args.route or ["Ç1"]:
        route, _, direction = spec.partition(":")
        if not route.strip() or direction not in ("", "0", "1"):
            parser.error(f"invalid route {spec!r}; use CODE or CODE:0 / CODE:1")
        targets += [(route, d) for d in ([direction] if direction else directions)]
    targets = list(dict.fromkeys(targets))
    logging.info("ETA observation pilot started: %d targets %s interval=%ss", len(targets),
                 " ".join(f"{r}:{d}" for r, d in targets), args.interval)
    last_cleanup = 0
    retry_state = None if args.once else {}
    try:
        while not stop.is_set():
            started = time.monotonic()
            successes = collect_once(db, targets, args.timeout, stop, retry_state)
            if time.monotonic() - last_cleanup >= 3600:
                prune(db, int(time.time() * 1000), args.sample_days, args.transition_days)
                last_cleanup = time.monotonic()
            if args.once:
                return 0 if successes == len(targets) else 1
            stop.wait(max(0, args.interval - (time.monotonic() - started)))
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
