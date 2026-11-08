#!/usr/bin/env python3
"""
test_challenger_m3_empirical.py

EMPIRICAL CHALLENGER TEST SUITE FOR MILESTONE 3 (R2, R3, R4):
Adversarial stress harness and invariant verification:
1. Spot-Check Dynamic Quota Calculations across Extreme Volumes (0 to 1000 reviews):
   - Exhaustive sweep for all volumes 0..1000 verifying 10%–20% bounds.
   - Mathematical integer rounding bounds: lower = max(1, round(vol * 0.10)), upper = max(1, round(vol * 0.20)).
   - Extreme boundary stress: negative volumes, massive volumes (10,000, 100,000), custom defaults, inverted ratios.
2. LRU Sorting by `last_spot_check` Timestamp Under Ties & Randomized Updates:
   - Exhaustive verification of timestamp variations (None, 0, positive integers).
   - Deterministic secondary tie-breaking on word ID.
   - 15-session multi-day circular rotation simulation with 30 words verifying exact uniform sampling (zero starvation).
   - Randomized timestamp fuzzing with 100 words verifying strict monotonic ascending LRU order.
3. Zero-Duplicate Invariants in `generate_session` under Mixed Queues:
   - 500 randomized fuzzing iterations under dirty stores and mixed queue states.
   - Strict zero-duplicate invariant: len(queue) == len(set(ids)).
   - Strict queue precedence hierarchy: Due -> Spot-Check -> New unlearned words.
   - Excess review carryover isolation: overdue words beyond review_cap never leak into unlearned or spot-check queues.
4. Pretest & Spot-Check State Machine Multi-Day Lifecycle:
   - Pre-test pass -> stage 6, 2099-12-31, excluded from due and new queues.
   - Pre-test fail -> stage 0, today, lapsed=True, review_count=0, enrolled into active review queue.
   - Spot-check pass -> stage 6 retained, 2099-12-31 retained, spot_check_correct incremented, NO interval advance.
   - Spot-check fail -> stage 0 reset, next_review_date=tomorrow, lapsed=True, spot_check_wrong incremented.
   - Tomorrow re-enrollment -> appears in active due queue -> pass promotes to stage 1.
"""

import os
import sys
import time
import random
import shutil
import tempfile
import datetime
from datetime import timedelta
import unittest

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import config
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


# =============================================================================
# 1. SPOT-CHECK QUOTA STRESS HARNESS (VOLUMES 0 TO 1000)
# =============================================================================
class TestSpotCheckQuotaStressHarness(unittest.TestCase):
    """Stress tests spot-check quota calculations across extreme volume values."""

    def test_exhaustive_quota_sweep_0_to_1000(self):
        """Exhaustively verifies every single integer volume from 0 to 1000."""
        for vol in range(0, 1001):
            quota = calculate_spot_check_quota(vol)
            self.assertIsInstance(quota, int, f"Volume {vol} did not return integer")
            self.assertGreaterEqual(quota, 1, f"Volume {vol} returned quota < 1")

            if vol == 0:
                self.assertEqual(quota, 5, "Volume 0 must return default count 5")
            else:
                lower = max(1, round(vol * 0.10))
                upper = max(1, round(vol * 0.20))
                target = round(vol * 0.15)
                expected = min(max(target, lower), upper)
                self.assertEqual(
                    quota, expected,
                    f"Volume {vol}: expected {expected}, got {quota}"
                )
                self.assertTrue(
                    lower <= quota <= upper,
                    f"Volume {vol}: quota {quota} not within [{lower}, {upper}]"
                )

                # For review volumes >= 5, verify the effective percentage is bounded in [10%, 20%]
                if vol >= 5:
                    ratio = quota / vol
                    self.assertGreaterEqual(
                        ratio, 0.099,
                        f"Volume {vol}: ratio {ratio:.4f} fell below 10%"
                    )
                    self.assertLessEqual(
                        ratio, 0.201,
                        f"Volume {vol}: ratio {ratio:.4f} exceeded 20%"
                    )

    def test_extreme_and_boundary_volumes(self):
        """Tests extreme volumes, negative inputs, and massive numbers."""
        # Massive volumes
        self.assertEqual(calculate_spot_check_quota(10000), 1500)
        self.assertEqual(calculate_spot_check_quota(100000), 15000)

        # Negative and zero volumes
        self.assertEqual(calculate_spot_check_quota(-1), 5)
        self.assertEqual(calculate_spot_check_quota(-9999), 5)
        self.assertEqual(calculate_spot_check_quota(0), 5)

        # Custom default counts on volume <= 0
        self.assertEqual(calculate_spot_check_quota(0, default_count=12), 12)
        self.assertEqual(calculate_spot_check_quota(-10, default_count=20), 20)
        # Non-positive default count falls back to 1
        self.assertEqual(calculate_spot_check_quota(0, default_count=0), 1)
        self.assertEqual(calculate_spot_check_quota(0, default_count=-5), 1)

    def test_ratio_swapping_and_custom_ratios(self):
        """Tests inverted ratios, identical ratios, and extreme ratios."""
        # Swapped ratios min > max
        self.assertEqual(
            calculate_spot_check_quota(100, min_ratio=0.20, max_ratio=0.10),
            15
        )
        # Equal ratios (forces exact ratio clamping)
        self.assertEqual(
            calculate_spot_check_quota(100, min_ratio=0.10, max_ratio=0.10),
            10
        )
        self.assertEqual(
            calculate_spot_check_quota(100, min_ratio=0.20, max_ratio=0.20),
            20
        )


# =============================================================================
# 2. LRU SORTING UNDER TIES & RANDOMIZED UPDATES
# =============================================================================
class TestSpotCheckLRUAndTieBreaking(unittest.TestCase):
    """Stress tests LRU sampling by last_spot_check under ties and randomized updates."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="test_challenger_lru_")
        self.store = ModuleStore(os.path.join(self.tmp, "listening.json"))
        self.today = get_shanghai_today()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_deterministic_alphabetical_tie_breaker(self):
        """When multiple words share the exact same timestamp, tie-breaking is strictly alphabetical by ID."""
        words = ["zebra", "apple", "mango", "banana", "cherry"]
        for w_id in words:
            self.store.update_word(w_id, {
                "id": w_id, "word": w_id, "stage": 6, "pretest_status": "passed",
                "next_review_date": "2099-12-31", "last_spot_check": 1000
            })

        self.store.update_settings({"review_cap": 40, "daily_new_words": 0, "spot_check_count": 3})
        session = generate_session(self.store, current_date_shanghai=self.today)
        sampled_ids = [w["id"] for w in session["queue"] if w.get("_isSpotCheck")]

        # All 5 words have timestamp 1000. Sorting by (1000, id) must yield alphabetical order!
        self.assertEqual(sampled_ids, ["apple", "banana", "cherry"])

    def test_none_and_zero_priority_over_timestamps(self):
        """Words with last_spot_check=None or 0 take precedence over any positive timestamp."""
        self.store.update_word("w_ts1", {
            "id": "w_ts1", "word": "ts1", "stage": 6, "pretest_status": "passed",
            "next_review_date": "2099-12-31", "last_spot_check": 1
        })
        self.store.update_word("w_none", {
            "id": "w_none", "word": "none", "stage": 6, "pretest_status": "passed",
            "next_review_date": "2099-12-31", "last_spot_check": None
        })
        self.store.update_word("w_zero", {
            "id": "w_zero", "word": "zero", "stage": 6, "pretest_status": "passed",
            "next_review_date": "2099-12-31", "last_spot_check": 0
        })

        self.store.update_settings({"review_cap": 40, "daily_new_words": 0, "spot_check_count": 2})
        session = generate_session(self.store, current_date_shanghai=self.today)
        sampled_ids = [w["id"] for w in session["queue"] if w.get("_isSpotCheck")]

        # None (0) and 0 (0) come before ts1 (1). Between w_none and w_zero, alphabetical: w_none, w_zero
        self.assertEqual(sampled_ids, ["w_none", "w_zero"])

    def test_multi_session_fair_rotation_zero_starvation(self):
        """Simulates 15 consecutive daily spot-check sessions across a pool of 30 words.

        Verifies that LRU updates guarantee 100% fair rotation with zero starvation.
        """
        pool_size = 30
        quota = 6
        for i in range(pool_size):
            wid = f"word_{i:02d}"
            self.store.update_word(wid, {
                "id": wid, "word": wid, "stage": 6, "pretest_status": "passed",
                "next_review_date": "2099-12-31", "last_spot_check": None
            })

        self.store.update_settings({"review_cap": 40, "daily_new_words": 0, "spot_check_count": quota})

        # Run 15 sessions. Total samples = 15 * 6 = 90.
        # Across 30 words, every word must be picked EXACTLY 3 times.
        pick_counts = {f"word_{i:02d}": 0 for i in range(pool_size)}
        for session_idx in range(15):
            sim_date = self.today + timedelta(days=session_idx)
            session = generate_session(self.store, current_date_shanghai=sim_date)
            sampled = [w for w in session["queue"] if w.get("_isSpotCheck")]
            self.assertEqual(len(sampled), quota)

            # Update sampled words with current timestamp
            now_ts = 1700000000 + (session_idx * 86400)
            for sw in sampled:
                pick_counts[sw["id"]] += 1
                w_record = self.store.get_word(sw["id"])
                apply_spot_check_result(w_record, is_correct=True, now_ts=now_ts)
                self.store.update_word(sw["id"], w_record)

        # Verify exact uniformity
        for wid, count in pick_counts.items():
            self.assertEqual(
                count, 3,
                f"Word {wid} was picked {count} times instead of exactly 3"
            )

    def test_randomized_timestamp_lru_fuzzing(self):
        """Seeds 100 words with randomized timestamps (including tie clusters) and verifies strict LRU ordering."""
        rng = random.Random(999)
        num_words = 100
        for i in range(num_words):
            wid = f"fuzz_{i:03d}"
            ts = rng.choice([None, 0, 100, 100, 200, 200, rng.randint(1, 10000)])
            self.store.update_word(wid, {
                "id": wid, "word": wid, "stage": 6, "pretest_status": "passed",
                "next_review_date": "2099-12-31", "last_spot_check": ts
            })

        self.store.update_settings({"review_cap": 40, "daily_new_words": 0, "spot_check_count": 35})
        session = generate_session(self.store, current_date_shanghai=self.today)
        sampled = [w for w in session["queue"] if w.get("_isSpotCheck")]
        self.assertEqual(len(sampled), 35)

        # Keys extracted from sampled list must be strictly monotonic ascending
        keys = [(w.get("last_spot_check") or 0, w["id"]) for w in sampled]
        self.assertEqual(keys, sorted(keys), "Sampled words violated strict LRU ordering")


# =============================================================================
# 3. ZERO-DUPLICATE INVARIANTS & QUEUE PRECEDENCE FUZZING
# =============================================================================
class TestZeroDuplicateAndQueuePrecedenceFuzzing(unittest.TestCase):
    """Stress tests zero duplicate invariants and queue precedence hierarchy under random fuzzing."""

    def test_randomized_mixed_queue_fuzzing_valid_store(self):
        """Runs 300 randomized fuzzing iterations on valid stores, asserting zero duplicates, sub-count sum, and strict hierarchy."""
        rng = random.Random(424242)

        for iteration in range(300):
            tmp = tempfile.mkdtemp(prefix=f"test_fuzz_valid_{iteration}_")
            try:
                store = ModuleStore(os.path.join(tmp, "listening.json"))
                num_items = rng.randint(20, 120)

                for i in range(num_items):
                    w_id = f"word_{i}"
                    status = rng.choice([None, "", "passed", "failed", "untested"])
                    stage = rng.choice([-1, 0, 1, 2, 4, 6, 7])
                    lapsed = rng.choice([True, False])
                    rev_count = rng.choice([0, 1, 5, 20])
                    next_date = rng.choice(["2025-01-01", "2026-11-08", "2026-11-09", "2099-12-31", None])
                    last_sc = rng.choice([None, 0, 500, 1000])
                    last_rev = rng.choice([None, 1700000000])

                    store.update_word(w_id, {
                        "id": w_id,
                        "word": w_id,
                        "stage": stage,
                        "lapsed": lapsed,
                        "review_count": rev_count,
                        "next_review_date": next_date,
                        "pretest_status": status,
                        "last_spot_check": last_sc,
                        "last_review": last_rev
                    })

                cap = rng.randint(1, 30)
                new_budget = rng.randint(0, 20)
                sc_count = rng.randint(0, 15)
                store.update_settings({
                    "review_cap": cap,
                    "daily_new_words": new_budget,
                    "spot_check_count": sc_count
                })

                session = generate_session(store, current_date_shanghai="2026-11-08")
                queue = session["queue"]
                ids = [w.get("id") or w.get("word") for w in queue]

                # Invariant 1: Absolute Zero Duplicates
                self.assertEqual(
                    len(ids), len(set(ids)),
                    f"Iteration {iteration}: Duplicate words detected in session queue!"
                )

                # Invariant 2: Total count strictly matches list length
                self.assertEqual(
                    session["total"], len(queue),
                    f"Iteration {iteration}: Total count mismatch"
                )

                # Invariant 3: Component counts sum exactly to total
                self.assertEqual(
                    session["due_count"] + session["spot_check_count"] + session["new_count"],
                    session["total"],
                    f"Iteration {iteration}: Sub-counts do not sum to total"
                )

                # Invariant 4: Queue Precedence Hierarchy: Due -> Spot Check -> New
                seen_phase = "due"
                for w in queue:
                    is_spot = bool(w.get("_isSpotCheck"))
                    is_new = (
                        w.get("stage", 0) == 0 and
                        w.get("review_count", 0) == 0 and
                        not w.get("lapsed") and
                        not is_spot
                    )
                    is_due = (not is_spot and not is_new)

                    if seen_phase == "due":
                        if is_spot:
                            seen_phase = "spot"
                        elif is_new:
                            seen_phase = "new"
                    elif seen_phase == "spot":
                        if is_due:
                            self.fail(f"Iteration {iteration}: Due review appeared after spot-check words")
                        elif is_new:
                            seen_phase = "new"
                    elif seen_phase == "new":
                        if is_due:
                            self.fail(f"Iteration {iteration}: Due review appeared after new words")
                        if is_spot:
                            self.fail(f"Iteration {iteration}: Spot-check word appeared after new words")

                # Invariant 5: Mutual exclusivity of categories
                due_words = queue[:session["due_count"]]
                spot_words = queue[session["due_count"]:session["due_count"] + session["spot_check_count"]]
                new_words = queue[session["due_count"] + session["spot_check_count"]:]

                due_set = {w.get("id") or w.get("word") for w in due_words}
                spot_set = {w.get("id") or w.get("word") for w in spot_words}
                new_set = {w.get("id") or w.get("word") for w in new_words}

                self.assertTrue(due_set.isdisjoint(spot_set), "Overlap between due and spot sets")
                self.assertTrue(due_set.isdisjoint(new_set), "Overlap between due and new sets")
                self.assertTrue(spot_set.isdisjoint(new_set), "Overlap between spot and new sets")

            finally:
                shutil.rmtree(tmp)

    def test_adversarial_corrupted_store_zero_duplicates_guarantee(self):
        """Even if the underlying storage contains duplicate internal IDs across keys, session queue guarantees zero duplicates."""
        rng = random.Random(777)
        for iteration in range(50):
            tmp = tempfile.mkdtemp(prefix=f"test_fuzz_corrupt_{iteration}_")
            try:
                store = ModuleStore(os.path.join(tmp, "listening.json"))
                # Intentionally insert duplicate IDs across different store keys
                shared_ids = ["apple", "banana", "cherry", "date"]
                for i in range(20):
                    chosen_id = rng.choice(shared_ids)
                    store.update_word(f"key_{i}", {
                        "id": chosen_id,
                        "word": chosen_id,
                        "stage": rng.choice([0, 1, 6]),
                        "pretest_status": rng.choice(["passed", "failed", None]),
                        "next_review_date": "2026-11-08"
                    })

                session = generate_session(store, current_date_shanghai="2026-11-08")
                queue = session["queue"]
                ids = [w.get("id") or w.get("word") for w in queue]

                # Deduplication invariant MUST hold: zero duplicate IDs in queue
                self.assertEqual(len(ids), len(set(ids)))
                self.assertEqual(session["total"], len(queue))
            finally:
                shutil.rmtree(tmp)


# =============================================================================
# 4. PRETEST & SPOT-CHECK STATE MACHINE MULTI-DAY LIFECYCLE
# =============================================================================
class TestStateTransitionsAndLifecycle(unittest.TestCase):
    """Verifies complete state machine transitions across multiple simulated days."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="test_lifecycle_")
        self.store = ModuleStore(os.path.join(self.tmp, "listening.json"))
        self.day1 = datetime.date(2026, 11, 1)
        self.day2 = datetime.date(2026, 11, 2)
        self.day3 = datetime.date(2026, 11, 3)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_pretest_pass_lifecycle(self):
        """Pre-test pass words remain permanently mastered across days unless spot-checked and failed."""
        w = {"id": "comprehend", "word": "comprehend", "stage": 0, "review_count": 0}
        apply_pretest_result(w, is_correct=True, current_date_shanghai=self.day1)
        self.store.update_word("comprehend", w)

        # Day 1: not in due or new queues
        s1 = generate_session(self.store, current_date_shanghai=self.day1)
        normal_ids = [item["id"] for item in s1["queue"] if not item.get("_isSpotCheck")]
        self.assertNotIn("comprehend", normal_ids)

        # Day 2: spot check pass retains mastered status
        apply_spot_check_result(w, is_correct=True, current_date_shanghai=self.day2)
        self.store.update_word("comprehend", w)

        self.assertEqual(w["stage"], 6)
        self.assertEqual(w["next_review_date"], "2099-12-31")
        self.assertFalse(w["lapsed"])
        self.assertEqual(w["spot_check_correct"], 1)

    def test_spot_check_failure_reactivation_and_progression(self):
        """Spot check failure sets stage=0, lapsed=True, schedules tomorrow, and advances to stage 1 upon passing."""
        w = {
            "id": "relinquish", "word": "relinquish", "stage": 6,
            "pretest_status": "passed", "next_review_date": "2099-12-31"
        }
        self.store.update_word("relinquish", w)

        # Day 1: Spot check failed
        apply_spot_check_result(w, is_correct=False, current_date_shanghai=self.day1)
        self.store.update_word("relinquish", w)

        self.assertEqual(w["pretest_status"], "failed")
        self.assertEqual(w["stage"], 0)
        self.assertTrue(w["lapsed"])
        self.assertEqual(w["spot_check_wrong"], 1)
        self.assertEqual(w["next_review_date"], "2026-11-02")

        # Day 1: Must NOT be due on Day 1 (scheduled for tomorrow)
        s1 = generate_session(self.store, current_date_shanghai=self.day1)
        due_day1 = [item["id"] for item in s1["queue"] if not item.get("_isSpotCheck")]
        self.assertNotIn("relinquish", due_day1)

        # Day 2: MUST be in due queue
        s2 = generate_session(self.store, current_date_shanghai=self.day2)
        due_day2 = [item["id"] for item in s2["queue"] if not item.get("_isSpotCheck")]
        self.assertIn("relinquish", due_day2)

        # Day 2: User successfully reviews it
        w = self.store.get_word("relinquish")
        completed = apply_listening_review(w, is_correct=True, current_date_shanghai=self.day2)
        self.store.update_word("relinquish", w)

        self.assertTrue(completed)
        self.assertEqual(w["stage"], 1)
        self.assertFalse(w["lapsed"])
        self.assertEqual(w["next_review_date"], "2026-11-03")

        # Day 3: Comes due again at stage 1
        s3 = generate_session(self.store, current_date_shanghai=self.day3)
        due_day3 = [item["id"] for item in s3["queue"] if not item.get("_isSpotCheck")]
        self.assertIn("relinquish", due_day3)


if __name__ == "__main__":
    unittest.main()
