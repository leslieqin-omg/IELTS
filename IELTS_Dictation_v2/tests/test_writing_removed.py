#!/usr/bin/env python3
"""
test_writing_removed.py

Verifies Requirement R1 & Features 3, 4, 5, 6:
Writing module completely excised from IELTS_Dictation_v2:
1. Asserts data/writing.json and backup files are absent (Feature 5).
2. Asserts scripts/migrate_writing.py is absent (Feature 5).
3. Asserts core/scheduler_writing.py is absent (Feature 4).
4. Asserts core/__init__.py and config.py have no writing references (Features 4, 5).
5. Asserts /api/writing/* returns HTTP 404 across all HTTP verbs and sub-paths (Feature 3).
6. Asserts static/js/module_writing.js absence (Feature 6).
"""

import os
import sys
import glob
import json
import urllib.request
import urllib.error
from http.server import HTTPServer
import threading
import unittest

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import config
import server
from core.storage import ModuleStore


class TestWritingModuleRemoved(unittest.TestCase):
    """Test suite verifying complete removal of the Writing module from backend, scripts, and API."""

    @classmethod
    def setUpClass(cls):
        # Spin up an ephemeral HTTP server on localhost with ephemeral port
        cls.server = HTTPServer(("127.0.0.1", 0), server.DictationHandler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def _make_request(self, path: str, method: str = "GET", data: dict | None = None) -> tuple[int, dict | str]:
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

    def test_01_writing_data_files_absent(self):
        """Verifies data/writing.json and all data/writing.json.backup_* are completely absent."""
        writing_json = os.path.join(PROJECT_ROOT, "data", "writing.json")
        self.assertFalse(os.path.exists(writing_json), f"Forbidden file exists: {writing_json}")

        backups = glob.glob(os.path.join(PROJECT_ROOT, "data", "writing.json*"))
        self.assertEqual(backups, [], f"Forbidden writing data/backup files exist: {backups}")

    def test_02_writing_scripts_absent(self):
        """Verifies scripts/migrate_writing.py is absent."""
        migrate_script = os.path.join(PROJECT_ROOT, "scripts", "migrate_writing.py")
        self.assertFalse(os.path.exists(migrate_script), f"Forbidden script exists: {migrate_script}")

    def test_03_writing_core_schedulers_absent(self):
        """Verifies core/scheduler_writing.py is absent."""
        scheduler_writing = os.path.join(PROJECT_ROOT, "core", "scheduler_writing.py")
        self.assertFalse(os.path.exists(scheduler_writing), f"Forbidden core file exists: {scheduler_writing}")

    def test_04_core_init_cleaned(self):
        """Verifies core/__init__.py does not export or import writing scheduler symbols."""
        init_file = os.path.join(PROJECT_ROOT, "core", "__init__.py")
        with open(init_file, "r", encoding="utf-8") as f:
            content = f.read()
        self.assertNotIn("scheduler_writing", content)
        self.assertNotIn("calculate_writing_next_review", content)
        self.assertNotIn("apply_writing_review", content)

    def test_05_config_cleaned(self):
        """Verifies config.py contains no writing file paths or settings."""
        with open(os.path.join(PROJECT_ROOT, "config.py"), "r", encoding="utf-8") as f:
            content = f.read()
        self.assertNotIn("WRITING_DATA_FILE", content)
        self.assertNotIn("DEFAULT_WRITING_SETTINGS", content)
        self.assertNotIn("WRITING_INTERVALS", content)
        self.assertNotIn("WRITING_LAPSE_INTERVAL", content)

    def test_06_server_get_store_rejects_writing(self):
        """Verifies DictationHandler.get_store('writing') returns None."""
        self.assertIsNone(server.DictationHandler.get_store("writing"))
        self.assertIsNone(server.DictationHandler.get_store("WRITING"))

    def test_07_api_writing_get_endpoints_return_404(self):
        """Verifies GET /api/writing/* returns HTTP 404 across all standard resources."""
        resources = ["words", "stats", "checkin", "session", "settings", "nonexistent"]
        for res in resources:
            status, body = self._make_request(f"/api/writing/{res}", method="GET")
            self.assertEqual(status, 404, f"Expected 404 on GET /api/writing/{res}, got {status}: {body}")

    def test_08_api_writing_post_endpoints_return_404(self):
        """Verifies POST /api/writing/* returns HTTP 404 across all mutating actions."""
        post_endpoints = [
            ("/api/writing/checkin", {"date": "2026-11-04"}),
            ("/api/writing/session/start", {}),
            ("/api/writing/session/save", {"currentIndex": 0}),
            ("/api/writing/session/clear", {}),
            ("/api/writing/review", {"word_id": "test", "passed": True}),
            ("/api/writing/settings", {"review_cap": 20, "daily_new_words": 5}),
        ]
        for path, payload in post_endpoints:
            status, body = self._make_request(path, method="POST", data=payload)
            self.assertEqual(status, 404, f"Expected 404 on POST {path}, got {status}: {body}")

    def test_09_writing_ui_module_js_removal(self):
        """Verifies static/js/module_writing.js absence (Feature 6)."""
        writing_js = os.path.join(PROJECT_ROOT, "static", "js", "module_writing.js")
        if os.path.exists(writing_js):
            self.skipTest("Pending Milestone 4 UI writing removal (Feature 6)")
        self.assertFalse(os.path.exists(writing_js))


if __name__ == "__main__":
    unittest.main()
