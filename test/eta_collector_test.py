import copy
import importlib.util
from pathlib import Path
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

    def test_one_direction_failure_does_not_block_the_other(self):
        with patch.object(collector, "fetch_payload", side_effect=[TimeoutError("upstream"), (payload(0, direction="1"), 100)]):
            self.assertEqual(collector.collect_once(self.db, [("Ç1", "0"), ("Ç1", "1")], 10), 1)
        rows = self.db.execute("SELECT direction,ok FROM cycles ORDER BY id").fetchall()
        self.assertEqual([tuple(row) for row in rows], [("0", 0), ("1", 1)])

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

    def test_retry_backoff_applies_only_to_the_failed_direction(self):
        retries = {}
        with patch.object(collector.time, "monotonic", return_value=1000):
            with patch.object(collector, "fetch_payload", side_effect=[TimeoutError("upstream"), (payload(0, direction="1"), 100)]):
                collector.collect_once(self.db, [("Ç1", "0"), ("Ç1", "1")], 10, retry_state=retries)
        self.assertEqual(retries[("Ç1", "0")], (1, 1030))
        with patch.object(collector.time, "monotonic", return_value=1001):
            with patch.object(collector, "fetch_payload", return_value=(payload(0, direction="1"), 100)) as fetch:
                collector.collect_once(self.db, [("Ç1", "0"), ("Ç1", "1")], 10, retry_state=retries)
                self.assertEqual(fetch.call_count, 1)
                self.assertEqual(fetch.call_args.args[1], "1")


if __name__ == "__main__":
    unittest.main()
