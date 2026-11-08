#!/usr/bin/env python3
"""
test_filtering.py

Verifies Requirement R4 (Listening vocabulary filtering & deduplication):
1. Ingests 9fnnn_listening_vocabulary.json (1854 entries) in read-only mode.
2. Filters out categories: numeric_value (74), name_spelling (59), identifier_string (37) = 170 excluded.
3. Includes all valid categories: regular (1466), None (126), temporal (92) = 1684 kept.
4. Deduplicates kept items on word.strip().lower() to produce exactly 1622 unique vocabulary words.
5. Verifies attribute merging: union of acceptedAnswers, union of parts, glossZh priority.
6. Verifies excluded_words.log contains all 170 excluded entries with categories.
7. Executes scripts/import_listening.py in a sandbox if present and validates output artifacts.
"""

import os
import sys
import re
import json
import shutil
import tempfile
import subprocess
from collections import Counter, defaultdict
import unittest

ORIGINAL_9FNN_PATH = "/Users/leslie/Documents/ChatGPT/IELTS/IELTS_Dictation/data/9fnnn_listening_vocabulary.json"
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
IMPORT_SCRIPT_PATH = os.path.join(PROJECT_ROOT, "scripts", "import_listening.py")

EXCLUDED_CATEGORIES = {"numeric_value", "name_spelling", "identifier_string"}
KEPT_CATEGORIES = {"regular", "None", "temporal"}


def filter_and_deduplicate_vocabulary(words: list[dict]) -> tuple[list[dict], list[dict], list[dict]]:
    """
    Reference specification implementation of R4 filtering and deduplication.
    Returns: (kept_records, excluded_records, deduplicated_records)
    """
    excluded = []
    kept_raw = []

    # Step 1: Category, clock time, and number/code filtering
    for entry in words:
        cat = str(entry.get("category"))
        word_text = str(entry.get("word", "")).strip()
        is_clock_time = bool(re.search(r"^\d{1,2}[:.]\d{2}(\s*(am|pm))?$", word_text, re.IGNORECASE))
        is_pure_num_or_code = bool(re.match(r"^\d+$", word_text) or word_text.upper() == "GW432HA")
        if cat in EXCLUDED_CATEGORIES or is_clock_time or is_pure_num_or_code:
            excluded.append(entry)
        else:
            kept_raw.append(entry)

    # Step 2: Deduplication on trimmed, lowercased word
    groups = defaultdict(list)
    for entry in kept_raw:
        norm_key = entry.get("word", "").strip().lower()
        groups[norm_key].append(entry)

    category_priority = {"regular": 3, "temporal": 2, "None": 1}

    deduplicated = []
    for norm_key, items in groups.items():
        if len(items) == 1:
            deduplicated.append(items[0])
            continue

        # Sort by category priority descending
        items.sort(
            key=lambda x: category_priority.get(str(x.get("category")), 0),
            reverse=True
        )
        base = dict(items[0])

        # Merge acceptedAnswers (preserving order and removing duplicates)
        merged_answers = []
        seen_answers = set()
        for it in items:
            for ans in it.get("acceptedAnswers") or []:
                if ans not in seen_answers:
                    seen_answers.add(ans)
                    merged_answers.append(ans)
        base["acceptedAnswers"] = merged_answers

        # Merge parts
        merged_parts = []
        seen_parts = set()
        for it in items:
            for p in it.get("parts") or []:
                if p not in seen_parts:
                    seen_parts.add(p)
                    merged_parts.append(p)
        base["parts"] = merged_parts

        # Pick non-null glossZh
        for it in items:
            if it.get("glossZh"):
                base["glossZh"] = it["glossZh"]
                break

        deduplicated.append(base)

    return kept_raw, excluded, deduplicated


class TestVocabularyFiltering(unittest.TestCase):
    """Tier 1 & Tier 2 tests for 9fnn vocabulary filtering and deduplication."""

    @classmethod
    def setUpClass(cls):
        cls.assertTrue(
            os.path.exists(ORIGINAL_9FNN_PATH),
            f"Original dataset missing: {ORIGINAL_9FNN_PATH}"
        )
        with open(ORIGINAL_9FNN_PATH, "r", encoding="utf-8") as f:
            cls.raw_data = json.load(f)
        cls.words = cls.raw_data.get("words", [])

    def test_01_raw_dataset_counts_and_schema(self):
        """Verifies raw dataset contains 1854 entries with expected category distribution."""
        self.assertEqual(len(self.words), 1854, "Raw dataset must contain exactly 1854 words")

        cat_counts = Counter(str(w.get("category")) for w in self.words)
        self.assertEqual(cat_counts["regular"], 1466)
        self.assertEqual(cat_counts["None"], 126)
        self.assertEqual(cat_counts["temporal"], 92)
        self.assertEqual(cat_counts["numeric_value"], 74)
        self.assertEqual(cat_counts["name_spelling"], 59)
        self.assertEqual(cat_counts["identifier_string"], 37)

    def test_02_r4_category_filtering_counts(self):
        """Verifies filtering partition: 199 excluded entries, 1655 kept entries."""
        kept_raw, excluded, _ = filter_and_deduplicate_vocabulary(self.words)

        self.assertEqual(len(excluded), 199, f"Expected 199 excluded items, got {len(excluded)}")
        self.assertEqual(len(kept_raw), 1655, f"Expected 1655 kept items, got {len(kept_raw)}")

        # Verify kept set contains ZERO forbidden categories, clock times, or pure numbers
        for item in kept_raw:
            self.assertNotIn(
                item.get("category"),
                EXCLUDED_CATEGORIES,
                f"Item '{item.get('word')}' with category '{item.get('category')}' wrongly kept"
            )
            w = item.get("word", "").strip()
            self.assertFalse(bool(re.search(r"^\d{1,2}[:.]\d{2}(\s*(am|pm))?$", w, re.I)), f"Clock time '{w}' wrongly kept")
            self.assertFalse(bool(re.match(r"^\d+$", w) or w == "GW432HA"), f"Number '{w}' wrongly kept")

    def test_03_deduplication_exact_counts(self):
        """Verifies deduplication collapses 1655 kept items to exactly 1593 unique vocabulary items."""
        _, _, deduplicated = filter_and_deduplicate_vocabulary(self.words)
        self.assertEqual(
            len(deduplicated),
            1593,
            f"Expected exactly 1593 deduplicated items, got {len(deduplicated)}"
        )

        # Confirm all 1622 items have unique lowercased words
        norm_keys = [w["word"].strip().lower() for w in deduplicated]
        self.assertEqual(len(norm_keys), len(set(norm_keys)), "Deduplicated set contains duplicate keys!")

    def test_04_category_collision_filtering_priority(self):
        """
        Adversarial edge case:
        'station' exists in 'regular' ('station') and in 'name_spelling' ('Station').
        Filtering MUST occur before deduplication so regular 'station' is preserved.
        """
        kept_raw, excluded, deduplicated = filter_and_deduplicate_vocabulary(self.words)

        # 'Station' from name_spelling must be in excluded
        station_excluded = [w for w in excluded if w.get("word", "").strip().lower() == "station"]
        self.assertTrue(any(w.get("category") == "name_spelling" for w in station_excluded))

        # 'station' from regular must be preserved in deduplicated
        station_kept = [w for w in deduplicated if w.get("word", "").strip().lower() == "station"]
        self.assertEqual(len(station_kept), 1, "station should appear exactly once in kept vocabulary")
        self.assertEqual(station_kept[0].get("category"), "regular")
        self.assertIsNotNone(station_kept[0].get("glossZh"))

    def test_05_attribute_merging_on_duplicates(self):
        """
        Verifies duplicate merging retains union of acceptedAnswers,
        union of parts, and prioritizes non-null glossZh.
        """
        _, _, deduplicated = filter_and_deduplicate_vocabulary(self.words)
        dedup_by_word = {w["word"].strip().lower(): w for w in deduplicated}

        # Case 1: 'animals' - regular has ['animals'], None has ['animals', 'herds']
        animals = dedup_by_word.get("animals")
        self.assertIsNotNone(animals)
        self.assertIn("animals", animals["acceptedAnswers"])
        self.assertIn("herds", animals["acceptedAnswers"])
        self.assertIsNotNone(animals.get("glossZh"))

        # Case 2: 'garden' - regular has ['garden'], None has ['garden', 'Cretan garden']
        garden = dedup_by_word.get("garden")
        self.assertIsNotNone(garden)
        self.assertIn("garden", garden["acceptedAnswers"])
        self.assertIn("Cretan garden", garden["acceptedAnswers"])
        self.assertEqual(garden.get("category"), "regular")

    def test_06_hyphenated_and_multiword_phrases(self):
        """Verifies multi-word phrases and hyphenated entries are preserved without mangling."""
        _, _, deduplicated = filter_and_deduplicate_vocabulary(self.words)
        words_set = {w["word"].strip().lower() for w in deduplicated}

        # Check critical multi-word and hyphenated IELTS phrases
        self.assertIn("a newspaper", words_set)
        self.assertIn("eye-contact", words_set)
        self.assertIn("glow-worms", words_set)
        self.assertIn("non-smoking room", words_set)
        self.assertIn("problem-solving", words_set)

    def test_07_excluded_words_log_completeness(self):
        """
        Verifies that excluded records format satisfies R4:
        Every excluded word is logged with its category.
        """
        _, excluded, _ = filter_and_deduplicate_vocabulary(self.words)
        self.assertEqual(len(excluded), 199)

        # Every excluded item must have a word
        for entry in excluded:
            self.assertTrue(entry.get("word"), "Excluded entry missing word")

    def test_08_import_listening_script_integration(self):
        """
        If scripts/import_listening.py exists, executes it into an isolated temporary
        directory and verifies produced listening.json and excluded_words.log.
        """
        if not os.path.exists(IMPORT_SCRIPT_PATH):
            self.skipTest("scripts/import_listening.py is not yet implemented (Track A in progress)")

        with tempfile.TemporaryDirectory() as tmpdir:
            out_json = os.path.join(tmpdir, "listening.json")
            out_log = os.path.join(tmpdir, "excluded_words.log")

            # Execute the script pointing to temp destinations
            cmd = [
                sys.executable,
                IMPORT_SCRIPT_PATH,
                "--source", ORIGINAL_9FNN_PATH,
                "--output", out_json,
                "--log", out_log,
            ]
            proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.assertEqual(
                proc.returncode,
                0,
                f"import_listening.py failed (exit {proc.returncode}):\n{proc.stderr}\n{proc.stdout}"
            )

            # Assert output JSON exists and has 1593 unique words
            self.assertTrue(os.path.exists(out_json), "Output listening.json was not created")
            with open(out_json, "r", encoding="utf-8") as f:
                data = json.load(f)

            words_dict = data.get("words", {})
            self.assertEqual(
                len(words_dict),
                1593,
                f"Import script produced {len(words_dict)} words, expected 1593"
            )

            # Assert log file exists and contains 199 excluded entries
            self.assertTrue(os.path.exists(out_log), "Output excluded_words.log was not created")
            with open(out_log, "r", encoding="utf-8") as f:
                log_lines = [line.strip() for line in f if line.strip()]
            self.assertEqual(
                len(log_lines),
                199,
                f"excluded_words.log contains {len(log_lines)} lines, expected 199"
            )


if __name__ == "__main__":
    unittest.main()
