#!/usr/bin/env python3
"""
test_pretest_spot_check.py

Master Test Suite for Diagnostic Pre-test (R2) and Daily Spot Check (R3, R4):
1. Pre-test State Transitions:
   - Passed: stage=6, next_review_date="2099-12-31", review_count=1, correct_count=1,
     consecutive_correct=1, lapsed=False, excluded from unlearned & due queues.
   - Failed: stage=0, next_review_date=today, wrong_count=1, lapsed=True, review_count=0,
     enrolled into active Ebbinghaus review queue.
2. Spot-Check Dynamic Quota Calculation:
   - 10% to 20% clamping across volumes: 0, 5, 10, 20, 35, 40, 50, 80, 100, 200.
   - Bounds, fallbacks, negative inputs, and custom ratios.
3. Spot-Check Sampling & LRU Ordering:
   - Prioritizes words never spot-checked (last_spot_check=None/0), then oldest timestamps.
   - Handles empty mastered pool and partial pool (pool < quota).
   - Strict _isSpotCheck=True tagging.
4. Spot-Check State Transitions:
   - Passed: stage=6 retained, 2099-12-31 retained, spot_check_correct incremented, NO interval advance.
   - Failed: stage=0 reset, next_review_date=tomorrow, lapsed=True, spot_check_wrong incremented,
     re-enrollment into next day's due review queue.
5. Session Queue Composition & Zero Duplicates:
   - Strict 0 duplicate words across due, spot-check, and new unlearned words.
   - Queue hierarchy: Due reviews -> Spot-check words -> New unlearned words.
6. Ephemeral Server REST API & Endpoints:
   - Non-destructive execution via ephemeral port ("127.0.0.1", 0) with isolated temporary ModuleStore.
   - /api/listening/stats (pretest object).
   - /api/listening/words?scope=pretest and scope=spot_check.
   - /api/listening/review (is_pretest, is_spot_check).
   - /api/listening/settings (spot_check_count validation).
   - Static HTML serving validation.
"""

import os
import sys
import json
import time
import shutil
import tempfile
import threading
import datetime
import urllib.request
import urllib.error
from http.server import HTTPServer
import unittest

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import config
import server
from core.storage import ModuleStore
from core.session_manager import generate_session
from core.scheduler_listening import (
    apply_pretest_result,
    calculate_spot_check_quota,
    apply_spot_check_result,
    get_shanghai_today,
    get_shanghai_midnight_ts
)


# =============================================================================
# 1. PRE-TEST STATE TRANSITIONS (R2)
# =============================================================================
class TestPretestStateTransitions(unittest.TestCase):
    """Verifies pre-test pass and fail state transitions and queue exclusions."""

    def setUp(self):
        self.today = get_shanghai_today()
        self.now_ts = int(time.time())

    def test_pretest_passed_state(self):
        """Pre-test pass sets stage=6, 2099-12-31, consecutive_correct=1, lapsed=False."""
        word = {
            "id": "abandon",
            "word": "abandon",
            "stage": 0,
            "review_count": 0,
            "correct_count": 0,
            "wrong_count": 0,
            "consecutive_correct": 0,
            "lapsed": False
        }
        res = apply_pretest_result(word, is_correct=True, current_date_shanghai=self.today, now_ts=self.now_ts)

        self.assertEqual(res["pretest_status"], "passed")
        self.assertEqual(res["stage"], 6)
        self.assertEqual(res["next_review_date"], "2099-12-31")
        self.assertEqual(res["next_review"], 4102329600)
        self.assertEqual(res["consecutive_correct"], 1)
        self.assertEqual(res["review_count"], 1)
        self.assertEqual(res["correct_count"], 1)
        self.assertEqual(res["wrong_count"], 0)
        self.assertFalse(res["lapsed"])
        self.assertEqual(res["last_review"], self.now_ts)
        self.assertEqual(res["last_review_date"], self.today.strftime("%Y-%m-%d"))
        self.assertEqual(res["pretest_at"], self.now_ts)

    def test_pretest_failed_state(self):
        """Pre-test fail sets stage=0, next_review_date=today, wrong_count=1, lapsed=True."""
        word = {
            "id": "ability",
            "word": "ability",
            "stage": 0,
            "review_count": 0,
            "correct_count": 0,
            "wrong_count": 0,
            "consecutive_correct": 0,
            "lapsed": False
        }
        res = apply_pretest_result(word, is_correct=False, current_date_shanghai=self.today, now_ts=self.now_ts)

        self.assertEqual(res["pretest_status"], "failed")
        self.assertEqual(res["stage"], 0)
        self.assertEqual(res["next_review_date"], self.today.strftime("%Y-%m-%d"))
        self.assertEqual(res["next_review"], get_shanghai_midnight_ts(self.today))
        self.assertEqual(res["consecutive_correct"], 0)
        self.assertEqual(res["review_count"], 0)  # Remains unlearned to be studied
        self.assertEqual(res["wrong_count"], 1)
        self.assertTrue(res["lapsed"])
        self.assertEqual(res["last_review"], self.now_ts)
        self.assertEqual(res["last_review_date"], self.today.strftime("%Y-%m-%d"))
        self.assertEqual(res["pretest_at"], self.now_ts)

    def test_pretest_passed_excluded_from_unlearned_and_due(self):
        """Pre-test passed words are strictly excluded from unlearned and due queues."""
        tmp = tempfile.mkdtemp(prefix="test_pretest_queue_")
        try:
            store = ModuleStore(os.path.join(tmp, "listening.json"))
            # 1. Passed pre-test word
            store.update_word("w_passed", {
                "id": "w_passed", "word": "passed_word", "stage": 6,
                "pretest_status": "passed", "next_review_date": "2099-12-31"
            })
            # 2. Failed pre-test word
            store.update_word("w_failed", {
                "id": "w_failed", "word": "failed_word", "stage": 0,
                "pretest_status": "failed", "lapsed": True,
                "next_review_date": self.today.strftime("%Y-%m-%d")
            })
            # 3. Normal unlearned word
            store.update_word("w_new", {
                "id": "w_new", "word": "new_word", "stage": 0, "review_count": 0
            })

            session = generate_session(store, current_date_shanghai=self.today)
            due_ids = [w["id"] for w in session["queue"] if not w.get("_isSpotCheck") and w.get("lapsed")]
            new_ids = [w["id"] for w in session["queue"] if w.get("stage", 0) == 0 and not w.get("lapsed") and not w.get("_isSpotCheck")]
            spot_ids = [w["id"] for w in session["queue"] if w.get("_isSpotCheck")]

            self.assertNotIn("w_passed", due_ids)
            self.assertNotIn("w_passed", new_ids)
            self.assertIn("w_passed", spot_ids)  # Enrolled in spot check
            self.assertIn("w_failed", due_ids)    # Enrolled in due review queue
            self.assertIn("w_new", new_ids)        # Enrolled in new words queue
        finally:
            shutil.rmtree(tmp)


# =============================================================================
# 2. SPOT-CHECK DYNAMIC QUOTA CALCULATION (R3)
# =============================================================================
class TestSpotCheckQuotaCalculation(unittest.TestCase):
    """Verifies 10%–20% dynamic spot check quota clamping across all review volumes."""

    def test_quota_across_required_review_volumes(self):
        """Tests exact quota for volumes: 0, 5, 10, 20, 35, 40, 50, 80, 100, 200."""
        expected_quotas = {
            0: 5,     # Default count fallback
            5: 1,     # 10%=0.5->1, 20%=1.0->1, target=1 (20.0%)
            10: 2,    # 10%=1, 20%=2, target=2 (20.0%)
            20: 3,    # 10%=2, 20%=4, target=3 (15.0%)
            35: 5,    # 10%=4, 20%=7, target=5 (14.3%)
            40: 6,    # 10%=4, 20%=8, target=6 (15.0%)
            50: 8,    # 10%=5, 20%=10, target=8 (16.0%)
            80: 12,   # 10%=8, 20%=16, target=12 (15.0%)
            100: 15,  # 10%=10, 20%=20, target=15 (15.0%)
            200: 30   # 10%=20, 20%=40, target=30 (15.0%)
        }

        for vol, expected in expected_quotas.items():
            actual = calculate_spot_check_quota(vol)
            self.assertEqual(
                actual, expected,
                f"Volume {vol}: expected quota {expected}, got {actual}"
            )
            if vol > 0:
                # Assert mathematically bounded between round(10%) and round(20%)
                lower = max(1, round(vol * 0.10))
                upper = max(1, round(vol * 0.20))
                self.assertTrue(lower <= actual <= upper)

    def test_quota_boundary_and_corner_cases(self):
        """Tests negative volumes, zero default, custom default, and inverted ratios."""
        # Negative review volume returns default_count
        self.assertEqual(calculate_spot_check_quota(-10, default_count=5), 5)
        # Review volume <= 0 with zero/negative default returns 1
        self.assertEqual(calculate_spot_check_quota(0, default_count=0), 1)
        self.assertEqual(calculate_spot_check_quota(-5, default_count=-2), 1)
        # Custom default count on volume 0
        self.assertEqual(calculate_spot_check_quota(0, default_count=8), 8)
        # Inverted ratio arguments: min_ratio > max_ratio should auto-swap
        self.assertEqual(calculate_spot_check_quota(40, min_ratio=0.20, max_ratio=0.10), 6)
        # Equal ratio boundaries
        self.assertEqual(calculate_spot_check_quota(50, min_ratio=0.15, max_ratio=0.15), 8)


# =============================================================================
# 3. SPOT-CHECK SAMPLING & LRU ORDERING (R3)
# =============================================================================
class TestSpotCheckSamplingAndLRU(unittest.TestCase):
    """Verifies LRU ordering by last_spot_check timestamp, empty and partial pools."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="test_spot_lru_")
        self.store = ModuleStore(os.path.join(self.tmp, "listening.json"))
        self.today = get_shanghai_today()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_lru_ordering_by_last_spot_check_timestamp(self):
        """Prioritizes words never spot-checked (None/0), then oldest timestamp."""
        # Add 4 mastered words with varying last_spot_check timestamps
        self.store.update_word("w_never", {
            "id": "w_never", "word": "never", "stage": 6, "pretest_status": "passed",
            "next_review_date": "2099-12-31", "last_spot_check": None
        })
        self.store.update_word("w_old", {
            "id": "w_old", "word": "old", "stage": 6, "pretest_status": "passed",
            "next_review_date": "2099-12-31", "last_spot_check": 1000
        })
        self.store.update_word("w_mid", {
            "id": "w_mid", "word": "mid", "stage": 6, "pretest_status": "passed",
            "next_review_date": "2099-12-31", "last_spot_check": 2000
        })
        self.store.update_word("w_recent", {
            "id": "w_recent", "word": "recent", "stage": 6, "pretest_status": "passed",
            "next_review_date": "2099-12-31", "last_spot_check": 3000
        })

        # Set spot_check_count setting to 2
        self.store.update_settings({"review_cap": 40, "daily_new_words": 10, "spot_check_count": 2})

        session = generate_session(self.store, current_date_shanghai=self.today)
        sampled_ids = [w["id"] for w in session["queue"] if w.get("_isSpotCheck")]

        self.assertEqual(len(sampled_ids), 2)
        # Least recently checked (w_never, w_old) must be selected
        self.assertEqual(sampled_ids, ["w_never", "w_old"])

    def test_empty_mastered_pool(self):
        """When 0 words are mastered, session completes gracefully with spot_check_count=0."""
        self.store.update_word("w_new", {
            "id": "w_new", "word": "new", "stage": 0, "review_count": 0
        })
        session = generate_session(self.store, current_date_shanghai=self.today)
        self.assertEqual(session["spot_check_count"], 0)
        self.assertEqual(len([w for w in session["queue"] if w.get("_isSpotCheck")]), 0)

    def test_pool_smaller_than_quota(self):
        """When mastered pool < quota, samples all available without duplication."""
        self.store.update_word("w1", {
            "id": "w1", "word": "w1", "stage": 6, "pretest_status": "passed",
            "next_review_date": "2099-12-31"
        })
        self.store.update_word("w2", {
            "id": "w2", "word": "w2", "stage": 6, "pretest_status": "passed",
            "next_review_date": "2099-12-31"
        })
        # Quota is 5, but pool only has 2
        self.store.update_settings({"review_cap": 40, "daily_new_words": 10, "spot_check_count": 5})

        session = generate_session(self.store, current_date_shanghai=self.today)
        sampled_ids = [w["id"] for w in session["queue"] if w.get("_isSpotCheck")]

        self.assertEqual(len(sampled_ids), 2)
        self.assertEqual(set(sampled_ids), {"w1", "w2"})
        self.assertEqual(session["spot_check_count"], 2)


# =============================================================================
# 4. SPOT-CHECK PASS & FAIL STATE TRANSITIONS (R3)
# =============================================================================
class TestSpotCheckStateTransitions(unittest.TestCase):
    """Verifies spot-check pass (retains stage 6) and fail (resets to stage 0, reactivates)."""

    def setUp(self):
        self.today = get_shanghai_today()
        self.now_ts = int(time.time())

    def test_spot_check_passed(self):
        """Spot check pass retains stage 6, 2099-12-31, and increments spot_check_correct."""
        word = {
            "id": "academic",
            "word": "academic",
            "stage": 6,
            "pretest_status": "passed",
            "next_review_date": "2099-12-31",
            "next_review": 4102329600,
            "review_count": 1,
            "correct_count": 1,
            "lapsed": False,
            "spot_check_count": 0,
            "spot_check_correct": 0
        }
        res = apply_spot_check_result(word, is_correct=True, current_date_shanghai=self.today, now_ts=self.now_ts)

        self.assertEqual(res["stage"], 6)
        self.assertEqual(res["next_review_date"], "2099-12-31")
        self.assertEqual(res["next_review"], 4102329600)
        self.assertEqual(res["pretest_status"], "passed")
        self.assertFalse(res["lapsed"])
        self.assertEqual(res["spot_check_count"], 1)
        self.assertEqual(res["spot_check_correct"], 1)
        self.assertEqual(res["correct_count"], 2)
        self.assertEqual(res["last_spot_check"], self.now_ts)

    def test_spot_check_failed_resets_and_schedules_tomorrow(self):
        """Spot check fail resets stage=0, lapsed=True, next_review_date=tomorrow, spot_check_wrong=1."""
        word = {
            "id": "accurate",
            "word": "accurate",
            "stage": 6,
            "pretest_status": "passed",
            "next_review_date": "2099-12-31",
            "next_review": 4102329600,
            "review_count": 1,
            "consecutive_correct": 3,
            "lapsed": False,
            "wrong_count": 0,
            "spot_check_count": 0,
            "spot_check_wrong": 0
        }
        tomorrow = self.today + datetime.timedelta(days=1)
        res = apply_spot_check_result(word, is_correct=False, current_date_shanghai=self.today, now_ts=self.now_ts)

        self.assertEqual(res["stage"], 0)
        self.assertEqual(res["pretest_status"], "failed")
        self.assertTrue(res["lapsed"])
        self.assertEqual(res["consecutive_correct"], 0)
        self.assertEqual(res["wrong_count"], 1)
        self.assertEqual(res["spot_check_count"], 1)
        self.assertEqual(res.get("spot_check_wrong"), 1)
        self.assertEqual(res["next_review_date"], tomorrow.strftime("%Y-%m-%d"))
        self.assertEqual(res["next_review"], get_shanghai_midnight_ts(tomorrow))
        self.assertEqual(res["last_spot_check"], self.now_ts)

    def test_spot_check_failed_reactivates_into_next_day_due_queue(self):
        """A spot-check failed word re-enters the active due review queue the following day."""
        tmp = tempfile.mkdtemp(prefix="test_reactivate_")
        try:
            store = ModuleStore(os.path.join(tmp, "listening.json"))
            word = {
                "id": "achieve",
                "word": "achieve",
                "stage": 6,
                "pretest_status": "passed",
                "next_review_date": "2099-12-31"
            }
            # Fail spot check on Day 1
            apply_spot_check_result(word, is_correct=False, current_date_shanghai=self.today, now_ts=self.now_ts)
            store.update_word("achieve", word)

            # On Day 1 (today), next_review_date is tomorrow, so it is NOT due yet today
            s_today = generate_session(store, current_date_shanghai=self.today)
            due_today = [w["id"] for w in s_today["queue"] if w.get("lapsed") and not w.get("_isSpotCheck")]
            self.assertNotIn("achieve", due_today)

            # On Day 2 (tomorrow), it comes due and MUST be in the active review queue!
            tomorrow = self.today + datetime.timedelta(days=1)
            s_tomorrow = generate_session(store, current_date_shanghai=tomorrow)
            due_tomorrow = [w["id"] for w in s_tomorrow["queue"] if w.get("lapsed") and not w.get("_isSpotCheck")]
            self.assertIn("achieve", due_tomorrow)
        finally:
            shutil.rmtree(tmp)


# =============================================================================
# 5. SESSION QUEUE COMPOSITION & ZERO DUPLICATES (R2, R3, R4)
# =============================================================================
class TestSessionQueueCompositionAndZeroDuplicates(unittest.TestCase):
    """Verifies strict 0 duplicate words and queue precedence across due, spot-check, and new words."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="test_zero_dup_")
        self.store = ModuleStore(os.path.join(self.tmp, "listening.json"))
        self.today = get_shanghai_today()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_strict_zero_duplicates_across_due_spot_and_new(self):
        """Guarantees absolute 0 duplicate words in the session queue."""
        today_str = self.today.strftime("%Y-%m-%d")

        # 1. Populate 5 due review words
        for i in range(5):
            self.store.update_word(f"due_{i}", {
                "id": f"due_{i}", "word": f"due_{i}", "stage": 1, "review_count": 1,
                "next_review_date": today_str
            })
        # 2. Populate 5 mastered words (spot check pool)
        for i in range(5):
            self.store.update_word(f"mastered_{i}", {
                "id": f"mastered_{i}", "word": f"mastered_{i}", "stage": 6,
                "pretest_status": "passed", "next_review_date": "2099-12-31",
                "last_spot_check": i * 100
            })
        # 3. Populate 10 unlearned new words
        for i in range(10):
            self.store.update_word(f"new_{i}", {
                "id": f"new_{i}", "word": f"new_{i}", "stage": 0, "review_count": 0
            })

        self.store.update_settings({"review_cap": 10, "daily_new_words": 5, "spot_check_count": 3})
        session = generate_session(self.store, current_date_shanghai=self.today)

        queue = session["queue"]
        queue_ids = [w["id"] for w in queue]

        # 1. Strict uniqueness: count equals unique set count
        self.assertEqual(len(queue_ids), len(set(queue_ids)), "Duplicate words found in session queue!")
        # 2. Composition counts must sum exactly to total
        self.assertEqual(session["total"], len(queue))
        self.assertEqual(
            session["total"],
            session["due_count"] + session["spot_check_count"] + session["new_count"]
        )
        self.assertEqual(session["due_count"], 5)
        self.assertEqual(session["spot_check_count"], 1)  # Quota for review_volume=5 is 1
        self.assertEqual(session["new_count"], 5)

    def test_queue_ordering_hierarchy(self):
        """Verifies queue ordering: due reviews first -> spot checks second -> new words third."""
        today_str = self.today.strftime("%Y-%m-%d")
        self.store.update_word("w_due", {
            "id": "w_due", "word": "w_due", "stage": 2, "review_count": 2,
            "next_review_date": today_str
        })
        self.store.update_word("w_spot", {
            "id": "w_spot", "word": "w_spot", "stage": 6, "pretest_status": "passed",
            "next_review_date": "2099-12-31"
        })
        self.store.update_word("w_new", {
            "id": "w_new", "word": "w_new", "stage": 0, "review_count": 0
        })

        session = generate_session(self.store, current_date_shanghai=self.today)
        queue_ids = [w["id"] for w in session["queue"]]

        self.assertEqual(queue_ids, ["w_due", "w_spot", "w_new"])
        self.assertTrue(session["queue"][1].get("_isSpotCheck", False))


# =============================================================================
# 6. EPHEMERAL SERVER REST API & ENDPOINTS (R4)
# =============================================================================
class TestPretestSpotCheckServerAPI(unittest.TestCase):
    """Verifies Pre-test & Spot Check REST API endpoints in an isolated ephemeral test server."""

    @classmethod
    def setUpClass(cls):
        cls.tmpdir = tempfile.mkdtemp(prefix="test_pretest_srv_")
        cls.test_listening_file = os.path.join(cls.tmpdir, "listening.json")
        cls.test_store = ModuleStore(cls.test_listening_file, config.DEFAULT_LISTENING_SETTINGS)

        # Seed sample words:
        # Untested pre-test word
        cls.test_store.update_word("untested1", {
            "id": "untested1", "word": "untested1", "stage": 0, "review_count": 0
        })
        # Passed word
        cls.test_store.update_word("passed1", {
            "id": "passed1", "word": "passed1", "stage": 6, "pretest_status": "passed",
            "next_review_date": "2099-12-31", "review_count": 1
        })
        # Failed word
        cls.test_store.update_word("failed1", {
            "id": "failed1", "word": "failed1", "stage": 0, "pretest_status": "failed",
            "lapsed": True, "next_review_date": "2026-11-08"
        })
        cls.test_store.save()

        # Redirect server listening_store to test_store
        cls.orig_listening_store = server.listening_store
        cls.orig_handler_store = server.DictationHandler.listening_store
        server.listening_store = cls.test_store
        server.DictationHandler.listening_store = cls.test_store

        # Start ephemeral HTTPServer on dynamic free port 0
        cls.server = HTTPServer(("127.0.0.1", 0), server.DictationHandler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        server.listening_store = cls.orig_listening_store
        server.DictationHandler.listening_store = cls.orig_handler_store
        shutil.rmtree(cls.tmpdir)

    def _get(self, path: str) -> tuple[int, dict]:
        req = urllib.request.Request(f"{self.base_url}{path}")
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))

    def _post(self, path: str, data: dict) -> tuple[int, dict]:
        body = json.dumps(data).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}{path}",
            data=body,
            headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=3.0) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8")
            code = e.code
            e.close()
            return code, json.loads(raw) if raw else {}

    def test_01_stats_endpoint_includes_pretest(self):
        status, data = self._get("/api/listening/stats")
        self.assertEqual(status, 200)
        self.assertIn("pretest", data)
        pt = data["pretest"]
        self.assertEqual(pt["total"], pt["tested"] + pt["untested"])
        self.assertEqual(pt["tested"], pt["passed"] + pt["failed"])
        self.assertEqual(pt["passed"], 1)
        self.assertEqual(pt["failed"], 1)
        self.assertEqual(pt["untested"], 1)

    def test_02_words_pretest_and_spot_check_scope_filtering(self):
        # Pretest scope
        status, pt_data = self._get("/api/listening/words?scope=pretest")
        self.assertEqual(status, 200)
        pt_words = pt_data.get("words", [])
        self.assertEqual(len(pt_words), 1)
        self.assertEqual(pt_words[0]["id"], "untested1")
        self.assertTrue(pt_words[0]["_isPretest"])

        # Spot check scope
        status, sc_data = self._get("/api/listening/words?scope=spot_check")
        self.assertEqual(status, 200)
        sc_words = sc_data.get("words", [])
        self.assertEqual(len(sc_words), 1)
        self.assertEqual(sc_words[0]["id"], "passed1")
        self.assertTrue(sc_words[0]["_isSpotCheck"])

    def test_03_review_pretest_workflow(self):
        # Submit pretest pass
        status, res = self._post("/api/listening/review", {
            "word": "untested1",
            "correct": True,
            "is_pretest": True
        })
        self.assertEqual(status, 200)
        w = res["word"]
        self.assertEqual(w["pretest_status"], "passed")
        self.assertEqual(w["stage"], 6)
        self.assertEqual(w["next_review_date"], "2099-12-31")

        # Stats updated
        status, stats = self._get("/api/listening/stats")
        self.assertEqual(stats["pretest"]["passed"], 2)
        self.assertEqual(stats["pretest"]["untested"], 0)

    def test_04_review_spot_check_workflow(self):
        # Fail spot check for passed1
        status, res = self._post("/api/listening/review", {
            "word": "passed1",
            "correct": False,
            "is_spot_check": True
        })
        self.assertEqual(status, 200)
        w = res["word"]
        self.assertEqual(w["pretest_status"], "failed")
        self.assertEqual(w["stage"], 0)
        self.assertTrue(w["lapsed"])
        self.assertEqual(w.get("spot_check_wrong"), 1)

    def test_05_settings_spot_check_count_crud_and_validation(self):
        status, settings = self._get("/api/listening/settings")
        self.assertEqual(status, 200)

        # Update spot_check_count to 12
        status, updated = self._post("/api/listening/settings", {
            "review_cap": 40,
            "daily_new_words": 10,
            "spot_check_count": 12
        })
        self.assertEqual(status, 200)
        self.assertEqual(updated["settings"]["spot_check_count"], 12)

        # Validation: reject negative numbers
        status, err = self._post("/api/listening/settings", {
            "review_cap": 40,
            "daily_new_words": 10,
            "spot_check_count": -5
        })
        self.assertEqual(status, 400)

    def test_06_static_page_serves(self):
        req = urllib.request.Request(f"{self.base_url}/")
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            self.assertEqual(resp.status, 200)
            content = resp.read().decode("utf-8")
            self.assertIn("全库摸底测验", content)
            self.assertIn("熟词日常抽检", content)
            self.assertIn("pretest-banner-card", content)

    def test_07_pretest_no_retry_reinforcement_in_frontend(self):
        """Verifies that in pretest mode, error retry queue reinforcement is strictly disabled."""
        req = urllib.request.Request(f"{self.base_url}/")
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            content = resp.read().decode("utf-8")
            self.assertIn("if (!card || card._isPretest) return", content)
            self.assertIn("摸底测验不进行错词强化", content)


if __name__ == "__main__":
    unittest.main()
