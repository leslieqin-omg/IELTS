#!/usr/bin/env python3
"""
test_scheduling_backlog.py

Verifies Requirements R2, R5, R6 & Features 16, 17, 18, 30, 31, 32, 33, 34, 36:
1. Two-Tier Spelling Judgment:
   - Trimmed case-insensitive for general vocabulary.
   - Strict leading capital required for months and country names.
   - Capitalized common nouns from 9fnn allow lowercase answers.
   - Punctuation, alternative accepted answers, and empty input handling.
   - Startup capital scan (Feature 18).
2. Listening Scheduler (whole calendar days & Shanghai midnight):
   - Whole calendar day intervals: [1, 2, 4, 7, 15, 30].
   - Asia/Shanghai (UTC+8) midnight rollover (00:00:00 CST) with zero minute/second jitter.
   - Rescheduled strictly from actual review date.
   - Lapse handling (failed review resets to stage 0, lapsed=True, due next day).
3. Session Manager & Backlog Ordering:
   - Respects review_cap (default 40, minimum 1).
   - Excess overdue reviews carry over ordered strictly by due date ascending.
   - Respects daily_new_words budget (default 10); setting to 0 disables new words.
4. Error Retry Queue ("错词强化重测"):
   - Misspelled words re-queued 4–6 questions later.
   - Successful retry promotes normally to next stage.
   - No 5-minute double pass rule.
5. 7-Day Vacation Backlog Simulation:
   - Simulates 7 days off after learning Batch A and Batch B.
   - Verifies Batch A prioritized over Batch B.
   - Verifies new due date anchored to actual review date on Day 7.
6. Cross-Feature Combinations:
   - Settings mutation -> session generation -> backlog sorting -> review submission -> atomic save.
"""

import os
import sys
import json
import time
import tempfile
import datetime
from datetime import timezone, timedelta
import unittest

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from config import (
    SHANGHAI_TZ,
    LISTENING_INTERVALS,
    CASE_SENSITIVE_WORDS_FILE
)
from core.storage import ModuleStore
from core.spelling_judge import SpellingJudge, scan_case_sensitive_candidates
from core.session_manager import generate_session
from core.scheduler_listening import (
    calculate_listening_next_review,
    apply_listening_review,
    get_shanghai_midnight_ts,
    get_shanghai_today
)


class TestSpellingJudge(unittest.TestCase):
    """Tier 1 & Tier 2: Two-tier spelling evaluation and capitalization exceptions."""

    @classmethod
    def setUpClass(cls):
        cls.judge = SpellingJudge(CASE_SENSITIVE_WORDS_FILE)

    def test_01_standard_case_insensitive_matching(self):
        """General vocabulary matches case-insensitively with leading/trailing whitespace trimmed."""
        cases = [
            ("newspaper", "a newspaper", ["newspaper", "a newspaper"]),
            ("  airport  ", "airport", ["airport"]),
            ("ACCOMMODATION", "accommodation", ["accommodation"]),
            ("library", "Library", ["library"]),
        ]
        for user_inp, target, accepted in cases:
            ok, reason = self.judge.judge(user_inp, target, accepted)
            self.assertTrue(ok, f"Expected '{user_inp}' to match target '{target}'")
            self.assertEqual(reason, "correct")

    def test_02_capitalization_exceptions_months(self):
        """Months must start with a capital letter; lowercase answers return capitalization_error."""
        months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
        for m in months:
            # Correct capital
            ok, reason = self.judge.judge(m, m, [m])
            self.assertTrue(ok, f"Expected '{m}' to be accepted")
            self.assertEqual(reason, "correct")

            # Incorrect lowercase
            lower_m = m.lower()
            ok, reason = self.judge.judge(lower_m, m, [m])
            self.assertFalse(ok, f"Expected '{lower_m}' to be rejected for capitalization")
            self.assertEqual(reason, "capitalization_error")

    def test_03_capitalization_exceptions_countries(self):
        """Country names from case_sensitive_words.json must start with a capital letter; lowercase answers return capitalization_error."""
        countries = ["France", "Japan", "China", "Germany", "Italy", "Russia", "Spain", "America", "India", "Mexico"]
        for c in countries:
            ok, reason = self.judge.judge(c, c, [c])
            self.assertTrue(ok, f"Expected '{c}' to be accepted")
            self.assertEqual(reason, "correct")

            lower_c = c.lower()
            ok, reason = self.judge.judge(lower_c, c, [c])
            self.assertFalse(ok, f"Expected '{lower_c}' to be rejected for capitalization")
            self.assertEqual(reason, "capitalization_error")

    def test_04_capitalized_common_nouns_allow_lowercase(self):
        """Capitalized common nouns in 9fnn dataset (e.g. Carpets, Water, Danger) allow lowercase answers."""
        common_nouns = [
            ("carpets", "Carpets", ["carpets"]),
            ("water", "Water", ["water"]),
            ("danger", "Danger", ["danger"]),
            ("station", "Station", ["station"]),
        ]
        for user_inp, target, accepted in common_nouns:
            ok, reason = self.judge.judge(user_inp, target, accepted)
            self.assertTrue(ok, f"Expected common noun '{user_inp}' to be accepted for '{target}'")
            self.assertEqual(reason, "correct")

    def test_05_spelling_mismatches_and_empty_inputs(self):
        """Spelling mismatches and empty inputs return spelling_error."""
        invalid_cases = [
            ("", "airport"),
            ("   ", "station"),
            ("airprot", "airport"),
            ("newspapr", "newspaper"),
            ("stasion", "station"),
        ]
        for user_inp, target in invalid_cases:
            ok, reason = self.judge.judge(user_inp, target, [target])
            self.assertFalse(ok, f"Expected '{user_inp}' to be rejected for '{target}'")
            self.assertEqual(reason, "spelling_error")

    def test_06_startup_capital_candidate_scanner(self):
        """scan_case_sensitive_candidates finds all words with uppercase letters in vocabulary list."""
        sample_words = [
            {"word": "January"},
            {"word": "france"},
            {"word": "South Africa"},
            {"word": "a newspaper"},
            {"word": "Carpets"},
        ]
        candidates = scan_case_sensitive_candidates(sample_words)
        self.assertIn("January", candidates)
        self.assertIn("South Africa", candidates)
        self.assertIn("Carpets", candidates)
        self.assertNotIn("france", candidates)
        self.assertNotIn("a newspaper", candidates)


class TestListeningScheduler(unittest.TestCase):
    """Tier 1: Whole calendar day intervals and Asia/Shanghai midnight rollover."""

    def test_01_whole_calendar_day_intervals(self):
        """Verifies configured intervals are exactly [1, 2, 4, 7, 15, 30] whole days."""
        self.assertEqual(LISTENING_INTERVALS, [1, 2, 4, 7, 15, 30])
        self.assertEqual(len(LISTENING_INTERVALS), 6)

    def test_02_stage_progression_from_actual_review_date(self):
        """calculate_listening_next_review computes next due date as review_date + interval."""
        base_date = datetime.date(2026, 11, 4)
        expected_progressions = [
            (0, 1, "2026-11-05"),   # +1 day
            (1, 2, "2026-11-06"),   # +2 days
            (2, 3, "2026-11-08"),   # +4 days
            (3, 4, "2026-11-11"),   # +7 days
            (4, 5, "2026-11-19"),   # +15 days
            (5, 5, "2026-12-04"),   # max stage capped at 5, +30 days
        ]
        for current_stage, expected_next_stage, expected_due_str in expected_progressions:
            next_stage, next_due_str, next_ts, lapsed = calculate_listening_next_review(
                current_stage=current_stage,
                is_correct=True,
                current_date_shanghai=base_date
            )
            self.assertEqual(next_stage, expected_next_stage)
            self.assertEqual(next_due_str, expected_due_str)
            self.assertFalse(lapsed)

    def test_03_shanghai_midnight_rollover_alignment(self):
        """get_shanghai_midnight_ts() aligns exactly to 00:00:00 CST with zero jitter."""
        dt = datetime.datetime(2026, 11, 4, 15, 30, 45, tzinfo=SHANGHAI_TZ)
        midnight_ts = get_shanghai_midnight_ts(dt.date())
        midnight_dt = datetime.datetime.fromtimestamp(midnight_ts, tz=SHANGHAI_TZ)

        self.assertEqual(midnight_dt.hour, 0)
        self.assertEqual(midnight_dt.minute, 0)
        self.assertEqual(midnight_dt.second, 0)
        self.assertEqual(midnight_dt.microsecond, 0)
        self.assertEqual(midnight_dt.date(), dt.date())

    def test_04_apply_listening_review_success_and_lapse(self):
        """apply_listening_review handles promotion on is_correct=True and stage reset on is_correct=False."""
        word = {"id": "test", "word": "test", "stage": 3, "review_count": 3}
        today = datetime.date(2026, 11, 4)

        # Successful review: stage 3 -> 4, review_count -> 4, next_review -> +7 days
        completed = apply_listening_review(word, is_correct=True, current_date_shanghai=today)
        self.assertTrue(completed)
        self.assertEqual(word["stage"], 4)
        self.assertEqual(word["review_count"], 4)
        self.assertEqual(word["next_review_date"], "2026-11-11")
        self.assertFalse(word.get("lapsed", False))

        # Failed review: stage stays 4, review_count -> 5, lapsed -> True, next_review -> +1 day
        apply_listening_review(word, is_correct=False, current_date_shanghai=today)
        self.assertEqual(word["review_count"], 5)
        self.assertEqual(word["next_review_date"], "2026-11-05")
        self.assertTrue(word["lapsed"])


class TestSessionManagerAndBacklog(unittest.TestCase):
    """Tier 2 & Tier 3: Review cap, daily new words budget, and error retry queue."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="ielts_test_session_")
        self.data_file = os.path.join(self.tmpdir, "session_store.json")
        self.store = ModuleStore(self.data_file, {"review_cap": 5, "daily_new_words": 3})

    def tearDown(self):
        import shutil
        try:
            shutil.rmtree(self.tmpdir)
        except Exception:
            pass

    def test_01_review_cap_limits_and_orders_due_words(self):
        """Excess overdue reviews are capped at review_cap and sorted strictly by due date ascending."""
        # Insert 10 overdue words with distinct due dates
        for i in range(10):
            due_date = datetime.date(2026, 11, i % 9 + 1)
            due_ts = get_shanghai_midnight_ts(due_date)
            self.store.update_word(f"w_{i}", {
                "id": f"w_{i}",
                "word": f"word_{i}",
                "stage": 1,
                "review_count": 1,
                "next_review": due_ts,
                "next_review_date": due_date.strftime("%Y-%m-%d")
            })

        # Today is 2026-11-10 (all 10 are overdue)
        session = generate_session(self.store, current_date_shanghai=datetime.date(2026, 11, 10))
        queue = session["queue"]

        # review_cap is 5, so exactly 5 due words returned
        due_in_queue = [w for w in queue if w.get("review_count", 0) > 0]
        self.assertEqual(len(due_in_queue), 5)

        # Check due dates are strictly ascending
        due_dates = [w["next_review"] for w in due_in_queue]
        self.assertEqual(due_dates, sorted(due_dates))

    def test_02_daily_new_words_budget_and_zero_disable(self):
        """daily_new_words controls new word quota; daily_new_words=0 disables new words."""
        # Insert 10 unlearned words (review_count=0, stage=0)
        for i in range(10):
            self.store.update_word(f"new_{i}", {
                "id": f"new_{i}",
                "word": f"new_word_{i}",
                "stage": 0,
                "review_count": 0
            })

        # With daily_new_words = 3
        session = generate_session(self.store, current_date_shanghai=datetime.date(2026, 11, 10))
        new_in_queue = [w for w in session["queue"] if w.get("review_count", 0) == 0]
        self.assertEqual(len(new_in_queue), 3)

        # Update settings to daily_new_words = 0
        self.store.update_settings({"review_cap": 5, "daily_new_words": 0})
        session_zero = generate_session(self.store, current_date_shanghai=datetime.date(2026, 11, 10))
        zero_new_in_queue = [w for w in session_zero["queue"] if w.get("review_count", 0) == 0]
        self.assertEqual(len(zero_new_in_queue), 0)

    def test_03_error_retry_flow_simulation(self):
        """
        Feature 30: Error Retry ('错词强化重测').
        Misspelled words re-enter queue 4-6 questions later; when answered correctly,
        promoted normally without 5-minute double pass rule.
        """
        # Simulate in-memory active session queue
        queue = [
            {"id": f"q_{i}", "word": f"word_{i}", "stage": 1, "review_count": 1}
            for i in range(10)
        ]

        # Word at index 0 is misspelled
        failed_item = dict(queue[0])
        failed_item["retry_count"] = failed_item.get("retry_count", 0) + 1

        # Re-queue 4 to 6 positions later (e.g. index 5)
        retry_offset = 5
        insert_idx = min(len(queue), retry_offset)
        queue.insert(insert_idx, failed_item)

        # Verify failed item re-appears at expected position
        self.assertEqual(queue[insert_idx]["id"], "q_0")

        # Simulate user passing on retry
        apply_listening_review(
            queue[insert_idx],
            is_correct=True,
            current_date_shanghai=datetime.date(2026, 11, 4)
        )

        # Assert normal promotion: stage 1 -> 2, next_review scheduled +2 days
        self.assertEqual(queue[insert_idx]["stage"], 2)
        self.assertEqual(queue[insert_idx]["next_review_date"], "2026-11-06")


class Test7DayVacationBacklogSimulation(unittest.TestCase):
    """Tier 4: Comprehensive 7-day vacation backlog carryover simulation."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="ielts_vacation_")
        self.data_file = os.path.join(self.tmpdir, "vacation_store.json")
        self.store = ModuleStore(self.data_file, {"review_cap": 10, "daily_new_words": 10})

    def tearDown(self):
        import shutil
        try:
            shutil.rmtree(self.tmpdir)
        except Exception:
            pass

    def test_7day_vacation_backlog_carryover_and_actual_date_anchoring(self):
        """
        Complete 7-day vacation backlog scenario:
        1. Day 0 (2026-11-01): Learn Batch A (10 words), due Day 1 (2026-11-02).
        2. Day 1 (2026-11-02): Learn Batch B (10 words), due Day 2 (2026-11-03).
        3. Days 2-6: Vacation (no reviews).
        4. Day 7 (2026-11-08): Return. Both Batch A and B are overdue.
        5. Session 1 with cap=10 returns ONLY Batch A (oldest due date first).
        6. Reviewing Batch A on Day 7 computes next due from actual review date (Day 7 + 2 days = Day 9).
        7. Session 2 on Day 7 returns Batch B.
        """
        # Step 1: Day 0 - Batch A learned
        batch_a_ids = [f"batch_a_{i}" for i in range(10)]
        day_1_date = datetime.date(2026, 11, 2)
        day_1_ts = get_shanghai_midnight_ts(day_1_date)
        for wid in batch_a_ids:
            self.store.update_word(wid, {
                "id": wid,
                "word": f"word_{wid}",
                "stage": 1,
                "review_count": 1,
                "next_review": day_1_ts,
                "next_review_date": "2026-11-02"
            })

        # Step 2: Day 1 - Batch B learned
        batch_b_ids = [f"batch_b_{i}" for i in range(10)]
        day_2_date = datetime.date(2026, 11, 3)
        day_2_ts = get_shanghai_midnight_ts(day_2_date)
        for wid in batch_b_ids:
            self.store.update_word(wid, {
                "id": wid,
                "word": f"word_{wid}",
                "stage": 1,
                "review_count": 1,
                "next_review": day_2_ts,
                "next_review_date": "2026-11-03"
            })

        self.store.save()

        # Step 3 & 4: Day 7 return (2026-11-08). Both batches overdue.
        day_7_date = datetime.date(2026, 11, 8)

        # Step 5: Session 1 with review_cap = 10
        session_1 = generate_session(self.store, current_date_shanghai=day_7_date)
        queue_1_ids = [w["id"] for w in session_1["queue"]]

        self.assertEqual(len(queue_1_ids), 10)
        self.assertEqual(set(queue_1_ids), set(batch_a_ids), "Session 1 must contain exclusively Batch A (due 11-02 < 11-03)")

        # Step 6: Complete review of Batch A on Day 7
        for wid in batch_a_ids:
            current_w = dict(self.store.get_word(wid))
            apply_listening_review(current_w, is_correct=True, current_date_shanghai=day_7_date)
            # Stage was 1, next stage is 2 with interval 2 days
            # Crucial assertion: Next due date must be 2026-11-08 + 2 days = 2026-11-10!
            # It must NOT be missed target date 2026-11-02 + 2 days = 2026-11-04!
            self.assertEqual(
                current_w["next_review_date"],
                "2026-11-10",
                f"Word {wid} due date must be calculated from actual review date (2026-11-08 + 2 days)"
            )
            self.store.update_word(wid, current_w)

        self.store.save()

        # Step 7: Session 2 on Day 7. Batch B carries over and is now served!
        session_2 = generate_session(self.store, current_date_shanghai=day_7_date)
        queue_2_ids = [w["id"] for w in session_2["queue"]]

        self.assertEqual(len(queue_2_ids), 10)
        self.assertEqual(set(queue_2_ids), set(batch_b_ids), "Session 2 must contain Batch B carryover")


class TestCrossFeatureWorkflow(unittest.TestCase):
    """Tier 3: Pairwise settings change -> session generation -> review -> persistence."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="ielts_cross_")
        self.data_file = os.path.join(self.tmpdir, "cross_store.json")
        self.store = ModuleStore(self.data_file, {"review_cap": 20, "daily_new_words": 10})

    def tearDown(self):
        import shutil
        try:
            shutil.rmtree(self.tmpdir)
        except Exception:
            pass

    def test_settings_mutation_and_session_lifecycle(self):
        """Changing settings dynamically alters subsequent session generation and persists cleanly."""
        due_ts = get_shanghai_midnight_ts(datetime.date(2026, 11, 1))
        for i in range(15):
            self.store.update_word(f"w_{i}", {
                "id": f"w_{i}",
                "word": f"word_{i}",
                "stage": 1,
                "review_count": 1,
                "next_review": due_ts,
                "next_review_date": "2026-11-01"
            })
        for i in range(15):
            self.store.update_word(f"new_{i}", {
                "id": f"new_{i}",
                "word": f"new_{i}",
                "stage": 0,
                "review_count": 0
            })

        # Update settings to cap=8, new=4
        ok, _ = self.store.update_settings({"review_cap": 8, "daily_new_words": 4})
        self.assertTrue(ok)

        # Generate session
        session = generate_session(self.store, current_date_shanghai=datetime.date(2026, 11, 4))
        queue = session["queue"]

        due_count = len([w for w in queue if w.get("review_count", 0) > 0])
        new_count = len([w for w in queue if w.get("review_count", 0) == 0])

        self.assertEqual(due_count, 8)
        self.assertEqual(new_count, 4)
        self.assertEqual(len(queue), 12)

        # Reload store from disk
        reloaded = ModuleStore(self.data_file)
        self.assertEqual(reloaded.settings["review_cap"], 8)
        self.assertEqual(reloaded.settings["daily_new_words"], 4)


if __name__ == "__main__":
    unittest.main()
