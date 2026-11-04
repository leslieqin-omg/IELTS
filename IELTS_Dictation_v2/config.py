"""Centralized configuration for IELTS_Dictation_v2.

Uses only Python 3 standard library.
"""

import os
from datetime import timezone, timedelta

# Base Directories
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
STATIC_DIR = os.path.join(BASE_DIR, "static")
AUDIO_DIR = os.path.join(STATIC_DIR, "audio")
LOGS_DIR = os.path.join(DATA_DIR, "logs")

# Read-only reference to original IELTS_Dictation directory
ORIGINAL_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "IELTS_Dictation"))
ORIGINAL_LISTENING_FILE = os.path.join(ORIGINAL_DIR, "data", "9fnnn_listening_vocabulary.json")

# Module Data Files
LISTENING_DATA_FILE = os.path.join(DATA_DIR, "listening.json")
CASE_SENSITIVE_WORDS_FILE = os.path.join(DATA_DIR, "case_sensitive_words.json")

# Log Files
EXCLUDED_WORDS_LOG = os.path.join(LOGS_DIR, "excluded_words.log")
FAILED_AUDIO_LOG = os.path.join(LOGS_DIR, "failed_audio.log")

# Timezone (Asia/Shanghai = UTC+8, standard library, no external tz library needed)
SHANGHAI_TZ = timezone(timedelta(hours=8))

# Server Runtime
DEFAULT_PORT = int(os.environ.get("PORT", "8766"))
DEFAULT_HOST = os.environ.get("HOST", "0.0.0.0")

# Listening Module Schedulers (whole calendar days only, Asia/Shanghai midnight rollover)
LISTENING_INTERVALS = [1, 2, 4, 7, 15, 30]  # whole days
DEFAULT_LISTENING_SETTINGS = {
    "review_cap": 40,
    "daily_new_words": 10
}

# Settings Constraints
MIN_REVIEW_CAP = 1
MIN_DAILY_NEW_WORDS = 0
