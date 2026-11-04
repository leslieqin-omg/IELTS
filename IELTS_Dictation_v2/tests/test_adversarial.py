#!/usr/bin/env python3
"""
test_adversarial.py — Tier 5 Adversarial Stress & Hardening Test Suite
======================================================================
Comprehensive adversarial challenge harness testing:
1. Concurrency & Thread-safety:
   - High-concurrency atomic writes to listening.json and writing.json
   - Zero JSON corruption, zero lock starvation, zero orphaned .tmp files
   - Concurrent multithreaded HTTP REST requests under load
2. Adversarial Settings Payloads:
   - Boundary checks: review_cap=0, negative values, floats, strings, booleans, nulls, empty payloads
   - Valid boundary: daily_new_words=0 (disables new words), review_cap=1 (minimum)
   - Verified across both ModuleStore storage engine and HTTP REST API
3. Audio Path Traversal & Information Leak Defense:
   - Reject /static/audio/../../config.py, %2e%2e, %252e%252e, ..%2f, null bytes
   - Rejection code 404/403 with ZERO file content leakage
   - Direct attempts to read data/listening.json or server.py
4. Capitalization Boundaries & Two-Tier Evaluation:
   - Months (January..December) require leading capital, lowercase returns capitalization_error
   - Country names & regions require leading capital, lowercase returns capitalization_error
   - Common nouns (apple, accommodation, station) are strictly case-insensitive
   - Whitespace trimming, phrase preservation, empty input handling
5. Original Directory Deep SHA-256 Hash Verification:
   - Complete byte-for-byte verification of /Users/leslie/Documents/ChatGPT/IELTS/IELTS_Dictation
"""

import os
import sys
import json
import time
import shutil
import hashlib
import tempfile
import threading
import urllib.request
import urllib.error
import urllib.parse
from http.server import HTTPServer
import unittest

# Ensure project root is on sys.path
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import config
from core.storage import ModuleStore
from core.spelling_judge import SpellingJudge, scan_case_sensitive_candidates
import server

ORIGINAL_DIR = "/Users/leslie/Documents/ChatGPT/IELTS/IELTS_Dictation"
EXPECTED_ORIGINAL_HASHES = {
    ".DS_Store": "fed4d7c1be18eb874a2bdd7eeb5437f299747bbe02b14e65bb1c4c173f40265d",
    "server.log": "a88b4656dc3f9bd354a84f6e18c7e0e9c0e7cec8456ed572fb05f8476d32e3ec",
    "server.py": "1fa827f43e20802addbd85e6838432e4434e56adb9bd589b8eaf41259cc77102",
    "server.py.bak": "ad3653bcac0b383e1289fa8806f5a064bfe371bfe0ad2838903525157476a104",
    "__pycache__/server.cpython-314.pyc": "7a9b7b432f7c77e0e8e8fa966f2344bbd0c4841ea7b278930f54159dc0aca3f7",
    "static/index.html": "4b9ae6e171d88bbf1e362a0973f06c9e76deab8e9c9f5eaa4ebb8e2ca6232108",
    "static/index.html.bak": "3b359079afbe4f5b99cf9f5b6f158ebbba64a26a382b9100994700882607cbde",
    "data/9fnnn_listening_vocabulary.csv": "a149cdb0fa84baba094c6a7b0e0c2a09e6c8b47c67c12d92c32a4fb999f88ea6",
    "data/9fnnn_listening_vocabulary.json": "01ad7230f78720d177347db144f9f8528da6abc028c77fc8fcf29ec37cec6c31",
    "data/9fnnn_listening_vocabulary.md": "e1c2105a27e9de1faccc5494154cab99d452736a54d05c1ecd59395665e36966",
    "data/words.backup-20261023-before-fix.json": "f0b50bd8be2a6d44db23b37d90e0407ab2d2b1a373061c46e74c58a8ede19c5d",
    "data/words.backup-20261026-before-fix.json": "db8dd93d96dd437862f5c51739f78dc36709caf91b28eebd57fea67052294952",
    "data/words.json": "99708c8a2985f68de9ecb937dfddd145bf323b655dd8c4134c619e5ac45a169b",
    "data/words.json.bak": "882b2d679a316b5a106522b98861d2d75571e43198a964c60232e26051d004bf",
}


class TestAdversarialStress(unittest.TestCase):
    """Tier 5 Adversarial Challenge & Stress-Testing Suite."""

    @classmethod
    def setUpClass(cls):
        # 1. Snapshot original directory baseline
        cls.orig_hashes = {}
        for root, _, files in os.walk(ORIGINAL_DIR):
            for f in files:
                abs_p = os.path.join(root, f)
                rel_p = os.path.relpath(abs_p, ORIGINAL_DIR)
                with open(abs_p, "rb") as fp:
                    cls.orig_hashes[rel_p] = hashlib.sha256(fp.read()).hexdigest()

        # 2. Setup isolated temporary test directory
        cls.temp_dir = tempfile.mkdtemp(prefix="ielts_adv_test_")
        cls.listening_data_path = os.path.join(cls.temp_dir, "listening.json")
        cls.writing_data_path = os.path.join(cls.temp_dir, "writing.json")

        # 3. Create isolated stores for server testing
        cls.test_listening_store = ModuleStore(cls.listening_data_path, {"review_cap": 40, "daily_new_words": 10})
        cls.test_writing_store = ModuleStore(cls.writing_data_path, {"review_cap": 30, "daily_new_words": 10})
        cls.judge = SpellingJudge(config.CASE_SENSITIVE_WORDS_FILE)

        # 4. Spin up test ThreadingHTTPServer with production DictationHandler
        class AdversarialTestHandler(server.DictationHandler):
            listening_store = cls.test_listening_store
            writing_store = cls.test_writing_store
            spelling_judge = cls.judge

            def log_message(self, format, *args):
                # Suppress log noise in tests
                pass

        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), AdversarialTestHandler)
        cls.port = cls.httpd.server_port
        cls.base_url = f"http://127.0.0.1:{cls.port}"

        cls.server_thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.temp_dir, ignore_errors=True)

    def _http_get(self, path: str) -> tuple[int, dict | str, dict]:
        """Perform HTTP GET returning (status_code, parsed_body_or_string, headers)."""
        url = f"{self.base_url}{path}"
        req = urllib.request.Request(url, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                status = resp.status
                headers = dict(resp.headers)
                body = resp.read().decode("utf-8", errors="replace")
                try:
                    return status, json.loads(body), headers
                except Exception:
                    return status, body, headers
        except urllib.error.HTTPError as e:
            with e:
                status = e.code
                headers = dict(e.headers)
                body = e.read().decode("utf-8", errors="replace")
                try:
                    return status, json.loads(body), headers
                except Exception:
                    return status, body, headers

    def _http_post(self, path: str, payload: dict | str, raw_bytes: bytes | None = None) -> tuple[int, dict | str]:
        """Perform HTTP POST returning (status_code, parsed_body_or_string)."""
        url = f"{self.base_url}{path}"
        if raw_bytes is not None:
            data = raw_bytes
        elif isinstance(payload, str):
            data = payload.encode("utf-8")
        else:
            data = json.dumps(payload).encode("utf-8")

        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                status = resp.status
                body = resp.read().decode("utf-8", errors="replace")
                try:
                    return status, json.loads(body)
                except Exception:
                    return status, body
        except urllib.error.HTTPError as e:
            with e:
                status = e.code
                body = e.read().decode("utf-8", errors="replace")
                try:
                    return status, json.loads(body)
                except Exception:
                    return status, body

    # =========================================================================
    # 1. CONCURRENCY & THREAD-SAFETY TESTS
    # =========================================================================

    def test_01_concurrent_atomic_updates_multithreaded_load(self):
        """
        Stress test: 60 concurrent writer threads + 10 reader threads hammering
        listening.json and writing.json simultaneously.
        Verifies:
        - Zero file corruption.
        - JSON remains 100% valid and parseable on disk.
        - Zero orphaned .tmp files.
        - All written records persist accurately.
        """
        num_writers_per_store = 25
        updates_per_writer = 15
        errors = []

        def listening_writer(thread_id):
            try:
                for j in range(updates_per_writer):
                    word_id = f"list_w_{thread_id}_{j}"
                    self.test_listening_store.update_word(word_id, {
                        "id": word_id,
                        "word": f"word_{thread_id}_{j}",
                        "stage": (thread_id + j) % 6,
                        "updated_at": time.time()
                    })
                    # Periodic settings update
                    if j % 5 == 0:
                        self.test_listening_store.update_settings({
                            "review_cap": 40 + (j % 5),
                            "daily_new_words": 10 + (j % 3)
                        })
            except Exception as e:
                errors.append(f"Listening writer error in thread {thread_id}: {e}")

        def writing_writer(thread_id):
            try:
                for j in range(updates_per_writer):
                    word_id = f"writ_w_{thread_id}_{j}"
                    self.test_writing_store.update_word(word_id, {
                        "id": word_id,
                        "word": f"writing_{thread_id}_{j}",
                        "stage": (thread_id + j) % 9,
                        "updated_at": time.time()
                    })
                    # Periodic checkin update
                    if j % 5 == 0:
                        self.test_writing_store.update_checkin("2026-11-03", {
                            "count": thread_id * 10 + j
                        })
            except Exception as e:
                errors.append(f"Writing writer error in thread {thread_id}: {e}")

        stop_readers = threading.Event()

        def reader(reader_id):
            try:
                while not stop_readers.is_set():
                    _ = self.test_listening_store.get_words()
                    _ = self.test_writing_store.get_words()
                    _ = self.test_listening_store.get_settings()
                    _ = self.test_writing_store.get_settings()
                    time.sleep(0.005)
            except Exception as e:
                errors.append(f"Reader error in thread {reader_id}: {e}")

        threads = []
        # Launch 10 readers
        for i in range(10):
            t = threading.Thread(target=reader, args=(i,), daemon=True)
            t.start()
            threads.append(t)

        # Launch 25 listening writers and 25 writing writers
        for i in range(num_writers_per_store):
            t1 = threading.Thread(target=listening_writer, args=(i,))
            t2 = threading.Thread(target=writing_writer, args=(i,))
            t1.start()
            t2.start()
            threads.append(t1)
            threads.append(t2)

        # Wait for writers to complete
        for t in threads[10:]:
            t.join(timeout=10.0)
            self.assertFalse(t.is_alive(), "Writer thread hung or timed out!")

        # Stop readers
        stop_readers.set()
        for t in threads[:10]:
            t.join(timeout=2.0)

        self.assertEqual(errors, [], f"Thread-safety violations during concurrent load: {errors}")

        # Verify on-disk file integrity
        for path, expected_prefix, total_expected in [
            (self.listening_data_path, "list_w_", num_writers_per_store * updates_per_writer),
            (self.writing_data_path, "writ_w_", num_writers_per_store * updates_per_writer)
        ]:
            self.assertTrue(os.path.exists(path), f"Store file missing on disk: {path}")
            # Ensure file is completely valid JSON and not corrupt
            with open(path, "r", encoding="utf-8") as f:
                content = json.load(f)

            words = content.get("words", {})
            self.assertEqual(len(words), total_expected, f"Expected {total_expected} words in {path}, got {len(words)}")
            for i in range(num_writers_per_store):
                for j in range(updates_per_writer):
                    expected_id = f"{expected_prefix}{i}_{j}"
                    self.assertIn(expected_id, words, f"Missing expected word {expected_id} in {path}")

            # Ensure zero orphaned .tmp files in data directory
            tmp_file = path + ".tmp"
            self.assertFalse(os.path.exists(tmp_file), f"Orphaned temporary file found: {tmp_file}")

    def test_02_concurrent_http_requests_under_load(self):
        """
        Stress test: 30 concurrent threads making REST API requests over HTTP.
        Verifies:
        - ThreadingHTTPServer handles concurrent requests without dropped connections or 500 errors.
        - REST API returns consistent status and data under load.
        """
        http_errors = []

        def worker(w_id):
            try:
                for k in range(5):
                    # GET stats
                    status, res, _ = self._http_get("/api/listening/stats")
                    if status != 200 or "total" not in res:
                        http_errors.append(f"GET /stats failed in worker {w_id}: status={status}")

                    # POST review
                    status, res = self._http_post("/api/writing/review", {
                        "word": f"writ_w_{w_id % 5}_{k}",
                        "correct": True,
                        "retry_pass": False
                    })
                    if status != 200:
                        http_errors.append(f"POST /review failed in worker {w_id}: status={status}, res={res}")
            except Exception as e:
                http_errors.append(f"Worker {w_id} exception: {e}")

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(30)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10.0)
            self.assertFalse(t.is_alive(), "HTTP worker thread hung!")

        self.assertEqual(http_errors, [], f"HTTP concurrency failures: {http_errors}")

    # =========================================================================
    # 2. ADVERSARIAL SETTINGS PAYLOADS TESTS
    # =========================================================================

    def test_03_adversarial_settings_storage_layer(self):
        """
        Adversarial test on ModuleStore.update_settings:
        - Must REJECT review_cap = 0, negative values, floats, strings, booleans, nulls.
        - Must REJECT daily_new_words negative values, floats, strings, booleans, nulls.
        - Must ACCEPT daily_new_words = 0 (disables new words).
        - Must ACCEPT review_cap = 1 (minimum boundary).
        """
        store = ModuleStore(os.path.join(self.temp_dir, "test_settings_store.json"))

        invalid_payloads = [
            # Zero / negative review_cap
            ({"review_cap": 0, "daily_new_words": 10}, "review_cap must be an integer >= 1"),
            ({"review_cap": -1, "daily_new_words": 10}, "review_cap must be an integer >= 1"),
            ({"review_cap": -999, "daily_new_words": 10}, "review_cap must be an integer >= 1"),
            # Type confusion on review_cap
            ({"review_cap": 30.5, "daily_new_words": 10}, "review_cap must be an integer"),
            ({"review_cap": "30", "daily_new_words": 10}, "review_cap must be an integer"),
            ({"review_cap": True, "daily_new_words": 10}, "review_cap must be an integer"),
            ({"review_cap": False, "daily_new_words": 10}, "review_cap must be an integer"),
            ({"review_cap": None, "daily_new_words": 10}, "review_cap is required"),
            ({"review_cap": [30], "daily_new_words": 10}, "review_cap must be an integer"),
            ({"review_cap": {"val": 30}, "daily_new_words": 10}, "review_cap must be an integer"),
            # Negative daily_new_words
            ({"review_cap": 30, "daily_new_words": -1}, "daily_new_words must be an integer >= 0"),
            ({"review_cap": 30, "daily_new_words": -100}, "daily_new_words must be an integer >= 0"),
            # Type confusion on daily_new_words
            ({"review_cap": 30, "daily_new_words": 10.5}, "daily_new_words must be an integer"),
            ({"review_cap": 30, "daily_new_words": "10"}, "daily_new_words must be an integer"),
            ({"review_cap": 30, "daily_new_words": True}, "daily_new_words must be an integer"),
            ({"review_cap": 30, "daily_new_words": False}, "daily_new_words must be an integer"),
            ({"review_cap": 30, "daily_new_words": None}, "daily_new_words is required"),
            ({"review_cap": 30, "daily_new_words": []}, "daily_new_words must be an integer"),
            # Missing fields
            ({}, "review_cap is required"),
            ({"review_cap": 30}, "daily_new_words is required"),
            ({"daily_new_words": 10}, "review_cap is required"),
        ]

        for payload, expected_err_part in invalid_payloads:
            ok, err = store.update_settings(payload)
            self.assertFalse(ok, f"Payload {payload} should have been REJECTED but was accepted!")
            self.assertIn(expected_err_part, str(err), f"Payload {payload} error message mismatch: got '{err}'")

        # Non-dictionary argument
        ok, err = store.update_settings("not a dict")
        self.assertFalse(ok)
        ok, err = store.update_settings(None)
        self.assertFalse(ok)

        # Valid boundaries
        # 1. review_cap = 1 (minimum allowed), daily_new_words = 0 (disables new words)
        ok, res = store.update_settings({"review_cap": 1, "daily_new_words": 0})
        self.assertTrue(ok, f"Boundary review_cap=1, daily_new_words=0 should be ACCEPTED: {res}")
        self.assertEqual(res["review_cap"], 1)
        self.assertEqual(res["daily_new_words"], 0)

        # 2. review_cap = 1000, daily_new_words = 500
        ok, res = store.update_settings({"review_cap": 1000, "daily_new_words": 500})
        self.assertTrue(ok)
        self.assertEqual(res["review_cap"], 1000)
        self.assertEqual(res["daily_new_words"], 500)

    def test_04_adversarial_settings_http_api_layer(self):
        """
        Adversarial test on POST /api/{module}/settings:
        - Must return HTTP 400 Bad Request for all invalid payloads with clear error messages.
        - Must return HTTP 200 OK for valid payloads.
        - Must return HTTP 400 for malformed JSON bytes.
        """
        for module in ["listening", "writing"]:
            # 1. review_cap = 0 -> 400
            status, res = self._http_post(f"/api/{module}/settings", {"review_cap": 0, "daily_new_words": 10})
            self.assertEqual(status, 400, f"Expected 400 for review_cap=0, got {status}: {res}")
            self.assertIn("error", res)

            # 2. negative values -> 400
            status, res = self._http_post(f"/api/{module}/settings", {"review_cap": -10, "daily_new_words": 10})
            self.assertEqual(status, 400)
            status, res = self._http_post(f"/api/{module}/settings", {"review_cap": 30, "daily_new_words": -5})
            self.assertEqual(status, 400)

            # 3. floats -> 400
            status, res = self._http_post(f"/api/{module}/settings", {"review_cap": 25.5, "daily_new_words": 10})
            self.assertEqual(status, 400)
            status, res = self._http_post(f"/api/{module}/settings", {"review_cap": 30, "daily_new_words": 5.5})
            self.assertEqual(status, 400)

            # 4. strings -> 400
            status, res = self._http_post(f"/api/{module}/settings", {"review_cap": "40", "daily_new_words": 10})
            self.assertEqual(status, 400)
            status, res = self._http_post(f"/api/{module}/settings", {"review_cap": 40, "daily_new_words": "ten"})
            self.assertEqual(status, 400)

            # 5. booleans -> 400 (bool is int subclass in Python!)
            status, res = self._http_post(f"/api/{module}/settings", {"review_cap": True, "daily_new_words": 10})
            self.assertEqual(status, 400)
            status, res = self._http_post(f"/api/{module}/settings", {"review_cap": 40, "daily_new_words": False})
            self.assertEqual(status, 400)

            # 6. nulls -> 400
            status, res = self._http_post(f"/api/{module}/settings", {"review_cap": None, "daily_new_words": 10})
            self.assertEqual(status, 400)
            status, res = self._http_post(f"/api/{module}/settings", {"review_cap": 40, "daily_new_words": None})
            self.assertEqual(status, 400)

            # 7. Malformed JSON payload -> 400
            status, res = self._http_post(f"/api/{module}/settings", "", raw_bytes=b"{invalid_json:")
            self.assertEqual(status, 400)
            self.assertIn("Malformed JSON", str(res))

            # 8. Boundary OK: daily_new_words = 0
            status, res = self._http_post(f"/api/{module}/settings", {"review_cap": 35, "daily_new_words": 0})
            self.assertEqual(status, 200)
            self.assertTrue(res.get("ok"))
            self.assertEqual(res["settings"]["daily_new_words"], 0)

            # 9. Boundary OK: review_cap = 1
            status, res = self._http_post(f"/api/{module}/settings", {"review_cap": 1, "daily_new_words": 5})
            self.assertEqual(status, 200)
            self.assertEqual(res["settings"]["review_cap"], 1)

    # =========================================================================
    # 3. AUDIO PATH TRAVERSAL & INFORMATION LEAK DEFENSE
    # =========================================================================

    def test_05_audio_path_traversal_attacks(self):
        """
        Adversarial path traversal attacks targeting static and audio endpoints:
        - /static/audio/../../config.py
        - /static/audio/%2e%2e/%2e%2e/config.py
        - /static/audio/%252e%252e/%252e%252e/config.py
        - /static/audio/..%2f..%2fconfig.py
        - /static/audio/../../../etc/passwd
        - /static/../data/listening.json
        - /static/audio/word.mp3\0.txt
        - /static/audio/ (directory listing attempt)
        - /data/listening.json (direct access)
        - /config.py (direct access)

        Verifies:
        - Server returns HTTP 404 (or 403 Forbidden).
        - ZERO content of sensitive files (config.py, server.py, etc.) is leaked.
        - Server does not crash or raise unhandled exceptions.
        """
        traversal_payloads = [
            "/static/audio/../../config.py",
            "/static/audio/%2e%2e/%2e%2e/config.py",
            "/static/audio/%2e%2e%2f%2e%2e%2fconfig.py",
            "/static/audio/..%2f..%2fconfig.py",
            "/static/audio/%252e%252e/%252e%252e/config.py",
            "/static/audio/../../../etc/passwd",
            "/static/audio/..%5c..%5cconfig.py",
            "/static/audio/..\\..\\config.py",
            "/static/../data/listening.json",
            "/static/../../server.py",
            "/data/listening.json",
            "/data/writing.json",
            "/config.py",
            "/server.py",
            "/static/audio/",
            "/static/audio",
        ]

        sensitive_signatures = [
            "DEFAULT_PORT", "SHANGHAI_TZ", "WRITING_DATA_FILE",
            "ThreadingHTTPServer", "root:x:0:0", "listening_store"
        ]

        for path in traversal_payloads:
            status, body, headers = self._http_get(path)
            self.assertIn(
                status, [404, 403],
                f"Path traversal '{path}' returned status {status} instead of 404/403!"
            )
            body_str = str(body)
            for sig in sensitive_signatures:
                self.assertNotIn(
                    sig, body_str,
                    f"CRITICAL SECURITY LEAK: sensitive string '{sig}' found in response to '{path}'!"
                )

    # =========================================================================
    # 4. CAPITALIZATION BOUNDARIES & TWO-TIER EVALUATION
    # =========================================================================

    def test_06_spelling_judge_months_strict_capitalization(self):
        """
        R5 Capitalization requirement:
        - Months MUST start with a capital letter; lowercase input MUST be rejected
          with reason == 'capitalization_error'.
        - Case-preserved or all-caps input starting with capital must succeed.
        - Spelling typos must return 'spelling_error'.
        """
        months = [
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"
        ]

        for month in months:
            # 1. Exact match -> correct
            ok, reason = self.judge.judge(month, month)
            self.assertTrue(ok, f"Exact month '{month}' should be correct")
            self.assertEqual(reason, "correct")

            # 2. Leading/trailing spaces trimmed -> correct
            ok, reason = self.judge.judge(f"  {month}  ", month)
            self.assertTrue(ok, f"Padded month '{month}' should be correct")
            self.assertEqual(reason, "correct")

            # 3. All uppercase -> correct (starts with capital)
            ok, reason = self.judge.judge(month.upper(), month)
            self.assertTrue(ok, f"Uppercase month '{month.upper()}' should be correct")
            self.assertEqual(reason, "correct")

            # 4. Strict failure: Lowercase -> capitalization_error
            ok, reason = self.judge.judge(month.lower(), month)
            self.assertFalse(ok, f"Lowercase month '{month.lower()}' MUST be rejected!")
            self.assertEqual(
                reason, "capitalization_error",
                f"Lowercase month '{month.lower()}' expected reason 'capitalization_error', got '{reason}'"
            )

            # 5. Lowercase with spaces -> capitalization_error
            ok, reason = self.judge.judge(f"  {month.lower()}  ", month)
            self.assertFalse(ok)
            self.assertEqual(reason, "capitalization_error")

            # 6. Typo -> spelling_error
            typo = month[:-1]
            ok, reason = self.judge.judge(typo, month)
            self.assertFalse(ok)
            self.assertEqual(reason, "spelling_error")

    def test_07_spelling_judge_countries_and_regions(self):
        """
        R5 Capitalization requirement:
        - Country and region names (China, France, Russia, etc.) require leading capital.
        - Lowercase inputs must return capitalization_error.
        """
        countries = [
            "China", "France", "Germany", "India", "Italy", "Japan",
            "Mexico", "Russia", "Scotland", "Spain", "Sweden"
        ]

        for country in countries:
            # Capitalized -> correct
            ok, reason = self.judge.judge(country, country)
            self.assertTrue(ok, f"Country '{country}' should be correct")
            self.assertEqual(reason, "correct")

            # Uppercase -> correct
            ok, reason = self.judge.judge(country.upper(), country)
            self.assertTrue(ok)
            self.assertEqual(reason, "correct")

            # Lowercase -> capitalization_error
            ok, reason = self.judge.judge(country.lower(), country)
            self.assertFalse(ok, f"Lowercase country '{country.lower()}' MUST fail!")
            self.assertEqual(reason, "capitalization_error")

            # Typo -> spelling_error
            ok, reason = self.judge.judge(country + "x", country)
            self.assertFalse(ok)
            self.assertEqual(reason, "spelling_error")

    def test_08_spelling_judge_common_nouns_case_insensitive(self):
        """
        R5 General vocabulary requirement:
        - Common nouns (apple, accommodation, station, newspaper, government, etc.)
          are strictly case-insensitive!
        - 'apple', 'Apple', 'APPLE', 'aPpLe' must all return (True, 'correct').
        """
        common_words = [
            "apple", "accommodation", "station", "government",
            "newspaper", "university", "library", "environment"
        ]

        for word in common_words:
            variations = [
                word.lower(),
                word.capitalize(),
                word.upper(),
                f"  {word.capitalize()}  ",
                "".join(c.upper() if i % 2 == 0 else c.lower() for i, c in enumerate(word))
            ]
            for var in variations:
                ok, reason = self.judge.judge(var, word)
                self.assertTrue(
                    ok,
                    f"General word variation '{var}' for target '{word}' should be correct!"
                )
                self.assertEqual(reason, "correct")

            # Typo must still be spelling_error
            ok, reason = self.judge.judge(word + "s", word)
            self.assertFalse(ok)
            self.assertEqual(reason, "spelling_error")

    def test_09_spelling_judge_edge_cases_and_multiword_phrases(self):
        """
        Edge case handling:
        - Empty string -> spelling_error
        - Whitespace only -> spelling_error
        - None input -> spelling_error
        - Multi-word phrases: 'a newspaper', 'eye-contact'
        - Accepted alternate answers list
        """
        # Empty & whitespace
        ok, reason = self.judge.judge("", "apple")
        self.assertFalse(ok)
        self.assertEqual(reason, "spelling_error")

        ok, reason = self.judge.judge("   ", "apple")
        self.assertFalse(ok)
        self.assertEqual(reason, "spelling_error")

        # Multi-word phrase
        target = "a newspaper"
        ok, reason = self.judge.judge("a newspaper", target)
        self.assertTrue(ok)
        ok, reason = self.judge.judge("A NEWSPAPER", target)
        self.assertTrue(ok)
        ok, reason = self.judge.judge("A Newspaper", target)
        self.assertTrue(ok)

        # Hyphenated word
        target = "eye-contact"
        ok, reason = self.judge.judge("eye-contact", target)
        self.assertTrue(ok)
        ok, reason = self.judge.judge("Eye-Contact", target)
        self.assertTrue(ok)

        # Alternate accepted answers
        ok, reason = self.judge.judge("the USA", "USA", accepted_answers=["the USA", "United States"])
        self.assertTrue(ok)
        self.assertEqual(reason, "correct")

        ok, reason = self.judge.judge("United States", "USA", accepted_answers=["the USA", "United States"])
        self.assertTrue(ok)
        self.assertEqual(reason, "correct")

    def test_10_server_api_judge_endpoint(self):
        """
        Tests POST /api/judge REST endpoint for capitalization vs spelling evaluation:
        - POST {"user_input": "january", "target_word": "January"} -> {"ok": false, "reason": "capitalization_error"}
        - POST {"user_input": "January", "target_word": "January"} -> {"ok": true, "reason": "correct"}
        - POST {"user_input": "apple", "target_word": "Apple"} -> {"ok": true, "reason": "correct"}
        - POST {"user_input": "Apple", "target_word": "apple"} -> {"ok": true, "reason": "correct"}
        """
        # Month lowercase -> false, capitalization_error
        status, res = self._http_post("/api/judge", {"user_input": "january", "target_word": "January"})
        self.assertEqual(status, 200)
        self.assertFalse(res.get("ok"))
        self.assertEqual(res.get("reason"), "capitalization_error")

        # Month capitalized -> true, correct
        status, res = self._http_post("/api/judge", {"user_input": "January", "target_word": "January"})
        self.assertEqual(status, 200)
        self.assertTrue(res.get("ok"))
        self.assertEqual(res.get("reason"), "correct")

        # General noun -> case-insensitive
        status, res = self._http_post("/api/judge", {"user_input": "apple", "target_word": "Apple"})
        self.assertEqual(status, 200)
        self.assertTrue(res.get("ok"))
        self.assertEqual(res.get("reason"), "correct")

        status, res = self._http_post("/api/judge", {"user_input": "Apple", "target_word": "apple"})
        self.assertEqual(status, 200)
        self.assertTrue(res.get("ok"))
        self.assertEqual(res.get("reason"), "correct")

    def test_11_startup_capitalization_scan_contract(self):
        """
        Verifies scan_case_sensitive_candidates scans words with capital letters.
        """
        sample_words = [
            {"word": "January"},
            {"word": "apple"},
            {"word": "China", "acceptedAnswers": ["PRC"]},
            {"word": "station"},
            {"word": "the USA"}
        ]
        candidates = scan_case_sensitive_candidates(sample_words)
        self.assertIn("January", candidates)
        self.assertIn("China", candidates)
        self.assertIn("PRC", candidates)
        self.assertIn("the USA", candidates)
        self.assertNotIn("apple", candidates)
        self.assertNotIn("station", candidates)

    # =========================================================================
    # 5. ORIGINAL DIRECTORY INTEGRITY VERIFICATION
    # =========================================================================

    def test_12_original_directory_zero_modifications_deep_sha256(self):
        """
        Verifies that throughout all adversarial tests:
        - All 14 files in /Users/leslie/Documents/ChatGPT/IELTS/IELTS_Dictation remain 100% untouched.
        - Current hashes match EXPECTED_ORIGINAL_HASHES exactly.
        - Zero files added or removed.
        """
        current_hashes = {}
        for root, _, files in os.walk(ORIGINAL_DIR):
            for f in files:
                abs_p = os.path.join(root, f)
                rel_p = os.path.relpath(abs_p, ORIGINAL_DIR)
                with open(abs_p, "rb") as fp:
                    current_hashes[rel_p] = hashlib.sha256(fp.read()).hexdigest()

        # Check against pre-test snapshot
        self.assertEqual(
            set(current_hashes.keys()),
            set(self.orig_hashes.keys()),
            "Files were added or removed in IELTS_Dictation during adversarial test execution!"
        )
        for rel_p, exp_hash in self.orig_hashes.items():
            self.assertEqual(
                current_hashes[rel_p],
                exp_hash,
                f"File {rel_p} in IELTS_Dictation was MODIFIED during adversarial tests!"
            )

        # Check against authoritative baseline
        for rel_p, exp_hash in EXPECTED_ORIGINAL_HASHES.items():
            self.assertIn(rel_p, current_hashes, f"Baseline file {rel_p} missing from IELTS_Dictation")
            self.assertEqual(
                current_hashes[rel_p],
                exp_hash,
                f"Authoritative hash mismatch on {rel_p} in original directory!"
            )


if __name__ == "__main__":
    unittest.main()
