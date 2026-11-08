"""Two-tier spelling judge for IELTS_Dictation_v2.

Implements trimmed case-insensitive comparison for general vocabulary and strict
capitalization evaluation for months, country names, and capitalized terms.
Uses only Python standard library.
"""

import os
import json


class SpellingJudge:
    """Evaluates spelling correctness with configurable case sensitivity."""

    def __init__(self, case_sensitive_words_path: str | None = None):
        """Initialize judge and load case-sensitive dictionary.

        Args:
            case_sensitive_words_path: Path to case_sensitive_words.json.
        """
        self.case_sensitive_set = set()
        if case_sensitive_words_path and os.path.exists(case_sensitive_words_path):
            self._load_case_sensitive_words(case_sensitive_words_path)

    def _load_case_sensitive_words(self, filepath: str) -> None:
        """Load case-sensitive words and store in lowercase for lookup."""
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)

        if isinstance(data, dict):
            for val in data.values():
                if isinstance(val, list):
                    for item in val:
                        if item and isinstance(item, str):
                            self.case_sensitive_set.add(item.strip().lower())
        elif isinstance(data, list):
            for item in data:
                if item and isinstance(item, str):
                    self.case_sensitive_set.add(item.strip().lower())

    def judge(
        self,
        user_input: str,
        target_word: str,
        accepted_answers: list[str] | None = None
    ) -> tuple[bool, str]:
        """Judge user input against target word and accepted alternatives.

        Args:
            user_input: The string entered by the user.
            target_word: The canonical target spelling.
            accepted_answers: Optional list of alternate acceptable spellings.

        Returns:
            (True, "correct") if answer matches.
            (False, "capitalization_error") if spelling is right or word is capitalized but capitalization failed.
            (False, "spelling_error") if spelling mismatch or empty input.
        """
        clean_input = user_input.strip() if user_input is not None else ""
        clean_target = target_word.strip() if target_word is not None else ""
        clean_accepted = [
            a.strip() for a in accepted_answers if a and isinstance(a, str) and a.strip()
        ] if accepted_answers else []

        all_targets = [clean_target] + clean_accepted

        if not clean_input:
            return False, "spelling_error"

        # Direct exact match always succeeds
        if clean_input in all_targets:
            return True, "correct"

        # Determine if candidate word is in case-sensitive list (e.g. months, country names)
        is_case_sensitive = any(
            cand.lower() in self.case_sensitive_set for cand in all_targets if cand
        )

        if is_case_sensitive:
            # User input MUST start with a capital letter. If lowercase, returns capitalization_error.
            if not clean_input[0].isupper():
                return False, "capitalization_error"

        # General vocabulary (and case-sensitive words passing capitalization check)
        # evaluated case-insensitively
        matches = any(clean_input.lower() == cand.lower() for cand in all_targets)
        if matches:
            return True, "correct"
        else:
            return False, "spelling_error"


def scan_case_sensitive_candidates(words: list[dict]) -> list[str]:
    """Scan words for entries containing capital letters.

    Args:
        words: List of word dictionaries (e.g. from listening vocabulary).

    Returns:
        Sorted, deduplicated list of words containing capital letters.
    """
    candidates = set()
    for entry in words:
        if not isinstance(entry, dict):
            continue
        word_str = entry.get("word")
        if word_str and isinstance(word_str, str):
            trimmed = word_str.strip()
            if any(ch.isupper() for ch in trimmed):
                candidates.add(trimmed)
        accepted = entry.get("acceptedAnswers")
        if isinstance(accepted, list):
            for ans in accepted:
                if ans and isinstance(ans, str):
                    trimmed = ans.strip()
                    if any(ch.isupper() for ch in trimmed):
                        candidates.add(trimmed)
    return sorted(list(candidates))
