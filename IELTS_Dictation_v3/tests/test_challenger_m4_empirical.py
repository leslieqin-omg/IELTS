#!/usr/bin/env python3
"""
test_challenger_m4_empirical.py — Challenger M4.1 Tier 5 White-Box Adversarial Stress Testing

Comprehensive independent verification suite testing:
1. Mathematical Invariant & Quota Generator Stress (0 to 1000 volumes, extreme boundaries, custom ratios, types).
2. Deep Pre-Test State Machine & Lifecycle Invariants (pass/fail transitions, idempotency, queue exclusion).
3. Deep Spot-Check State Machine & LRU Invariants (pass retention, fail reactivation, LRU ordering, partial/empty pools).
4. Mastered Pool Filtering & Strict Queue Exclusion Invariants (zero duplicates, hierarchy, isolation).
5. Session Queue Composition Fuzzing (100 randomized mixed iterations, zero duplicates, hierarchy).
6. Multi-Day Temporal Lifecycles & 30-Day Simulation.
7. Concurrent Multi-Threaded Atomicity & Storage Resilience.
8. REST API Adversarial Payloads & Endpoint Boundary Hardening.
"""

import os
import sys
import json
import time
import shutil
import random
import tempfile
import threading
import datetime
from datetime import timedelta
import urllib.request
import urllib.error
import unittest

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import config
import server
from core.storage import ModuleStore
from core.session_manager import generate_session
from core.scheduler_listening import (
    calculate_spot_check_quota,
    apply_pretest_result,
    apply_spot_check_result,
    apply_listening_review,
    get_shanghai_today,
    get_shanghai_midnight_ts
)
from core.spelling_judge import SpellingJudge


# =============================================================================
# SUITE 1: MATHEMATICAL INVARIANT & QUOTA GENERATOR STRESS
# =============================================================================
class TestSpotCheckQuotaMathematicalInvariants(unittest.TestCase):
    """Stress tests spot-check quota calculations under extreme boundary conditions."""

    def test_float_and_boundary_volumes(self):
        """Tests floating point review volumes and boundary conversions."""
        # Int-equivalent floats
        self.assertEqual(calculate_spot_check_quota(40), 6)
        self.assertEqual(calculate_spot_check_quota(10), 2)
        self.assertEqual(calculate_spot_check_quota(20), 3)

        # Fractional / edge floats
        q_float = calculate_spot_check_quota(35.5)
        self.assertIsInstance(q_float, int)
        self.assertTrue(1 <= q_float <= 10)

        # Very small positive floats
        self.assertEqual(calculate_spot_check_quota(0.1), 1)
        self.assertEqual(calculate_spot_check_quota(0.9), 1)

    def test_massive_and_extreme_volumes(self):
        """Tests massive volume scales up to millions without overflow."""
        for large_vol in [10_000, 100_000, 1_000_000, 10_000_000]:
            quota = calculate_spot_check_quota(large_vol)
            self.assertIsInstance(quota, int)
            lower = max(1, round(large_vol * 0.10))
            upper = max(1, round(large_vol * 0.20))
            self.assertTrue(lower <= quota <= upper)
            self.assertEqual(quota, round(large_vol * 0.15))

    def test_negative_and_zero_volumes_with_various_defaults(self):
        """Tests negative and zero volumes under various default_count arguments."""
        # Standard default is 5
        self.assertEqual(calculate_spot_check_quota(0), 5)
        self.assertEqual(calculate_spot_check_quota(-1), 5)
        self.assertEqual(calculate_spot_check_quota(-999999), 5)

        # Custom positive defaults
        self.assertEqual(calculate_spot_check_quota(0, default_count=10), 10)
        self.assertEqual(calculate_spot_check_quota(-5, default_count=25), 25)

        # Non-positive defaults fallback safely to 1
        self.assertEqual(calculate_spot_check_quota(0, default_count=0), 1)
        self.assertEqual(calculate_spot_check_quota(0, default_count=-10), 1)
        self.assertEqual(calculate_spot_check_quota(-1, default_count=0), 1)

    def test_ratio_permutation_invariants(self):
        """Verifies custom, inverted, identical, and extreme ratios."""
        vol = 50
        # Inverted ratios: min > max -> should auto-swap
        self.assertEqual(
            calculate_spot_check_quota(vol, min_ratio=0.25, max_ratio=0.10),
            calculate_spot_check_quota(vol, min_ratio=0.10, max_ratio=0.25)
        )

        # Equal ratios force exact clamp
        self.assertEqual(calculate_spot_check_quota(vol, min_ratio=0.10, max_ratio=0.10), 5)
        self.assertEqual(calculate_spot_check_quota(vol, min_ratio=0.20, max_ratio=0.20), 10)

        # Zero ratios
        q_zero = calculate_spot_check_quota(vol, min_ratio=0.0, max_ratio=0.0)
        self.assertIsInstance(q_zero, int)
        self.assertGreaterEqual(q_zero, 1)


# =============================================================================
# SUITE 2: PRE-TEST STATE MACHINE & IDEMPOTENCY STRESS
# =============================================================================
class TestPretestStateMachineAndIdempotency(unittest.TestCase):
    """Stress tests pre-test state machine transitions, edge dictionaries, and idempotency."""

    def setUp(self):
        self.today = get_shanghai_today()
        self.now_ts = int(time.time())

    def test_pretest_pass_state_invariants(self):
        """Verifies all dictionary attributes set on pretest pass."""
        word = {"id": "abandon", "word": "abandon"}
        res = apply_pretest_result(word, is_correct=True, current_date_shanghai=self.today, now_ts=self.now_ts)

        self.assertEqual(res["pretest_status"], "passed")
        self.assertEqual(res["stage"], 6)
        self.assertEqual(res["next_review_date"], "2099-12-31")
        self.assertEqual(res["next_review"], 4102329600)
        self.assertEqual(res["review_count"], 1)
        self.assertEqual(res["correct_count"], 1)
        self.assertEqual(res["consecutive_correct"], 1)
        self.assertEqual(res.get("wrong_count", 0), 0)
        self.assertFalse(res["lapsed"])
        self.assertEqual(res["last_review"], self.now_ts)
        self.assertEqual(res["last_review_date"], self.today.strftime("%Y-%m-%d"))

    def test_pretest_fail_state_invariants(self):
        """Verifies all dictionary attributes set on pretest fail."""
        word = {"id": "accommodate", "word": "accommodate"}
        res = apply_pretest_result(word, is_correct=False, current_date_shanghai=self.today, now_ts=self.now_ts)

        self.assertEqual(res["pretest_status"], "failed")
        self.assertEqual(res["stage"], 0)
        self.assertEqual(res["review_count"], 0)
        self.assertEqual(res["wrong_count"], 1)
        self.assertEqual(res["consecutive_correct"], 0)
        self.assertTrue(res["lapsed"])
        self.assertEqual(res["next_review_date"], self.today.strftime("%Y-%m-%d"))
        self.assertEqual(res["next_review"], get_shanghai_midnight_ts(self.today))
        self.assertEqual(res["last_review"], self.now_ts)

    def test_pretest_repeated_calls_idempotency(self):
        """Tests repeated calls and state switches."""
        word = {"id": "test_word", "word": "test_word"}

        # Pass twice
        apply_pretest_result(word, is_correct=True, current_date_shanghai=self.today, now_ts=self.now_ts)
        apply_pretest_result(word, is_correct=True, current_date_shanghai=self.today, now_ts=self.now_ts + 10)
        self.assertEqual(word["stage"], 6)
        self.assertEqual(word["pretest_status"], "passed")
        self.assertEqual(word["correct_count"], 2)

        # Then fail
        apply_pretest_result(word, is_correct=False, current_date_shanghai=self.today, now_ts=self.now_ts + 20)
        self.assertEqual(word["stage"], 0)
        self.assertEqual(word["pretest_status"], "failed")
        self.assertTrue(word["lapsed"])
        self.assertEqual(word["review_count"], 0)
        self.assertEqual(word["wrong_count"], 1)

    def test_pretest_empty_or_sparse_dict(self):
        """Tests that passing an empty dictionary does not crash."""
        word = {}
        res = apply_pretest_result(word, is_correct=True, current_date_shanghai=self.today, now_ts=self.now_ts)
        self.assertEqual(res["stage"], 6)
        self.assertEqual(res["pretest_status"], "passed")


# =============================================================================
# SUITE 3: SPOT-CHECK STATE MACHINE & LRU ROTATION STRESS
# =============================================================================
class TestSpotCheckStateMachineAndLRU(unittest.TestCase):
    """Stress tests spot-check state transitions, interval retention, and LRU ordering."""

    def setUp(self):
        self.today = get_shanghai_today()
        self.now_ts = int(time.time())
        self.tmp = tempfile.mkdtemp(prefix="test_challenger_m4_sc_")
        self.store = ModuleStore(os.path.join(self.tmp, "listening.json"))

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_spot_check_pass_retains_mastered_without_interval_advance(self):
        """Spot-check pass keeps stage=6, next_review_date=2099-12-31, and does NOT advance interval."""
        word = {
            "id": "mastered_1",
            "word": "mastered_1",
            "stage": 6,
            "pretest_status": "passed",
            "next_review_date": "2099-12-31",
            "next_review": 4102329600,
            "correct_count": 5
        }
        res = apply_spot_check_result(word, is_correct=True, current_date_shanghai=self.today, now_ts=self.now_ts)

        self.assertEqual(res["stage"], 6)
        self.assertEqual(res["pretest_status"], "passed")
        self.assertEqual(res["next_review_date"], "2099-12-31")
        self.assertEqual(res["next_review"], 4102329600)
        self.assertFalse(res["lapsed"])
        self.assertEqual(res["spot_check_count"], 1)
        self.assertEqual(res["spot_check_correct"], 1)
        self.assertEqual(res["correct_count"], 6)
        self.assertEqual(res["last_spot_check"], self.now_ts)

    def test_spot_check_fail_reactivates_to_tomorrow_due_queue(self):
        """Spot-check fail resets stage=0, lapsed=True, schedules for tomorrow."""
        word = {
            "id": "mastered_2",
            "word": "mastered_2",
            "stage": 6,
            "pretest_status": "passed",
            "next_review_date": "2099-12-31",
            "next_review": 4102329600,
            "wrong_count": 0
        }
        res = apply_spot_check_result(word, is_correct=False, current_date_shanghai=self.today, now_ts=self.now_ts)

        self.assertEqual(res["stage"], 0)
        self.assertEqual(res["pretest_status"], "failed")
        self.assertTrue(res["lapsed"])
        self.assertEqual(res["spot_check_count"], 1)
        self.assertEqual(res["spot_check_wrong"], 1)
        self.assertEqual(res["wrong_count"], 1)
        self.assertEqual(res["consecutive_correct"], 0)

        tomorrow = self.today + timedelta(days=1)
        self.assertEqual(res["next_review_date"], tomorrow.strftime("%Y-%m-%d"))
        self.assertEqual(res["next_review"], get_shanghai_midnight_ts(tomorrow))

    def test_lru_with_mixed_timestamps_and_clusters(self):
        """Tests LRU sorting with None, 0, duplicate clusters, and newer timestamps."""
        words_data = [
            ("w_late", 5000),
            ("w_early_b", 100),
            ("w_none_b", None),
            ("w_zero", 0),
            ("w_early_a", 100),
            ("w_none_a", None),
        ]
        for wid, ts in words_data:
            self.store.update_word(wid, {
                "id": wid, "word": wid, "stage": 6, "pretest_status": "passed",
                "next_review_date": "2099-12-31", "last_spot_check": ts
            })

        self.store.update_settings({"review_cap": 40, "daily_new_words": 0, "spot_check_count": 6})
        session = generate_session(self.store, current_date_shanghai=self.today)
        sc_words = [w["id"] for w in session["queue"] if w.get("_isSpotCheck")]

        # Expected order:
        # None/0 treated as 0: w_none_a, w_none_b, w_zero (alphabetical tie-break: w_none_a, w_none_b, w_zero)
        # 100: w_early_a, w_early_b
        # 5000: w_late
        expected = ["w_none_a", "w_none_b", "w_zero", "w_early_a", "w_early_b", "w_late"]
        self.assertEqual(sc_words, expected)

    def test_partial_and_empty_mastered_pool(self):
        """When mastered pool is smaller than quota or empty, does not crash and samples all available."""
        # Empty pool
        self.store.update_settings({"review_cap": 40, "daily_new_words": 5, "spot_check_count": 10})
        s_empty = generate_session(self.store, current_date_shanghai=self.today)
        self.assertEqual(s_empty["spot_check_count"], 0)

        # 3 words in pool, quota 10
        for i in range(3):
            wid = f"master_{i}"
            self.store.update_word(wid, {
                "id": wid, "word": wid, "stage": 6, "pretest_status": "passed",
                "next_review_date": "2099-12-31"
            })
        s_partial = generate_session(self.store, current_date_shanghai=self.today)
        self.assertEqual(s_partial["spot_check_count"], 3)


# =============================================================================
# SUITE 4: ZERO-DUPLICATE INVARIANT & SESSION QUEUE FUZZING
# =============================================================================
class TestSessionQueueCompositionAndFuzzing(unittest.TestCase):
    """Fuzzes session generation with 100 randomized dirty store states, verifying absolute zero duplicates."""

    def test_randomized_store_queue_fuzzing(self):
        """Fuzzes stores with random word states, asserting zero duplicates and strict hierarchy."""
        rng = random.Random(1337)
        for iteration in range(100):
            tmp = tempfile.mkdtemp(prefix=f"test_fuzz_iter_{iteration}_")
            try:
                store = ModuleStore(os.path.join(tmp, "listening.json"))
                num_words = rng.randint(20, 80)

                for i in range(num_words):
                    wid = f"w_{i}"
                    status = rng.choice([None, "passed", "failed", "untested"])
                    stage = rng.choice([0, 1, 3, 6])
                    lapsed = rng.choice([True, False])
                    rev_count = rng.choice([0, 1, 5])
                    next_date = rng.choice(["2025-01-01", "2026-11-08", "2026-11-09", "2099-12-31", None])
                    last_sc = rng.choice([None, 0, 1000, 2000])
                    last_rev = rng.choice([None, 1700000000])

                    store.update_word(wid, {
                        "id": wid, "word": wid, "stage": stage, "lapsed": lapsed,
                        "review_count": rev_count, "next_review_date": next_date,
                        "pretest_status": status, "last_spot_check": last_sc,
                        "last_review": last_rev
                    })

                cap = rng.randint(1, 25)
                new_b = rng.randint(0, 15)
                sc_c = rng.randint(0, 10)
                store.update_settings({"review_cap": cap, "daily_new_words": new_b, "spot_check_count": sc_c})

                session = generate_session(store, current_date_shanghai="2026-11-08")
                q = session["queue"]
                ids = [w.get("id") or w.get("word") for w in q]

                # INVARIANT 1: Absolute Zero Duplicates
                self.assertEqual(len(ids), len(set(ids)), f"Iteration {iteration}: duplicate IDs in session queue!")

                # INVARIANT 2: Count consistency
                self.assertEqual(session["total"], len(q))
                self.assertEqual(session["total"], session["due_count"] + session["spot_check_count"] + session["new_count"])

                # INVARIANT 3: Queue hierarchy (Due reviews first -> Spot checks second -> New words third)
                due_slice = q[:session["due_count"]]
                sc_slice = q[session["due_count"]:session["due_count"] + session["spot_check_count"]]
                new_slice = q[session["due_count"] + session["spot_check_count"]:]

                for w in due_slice:
                    self.assertFalse(w.get("_isSpotCheck", False))
                for w in sc_slice:
                    self.assertTrue(w.get("_isSpotCheck", False))
                for w in new_slice:
                    self.assertFalse(w.get("_isSpotCheck", False))
                    self.assertNotEqual(w.get("pretest_status"), "passed")
            finally:
                shutil.rmtree(tmp)


# =============================================================================
# SUITE 5: 30-DAY TEMPORAL SIMULATION
# =============================================================================
class TestTemporalSimulation30Days(unittest.TestCase):
    """Simulates a 30-day continuous study cycle with pre-test, spot checks, and reviews."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="test_challenger_temporal_")
        self.store = ModuleStore(os.path.join(self.tmp, "listening.json"))
        self.start_date = datetime.date(2026, 1, 1)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_30_day_lifecycle_with_mixed_user_actions(self):
        """Simulates 30 days: 40 words pass pretest, 20 words fail pretest, daily review + spot check."""
        # 1. Initialize words
        for i in range(40):
            wid = f"passed_word_{i}"
            self.store.update_word(wid, {"id": wid, "word": wid})
            apply_pretest_result(self.store.get_word(wid), is_correct=True, current_date_shanghai=self.start_date)
            self.store.update_word(wid, self.store.get_word(wid))

        for i in range(20):
            wid = f"failed_word_{i}"
            self.store.update_word(wid, {"id": wid, "word": wid})
            apply_pretest_result(self.store.get_word(wid), is_correct=False, current_date_shanghai=self.start_date)
            self.store.update_word(wid, self.store.get_word(wid))

        self.store.update_settings({"review_cap": 25, "daily_new_words": 5, "spot_check_count": 5})

        curr_date = self.start_date
        reactivated_spot_checks = set()

        for day in range(30):
            curr_date = self.start_date + timedelta(days=day)
            session = generate_session(self.store, current_date_shanghai=curr_date)
            q = session["queue"]

            # Invariant: Zero duplicates every single day
            q_ids = [w["id"] for w in q]
            self.assertEqual(len(q_ids), len(set(q_ids)), f"Day {day}: duplicates detected in session queue!")

            # Simulate completing reviews in session
            now_ts = 1767225600 + (day * 86400)
            for w_item in q:
                wid = w_item["id"]
                w_rec = self.store.get_word(wid)

                if w_item.get("_isSpotCheck"):
                    # Spot check word: 80% pass, 20% fail
                    sc_pass = (day % 5 != 0)  # every 5th day, spot check fails
                    apply_spot_check_result(w_rec, is_correct=sc_pass, current_date_shanghai=curr_date, now_ts=now_ts)
                    if not sc_pass:
                        reactivated_spot_checks.add(wid)
                else:
                    # Regular review or pretest failed word: pass review
                    apply_listening_review(w_rec, is_correct=True, current_date_shanghai=curr_date, now_ts=now_ts)

                self.store.update_word(wid, w_rec)

        # After 30 days, verify reactivated words progressed into higher stages
        for wid in reactivated_spot_checks:
            rec = self.store.get_word(wid)
            self.assertGreaterEqual(rec.get("stage", 0), 1, f"Reactivated word {wid} failed to advance stage!")


# =============================================================================
# SUITE 6: CONCURRENT ATOMICITY & RESILIENCE
# =============================================================================
class TestStoreConcurrencyAtomicity(unittest.TestCase):
    """Stress tests ModuleStore atomicity and thread-safety under heavy concurrent updates."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="test_challenger_concurrency_")
        self.store = ModuleStore(os.path.join(self.tmp, "listening.json"))

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_multithreaded_concurrent_crud_and_sessions(self):
        """10 threads concurrently updating words, settings, and generating sessions."""
        errors = []

        def worker(thread_idx: int):
            try:
                for step in range(30):
                    wid = f"t_{thread_idx}_w_{step}"
                    self.store.update_word(wid, {
                        "id": wid, "word": wid, "stage": step % 7,
                        "pretest_status": "passed" if step % 2 == 0 else "failed",
                        "next_review_date": "2099-12-31" if step % 2 == 0 else "2026-11-08"
                    })
                    if step % 5 == 0:
                        self.store.update_settings({
                            "review_cap": 20 + (step % 10),
                            "daily_new_words": 5 + (step % 5),
                            "spot_check_count": 3 + (step % 3)
                        })
                    session = generate_session(self.store, current_date_shanghai="2026-11-08")
                    if len(session["queue"]) != len(set(w["id"] for w in session["queue"])):
                        errors.append(f"Thread {thread_idx} saw duplicates!")
            except Exception as e:
                errors.append(f"Thread {thread_idx} raised {e}")

        threads = [threading.Thread(target=worker, args=(t,)) for t in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(errors, [], f"Concurrency errors occurred: {errors}")

        # Verify no orphan .tmp files
        tmp_files = [f for f in os.listdir(self.tmp) if f.endswith(".tmp")]
        self.assertEqual(tmp_files, [], "Found orphaned .tmp files after concurrent operations!")

        # Verify clean reload
        reloaded = ModuleStore(self.store.data_file)
        self.assertEqual(len(reloaded.words), 300)


# =============================================================================
# SUITE 7: REST API ADVERSARIAL PAYLOADS & BOUNDARY HARDENING
# =============================================================================
class TestRestApiAdversarialHardening(unittest.TestCase):
    """Stress tests HTTP REST API with adversarial, invalid, and malformed payloads."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="test_challenger_api_")
        cls.data_file = os.path.join(cls.tmp, "listening.json")
        cls.test_store = ModuleStore(cls.data_file, config.DEFAULT_LISTENING_SETTINGS)
        cls.judge = SpellingJudge(config.CASE_SENSITIVE_WORDS_FILE)

        class EphemeralHandler(server.DictationHandler):
            listening_store = cls.test_store
            spelling_judge = cls.judge

            def log_message(self, format, *args):
                pass

        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), EphemeralHandler)
        cls.port = cls.httpd.server_port
        cls.base_url = f"http://127.0.0.1:{cls.port}"

        cls.server_thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _post(self, path: str, payload: dict | str) -> tuple[int, dict | str]:
        url = f"{self.base_url}{path}"
        data = payload.encode("utf-8") if isinstance(payload, str) else json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                body = resp.read().decode("utf-8")
                return resp.status, json.loads(body)
        except urllib.error.HTTPError as e:
            with e:
                body = e.read().decode("utf-8")
                try:
                    return e.code, json.loads(body)
                except Exception:
                    return e.code, body

    def _get(self, path: str) -> tuple[int, dict | str]:
        url = f"{self.base_url}{path}"
        req = urllib.request.Request(url, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                body = resp.read().decode("utf-8")
                return resp.status, json.loads(body)
        except urllib.error.HTTPError as e:
            with e:
                body = e.read().decode("utf-8")
                try:
                    return e.code, json.loads(body)
                except Exception:
                    return e.code, body

    def test_settings_adversarial_types_and_ranges(self):
        """Verifies strict 400 rejection on invalid settings payloads."""
        # Booleans (subclass of int in Python)
        code, _ = self._post("/api/listening/settings", {"review_cap": True, "daily_new_words": 10})
        self.assertEqual(code, 400)
        code, _ = self._post("/api/listening/settings", {"review_cap": 20, "daily_new_words": False})
        self.assertEqual(code, 400)
        code, _ = self._post("/api/listening/settings", {"review_cap": 20, "daily_new_words": 10, "spot_check_count": True})
        self.assertEqual(code, 400)

        # Negative numbers
        code, _ = self._post("/api/listening/settings", {"review_cap": -5, "daily_new_words": 10})
        self.assertEqual(code, 400)
        code, _ = self._post("/api/listening/settings", {"review_cap": 20, "daily_new_words": -1})
        self.assertEqual(code, 400)
        code, _ = self._post("/api/listening/settings", {"review_cap": 20, "daily_new_words": 10, "spot_check_count": -1})
        self.assertEqual(code, 400)

        # Non-numeric strings
        code, _ = self._post("/api/listening/settings", {"review_cap": "abc", "daily_new_words": 10})
        self.assertEqual(code, 400)

        # Malformed JSON
        code, _ = self._post("/api/listening/settings", "{invalid json")
        self.assertEqual(code, 400)

        # Valid boundaries: review_cap=1, daily_new_words=0, spot_check_count=0
        code, res = self._post("/api/listening/settings", {"review_cap": 1, "daily_new_words": 0, "spot_check_count": 0})
        self.assertEqual(code, 200)
        self.assertTrue(res.get("ok"))
        self.assertEqual(res["settings"]["review_cap"], 1)
        self.assertEqual(res["settings"]["daily_new_words"], 0)
        self.assertEqual(res["settings"]["spot_check_count"], 0)

    def test_review_endpoint_pretest_and_spot_check_routing(self):
        """Verifies POST /api/listening/review routes correctly with is_pretest and is_spot_check flags."""
        # Pretest Pass
        code, res = self._post("/api/listening/review", {
            "word": "api_pretest_word",
            "correct": True,
            "is_pretest": True
        })
        self.assertEqual(code, 200)
        w = res["word"]
        self.assertEqual(w["stage"], 6)
        self.assertEqual(w["pretest_status"], "passed")
        self.assertEqual(w["next_review_date"], "2099-12-31")

        # Spot check Pass on that word
        code, res = self._post("/api/listening/review", {
            "word": "api_pretest_word",
            "correct": True,
            "is_spot_check": True
        })
        self.assertEqual(code, 200)
        w = res["word"]
        self.assertEqual(w["stage"], 6)
        self.assertEqual(w["spot_check_correct"], 1)

        # Spot check Fail on that word
        code, res = self._post("/api/listening/review", {
            "word": "api_pretest_word",
            "correct": False,
            "is_spot_check": True
        })
        self.assertEqual(code, 200)
        w = res["word"]
        self.assertEqual(w["stage"], 0)
        self.assertEqual(w["pretest_status"], "failed")
        self.assertTrue(w["lapsed"])

    def test_stats_pretest_metrics_invariant(self):
        """Verifies /api/listening/stats pretest breakdown adheres to sum invariant."""
        code, stats = self._get("/api/listening/stats")
        self.assertEqual(code, 200)
        pt = stats.get("pretest", {})
        self.assertIn("total", pt)
        self.assertIn("tested", pt)
        self.assertIn("passed", pt)
        self.assertIn("failed", pt)
        self.assertIn("untested", pt)
        self.assertEqual(pt["tested"], pt["passed"] + pt["failed"])
        self.assertEqual(pt["total"], pt["tested"] + pt["untested"])


if __name__ == "__main__":
    unittest.main()
