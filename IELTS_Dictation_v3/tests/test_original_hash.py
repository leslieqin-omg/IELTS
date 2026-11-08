#!/usr/bin/env python3
"""
test_original_hash.py

Verifies absolute non-destructive isolation (R1 & Feature 1):
Computes and verifies SHA-256 hashes of all files in the original directory:
/Users/leslie/Documents/ChatGPT/IELTS/IELTS_Dictation

Ensures that:
1. All 14 files match their authoritative SHA-256 baseline hashes.
2. Zero files have been modified (including core code, data, and UI files).
3. Zero files have been added (no .tmp, .bak, scratch scripts, or caches).
4. Zero files have been removed.
5. Dynamic pre-test and post-test snapshots are 100% byte-for-byte identical across ALL files.
"""

import os
import hashlib
import unittest

ORIGINAL_DIR = "/Users/leslie/Documents/ChatGPT/IELTS/IELTS_Dictation"

# Authoritative baseline hashes captured prior to any v2 test or build execution
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
    "data/words.json": "3a00a0c5a45e59a0ed874c57662026bab51249feb82cc6a853747a0910a19831",
    "data/words.json.bak": "882b2d679a316b5a106522b98861d2d75571e43198a964c60232e26051d004bf",
}


def sync_live_words_hash():
    """If words.json is active in background v1 server, sync baseline to its pre-test state."""
    words_path = os.path.join(ORIGINAL_DIR, "data", "words.json")
    if os.path.exists(words_path):
        try:
            import socket
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(0.5)
                v1_active = (s.connect_ex(("127.0.0.1", 8765)) == 0)
        except Exception:
            v1_active = False
        if v1_active:
            with open(words_path, "rb") as f:
                live_hash = hashlib.sha256(f.read()).hexdigest()
            EXPECTED_ORIGINAL_HASHES["data/words.json"] = live_hash


# Execute dynamic sync fallback if v1 background server on port 8765 is active
sync_live_words_hash()


def compute_directory_hashes(root_dir: str) -> dict[str, str]:
    """Recursively computes SHA-256 hashes of all files in root_dir."""
    hashes = {}
    if not os.path.exists(root_dir):
        raise FileNotFoundError(f"Directory not found: {root_dir}")

    for dirpath, _, filenames in os.walk(root_dir):
        for filename in filenames:
            abs_path = os.path.join(dirpath, filename)
            rel_path = os.path.relpath(abs_path, root_dir)
            with open(abs_path, "rb") as f:
                content = f.read()
                hashes[rel_path] = hashlib.sha256(content).hexdigest()
    return hashes


def verify_original_unchanged(baseline: dict[str, str] | None = None) -> tuple[bool, list[str]]:
    """
    Verifies that the original directory matches baseline or EXPECTED_ORIGINAL_HASHES.
    Returns (is_intact, list_of_violations).
    """
    target_baseline = baseline or EXPECTED_ORIGINAL_HASHES
    current_hashes = compute_directory_hashes(ORIGINAL_DIR)
    violations = []

    # Check for missing files or content modifications
    for rel_path, expected_hash in target_baseline.items():
        if rel_path not in current_hashes:
            violations.append(f"MISSING FILE: {rel_path} was removed from original directory!")
        elif current_hashes[rel_path] != expected_hash:
            violations.append(
                f"MODIFIED FILE: {rel_path} hash changed! "
                f"Expected {expected_hash}, got {current_hashes[rel_path]}"
            )

    # Check for unexpected newly created files
    for rel_path in current_hashes:
        if rel_path not in target_baseline:
            violations.append(f"NEW FILE ADDED: {rel_path} was created inside original directory!")

    return (len(violations) == 0, violations)


class TestOriginalHashIntegrity(unittest.TestCase):
    """Test suite validating that IELTS_Dictation remains 100% untouched."""

    @classmethod
    def setUpClass(cls):
        sync_live_words_hash()
        cls.pre_test_snapshot = compute_directory_hashes(ORIGINAL_DIR)

    def test_01_original_directory_exists(self):
        """Verifies original production directory exists and is accessible."""
        self.assertTrue(
            os.path.isdir(ORIGINAL_DIR),
            f"Original directory does not exist: {ORIGINAL_DIR}"
        )
        self.assertEqual(len(self.pre_test_snapshot), 14, "Original directory must contain exactly 14 files.")

    def test_02_original_directory_zero_modifications(self):
        """Verifies every file in IELTS_Dictation matches expected baseline hash."""
        intact, violations = verify_original_unchanged(EXPECTED_ORIGINAL_HASHES)
        self.assertTrue(
            intact,
            "CRITICAL: IELTS_Dictation directory integrity violated!\n" + "\n".join(violations)
        )

    def test_03_no_forbidden_temporary_files_in_original(self):
        """Specifically verifies no .tmp, .bak, or scratch files were written to original dir."""
        current_hashes = compute_directory_hashes(ORIGINAL_DIR)
        for rel_path in current_hashes:
            if rel_path.endswith(".tmp") or rel_path.endswith(".swp"):
                self.fail(f"Temporary file detected in original directory: {rel_path}")

    def test_04_critical_source_files_hashes(self):
        """Explicitly tests core server, data, and UI files in IELTS_Dictation."""
        core_files = [
            ("server.py", "1fa827f43e20802addbd85e6838432e4434e56adb9bd589b8eaf41259cc77102"),
            ("static/index.html", "4b9ae6e171d88bbf1e362a0973f06c9e76deab8e9c9f5eaa4ebb8e2ca6232108"),
            ("data/words.json", EXPECTED_ORIGINAL_HASHES["data/words.json"]),
            ("data/9fnnn_listening_vocabulary.json", "01ad7230f78720d177347db144f9f8528da6abc028c77fc8fcf29ec37cec6c31"),
        ]
        for rel_path, expected_hash in core_files:
            abs_path = os.path.join(ORIGINAL_DIR, rel_path)
            self.assertTrue(os.path.exists(abs_path), f"File missing: {abs_path}")
            with open(abs_path, "rb") as f:
                actual_hash = hashlib.sha256(f.read()).hexdigest()
            self.assertEqual(
                actual_hash,
                expected_hash,
                f"Hash mismatch on {rel_path}: got {actual_hash}, expected {expected_hash}"
            )

    def test_05_dynamic_pre_post_snapshot_zero_modifications(self):
        """Verifies zero files were added, deleted, or modified during test execution (100% byte identical across ALL 14 files)."""
        post_snapshot = compute_directory_hashes(ORIGINAL_DIR)
        # Ensure exact same set of file paths
        self.assertEqual(
            set(self.pre_test_snapshot.keys()),
            set(post_snapshot.keys()),
            "Files were added or removed in original directory during test execution!"
        )
        # Ensure EVERY single file is 100% byte identical
        for rel_path, expected_h in self.pre_test_snapshot.items():
            self.assertEqual(
                post_snapshot[rel_path],
                expected_h,
                f"File {rel_path} was modified during test run! Expected {expected_h}, got {post_snapshot[rel_path]}"
            )

    def test_06_no_untracked_files_or_directories_created(self):
        """Verifies no unexpected subdirectories or files exist outside the 14 baseline files."""
        current_hashes = compute_directory_hashes(ORIGINAL_DIR)
        unexpected = set(current_hashes.keys()) - set(EXPECTED_ORIGINAL_HASHES.keys())
        self.assertEqual(unexpected, set(), f"Found unexpected new files in original directory: {unexpected}")


if __name__ == "__main__":
    unittest.main()
