import calendar
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1] / "backend"
def load_module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
model = load_module("eta_model")
collector = load_module("collector")

MONDAY_NOON = calendar.timegm((2026, 10, 19, 9, 0, 0)) * 1000  # 12:00 in Çanakkale
DAY = 86_400_000


def stops(n, prefix=""):
    return [{"seq": i + 1, "id": f"{prefix}{i}", "lat": 40.05 + i * .001, "lng": 26.35} for i in range(n)]


class ModelTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.db_path = Path(self.tmp.name) / "eta.sqlite3"
        self.db = collector.connect(self.db_path)

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def add_path(self, v, n, last_seen=1, rd="R|0", prefix=""):
        route, direction = rd.split("|")
        with self.db:
            self.db.execute("INSERT INTO paths VALUES (?,?,?,?,?,?)", (v, route, direction, "p", json.dumps(stops(n, prefix)), last_seen))

    def add_spans(self, rows, bracket_ms=0):
        """rows: (version, from, to, minutes, ms the bus reached `from`[, bus]); poll bracket +-bracket_ms."""
        with self.db:
            for v, a, b, minutes, start, *bus in rows:
                d = round(minutes * 60000)
                self.db.execute("INSERT INTO transitions(received_ms,version,bus_id,trip_id,from_idx,to_idx,duration_low_ms,duration_high_ms) "
                                "VALUES (?,?,?,?,?,?,?,?)", (start + d + 15000, v, bus[0] if bus else "b", "t", a, b, d - bracket_ms, d + bracket_ms))

    def fitted(self, recent_from=0, **kw):
        db = model.connect(self.db_path)
        try:
            paths = model.load_paths(db)
            return model.Model(paths, **kw).fit(model.aggregate(db, recent_from))
        finally:
            db.close()

    def test_multi_stop_spans_are_shared_so_quick_segments_are_not_overestimated(self):
        # Truth: 2.0, 0.25 and 1.5 minutes. The quick middle segment is mostly passed
        # within one poll, so it shows up alone only on its rare slow traversals.
        self.add_path("v1", 4)
        self.add_spans([("v1", 0, 1, 2.0, MONDAY_NOON)] * 10 + [("v1", 2, 3, 1.5, MONDAY_NOON)] * 10 +
                       [("v1", 1, 2, 0.5, MONDAY_NOON)] * 2 +
                       [("v1", 0, 2, 2.25, MONDAY_NOON)] * 10 + [("v1", 1, 3, 1.75, MONDAY_NOON)] * 10)
        m = self.fitted(levels=())
        theta = [m.theta[k] for k in m.keys["v1"]]
        self.assertLess(theta[1], 0.4)
        self.assertAlmostEqual(theta[0], 2.0, delta=0.15)
        self.assertAlmostEqual(theta[2], 1.5, delta=0.15)
        observed = 10 * 2.0 + 10 * 1.5 + 2 * 0.5 + 10 * 2.25 + 10 * 1.75
        predicted = 10 * theta[0] + 10 * theta[2] + 2 * theta[1] + 10 * sum(theta[0:2]) + 10 * sum(theta[1:3])
        self.assertAlmostEqual(predicted / observed, 1.0, delta=0.01)

    def test_sparse_cells_shrink_towards_one_and_rich_cells_follow_data(self):
        hour = 3_600_000
        self.add_path("v1", 2)
        self.add_spans([("v1", 0, 1, 1.0, MONDAY_NOON)] * 2000 + [("v1", 0, 1, 1.5, MONDAY_NOON - 4 * hour)] * 2000 +
                       [("v1", 0, 1, 3.0, MONDAY_NOON + 9 * hour)])
        f = self.fitted(prior_minutes=30, levels=("week",)).factors["week"]
        self.assertAlmostEqual(f[(False, 8)] / f[(False, 12)], 1.5, delta=0.05)
        self.assertAlmostEqual(f[(False, 21)], 1.0, delta=0.1)  # one 3-minute sample; unshrunk it would be ~2.4
        self.assertNotIn((True, 8), f)

    def test_service_day_puts_early_morning_on_the_previous_day_in_python_and_sql(self):
        saturday_0030 = calendar.timegm((2026, 10, 23, 21, 30, 0)) * 1000
        saturday_1000 = calendar.timegm((2026, 10, 24, 7, 0, 0)) * 1000
        self.assertEqual(model.service_slot(saturday_0030), (1, 0))  # Friday's service day
        self.assertEqual(model.service_slot(saturday_1000), (2, 10))
        self.assertEqual(model.service_day(saturday_0030), "2026-10-23")
        self.assertEqual(model.day_start("2026-10-24"), calendar.timegm((2026, 10, 24, 1, 0, 0)) * 1000)  # 04:00 local
        self.assertEqual(model.level_key("part", "R|0", 2, 2, 10), ("R|0", 2, True, 10))
        self.add_path("v1", 2)
        self.add_spans([("v1", 0, 1, 1.0, saturday_0030), ("v1", 0, 1, 1.0, saturday_1000)])
        db = model.connect(self.db_path)
        try:
            groups = model.aggregate(db, recent_from=saturday_1000)
        finally:
            db.close()
        self.assertEqual(sorted((g.day_type, g.hour, g.recent) for g in groups), [(1, 0, 0), (2, 10, 1)])

    def test_live_prediction_counts_half_the_current_segment_and_each_segments_own_hour(self):
        m = model.Model({"v1": {"rd": "R|0", "stops": stops(3), "last_seen": 1}}, levels=("week",))
        k0, k1 = m.keys["v1"]
        m.theta, m.samples = {k0: 2.0, k1: 4.0}, {k0: 9, k1: 9}
        m.factors["week"] = {(False, 8): 1.5, (False, 9): 1.0}
        monday_0859 = MONDAY_NOON - 3 * 3_600_000 - 60_000
        self.assertEqual(dict(m.cumulative("v1", 0, monday_0859)), {1: 1.5, 2: 5.5})
        self.assertEqual(dict(m.cumulative("v1", 0, monday_0859, live=False)), {1: 3.0, 2: 7.0})

    def test_live_prediction_subtracts_the_learned_stay_where_stops_go_unreported(self):
        # Stops 1 and 2 are usually not reported: the bus shows "stop 0" for ~6 minutes.
        self.add_path("v1", 5)
        self.add_spans([("v1", 0, 3, 6.0, MONDAY_NOON)] * 10 + [("v1", 3, 4, 2.0, MONDAY_NOON)] * 10 +
                       [("v1", k, k + 1, 2.0, MONDAY_NOON) for k in range(3)] * 2)
        m = self.fitted(levels=())
        predicted = dict(m.cumulative("v1", 0, MONDAY_NOON))
        # Length-weighted elapsed stay at stop 0: (10*36 + 2*4) / (2 * (60 + 4)) = 2.875 minutes.
        self.assertAlmostEqual(predicted[3], 6.0 - 2.875, delta=0.1)
        self.assertEqual(predicted[1], 0.0)
        self.assertEqual(list(m.cumulative("v1", 4, MONDAY_NOON)), [])
        # Stop 1 has two stays, below the sample minimum: the app keeps the half-segment rule there.
        self.assertEqual(self.fitted().export()["routes"]["R|0"]["elapsed"][:2], [2.875, None])

    def test_export_uses_the_current_path_and_omits_unmeasured_segments(self):
        self.add_path("old", 3, last_seen=1, prefix="x")
        self.add_path("new", 3, last_seen=2)
        self.add_spans([("new", 0, 1, 2.0, MONDAY_NOON)] * 6 + [("new", 1, 2, 2.0, MONDAY_NOON)] * 2)
        out = self.fitted().export()
        route = out["routes"]["R|0"]
        self.assertEqual(route["stops"], ["0", "1", "2"])
        self.assertEqual(route["base"][1], None)
        self.assertAlmostEqual(route["base"][0], 2.0, delta=0.1)
        self.assertEqual(list(out["dayFactors"]), ["Mon-Thu", "Fri", "Sat", "Sun"])
        self.assertEqual(len(out["dayFactors"]["Fri"]), 24)
        self.assertEqual(len(route["partFactors"]["weekend"]), model.PARTS)
        self.assertNotIn("use", route)

    def test_chains_link_only_consecutive_transitions_of_one_bus(self):
        first = model.Span("v1", "b", 0, 1, 1.0, 0, 100_000, 60_000)
        second = model.Span("v1", "b", 1, 2, 1.0, 0, 160_000, 90_000)   # left stop 1 after the poll at 70 s
        after_reset = model.Span("v1", "b", 2, 3, 1.0, 0, 400_000, 100_000)  # last poll at stop 2 was 300 s
        self.assertEqual(model.chains([after_reset, second, first]),
                         [("v1", [(1, 85_000, 100_000), (2, 145_000, 160_000)])])

    def test_recent_week_gets_at_least_a_quarter_of_each_day_types_weight(self):
        def group(day_type, recent, n):
            return model.Group("v1", 0, 1, day_type, 12, recent, n, n * 1.0, n * 1.0)
        w = model.recency_weights([group(0, 0, 900), group(0, 1, 100), group(1, 0, 100), group(1, 1, 300),
                                   group(2, 1, 50), group(3, 0, 40)])
        self.assertAlmostEqual(w[(0, 1)] * 100 / 1000, 0.25)  # Mon-Thu: 10% of samples, raised to 25%
        self.assertAlmostEqual(w[(0, 0)] * 900 / 1000, 0.75)
        self.assertAlmostEqual(w[(1, 1)], 1.0)  # Fri: recent is already 75% of the samples
        self.assertAlmostEqual(w[(1, 0)], 1.0)
        self.assertEqual((w[(2, 1)], w[(3, 0)]), (1.0, 1.0))  # Sat has only recent data, Sun only older

    def test_recent_week_moves_the_estimate_by_its_share(self):
        self.add_path("v1", 2)
        two_weeks_ago = MONDAY_NOON - 14 * DAY  # also a Monday
        self.add_spans([("v1", 0, 1, 2.0, two_weeks_ago)] * 90 + [("v1", 0, 1, 1.0, MONDAY_NOON)] * 10)
        m = self.fitted(recent_from=MONDAY_NOON - 7 * DAY, levels=())
        self.assertAlmostEqual(m.theta[m.keys["v1"][0]], 0.75 * 2.0 + 0.25 * 1.0)
        self.assertEqual(m.recency["Mon-Thu"], {"recentShare": 0.25, "recentSamples": 10, "olderSamples": 90})

    def test_gate_uses_four_weeks_and_needs_a_clear_gain(self):
        state = sqlite3.connect(":memory:")
        state.executescript(model.STATE)
        state.executemany("INSERT INTO validation VALUES (?,?,?,?,?,?,?)", [
            ("2026-11-19", "A|0", 400, 800.0, 600.0, 40, 20),   # error 2.0 -> 1.5: use
            ("2026-11-19", "B|0", 400, 800.0, 760.0, 40, 20),   # 95% of the timetable's error: keep
            ("2026-11-19", "C|0", 100, 200.0, 50.0, 4, 0),      # too few predictions
            ("2026-10-01", "B|0", 5000, 10000.0, 1000.0, 0, 0),  # older than four weeks
            ("2026-11-20", "B|0", 5000, 10000.0, 1000.0, 0, 0),  # today, not finished
        ])
        out = model.gate(state, "2026-11-20")
        self.assertEqual({rd: r["use"] for rd, r in out.items()}, {"A|0": True, "B|0": False, "C|0": False})
        self.assertEqual((out["B|0"]["points"], out["B|0"]["appMae"], out["B|0"]["modelMae"]), (400, 2.0, 1.9))

    def git(self, *args):
        return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout

    def clone(self, origin, name):
        path = str(Path(self.tmp.name) / name)
        self.git("clone", "--quiet", origin, path)
        for key, value in (("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false")):
            self.git("-C", path, "config", key, value)
        return path

    def repository(self):
        origin = str(Path(self.tmp.name) / "origin.git")
        self.git("init", "--quiet", "--bare", "-b", "main", origin)
        seed = self.clone(origin, "seed")
        Path(seed, "README.md").write_text("seed\n", encoding="utf-8")
        self.git("-C", seed, "add", "README.md")
        self.git("-C", seed, "commit", "--quiet", "-m", "seed")
        self.git("-C", seed, "push", "--quiet", "origin", "HEAD:main")
        return origin, seed

    def test_publish_commits_on_top_of_upstream_and_skips_unchanged_models(self):
        origin, seed = self.repository()
        job = self.clone(origin, "job")
        Path(seed, "other.txt").write_text("upstream\n", encoding="utf-8")  # pushed after the job cloned
        self.git("-C", seed, "add", "other.txt")
        self.git("-C", seed, "commit", "--quiet", "-m", "upstream")
        self.git("-C", seed, "push", "--quiet", "origin", "HEAD:main")
        self.assertTrue(model.publish(job, '{"a":1}', "2026-10-25"))
        self.assertEqual(self.git("--git-dir", origin, "log", "--format=%s", "main").split("\n")[:3],
                         ["chore: update segment times 2026-10-25", "upstream", "seed"])
        self.assertEqual(self.git("--git-dir", origin, "show", "main:" + model.MODEL_FILE), '{"a":1}')
        self.assertFalse(model.publish(job, '{"a":1}', "2026-10-26"))

    def test_nightly_validates_each_finished_day_once_and_publishes(self):
        self.add_path("v1", 4)
        for day in range(3):  # Mon-Wed: two bus runs a day, 6 + 8 + 7 minutes
            for start, bus in ((MONDAY_NOON + day * DAY, "b1"), (MONDAY_NOON + day * DAY + 3 * 3_600_000, "b2")):
                self.add_spans([("v1", 0, 1, 6.0, start, bus), ("v1", 1, 2, 8.0, start + 6 * 60000, bus),
                                ("v1", 2, 3, 7.0, start + 14 * 60000, bus)], bracket_ms=30000)
        offsets = {"v1": [{"arr": t, "dep": t} for t in (0, 300, 900, 1200)]}
        origin, _ = self.repository()
        job = self.clone(origin, "job")
        state_path = Path(self.tmp.name) / "model.sqlite3"
        thursday_0430 = calendar.timegm((2026, 10, 22, 1, 30, 0)) * 1000
        with patch("builtins.print"):
            self.assertTrue(model.nightly(self.db_path, state_path, job, now_ms=thursday_0430, offsets=offsets))
            state = sqlite3.connect(state_path)
            first = state.execute("SELECT day, at_ms FROM validated ORDER BY day").fetchall()
            model.nightly(self.db_path, state_path, job, now_ms=thursday_0430, offsets=offsets)
            self.assertEqual(state.execute("SELECT day, at_ms FROM validated ORDER BY day").fetchall(), first)
            state.close()
        self.assertEqual([d for d, _ in first], ["2026-10-19", "2026-10-20", "2026-10-21"])
        route = json.loads(self.git("--git-dir", origin, "show", "main:" + model.MODEL_FILE))["routes"]["R|0"]
        self.assertFalse(route["use"])  # three days of one bus are far below 300 predictions
        self.assertEqual(route["validation"]["days"], 3)

    def test_cli_fits_the_collector_database_and_writes_json(self):
        self.add_path("v1", 3)
        self.add_spans([("v1", 0, 1, 2.0, MONDAY_NOON + i * 600_000) for i in range(6)])
        out = Path(self.tmp.name) / "model.json"
        with patch("sys.argv", ["eta_model.py", "--db", str(self.db_path), "--out", str(out)]), patch("builtins.print"):
            self.assertEqual(model.main(), 0)
        self.assertAlmostEqual(json.loads(out.read_text(encoding="utf-8"))["routes"]["R|0"]["base"][0], 2.0, delta=0.05)


if __name__ == "__main__":
    unittest.main()
