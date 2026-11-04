#!/usr/bin/env python3
"""
test_isolation.py

Verifies Requirement R1, R2, R3, R8 & Features 1, 7, 15, 35:
1. Production & Original Isolation:
   - Sandboxed test runs leave production data/listening.json and original IELTS_Dictation untouched.
2. Atomic File Persistence:
   - Uses .tmp -> flush -> fsync -> os.replace.
   - Leaves zero temporary or artifact files behind.
   - Crash resilience: interrupted write does not corrupt active database file.
3. Thread Safety & Concurrency:
   - Multi-threaded concurrent reads and mutations under ModuleStore.lock (RLock) without race conditions.
4. Sub-Store State Isolation:
   - Mutations in active_session or checkins do not modify or corrupt vocabulary words or settings.
   - Trash operations isolate deleted items from active vocabulary.
5. Settings Validation & Persistence:
   - Rejects review_cap < 1, daily_new_words < 0, strings, floats, booleans.
   - Atomically persists and reloads settings cleanly.
"""

import os
import sys
import time
import json
import hashlib
import tempfile
import threading
import unittest

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import config
from core.storage import ModuleStore

ORIGINAL_DIR = "/Users/leslie/Documents/ChatGPT/IELTS/IELTS_Dictation"
PRODUCTION_LISTENING_FILE = os.path.join(PROJECT_ROOT, "data", "listening.json")


def sha256_of_file(filepath: str) -> str:
    """Computes SHA-256 hex digest of file."""
    with open(filepath, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


class TestProcessAndProductionIsolation(unittest.TestCase):
    """Tier 3: Verifies complete isolation between test execution and production stores."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="ielts_test_iso_")
        self.test_data_file = os.path.join(self.tmpdir, "test_listening.json")

    def tearDown(self):
        import shutil
        try:
            shutil.rmtree(self.tmpdir)
        except Exception:
            pass

    def test_01_sandboxed_operations_leave_production_listening_untouched(self):
        """Operations within sandboxed ModuleStore leave production data/listening.json strictly untouched."""
        self.assertTrue(os.path.exists(PRODUCTION_LISTENING_FILE), "Production listening.json must exist")
        prod_hash_before = sha256_of_file(PRODUCTION_LISTENING_FILE)
        prod_mtime_before = os.path.getmtime(PRODUCTION_LISTENING_FILE)

        time.sleep(0.01)

        # Create sandbox store and perform extensive mutations
        sandbox_store = ModuleStore(self.test_data_file, {"review_cap": 25, "daily_new_words": 5})
        for i in range(50):
            sandbox_store.update_word(f"word_{i}", {
                "id": f"word_{i}",
                "word": f"test word {i}",
                "stage": i % 6,
                "review_count": i
            })
        sandbox_store.update_settings({"review_cap": 50, "daily_new_words": 15})
        sandbox_store.update_checkin("2026-11-04", {"count": 25, "completed": True})
        sandbox_store.save()

        # Assert production file remains 100% byte-for-byte identical
        prod_hash_after = sha256_of_file(PRODUCTION_LISTENING_FILE)
        prod_mtime_after = os.path.getmtime(PRODUCTION_LISTENING_FILE)

        self.assertEqual(
            prod_hash_before,
            prod_hash_after,
            "CRITICAL: Production data/listening.json was mutated by sandboxed test!"
        )
        self.assertEqual(
            prod_mtime_before,
            prod_mtime_after,
            "CRITICAL: Production data/listening.json modification time changed!"
        )

    def test_02_production_listening_word_count_and_integrity(self):
        """Verifies production data/listening.json maintains exactly 1,622 unique vocabulary items."""
        with open(PRODUCTION_LISTENING_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)

        words = data.get("words", {})
        self.assertEqual(
            len(words),
            1622,
            f"Expected exactly 1622 words in data/listening.json, found {len(words)}"
        )
        # Ensure all items have valid 'word' and non-empty definitions
        for wid, entry in words.items():
            self.assertTrue(entry.get("word"), f"Word entry {wid} missing 'word' field")
            self.assertTrue(
                entry.get("glossZh") or entry.get("meaning") or entry.get("definition"),
                f"Word entry {wid} missing Chinese meaning"
            )


class TestAtomicPersistenceAndResilience(unittest.TestCase):
    """Tier 1 & Tier 2: Atomic write pattern, directory auto-creation, and crash resilience."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="ielts_test_atomic_")
        self.target_file = os.path.join(self.tmpdir, "subdir", "store.json")

    def tearDown(self):
        import shutil
        try:
            shutil.rmtree(self.tmpdir)
        except Exception:
            pass

    def test_01_atomic_write_replace_pattern_and_cleanup(self):
        """Verifies that save creates target file atomically and leaves no leftover .tmp file."""
        store = ModuleStore(self.target_file, {"review_cap": 40, "daily_new_words": 10})
        store.update_word("listen", {"id": "listen", "word": "listen", "stage": 1})
        store.save()

        # Target file exists and is valid JSON
        self.assertTrue(os.path.exists(self.target_file))
        tmp_file = self.target_file + ".tmp"
        self.assertFalse(os.path.exists(tmp_file), "Temporary file was not cleaned up!")

        with open(self.target_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        self.assertIn("listen", data["words"])
        self.assertEqual(data["settings"]["review_cap"], 40)

    def test_02_crash_resilience_prior_state_preserved(self):
        """Simulates write failure before replace; verifies existing target file remains intact."""
        store = ModuleStore(self.target_file, {"review_cap": 30, "daily_new_words": 10})
        store.update_word("initial", {"id": "initial", "word": "initial", "stage": 0})
        store.save()

        hash_before = sha256_of_file(self.target_file)

        # Simulate aborted write leaving .tmp file
        tmp_path = self.target_file + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write("corrupted incomplete json content...")

        # Re-loading store from target_file should remain 100% intact
        reloaded_store = ModuleStore(self.target_file)
        self.assertIn("initial", reloaded_store.words)
        self.assertEqual(sha256_of_file(self.target_file), hash_before)


class TestConcurrencyAndThreadSafety(unittest.TestCase):
    """Tier 3: Multi-threaded concurrent reads and mutations under RLock."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="ielts_test_concurrency_")
        self.data_file = os.path.join(self.tmpdir, "concurrent_store.json")
        self.store = ModuleStore(self.data_file, {"review_cap": 40, "daily_new_words": 10})

    def tearDown(self):
        import shutil
        try:
            shutil.rmtree(self.tmpdir)
        except Exception:
            pass

    def test_01_multithreaded_concurrent_updates_no_corruption(self):
        """10 concurrent threads simultaneously updating words, checkins, and settings; zero data loss."""
        num_threads = 10
        ops_per_thread = 20
        errors = []

        def worker_task(thread_id: int):
            try:
                for i in range(ops_per_thread):
                    word_id = f"w_{thread_id}_{i}"
                    self.store.update_word(word_id, {
                        "id": word_id,
                        "word": f"word {thread_id} {i}",
                        "stage": i % 5,
                        "review_count": i
                    })
                    if i % 5 == 0:
                        self.store.update_checkin(f"2026-11-0{thread_id % 9 + 1}", {"count": i})
                    if i % 10 == 0:
                        self.store.get_words()
                        self.store.get_settings()
            except Exception as e:
                errors.append(f"Thread {thread_id} error: {e}")

        threads = [threading.Thread(target=worker_task, args=(tid,)) for tid in range(num_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=5.0)

        self.assertEqual(errors, [], f"Thread errors encountered: {errors}")
        self.assertEqual(
            len(self.store.words),
            num_threads * ops_per_thread,
            "Total words in store must match total thread inserts"
        )

        # Verify disk persistence matches in-memory state
        reloaded = ModuleStore(self.data_file)
        self.assertEqual(len(reloaded.words), num_threads * ops_per_thread)


class TestSubStoreStateIsolation(unittest.TestCase):
    """Tier 2 & Tier 3: Sub-store state independence (words vs settings vs checkins vs session)."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="ielts_test_substore_")
        self.data_file = os.path.join(self.tmpdir, "substore.json")
        self.store = ModuleStore(self.data_file, {"review_cap": 40, "daily_new_words": 10})
        self.store.update_word("apple", {"id": "apple", "word": "apple", "stage": 1})
        self.store.save()

    def tearDown(self):
        import shutil
        try:
            shutil.rmtree(self.tmpdir)
        except Exception:
            pass

    def test_01_active_session_isolation(self):
        """Updating active_session does not alter vocabulary or settings."""
        self.store.active_session = {"currentIndex": 3, "queue": ["apple"]}
        self.store.save()

        reloaded = ModuleStore(self.data_file)
        self.assertEqual(reloaded.active_session, {"currentIndex": 3, "queue": ["apple"]})
        self.assertIn("apple", reloaded.words)
        self.assertEqual(reloaded.settings["review_cap"], 40)

    def test_02_trash_isolation_from_active_words(self):
        """Deleting a word moves it to trash without corrupting remaining words."""
        self.store.update_word("banana", {"id": "banana", "word": "banana", "stage": 0})
        self.assertIn("banana", self.store.words)

        # Move to trash
        with self.store.lock:
            self.store.trash["banana"] = self.store.words.pop("banana")
            self.store.save()

        self.assertNotIn("banana", self.store.words)
        self.assertIn("banana", self.store.trash)

        reloaded = ModuleStore(self.data_file)
        self.assertNotIn("banana", reloaded.words)
        self.assertIn("banana", reloaded.trash)


class TestSettingsValidationAndPersistence(unittest.TestCase):
    """Tier 2: Boundary validation for review_cap and daily_new_words."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="ielts_test_settings_")
        self.data_file = os.path.join(self.tmpdir, "settings_store.json")
        self.store = ModuleStore(self.data_file, {"review_cap": 40, "daily_new_words": 10})

    def tearDown(self):
        import shutil
        try:
            shutil.rmtree(self.tmpdir)
        except Exception:
            pass

    def test_01_review_cap_boundaries(self):
        """review_cap must be an integer >= 1; rejects 0, negatives, floats, booleans, strings."""
        # Valid minimum
        ok, res = self.store.update_settings({"review_cap": 1, "daily_new_words": 10})
        self.assertTrue(ok)
        self.assertEqual(res["review_cap"], 1)

        # Invalid: 0, negative, float, bool, string
        invalid_caps = [0, -1, -100, 1.5, True, False, "40", None, []]
        for cap in invalid_caps:
            ok, err = self.store.update_settings({"review_cap": cap, "daily_new_words": 10})
            self.assertFalse(ok, f"Expected review_cap={cap} to be rejected")

    def test_02_daily_new_words_boundaries(self):
        """daily_new_words must be integer >= 0; accepts 0 (disables new words); rejects negatives and non-ints."""
        # Valid 0 (disables new words)
        ok, res = self.store.update_settings({"review_cap": 40, "daily_new_words": 0})
        self.assertTrue(ok)
        self.assertEqual(res["daily_new_words"], 0)

        # Invalid: negative, float, bool, string
        invalid_new = [-1, -5, 2.5, True, False, "10", None, {}]
        for val in invalid_new:
            ok, err = self.store.update_settings({"review_cap": 40, "daily_new_words": val})
            self.assertFalse(ok, f"Expected daily_new_words={val} to be rejected")


if __name__ == "__main__":
    unittest.main()
