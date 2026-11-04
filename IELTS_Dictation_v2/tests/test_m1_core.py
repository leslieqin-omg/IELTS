#!/usr/bin/env python3
"""Comprehensive test suite for Milestone 1 (M1) Core Foundation:

- core/storage.py (ModuleStore)
- core/spelling_judge.py (SpellingJudge & scan_case_sensitive_candidates)
- core/session_manager.py (generate_session)
- core/__init__.py (clean exports)
"""

import os
import sys
import json
import time
import shutil
import tempfile
import threading
import datetime
import unittest

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from config import (
    SHANGHAI_TZ,
    CASE_SENSITIVE_WORDS_FILE,
    WRITING_DUE_GRACE
)
from core import (
    ModuleStore,
    SpellingJudge,
    generate_session,
    calculate_listening_next_review,
    calculate_writing_next_review,
    scan_case_sensitive_candidates
)


class TestModuleStore(unittest.TestCase):
    """Exhaustive tests for ModuleStore."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="ielts_test_store_")
        self.data_file = os.path.join(self.tmpdir, "test_module.json")

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_01_init_and_atomic_creation(self):
        """Initializes with non-existent file, populates defaults, writes atomically."""
        self.assertFalse(os.path.exists(self.data_file))
        store = ModuleStore(self.data_file, default_settings={"review_cap": 25, "daily_new_words": 8})

        self.assertTrue(os.path.exists(self.data_file))
        self.assertFalse(os.path.exists(self.data_file + ".tmp"))

        settings = store.get_settings()
        self.assertEqual(settings["review_cap"], 25)
        self.assertEqual(settings["daily_new_words"], 8)
        self.assertEqual(store.get_words(), [])

    def test_02_word_crud_and_persistence(self):
        """Tests get_word, update_word, get_words and verifies persistence."""
        store = ModuleStore(self.data_file)
        self.assertIsNone(store.get_word("w1"))

        # Insert new word
        store.update_word("w1", {"id": "w1", "word": "apple", "stage": 1, "review_count": 1})
        w = store.get_word("w1")
        self.assertIsNotNone(w)
        self.assertEqual(w["word"], "apple")
        self.assertEqual(w["stage"], 1)

        # Update existing word
        store.update_word("w1", {"stage": 2, "review_count": 2})
        w = store.get_word("w1")
        self.assertEqual(w["stage"], 2)
        self.assertEqual(w["review_count"], 2)

        # Insert second word
        store.update_word("w2", {"id": "w2", "word": "banana", "stage": 0, "review_count": 0})
        words = store.get_words()
        self.assertEqual(len(words), 2)

        # Reload from disk into a fresh instance
        reloaded = ModuleStore(self.data_file)
        self.assertEqual(len(reloaded.get_words()), 2)
        self.assertEqual(reloaded.get_word("w1")["stage"], 2)
        self.assertEqual(reloaded.get_word("w2")["word"], "banana")

    def test_03_settings_validation_and_persistence(self):
        """Strict validation of review_cap and daily_new_words."""
        store = ModuleStore(self.data_file, default_settings={"review_cap": 30, "daily_new_words": 10})

        # Test valid update
        ok, res = store.update_settings({"review_cap": 50, "daily_new_words": 15})
        self.assertTrue(ok)
        self.assertEqual(res["review_cap"], 50)
        self.assertEqual(res["daily_new_words"], 15)

        # Test daily_new_words = 0 (disabling new words is valid)
        ok, res = store.update_settings({"review_cap": 50, "daily_new_words": 0})
        self.assertTrue(ok)
        self.assertEqual(res["daily_new_words"], 0)

        # Invalid: review_cap < 1
        ok, err = store.update_settings({"review_cap": 0, "daily_new_words": 10})
        self.assertFalse(ok)
        self.assertIn("review_cap", err)

        # Invalid: negative review_cap
        ok, err = store.update_settings({"review_cap": -5, "daily_new_words": 10})
        self.assertFalse(ok)

        # Invalid: negative daily_new_words
        ok, err = store.update_settings({"review_cap": 30, "daily_new_words": -1})
        self.assertFalse(ok)
        self.assertIn("daily_new_words", err)

        # Invalid: boolean (True/False should not be accepted as integers)
        ok, err = store.update_settings({"review_cap": True, "daily_new_words": 10})
        self.assertFalse(ok)
        ok, err = store.update_settings({"review_cap": 30, "daily_new_words": False})
        self.assertFalse(ok)

        # Invalid: floats, strings, None
        ok, err = store.update_settings({"review_cap": 30.5, "daily_new_words": 10})
        self.assertFalse(ok)
        ok, err = store.update_settings({"review_cap": "30", "daily_new_words": 10})
        self.assertFalse(ok)
        ok, err = store.update_settings({"review_cap": None, "daily_new_words": 10})
        self.assertFalse(ok)
        ok, err = store.update_settings("not a dict")
        self.assertFalse(ok)

        # Reload from disk and verify settings persisted
        reloaded = ModuleStore(self.data_file)
        self.assertEqual(reloaded.get_settings()["review_cap"], 50)
        self.assertEqual(reloaded.get_settings()["daily_new_words"], 0)

    def test_04_checkin_updates(self):
        """Tests checkins getter and updater."""
        store = ModuleStore(self.data_file)
        store.update_checkin("2026-11-03", {"count": 10, "new_words_learned": 5, "completed": True})

        checkins = store.get_checkins()
        self.assertIn("records", checkins)
        self.assertEqual(checkins["records"]["2026-11-03"]["count"], 10)
        self.assertEqual(checkins["records"]["2026-11-03"]["new_words_learned"], 5)

        # Reload from disk
        reloaded = ModuleStore(self.data_file)
        reloaded_checkins = reloaded.get_checkins()
        self.assertEqual(reloaded_checkins["records"]["2026-11-03"]["count"], 10)

    def test_05_concurrent_access_thread_safety(self):
        """Verifies concurrent multi-threaded writes without corruption."""
        store = ModuleStore(self.data_file)
        num_threads = 10
        writes_per_thread = 20

        def worker(thread_idx):
            for i in range(writes_per_thread):
                w_id = f"word_{thread_idx}_{i}"
                store.update_word(w_id, {"id": w_id, "thread": thread_idx, "index": i})

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(num_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # Check total words
        words = store.get_words()
        self.assertEqual(len(words), num_threads * writes_per_thread)

        # File must be valid JSON
        with open(self.data_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(len(data["words"]), num_threads * writes_per_thread)


class TestSpellingJudge(unittest.TestCase):
    """Exhaustive tests for SpellingJudge and case-sensitivity scanning."""

    @classmethod
    def setUpClass(cls):
        cls.judge = SpellingJudge(CASE_SENSITIVE_WORDS_FILE)

    def test_01_general_vocabulary(self):
        """General vocabulary comparison is case-insensitive and trims whitespace."""
        ok, reason = self.judge.judge("  newspaper  ", "newspaper")
        self.assertTrue(ok)
        self.assertEqual(reason, "correct")

        ok, reason = self.judge.judge("Newspaper", "newspaper")
        self.assertTrue(ok)
        self.assertEqual(reason, "correct")

        ok, reason = self.judge.judge("NEWSPAPER", "newspaper")
        self.assertTrue(ok)
        self.assertEqual(reason, "correct")

        # Spelling error
        ok, reason = self.judge.judge("newspapper", "newspaper")
        self.assertFalse(ok)
        self.assertEqual(reason, "spelling_error")

        # Empty input
        ok, reason = self.judge.judge("   ", "newspaper")
        self.assertFalse(ok)
        self.assertEqual(reason, "spelling_error")

    def test_02_months_case_sensitivity(self):
        """Months must start with a capital letter; lowercase is capitalization_error."""
        # Correct with capital
        ok, reason = self.judge.judge("January", "January")
        self.assertTrue(ok)
        self.assertEqual(reason, "correct")

        # Lowercase input
        ok, reason = self.judge.judge("january", "January")
        self.assertFalse(ok)
        self.assertEqual(reason, "capitalization_error")

        # Whitespace trimmed, but lowercase
        ok, reason = self.judge.judge("  january  ", "January")
        self.assertFalse(ok)
        self.assertEqual(reason, "capitalization_error")

        # Capitalized typo -> spelling_error
        ok, reason = self.judge.judge("Janary", "January")
        self.assertFalse(ok)
        self.assertEqual(reason, "spelling_error")

    def test_03_countries_case_sensitivity(self):
        """Country names must start with a capital letter."""
        ok, reason = self.judge.judge("China", "China")
        self.assertTrue(ok)
        self.assertEqual(reason, "correct")

        ok, reason = self.judge.judge("china", "China")
        self.assertFalse(ok)
        self.assertEqual(reason, "capitalization_error")

        ok, reason = self.judge.judge("Spain", "Spain")
        self.assertTrue(ok)
        self.assertEqual(reason, "correct")

        ok, reason = self.judge.judge("spain", "Spain")
        self.assertFalse(ok)
        self.assertEqual(reason, "capitalization_error")

        # Multi-word country: "the USA"
        ok, reason = self.judge.judge("the USA", "the USA")
        self.assertTrue(ok)
        self.assertEqual(reason, "correct")

        ok, reason = self.judge.judge("The USA", "the USA")
        self.assertTrue(ok)
        self.assertEqual(reason, "correct")

        ok, reason = self.judge.judge("the usa", "the USA")
        self.assertFalse(ok)
        self.assertEqual(reason, "capitalization_error")

    def test_04_accepted_answers(self):
        """Accepted answers are supported."""
        ok, reason = self.judge.judge("theatre", "theater", accepted_answers=["theatre"])
        self.assertTrue(ok)
        self.assertEqual(reason, "correct")

        ok, reason = self.judge.judge("theater", "theater", accepted_answers=["theatre"])
        self.assertTrue(ok)
        self.assertEqual(reason, "correct")

        ok, reason = self.judge.judge("THEATRE", "theater", accepted_answers=["theatre"])
        self.assertTrue(ok)
        self.assertEqual(reason, "correct")

    def test_05_scan_case_sensitive_candidates(self):
        """Scans vocabulary entries and returns sorted list of words containing capitals."""
        sample_words = [
            {"word": "apple", "acceptedAnswers": []},
            {"word": "January", "acceptedAnswers": []},
            {"word": "station", "acceptedAnswers": ["Station"]},
            {"word": "the USA", "acceptedAnswers": ["USA"]},
            {"word": "creativity", "acceptedAnswers": []},
            {"word": "China", "acceptedAnswers": ["PRC"]},
        ]
        candidates = scan_case_sensitive_candidates(sample_words)
        self.assertIn("January", candidates)
        self.assertIn("Station", candidates)
        self.assertIn("the USA", candidates)
        self.assertIn("USA", candidates)
        self.assertIn("China", candidates)
        self.assertIn("PRC", candidates)
        self.assertNotIn("apple", candidates)
        self.assertNotIn("creativity", candidates)
        self.assertEqual(candidates, sorted(candidates))


class TestSessionManager(unittest.TestCase):
    """Exhaustive tests for session generation, review cap, and new words budget."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="ielts_test_session_")
        self.data_file = os.path.join(self.tmpdir, "session_store.json")
        self.store = ModuleStore(self.data_file, default_settings={"review_cap": 3, "daily_new_words": 2})

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_01_writing_session_overdue_sorting_and_cap(self):
        """Writing due words ordered by next_review_ts ascending and capped."""
        now_ts = 100000

        # Add 5 words with different due timestamps
        # w1: due long ago (now_ts - 500)
        # w2: due recently (now_ts - 100)
        # w3: due now (now_ts)
        # w4: due within grace (now_ts + 30 <= now_ts + WRITING_DUE_GRACE)
        # w5: not due yet (now_ts + 500)
        # w_new1, w_new2, w_new3: unlearned (stage 0, review_count 0)
        self.store.update_word("w1", {"id": "w1", "stage": 1, "review_count": 1, "next_review_ts": now_ts - 500})
        self.store.update_word("w2", {"id": "w2", "stage": 1, "review_count": 1, "next_review_ts": now_ts - 100})
        self.store.update_word("w3", {"id": "w3", "stage": 2, "review_count": 2, "next_review_ts": now_ts})
        self.store.update_word("w4", {"id": "w4", "stage": 1, "review_count": 1, "next_review_ts": now_ts + 30})
        self.store.update_word("w5", {"id": "w5", "stage": 1, "review_count": 1, "next_review_ts": now_ts + 500})

        self.store.update_word("new1", {"id": "new1", "stage": 0, "review_count": 0})
        self.store.update_word("new2", {"id": "new2", "stage": 0, "review_count": 0})
        self.store.update_word("new3", {"id": "new3", "stage": 0, "review_count": 0})

        session = generate_session(self.store, module_type="writing", now_ts=now_ts)

        # 4 words are due: w1, w2, w3, w4.
        # But review_cap = 3!
        # Top 3 oldest overdue words must be selected: w1, w2, w3.
        # Daily new words budget = 2 (none learned today).
        # Total in queue = 3 + 2 = 5.
        self.assertEqual(session["due_count"], 3)
        self.assertEqual(session["new_count"], 2)
        self.assertEqual(session["total"], 5)

        queue_ids = [w["id"] for w in session["queue"]]
        self.assertEqual(queue_ids[:3], ["w1", "w2", "w3"])
        self.assertEqual(queue_ids[3:], ["new1", "new2"])

    def test_02_listening_session_date_sorting_and_backlog(self):
        """Listening due words ordered by next_review_date ascending, backlog rollover."""
        today = datetime.date(2026, 11, 3)

        # Words with stages > 0
        # w_old: due 2026-10-25 (overdue 9 days)
        # w_yesterday: due 2026-11-02
        # w_today: due 2026-11-03
        # w_tomorrow: due 2026-11-04 (not due)
        self.store.update_word("w_old", {"id": "w_old", "stage": 2, "next_review_date": "2026-10-25"})
        self.store.update_word("w_yesterday", {"id": "w_yesterday", "stage": 1, "next_review_date": "2026-11-02"})
        self.store.update_word("w_today", {"id": "w_today", "stage": 1, "next_review_date": "2026-11-03"})
        self.store.update_word("w_tomorrow", {"id": "w_tomorrow", "stage": 1, "next_review_date": "2026-11-04"})

        # New words
        self.store.update_word("n1", {"id": "n1", "stage": 0, "review_count": 0})
        self.store.update_word("n2", {"id": "n2", "stage": 0, "review_count": 0})

        # Set review_cap to 2, daily_new_words to 1
        self.store.update_settings({"review_cap": 2, "daily_new_words": 1})

        session = generate_session(self.store, module_type="listening", current_date_shanghai=today)

        # Due words are w_old, w_yesterday, w_today.
        # review_cap is 2 -> w_old, w_yesterday.
        # new_words is 1 -> n1.
        self.assertEqual(session["due_count"], 2)
        self.assertEqual(session["new_count"], 1)
        self.assertEqual(session["total"], 3)

        queue_ids = [w["id"] for w in session["queue"]]
        self.assertEqual(queue_ids, ["w_old", "w_yesterday", "n1"])

    def test_03_daily_new_words_budget_with_checkin_history(self):
        """When checkin history shows words already learned, remaining budget is reduced."""
        today = datetime.date(2026, 11, 3)
        today_str = "2026-11-03"

        self.store.update_settings({"review_cap": 10, "daily_new_words": 5})

        # 10 unlearned words
        for i in range(10):
            self.store.update_word(f"new_{i}", {"id": f"new_{i}", "stage": 0, "review_count": 0})

        # Scenario A: 0 learned today -> gets 5 new words
        session = generate_session(self.store, module_type="writing", current_date_shanghai=today)
        self.assertEqual(session["new_count"], 5)

        # Scenario B: 3 learned today -> gets 2 new words
        self.store.update_checkin(today_str, {"new_words_learned": 3})
        session = generate_session(self.store, module_type="writing", current_date_shanghai=today)
        self.assertEqual(session["new_count"], 2)

        # Scenario C: 5 or more learned today -> gets 0 new words
        self.store.update_checkin(today_str, {"new_words_learned": 5})
        session = generate_session(self.store, module_type="writing", current_date_shanghai=today)
        self.assertEqual(session["new_count"], 0)

        # Scenario D: daily_new_words disabled (0) -> gets 0 new words
        self.store.update_settings({"review_cap": 10, "daily_new_words": 0})
        self.store.update_checkin(today_str, {"new_words_learned": 0})
        session = generate_session(self.store, module_type="writing", current_date_shanghai=today)
        self.assertEqual(session["new_count"], 0)

    def test_04_writing_stage0_second_pass_due_included(self):
        """Writing Stage 0 word after pass 1 (stage 0, review_count 1) is queued when due."""
        now_ts = 1000
        # Word passes pass 1 at now_ts=1000 -> next_review_ts = 1300
        self.store.update_word("w_stage0", {
            "id": "w_stage0",
            "word": "persistent",
            "stage": 0,
            "review_count": 1,
            "next_review_ts": 1300
        })

        # When now_ts is 1200 (not due yet, grace is 60s so 1200 + 60 = 1260 < 1300)
        session_early = generate_session(self.store, module_type="writing", now_ts=1200)
        self.assertEqual(session_early["due_count"], 0)
        self.assertNotIn("w_stage0", [w["id"] for w in session_early["queue"]])

        # When now_ts is 1350 (due)
        session_due = generate_session(self.store, module_type="writing", now_ts=1350)
        self.assertEqual(session_due["due_count"], 1)
        self.assertIn("w_stage0", [w["id"] for w in session_due["queue"]])

    def test_05_listening_stage0_failure_due_included(self):
        """Listening Stage 0 word after failure (stage 0, review_count 1) is queued on due date."""
        # Failed word at stage 0 rescheduled for tomorrow (2026-11-04)
        self.store.update_word("w_listen_fail", {
            "id": "w_listen_fail",
            "word": "accommodation",
            "stage": 0,
            "review_count": 1,
            "next_review_date": "2026-11-04"
        })

        # Today: 2026-11-03 (not due)
        session_today = generate_session(self.store, module_type="listening", current_date_shanghai="2026-11-03")
        self.assertEqual(session_today["due_count"], 0)
        self.assertNotIn("w_listen_fail", [w["id"] for w in session_today["queue"]])

        # Tomorrow: 2026-11-04 (due)
        session_tomorrow = generate_session(self.store, module_type="listening", current_date_shanghai="2026-11-04")
        self.assertEqual(session_tomorrow["due_count"], 1)
        self.assertIn("w_listen_fail", [w["id"] for w in session_tomorrow["queue"]])


if __name__ == "__main__":
    unittest.main()
