import copy
import importlib.util
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("eta_collector", Path(__file__).resolve().parents[1] / "backend" / "collector.py")
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


def payload(idx, trip="trip-1", direction="0", lat=None):
    return {"result": {"code": 0}, "pathList": [{
        "displayRouteCode": "Ç1", "direction": direction, "path_code": "path-1",
        "busStopList": [{"seq": str(i + 1), "stopId": str(i), "lat": str(40.1 + i * .001), "lng": "26.4"} for i in range(6)],
        "busList": [{"busId": "bus-1", "tripId": trip, "stopId": str(idx),
                     "lat": str(lat if lat is not None else 40.1 + idx * .001), "lng": "26.4"}],
    }]}


class Kentkart:
    """Fake pathInfo: stop lists on request, bus lists from a queue; records each call's resultType."""

    def __init__(self, *bus_lists, path_codes=("path-1",)):
        self.bus_lists, self.path_codes, self.calls = list(bus_lists), path_codes, []

    def __call__(self, route, direction, timeout, result_type=collector.BUSES):
        self.calls.append(result_type)
        if result_type == collector.STOPS:
            return {"result": {"code": 0}, "pathList": [{
                "displayRouteCode": route, "direction": direction, "path_code": code,
                "busStopList": payload(0)["pathList"][0]["busStopList"]} for code in self.path_codes]}, 20_000
        buses = self.bus_lists.pop(0)
        if isinstance(buses, Exception):
            raise buses
        code, buses = buses if isinstance(buses, tuple) else ("path-1", buses)
        return {"result": {"code": 0}, "pathList": [{
            "displayRouteCode": route, "direction": direction, "path_code": code, "busList": buses}]}, 1_000


def bus(stop, bus_id="bus-1"):
    lat = 40.1 + int(stop) * .001 if int(stop) < 6 else 40.2
    return {"busId": bus_id, "tripId": "trip-1", "stopId": stop, "lat": str(lat), "lng": "26.4"}


class CollectorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = collector.connect(Path(self.temp.name) / "eta.sqlite3")

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def add(self, idx, ts, **kwargs):
        with self.db:
            return collector.ingest(self.db, payload(idx, **kwargs), "Ç1", "0", ts)

    def test_first_sighting_is_censored_and_following_duration_is_bounded(self):
        self.add(0, 1_000)
        self.assertEqual(self.add(1, 31_000)["transitions"], 0)
        self.add(1, 61_000, lat=40.1011)
        self.assertEqual(self.add(2, 91_000)["transitions"], 1)
        row = self.db.execute("SELECT * FROM transitions").fetchone()
        self.assertEqual((row["from_idx"], row["to_idx"]), (1, 2))
        self.assertEqual((row["duration_low_ms"], row["duration_high_ms"]), (30_000, 90_000))

    def test_unchanged_positions_are_not_duplicate_observations(self):
        self.add(0, 1_000)
        self.assertEqual(self.add(0, 31_000)["observations"], 0)
        self.assertEqual(self.db.execute("SELECT last_seen_ms FROM cursors").fetchone()[0], 31_000)

    def test_trip_change_gap_backward_and_gps_jump_reset_timing(self):
        for change in ("trip", "gap", "backward", "jump"):
            with self.subTest(change=change):
                self.db.execute("DELETE FROM cursors")
                self.db.execute("DELETE FROM transitions")
                self.db.commit()
                self.add(0, 1_000)
                self.add(1, 31_000)
                args = {"trip": "trip-2"} if change == "trip" else {}
                idx = 0 if change == "backward" else 2
                ts = 181_000 if change == "gap" else 61_000
                if change == "jump":
                    args["lat"] = 40.2
                self.assertEqual(self.add(idx, ts, **args)["transitions"], 0)
                self.assertIsNone(self.db.execute("SELECT enter_high_ms FROM cursors").fetchone()[0])

    def test_frozen_telemetry_is_not_learned_as_slow_travel(self):
        self.add(0, 1_000)
        self.add(1, 31_000)
        for ts in (61_000, 91_000, 121_000, 151_000):
            self.add(1, ts)
        self.assertEqual(self.add(2, 181_000)["transitions"], 0)

    def test_skipped_stops_remain_one_aggregate_transition(self):
        self.add(0, 1_000)
        self.add(1, 31_000)
        self.add(4, 61_000)
        rows = self.db.execute("SELECT from_idx,to_idx FROM transitions").fetchall()
        self.assertEqual([tuple(row) for row in rows], [(1, 4)])

    def test_ambiguous_stop_and_missing_trip_are_ignored(self):
        p = payload(0)
        p["pathList"][0]["busStopList"][1]["stopId"] = "0"
        with self.db:
            self.assertEqual(collector.ingest(self.db, p, "Ç1", "0", 1_000)["ignored"], 1)
        self.assertEqual(self.add(0, 2_000, trip="")["ignored"], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM cursors").fetchone()[0], 0)

    def test_route_geometry_change_does_not_bridge_history(self):
        self.add(0, 1_000)
        self.add(1, 31_000)
        p = payload(2)
        p["pathList"][0]["busStopList"][0]["lat"] = "40.1001"
        with self.db:
            self.assertEqual(collector.ingest(self.db, p, "Ç1", "0", 61_000)["transitions"], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM paths").fetchone()[0], 2)

    def test_malformed_source_rolls_back_and_wrong_direction_is_rejected(self):
        p = payload(0)
        p["pathList"].append(copy.deepcopy(p["pathList"][0]))
        p["pathList"][1]["busStopList"] = []
        with self.assertRaises(ValueError):
            with self.db:
                collector.ingest(self.db, p, "Ç1", "0", 1_000)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM observations").fetchone()[0], 0)
        with self.assertRaises(ValueError):
            with self.db:
                collector.ingest(self.db, payload(0, direction="1"), "Ç1", "0", 1_000)

    def test_retention_prunes_samples_but_keeps_transitions(self):
        self.add(0, 1_000)
        self.add(1, 31_000)
        self.add(2, 61_000)
        now = 32 * 86_400_000
        self.add(3, now)
        collector.prune(self.db, now, 7)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM observations").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM transitions").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM paths").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM cursors").fetchone()[0], 1)

    def test_retention_catches_up_when_inserts_exceed_one_batch(self):
        with self.db:
            self.db.executemany("INSERT INTO cycles(received_ms,route,direction,ok,response_bytes,elapsed_ms,observations,transitions,ignored) VALUES (?,'Ç1','0',1,0,0,0,0,0)",
                                [(i,) for i in range(collector.PRUNE_BATCH * 2 + 1)])
        collector.prune(self.db, 8 * 86_400_000, 7)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM cycles").fetchone()[0], 0)

    def test_route_direction_spec_limits_one_way_routes(self):
        db_path = Path(self.temp.name) / "main.sqlite3"
        argv = ["collector.py", "--once", "--db", str(db_path), "--route", "Ç6:0", "--route", "Ç1"]
        with patch("sys.argv", argv), patch.object(collector.signal, "signal"), \
                patch.object(collector, "fetch_payload", side_effect=TimeoutError("offline")) as fetch:
            self.assertEqual(collector.main(), 1)
        self.assertEqual([c.args[:2] for c in fetch.call_args_list], [("Ç6", "0"), ("Ç1", "0"), ("Ç1", "1")])
        with patch("sys.argv", ["collector.py", "--route", "Ç6:2"]), self.assertRaises(SystemExit):
            collector.main()

    def poll(self, target, kentkart, windows=None, now_s=1_000.0):
        totals = collector.new_totals()
        with patch.object(collector, "fetch_payload", side_effect=kentkart), patch.object(collector.time, "time", return_value=now_s):
            collector.poll(self.db, target, 10, 30, windows, totals)
        return totals

    def test_stop_list_is_fetched_once_and_buses_alone_after(self):
        target, kentkart = collector.Target("Ç1", "0"), Kentkart([bus("1")], [bus("2")])
        self.poll(target, kentkart)
        self.poll(target, kentkart, now_s=1_030.0)
        self.assertEqual(kentkart.calls, [collector.STOPS, collector.BUSES, collector.BUSES])
        kinds = [r[0] for r in self.db.execute("SELECT kind FROM cycles ORDER BY id")]
        self.assertEqual(kinds, ["stops", "probe", "fast"])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM transitions").fetchone()[0], 0)  # first sighting is censored

    def test_active_route_polls_fast_until_two_empty_polls(self):
        target, kentkart = collector.Target("Ç1", "0"), Kentkart([bus("1")], [], [])
        self.poll(target, kentkart)
        self.assertEqual((target.fast, target.due), (True, 1_030_000))
        self.poll(target, kentkart, now_s=1_030.0)
        self.assertEqual((target.fast, target.due), (True, 1_060_000))
        self.poll(target, kentkart, now_s=1_060.0)
        self.assertEqual((target.fast, target.due), (False, 1_060_000 + collector.PROBE_S * 1000))

    def test_parked_bus_off_the_route_does_not_count_as_active(self):
        target, kentkart = collector.Target("Ç1", "0"), Kentkart([bus("217")])
        self.poll(target, kentkart)
        self.assertFalse(target.fast)
        self.assertEqual(kentkart.calls, [collector.STOPS, collector.BUSES])  # fresh stop list: not refetched

    def test_new_path_code_refetches_the_stop_list(self):
        target, kentkart = collector.Target("Ç1", "0"), Kentkart([bus("1")], ("path-2", [bus("2")]))
        self.poll(target, kentkart)
        kentkart.path_codes = ("path-2",)
        self.poll(target, kentkart, now_s=1_030.0)
        self.assertEqual(kentkart.calls, [collector.STOPS, collector.BUSES, collector.BUSES, collector.STOPS])
        self.assertIn("path-2", target.stops)

    def test_failed_route_backs_off_without_blocking_another(self):
        failing, working = collector.Target("Ç1", "0"), collector.Target("Ç1", "1")
        self.poll(failing, Kentkart(TimeoutError("upstream")))
        self.poll(working, Kentkart([bus("1")]))
        self.assertEqual(failing.due, 1_030_000)
        self.assertTrue(working.fast)
        rows = self.db.execute("SELECT direction, kind, ok FROM cycles ORDER BY id").fetchall()
        self.assertEqual([tuple(r) for r in rows], [("0", "stops", 1), ("0", "probe", 0), ("1", "stops", 1), ("1", "probe", 1)])

    def test_timetable_windows_decide_when_routes_are_polled(self):
        windows = {"windows": {"Ç1|0": {"start": 10_000, "end": 20_000}}, "network": {"start": 5_000, "end": 30_000}}
        scheduled, unscheduled = collector.Target("Ç1", "0"), collector.Target("Ç14", "1")
        self.assertEqual(collector.may_poll(scheduled, windows, 15_000), (True, collector.PROBE_S))
        self.assertFalse(collector.may_poll(scheduled, windows, 9_000)[0])
        self.assertFalse(collector.may_poll(scheduled, windows, 21_000)[0])
        self.assertEqual(collector.may_poll(unscheduled, windows, 25_000), (True, collector.UNSCHEDULED_PROBE_S))
        self.assertFalse(collector.may_poll(unscheduled, windows, 31_000)[0])
        scheduled.fast = True  # the last bus is still running after the window
        self.assertTrue(collector.may_poll(scheduled, windows, 21_000)[0])
        self.assertEqual(collector.may_poll(unscheduled, None, 31_000), (True, collector.PROBE_S))
        closed, kentkart = collector.Target("Ç1", "0"), Kentkart()
        self.poll(closed, kentkart, windows, now_s=21.0)
        self.assertEqual((kentkart.calls, closed.due), ([], 21_000 + collector.PROBE_S * 1000))

    def test_windows_file_counts_only_for_the_current_service_day(self):
        path = Path(self.temp.name) / "windows.json"
        windows = collector.Windows(path)
        tuesday_0200 = 1_793_142_000_000  # 2026-10-28 02:00 local: still Tuesday's service day
        self.assertIsNone(windows.today(tuesday_0200))
        path.write_text('{"day": "2026-10-27", "unavailable": false, "windows": {}, "network": null}', encoding="utf-8")
        self.assertEqual(windows.today(tuesday_0200)["day"], "2026-10-27")
        self.assertIsNone(windows.today(tuesday_0200 + 3 * 3_600_000))  # 05:00: Wednesday, stale file
        path.write_text('{"day": "2026-10-27", "unavailable": true}', encoding="utf-8")
        os.utime(path, (1, 2))  # make sure the reload sees a new modification time
        self.assertIsNone(windows.today(tuesday_0200))

    def test_request_purpose_column_is_added_to_an_existing_database(self):
        path = Path(self.temp.name) / "old.sqlite3"
        old = sqlite3.connect(path)
        old.execute("CREATE TABLE cycles (id INTEGER PRIMARY KEY, received_ms INTEGER NOT NULL, route TEXT NOT NULL, direction TEXT NOT NULL, "
                    "ok INTEGER NOT NULL, response_bytes INTEGER NOT NULL, elapsed_ms INTEGER NOT NULL, observations INTEGER NOT NULL, "
                    "transitions INTEGER NOT NULL, ignored INTEGER NOT NULL, error TEXT)")
        old.execute("INSERT INTO cycles VALUES (1, 1, 'Ç1', '0', 1, 0, 0, 0, 0, 0, NULL)")
        old.commit()
        old.close()
        db = collector.connect(path)
        self.assertEqual(db.execute("SELECT kind FROM cycles").fetchone()[0], "fast")
        db.close()


if __name__ == "__main__":
    unittest.main()
