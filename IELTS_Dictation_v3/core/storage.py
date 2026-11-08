"""Storage engine for IELTS_Dictation_v2 modules.

Provides thread-safe, atomically-persisted JSON storage for each independent
module (listening, writing). Uses only Python standard library.
"""

import os
import json
import threading


class ModuleStore:
    """Thread-safe, isolated JSON store with atomic file writes."""

    def __init__(self, data_file: str, default_settings: dict | None = None):
        """Initialize module store.

        Args:
            data_file: Path to the JSON data file.
            default_settings: Default settings dictionary.
        """
        self.data_file = os.path.abspath(data_file)
        if default_settings is None:
            self.default_settings = {"review_cap": 30, "daily_new_words": 10, "spot_check_count": 5}
        else:
            self.default_settings = dict(default_settings)
            if "spot_check_count" not in self.default_settings:
                self.default_settings["spot_check_count"] = 5

        self.lock = threading.RLock()
        self.words = {}
        self.trash = {}
        self.active_session = None
        self.meta = {}
        self.checkins = {"daily_goal": 20, "records": {}}
        self.settings = dict(self.default_settings)

        self.load()

    def load(self) -> None:
        """Load data from file, populating defaults if missing."""
        with self.lock:
            if os.path.exists(self.data_file):
                with open(self.data_file, "r", encoding="utf-8") as f:
                    content = json.load(f)

                raw_words = content.get("words", {})
                if isinstance(raw_words, list):
                    self.words = {
                        w.get("id", w.get("word", str(i))): w
                        for i, w in enumerate(raw_words)
                    }
                elif isinstance(raw_words, dict):
                    self.words = raw_words
                else:
                    self.words = {}

                self.trash = content.get("trash", {})
                self.active_session = content.get("active_session")
                self.meta = content.get("meta", {})
                self.checkins = content.get("checkins", {"daily_goal": 20, "records": {}})

                loaded_settings = content.get("settings", {})
                self.settings = dict(self.default_settings)
                if isinstance(loaded_settings, dict):
                    self.settings.update(loaded_settings)
                if "spot_check_count" not in self.settings:
                    self.settings["spot_check_count"] = self.default_settings.get("spot_check_count", 5)
            else:
                self.save()

    def save(self) -> None:
        """Atomically persist store contents to disk via .tmp + fsync + os.replace."""
        with self.lock:
            tmp_path = self.data_file + ".tmp"
            os.makedirs(os.path.dirname(self.data_file), exist_ok=True)
            payload = {
                "settings": self.settings,
                "words": self.words,
                "trash": self.trash,
                "active_session": self.active_session,
                "meta": self.meta,
                "checkins": self.checkins
            }
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, self.data_file)

    def get_word(self, word_id: str) -> dict | None:
        """Retrieve word dictionary by ID, or None if not found."""
        with self.lock:
            return self.words.get(word_id)

    def update_word(self, word_id: str, updates: dict) -> None:
        """Update or insert a word dictionary and persist."""
        with self.lock:
            if word_id in self.words:
                self.words[word_id].update(updates)
            else:
                new_entry = dict(updates)
                new_entry.setdefault("id", word_id)
                self.words[word_id] = new_entry
            self.save()

    def get_words(self) -> list[dict]:
        """Return list of all word dictionaries in the store."""
        with self.lock:
            return list(self.words.values())

    def get_settings(self) -> dict:
        """Return a copy of the current module settings."""
        with self.lock:
            return dict(self.settings)

    def update_settings(self, new_settings: dict) -> tuple[bool, str | dict]:
        """Validate and update module settings.

        Args:
            new_settings: Dictionary containing review_cap and daily_new_words.

        Returns:
            (True, updated_settings) on success.
            (False, error_message) on failure.
        """
        with self.lock:
            if not isinstance(new_settings, dict):
                return False, "new_settings must be a dictionary"

            review_cap = new_settings.get("review_cap")
            daily_new_words = new_settings.get("daily_new_words")
            spot_check_count = new_settings.get("spot_check_count")

            if review_cap is None:
                return False, "review_cap is required"
            if isinstance(review_cap, bool) or not isinstance(review_cap, int):
                return False, "review_cap must be an integer"
            if review_cap < 1:
                return False, "review_cap must be an integer >= 1"

            if daily_new_words is None:
                return False, "daily_new_words is required"
            if isinstance(daily_new_words, bool) or not isinstance(daily_new_words, int):
                return False, "daily_new_words must be an integer"
            if daily_new_words < 0:
                return False, "daily_new_words must be an integer >= 0"

            if spot_check_count is not None:
                if isinstance(spot_check_count, bool) or not isinstance(spot_check_count, int):
                    return False, "spot_check_count must be an integer"
                if spot_check_count < 0:
                    return False, "spot_check_count must be an integer >= 0"
                self.settings["spot_check_count"] = spot_check_count
            elif "spot_check_count" not in self.settings:
                self.settings["spot_check_count"] = 5

            self.settings["review_cap"] = review_cap
            self.settings["daily_new_words"] = daily_new_words
            self.save()
            return True, dict(self.settings)

    def get_checkins(self) -> dict:
        """Return checkins structure."""
        with self.lock:
            return self.checkins

    def update_checkin(self, date_str: str, record: dict) -> None:
        """Update checkin entry for a given date."""
        with self.lock:
            if "records" in self.checkins and isinstance(self.checkins["records"], dict):
                if date_str in self.checkins["records"] and isinstance(self.checkins["records"][date_str], dict):
                    self.checkins["records"][date_str].update(record)
                else:
                    self.checkins["records"][date_str] = dict(record)
            else:
                if date_str in self.checkins and isinstance(self.checkins[date_str], dict):
                    self.checkins[date_str].update(record)
                else:
                    self.checkins[date_str] = dict(record)
            self.save()
