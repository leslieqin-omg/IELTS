#!/usr/bin/env python3
"""
test_server_endpoints.py

Verifies Requirements R1, R2, R6, R7 & Features 2, 3, 16, 17, 19, 20, 24, 33, 34, 35, 37:
1. Distinct server port: verifies config.DEFAULT_PORT == 8766 (isolated from port 8765).
2. Listening REST API endpoints (GET): words, stats, checkin, session, settings, trash, network.
3. Settings validation:
   - review_cap >= 1 (rejects 0, negatives, floats, booleans, strings with HTTP 400).
   - daily_new_words >= 0 (accepts 0 with HTTP 200, rejects negatives and invalid types with HTTP 400).
4. Session lifecycle: /api/listening/session/start, /save, /clear.
5. Word Bank CRUD & Trash lifecycle: add, update, delete, trash list, restore.
6. Spelling judge endpoint: POST /api/judge with case-sensitivity validation.
7. Writing endpoints complete rejection: all /api/writing/* routes return HTTP 404.
8. Static file serving and path traversal security.
"""

import os
import sys
import json
import time
import shutil
import tempfile
import threading
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


class TestServerEndpoints(unittest.TestCase):
    """Tier 1, Tier 2, Tier 3 HTTP REST API and Server Endpoint Tests."""

    @classmethod
    def setUpClass(cls):
        # Create an isolated temporary data store so tests do not touch production listening.json
        cls.tmpdir = tempfile.mkdtemp(prefix="ielts_test_srv_")
        cls.test_listening_file = os.path.join(cls.tmpdir, "listening.json")

        # Initialize mock test store with sample words
        cls.test_store = ModuleStore(cls.test_listening_file, config.DEFAULT_LISTENING_SETTINGS)
        cls.test_store.update_word("newspaper", {
            "id": "newspaper",
            "word": "a newspaper",
            "section": "part1",
            "stage": 0,
            "review_count": 0,
            "glossZh": "报纸"
        })
        cls.test_store.update_word("airport", {
            "id": "airport",
            "word": "airport",
            "section": "part2",
            "stage": 2,
            "review_count": 2,
            "next_review": int(time.time()),
            "next_review_date": "2026-11-04",
            "glossZh": "机场"
        })
        cls.test_store.save()

        # Temporarily redirect server's listening_store to our isolated store
        cls.orig_listening_store = server.listening_store
        cls.orig_handler_store = server.DictationHandler.listening_store
        server.listening_store = cls.test_store
        server.DictationHandler.listening_store = cls.test_store

        # Start ephemeral test server on localhost
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
        try:
            shutil.rmtree(cls.tmpdir)
        except Exception:
            pass

    def _request(self, path: str, method: str = "GET", data: dict | None = None) -> tuple[int, dict | str]:
        url = f"{self.base_url}{path}"
        req = urllib.request.Request(url, method=method)
        req.add_header("Content-Type", "application/json")
        body = json.dumps(data).encode("utf-8") if data else None

        try:
            with urllib.request.urlopen(req, data=body, timeout=3.0) as resp:
                raw = resp.read().decode("utf-8")
                try:
                    return resp.status, json.loads(raw)
                except Exception:
                    return resp.status, raw
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8")
            code = e.code
            e.close()
            try:
                return code, json.loads(raw)
            except Exception:
                return code, raw

    def test_01_config_port_and_host(self):
        """Verifies configured port is 8766 (distinct from original 8765) and host is 0.0.0.0."""
        self.assertEqual(config.DEFAULT_PORT, 8766)
        self.assertEqual(config.DEFAULT_HOST, "0.0.0.0")

    def test_02_listening_get_endpoints(self):
        """Verifies GET endpoints for listening module return HTTP 200 and expected schemas."""
        # 1. Words
        status, body = self._request("/api/listening/words")
        self.assertEqual(status, 200)
        self.assertIn("words", body)
        self.assertGreaterEqual(body.get("total", 0), 2)

        # 2. Stats
        status, body = self._request("/api/listening/stats")
        self.assertEqual(status, 200)
        self.assertIn("total", body)
        self.assertIn("due", body)

        # 3. Checkin
        status, body = self._request("/api/listening/checkin")
        self.assertEqual(status, 200)
        self.assertIn("daily_goal", body)

        # 4. Settings
        status, body = self._request("/api/listening/settings")
        self.assertEqual(status, 200)
        self.assertIn("review_cap", body)
        self.assertIn("daily_new_words", body)

        # 5. Trash
        status, body = self._request("/api/listening/trash")
        self.assertEqual(status, 200)
        self.assertTrue(body.get("ok"))
        self.assertIn("words", body)

        # 6. Network status
        status, body = self._request("/api/network")
        self.assertEqual(status, 200)
        self.assertIn("local_ip", body)
        self.assertEqual(body.get("port"), 8766)
        self.assertIn("mobile_url", body)

    def test_03_settings_validation_boundary_conditions(self):
        """Adversarial & Boundary Verification for POST /api/listening/settings."""
        # 1. Valid settings update
        status, body = self._request("/api/listening/settings", method="POST", data={
            "review_cap": 25,
            "daily_new_words": 15
        })
        self.assertEqual(status, 200)
        self.assertEqual(body["settings"]["review_cap"], 25)
        self.assertEqual(body["settings"]["daily_new_words"], 15)

        # 2. Valid daily_new_words = 0 (disables new words)
        status, body = self._request("/api/listening/settings", method="POST", data={
            "review_cap": 1,
            "daily_new_words": 0
        })
        self.assertEqual(status, 200)
        self.assertEqual(body["settings"]["daily_new_words"], 0)
        self.assertEqual(body["settings"]["review_cap"], 1)

        # 3. review_cap = 0 must be rejected with HTTP 400
        status, body = self._request("/api/listening/settings", method="POST", data={
            "review_cap": 0,
            "daily_new_words": 10
        })
        self.assertEqual(status, 400)

        # 4. Negative values rejected with HTTP 400
        for payload in [
            {"review_cap": -10, "daily_new_words": 10},
            {"review_cap": 20, "daily_new_words": -1},
            {"review_cap": -5, "daily_new_words": -5},
        ]:
            status, _ = self._request("/api/listening/settings", method="POST", data=payload)
            self.assertEqual(status, 400, f"Expected 400 for payload: {payload}")

        # 5. Non-integers (floats, strings, booleans) rejected with HTTP 400
        for payload in [
            {"review_cap": 20.5, "daily_new_words": 10},
            {"review_cap": "twenty", "daily_new_words": 10},
            {"review_cap": True, "daily_new_words": 10},
            {"review_cap": 20, "daily_new_words": False},
            {"review_cap": 20, "daily_new_words": "ten"},
        ]:
            status, _ = self._request("/api/listening/settings", method="POST", data=payload)
            self.assertEqual(status, 400, f"Expected 400 for payload: {payload}")

    def test_04_session_lifecycle_endpoints(self):
        """Tests session start, save, query, and clear lifecycle."""
        # 1. Start session
        status, body = self._request("/api/listening/session/start", method="POST", data={})
        self.assertEqual(status, 200)
        self.assertTrue(body.get("ok"))
        self.assertIn("queue", body)

        # 2. Save session state
        status, body = self._request("/api/listening/session/save", method="POST", data={"currentIndex": 1})
        self.assertEqual(status, 200)

        # 3. Query session state
        status, body = self._request("/api/listening/session", method="GET")
        self.assertEqual(status, 200)
        self.assertIsNotNone(body.get("session"))
        self.assertEqual(body["session"].get("currentIndex"), 1)

        # 4. Clear session
        status, body = self._request("/api/listening/session/clear", method="POST", data={})
        self.assertEqual(status, 200)

        # 5. Query cleared session
        status, body = self._request("/api/listening/session", method="GET")
        self.assertEqual(status, 200)
        self.assertIsNone(body.get("session"))

    def test_05_word_bank_crud_and_trash_lifecycle(self):
        """Tests Word Bank add, update, delete, trash list, and restore."""
        word_id = "test_crud_word"

        # 1. Add word
        add_payload = {
            "id": word_id,
            "word": "testword",
            "section": "part1",
            "glossZh": "测试单词"
        }
        status, body = self._request("/api/listening/word/add", method="POST", data=add_payload)
        self.assertEqual(status, 200)
        self.assertTrue(body.get("ok"))

        # 2. Update word
        update_payload = {
            "id": word_id,
            "glossZh": "更新测试单词"
        }
        status, body = self._request("/api/listening/word/update", method="POST", data=update_payload)
        self.assertEqual(status, 200)
        self.assertTrue(body.get("ok"))

        # 3. Delete word (moves to trash)
        status, body = self._request("/api/listening/word/delete", method="POST", data={"id": word_id})
        self.assertEqual(status, 200)
        self.assertTrue(body.get("ok"))

        # 4. Query trash
        status, body = self._request("/api/listening/trash", method="GET")
        self.assertEqual(status, 200)
        trash_ids = [w.get("id") for w in body.get("words", [])]
        self.assertIn(word_id, trash_ids)

        # 5. Restore word
        status, body = self._request("/api/listening/trash/restore", method="POST", data={"id": word_id})
        self.assertEqual(status, 200)
        self.assertTrue(body.get("ok"))

        # 6. Verify word is back in active words
        self.assertIsNotNone(self.test_store.get_word(word_id))

    def test_06_spelling_judge_endpoint(self):
        """Tests POST /api/judge for capitalization exceptions and general matching."""
        # 1. Capitalized month - correct
        status, body = self._request("/api/judge", method="POST", data={
            "user_input": "January", "target_word": "January", "accepted_answers": ["January"]
        })
        self.assertEqual(status, 200)
        self.assertTrue(body.get("ok"))
        self.assertEqual(body.get("reason"), "correct")

        # 2. Capitalized month - lowercase rejected
        status, body = self._request("/api/judge", method="POST", data={
            "user_input": "january", "target_word": "January", "accepted_answers": ["January"]
        })
        self.assertEqual(status, 200)
        self.assertFalse(body.get("ok"))
        self.assertEqual(body.get("reason"), "capitalization_error")

        # 3. General word - case-insensitive accepted
        status, body = self._request("/api/judge", method="POST", data={
            "user_input": "AIRPORT", "target_word": "airport", "accepted_answers": ["airport"]
        })
        self.assertEqual(status, 200)
        self.assertTrue(body.get("ok"))
        self.assertEqual(body.get("reason"), "correct")

    def test_07_writing_endpoints_rejected_with_404(self):
        """Verifies all writing module routes return HTTP 404 Not Found."""
        for endpoint in [
            "/api/writing/words",
            "/api/writing/stats",
            "/api/writing/checkin",
            "/api/writing/session",
            "/api/writing/settings",
            "/api/writing/trash",
        ]:
            status, _ = self._request(endpoint, method="GET")
            self.assertEqual(status, 404, f"Expected 404 on GET {endpoint}, got {status}")

    def test_08_static_file_serving_and_security(self):
        """Verifies static asset serving and path traversal security."""
        # 1. Index page
        status, html = self._request("/")
        self.assertEqual(status, 200)
        self.assertIn("<!DOCTYPE html>", str(html))

        # 2. CSS asset
        status, css = self._request("/static/css/app.css")
        self.assertEqual(status, 200)

        # 3. JS asset
        status, js = self._request("/static/js/app.js")
        self.assertEqual(status, 200)

        # 4. Path traversal attempt should return 404 or 403
        for malicious_path in [
            "/../server.py",
            "/static/../../server.py",
            "/static/../config.py",
            "/static/%2e%2e/config.py"
        ]:
            status, _ = self._request(malicious_path)
            self.assertIn(status, [400, 403, 404], f"Path traversal on {malicious_path} was not blocked! Status: {status}")


if __name__ == "__main__":
    unittest.main()
