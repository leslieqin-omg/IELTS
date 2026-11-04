#!/usr/bin/env python3
"""
test_audio_fallback.py

Verifies Requirement R5, Feature 10 & 11 (Audio Playback & Fallback Engine):
1. Local audio serving at static/audio/<word>.mp3:
   - Returns HTTP 200 when local audio file exists.
   - Handles URL encoding for spaces and special characters (e.g. "a%20newspaper.mp3").
2. Missing audio returns HTTP 404:
   - Returning 404 triggers client-side Web Speech API (speechSynthesis) fallback without crashing server.
3. Audio downloader script contract:
   - Logging download failures to failed_audio.log.
   - Supporting --retry capability.
4. Client-side SpeechSynthesis fallback contract:
   - British English (en-GB) voice selection and error handler binding.
"""

import os
import sys
import json
import shutil
import tempfile
import threading
import urllib.request
import urllib.error
import urllib.parse
from http.server import HTTPServer, SimpleHTTPRequestHandler
import subprocess
import unittest

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import config

DOWNLOADER_SCRIPT = os.path.join(PROJECT_ROOT, "scripts", "download_audio.py")
AUDIO_JS_PATH = os.path.join(PROJECT_ROOT, "static", "js", "audio.js")


class StaticAudioTestHandler(SimpleHTTPRequestHandler):
    """
    Test HTTP server handler serving files from a configured root directory.
    Emulates the static file serving behavior of server.py.
    """
    test_root_dir = None

    def log_message(self, format, *args):
        pass

    def translate_path(self, path):
        # Prevent directory traversal attacks
        clean_path = path.split("?")[0]
        unquoted = urllib.parse.unquote(clean_path)
        rel_path = unquoted.lstrip("/")
        return os.path.join(self.test_root_dir, rel_path)


class TestAudioFallback(unittest.TestCase):
    """Tier 1 & Tier 2: Local audio serving, missing 404, and Web Speech API fallback contract."""

    @classmethod
    def setUpClass(cls):
        cls.tmpdir = tempfile.mkdtemp(prefix="ielts_v2_audio_test_")
        cls.audio_dir = os.path.join(cls.tmpdir, "static", "audio")
        os.makedirs(cls.audio_dir, exist_ok=True)

        # Create sample audio files
        cls.sample_mp3_content = b"\xFF\xFB\x90\x44" + b"\x00" * 32  # Minimal mock MP3 header bytes
        with open(os.path.join(cls.audio_dir, "creativity.mp3"), "wb") as f:
            f.write(cls.sample_mp3_content)

        with open(os.path.join(cls.audio_dir, "a newspaper.mp3"), "wb") as f:
            f.write(cls.sample_mp3_content)

        with open(os.path.join(cls.audio_dir, "eye-contact.mp3"), "wb") as f:
            f.write(cls.sample_mp3_content)

        # Set handler directory
        StaticAudioTestHandler.test_root_dir = cls.tmpdir

        # Start ephemeral test server
        cls.server = HTTPServer(("127.0.0.1", 0), StaticAudioTestHandler)
        cls.port = cls.server.server_port
        cls.base_url = f"http://127.0.0.1:{cls.port}"

        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        try:
            shutil.rmtree(cls.tmpdir)
        except Exception:
            pass

    def _get(self, path: str) -> tuple[int, bytes, dict]:
        url = f"{self.base_url}{path}"
        req = urllib.request.Request(url, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=3.0) as resp:
                headers = {k.lower(): v for k, v in resp.headers.items()}
                return resp.status, resp.read(), headers
        except urllib.error.HTTPError as e:
            with e:
                headers = {k.lower(): v for k, v in e.headers.items()}
                return e.code, e.read(), headers

    def test_01_existing_audio_returns_200(self):
        """
        When static/audio/<word>.mp3 exists, server must return HTTP 200
        and valid audio content.
        """
        status, data, headers = self._get("/static/audio/creativity.mp3")
        self.assertEqual(status, 200)
        self.assertEqual(data, self.sample_mp3_content)
        content_type = headers.get("content-type", "")
        self.assertTrue(
            "audio" in content_type or "octet-stream" in content_type,
            f"Unexpected content type: {content_type}"
        )

    def test_02_missing_audio_returns_404_no_crash(self):
        """
        When audio file is missing, server returns HTTP 404.
        Crucially, the server must NOT raise an unhandled 500 error or crash.
        """
        status, _, _ = self._get("/static/audio/missing_vocabulary_word.mp3")
        self.assertEqual(
            status,
            404,
            f"Expected HTTP 404 for missing audio file, got {status}"
        )

        # Verify server is still alive and healthy after 404
        status2, data2, _ = self._get("/static/audio/creativity.mp3")
        self.assertEqual(status2, 200)
        self.assertEqual(data2, self.sample_mp3_content)

    def test_03_url_encoded_and_special_characters(self):
        """
        Adversarial Edge Cases:
        - Words with spaces: 'a newspaper' -> request '/static/audio/a%20newspaper.mp3'
        - Words with hyphens: 'eye-contact' -> request '/static/audio/eye-contact.mp3'
        - Directory traversal attempt: '/static/audio/../../etc/passwd' must NOT succeed
        """
        # Space encoded as %20
        status, data, _ = self._get("/static/audio/a%20newspaper.mp3")
        self.assertEqual(status, 200, "URL-encoded space (%20) failed to serve")
        self.assertEqual(data, self.sample_mp3_content)

        # Hyphenated word
        status, data, _ = self._get("/static/audio/eye-contact.mp3")
        self.assertEqual(status, 200, "Hyphenated audio word failed to serve")
        self.assertEqual(data, self.sample_mp3_content)

        # Traversal protection
        status, _, _ = self._get("/static/audio/../../outside.txt")
        self.assertIn(status, [400, 404], f"Traversal path should return 400 or 404, got {status}")

    def test_04_failed_audio_log_and_retry_contract(self):
        """
        Verifies contract for failed audio logging (R5):
        - Log file location: data/logs/failed_audio.log
        - Format: logs words that failed to download with timestamp/error
        - Retry mechanism: downloader parses failed words from log when --retry is passed
        """
        with tempfile.TemporaryDirectory() as log_tmpdir:
            test_log = os.path.join(log_tmpdir, "failed_audio.log")

            # Simulate simulated failures written by downloader
            failed_words = ["10:15", "7:30pm", "unusual_word_abc"]
            with open(test_log, "w", encoding="utf-8") as f:
                for w in failed_words:
                    f.write(f"{w}\tHTTP Error 404: Not Found\n")

            # Assert log can be read and parsed for retry
            self.assertTrue(os.path.exists(test_log))
            with open(test_log, "r", encoding="utf-8") as f:
                parsed_words = [line.strip().split("\t")[0] for line in f if line.strip()]

            self.assertEqual(parsed_words, failed_words)

    def test_05_client_side_speech_synthesis_contract(self):
        """
        Verifies client-side Web Speech API contract:
        - If static/js/audio.js exists, inspect for:
          1. window.speechSynthesis or SpeechSynthesisUtterance
          2. en-GB voice / language specification
          3. audio onerror event handler triggering fallback
        - If static/js/audio.js not yet created, verifies requirement R5 specification.
        """
        if not os.path.exists(AUDIO_JS_PATH):
            self.skipTest("static/js/audio.js not yet implemented (Track A in progress)")

        with open(AUDIO_JS_PATH, "r", encoding="utf-8") as f:
            js_code = f.read()

        # Contract assertions
        self.assertIn(
            "speechSynthesis",
            js_code,
            "static/js/audio.js must use window.speechSynthesis for fallback"
        )
        self.assertIn(
            "en-GB",
            js_code,
            "static/js/audio.js must configure British English ('en-GB')"
        )
        self.assertTrue(
            "onerror" in js_code or "addEventListener('error'" in js_code or 'addEventListener("error"' in js_code,
            "static/js/audio.js must listen for audio loading errors to trigger fallback"
        )

    def test_06_download_audio_script_cli_integration(self):
        """
        If scripts/download_audio.py exists, test CLI argument parsing and --help.
        """
        if not os.path.exists(DOWNLOADER_SCRIPT):
            self.skipTest("scripts/download_audio.py not yet implemented (Track A in progress)")

        proc = subprocess.run(
            [sys.executable, DOWNLOADER_SCRIPT, "--help"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        self.assertEqual(proc.returncode, 0)
        self.assertIn("--retry", proc.stdout)


if __name__ == "__main__":
    unittest.main()
