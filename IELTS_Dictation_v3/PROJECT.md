# Project: IELTS Dictation v2 (Standalone Listening Dictation App)

## Architecture
- **Server Core**: Python Standard Library `http.server.ThreadingHTTPServer` (`server.py`) running on port `8766`, binding to `0.0.0.0` for local and LAN access. Zero third-party Python dependencies.
- **Data Engine**: Modular JSON storage with thread-safe `threading.RLock()` and atomic write semantics (`.tmp -> fsync -> os.replace`) (`core/storage.py`). Primary store: `data/listening.json` (1,622 unique vocabulary items).
- **Spelling Judge**: Two-tier spelling evaluator (`core/spelling_judge.py`) handling whitespace trimming, case-insensitivity, and mandatory capitalization for months and countries (`data/case_sensitive_words.json`), plus startup scanner for capitalized words.
- **Scheduler**: Whole calendar day intervals `[1, 2, 4, 7, 15, 30]` anchored to Asia/Shanghai (UTC+8) midnight rollover (`core/scheduler_listening.py`, `core/session_manager.py`).
- **Web UI**: Monolithic responsive frontend (`static/index.html`, `static/css/app.css`, `static/js/api.js`, `static/js/audio.js`, `static/js/app.js`) featuring 4 clean sub-tabs (首页, 默写, 词库, 艾宾浩斯), audio player with British en-GB pronunciation and Web Speech API fallback, veiled Chinese meaning, and error retry queue.
- **Dual-Track Assurance**:
  - Implementation Track: Builds modular code across milestones.
  - E2E Testing Track: Requirement-driven opaque-box test suite (`TEST_INFRA.md`, `tests/`) covering Tiers 1–4, culminating in `TEST_READY.md` and Tier 5 adversarial hardening.

---

## Code Layout
- `server.py`: HTTP request router, REST API handlers, startup capital letter scanner, static file server.
- `config.py`: Port (8766), host, timezone (Asia/Shanghai), whole-day intervals, default settings.
- `start.sh`: Executable one-click start script supporting `--restart` to clear port 8766.
- `README.md`: User and developer guide: standalone launch, port 8766, data locations, vocabulary re-import.
- `core/`:
  - `storage.py`: Thread-safe, atomic file persistence engine.
  - `spelling_judge.py`: Two-tier spelling evaluation and capital candidate scanner.
  - `scheduler_listening.py`: Whole-day Ebbinghaus interval calculator and Shanghai midnight alignment.
  - `session_manager.py`: Session queue generation, review cap, daily new words budget, backlog order.
- `scripts/`:
  - `import_listening.py`: Raw vocabulary importer, category filter, case-insensitive deduplicator, atomic writer.
  - `download_audio.py`: British en-GB MP3 downloader, failure logging to `data/logs/failed_audio.log`, `--retry` runner.
- `data/`:
  - `listening.json`: Active vocabulary, settings, checkin records, metadata.
  - `case_sensitive_words.json`: Months and country names requiring capitalized initial letters.
  - `logs/excluded_words.log`: 170 excluded items across numeric_value, name_spelling, identifier_string.
- `static/`:
  - `index.html`: Web UI with 4 sub-tabs, dictation view, word bank, stats, settings modal, LAN QR sync.
  - `audio/`: Local British en-GB pronunciation MP3 files.
  - `css/app.css`: Styles for dark/light themes, dictation card, responsive mobile layout.
  - `js/`: `api.js` (REST client), `audio.js` (audio & speech synthesis fallback), `app.js` (controller).
- `tests/`:
  - `test_original_hash.py`: Pre/post-run SHA-256 baseline verification of `/Users/leslie/Documents/ChatGPT/IELTS/IELTS_Dictation`.
  - `test_filtering.py`: R3 category filtering and deduplication assertions.
  - `test_writing_removed.py`: Verifies complete removal of writing files and `/api/writing/*` returning 404.
  - `test_scheduling_backlog.py`: R6 whole-day intervals, midnight rollover, 7-day vacation backlog carryover.
  - `test_audio_fallback.py`: R4 local MP3 serving, 404 fallback to `en-GB` speech synthesis.
  - `test_server_endpoints.py`: Endpoints, settings validation (`review_cap >= 1`, `daily_new_words >= 0`).
  - `run_all_tests.py`: Master test runner with cryptographic isolation verification.

---

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Original Hash Isolation | Original `/Users/leslie/Documents/ChatGPT/IELTS/IELTS_Dictation` strictly unmodified; verified via SHA-256 snapshot | M1 | R1, Survey 1 |
| 2 | Standalone Deployment | Runnable via `start.sh` on port 8766; bound to 0.0.0.0 with LAN access | M1 | R1, Survey 1 |
| 3 | Writing Endpoints Removal | `/api/writing/*` completely removed; returns HTTP 404 | M1 | R1, Survey 1 |
| 4 | Writing Core Removal | `core/scheduler_writing.py` deleted; writing cleaned from `core/__init__.py` & `session_manager.py` | M1 | R1, Survey 1 |
| 5 | Writing Scripts & Data Removal | `data/writing.json*` and `scripts/migrate_writing.py` deleted; `config.py` cleaned | M1 | R1, Survey 1 |
| 6 | Writing UI Removal | `.module-switcher` removed; writing styles deleted; brand set to `🎧 雅思听力默写`; `module_writing.js` deleted | M4 | R1, R2, Survey 1 |
| 7 | Listening Vocabulary Preserved | 1,622 unique vocabulary items with sections and Chinese meanings preserved in `data/listening.json` | M1 | R1, Survey 1 |
| 8 | Standalone README | Documentation covering start command, port 8766, data paths, and vocabulary re-import | M1 | R1, Survey 1 |
| 9 | Raw Vocabulary Ingestion | Read-only import from `/Users/leslie/Documents/ChatGPT/IELTS/IELTS_Dictation/data/9fnnn_listening_vocabulary.json` | M2 | R3, Survey 2 |
| 10 | Category Exclusion | Exclude categories: `numeric_value` (74), `name_spelling` (59), `identifier_string` (37) = 170 items | M2 | R3, Survey 2 |
| 11 | Category Retention | Retain categories: `regular` (1,466), `None` (126), `temporal` (92), missing category = 1,684 raw items | M2 | R3, Survey 2 |
| 12 | Exclusion Logging | Log exactly 170 excluded items with category to `data/logs/excluded_words.log`; print category breakdown | M2 | R3, Survey 2 |
| 13 | Case-Insensitive Deduplication | Deduplicate 1,684 raw items into 1,622 unique words using priority `regular` > `temporal` > `None` | M2 | R3, Survey 2 |
| 14 | Chinese Meaning Completeness | Ensure 100% of 1,622 words have valid Chinese definitions using curated fallbacks | M2 | R3, Survey 2 |
| 15 | Atomic File Writes | All persistence to `data/listening.json` uses `.tmp -> flush -> fsync -> os.replace` under lock | M2 | R3, Survey 2 |
| 16 | Standard Spelling Judge | Case-insensitive spelling comparison with leading/trailing whitespace trimming | M2 | R5, Survey 2 |
| 17 | Capitalization Exceptions | Strict initial uppercase enforcement for months and countries (`data/case_sensitive_words.json`) | M2 | R5, Survey 2 |
| 18 | Startup Capital Scan | Scan vocabulary at startup for capitalized words; print 194 candidates for confirmation | M2 | R5, Survey 2 |
| 19 | 4 Sub-tabs Navigation | Primary navigation: 首页 (Home), 默写 (Dictation), 词库 (Word Bank), 艾宾浩斯 (Ebbinghaus) | M4 | R2, Survey 3 |
| 20 | Home Dashboard | Daily goal progress card, 4 metric cards, live midnight countdown, unfinished session resume banner | M4 | R2, Survey 3 |
| 21 | Section Selector | Dictation filter by IELTS test section (Part 1, Part 2, Part 3, Part 4, Temporal) | M4 | R2, Survey 3 |
| 22 | 5 Scope Options | Dictation scope selection: `due`, `only_review`, `only_new`, `errors`, `all` | M4 | R2, Survey 3 |
| 23 | 4 Order Options | Dictation ordering: `review_first`, `new_first`, `random`, `order` | M4 | R2, Survey 3 |
| 24 | Word Bank Management | Live search, section filter, Add/Edit/Delete modal, batch deletion, trash bin with single/bulk restore | M4 | R2, Survey 3 |
| 25 | British Audio Playback | British English (en-GB) pronunciation automatically played on card load | M4 | R4, Survey 3 |
| 26 | Meaning Concealment & Enter Flow | Chinese meaning strictly veiled on card load; revealed only after typing, pressing Enter, and evaluation | M4 | R4, Survey 3 |
| 27 | Unlimited Audio Replay | Unlimited replays via on-screen button and shortcuts (`Ctrl+R` / `Cmd+R` w/ `e.preventDefault()`, `F2`, `Ctrl+Space`, `Space`) | M4 | R4, Survey 3 |
| 28 | Audio Fallback | Missing local MP3 returns 404 without crashing; triggers browser `speechSynthesis` (`lang = 'en-GB'`) | M4 | R4, Survey 3 |
| 29 | Audio Downloader & Retry | `scripts/download_audio.py` downloads en-GB MP3s, logs errors to `data/logs/failed_audio.log`, supports `--retry` | M4 | R4, Survey 3 |
| 30 | Error Retry ("错词强化重测") | Misspelled words re-queued 4–6 questions later; correct retry promotes normally; NO 5-min double pass | M4 | R2, Survey 3 |
| 31 | Whole-Day Intervals | Ebbinghaus review intervals in whole calendar days: `[1, 2, 4, 7, 15, 30]`. Zero second/minute jitter | M3 | R6, Survey 3 |
| 32 | Shanghai Midnight Rollover | Timezone Asia/Shanghai (UTC+8) midnight rollover (00:00:00 CST); new due date from actual review date | M3 | R6, Survey 3 |
| 33 | Review Cap Setting | Per-session review cap (default 40, minimum 1); excess reviews carry over ordered by due date ascending | M3 | R6, Survey 3 |
| 34 | Daily New Words Budget | Daily new words budget (default 10, minimum 0; 0 disables new words) | M3 | R6, Survey 3 |
| 35 | Settings Validation & Persistence | Rejects invalid inputs (`< 1` cap, `< 0` new words, strings, floats) with HTTP 400; persists atomically | M3 | R6, Survey 3 |
| 36 | 7-Day Backlog Simulation | Overdue reviews carry over in ascending order of due date; rescheduling anchored to actual review date | M3 | R6, Survey 3 |
| 37 | Mobile & LAN Access | Server binds to `0.0.0.0:8766`; displays local IP link and dynamic QR code in sync modal | M4 | R2, Survey 3 |
| 38 | Automated Test Suite & Checklist | Automated test suite covering isolation, filtering, spelling, scheduling, audio fallback, endpoints; manual checklist | Final | All, Survey 1-3 |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Clean Standalone Architecture & Writing Removal | Clean removal of writing endpoints, backend files, data, and scripts; port 8766 configuration; verify original directory hash isolation; README update | None | PLANNED |
| M2 | Vocabulary Ingestion, Filtering & Spelling Judge | Raw 9fnnn import script, category filtering (170 excluded to log), deduplication (1622 unique), atomic writes, two-tier spelling judge, startup capital scan (194 words) | M1 | PLANNED |
| M3 | Core Scheduling, Backlog Engine & Settings API | Whole-day intervals `[1, 2, 4, 7, 15, 30]`, Asia/Shanghai midnight rollover, Settings REST API with validation, 7-day vacation backlog carryover | M1 | PLANNED |
| M4 | Dedicated Listening Web UI & Audio Dictation Flow | 4 sub-tabs, removal of `.module-switcher`, dictation controls (5 scopes, 4 orderings), Word Bank CRUD & trash, error retry 4-6 questions later, en-GB audio playback & speech synthesis fallback, meaning veil on Enter | M2, M3 | PLANNED |
| Final | Full E2E Test Suite Pass & Adversarial Hardening | Pass 100% of E2E test suite (Tiers 1-4) published by E2E Testing Track; Tier 5 adversarial coverage hardening; final hash verification of original directory | M1, M2, M3, M4, TEST_READY.md | PLANNED |

---

## Interface Contracts

### ModuleStore ↔ Schedulers / DictationHandler
- `ModuleStore(filepath: str, default_settings: dict)`:
  - `get_words() -> dict[str, dict]`: Returns active vocabulary dictionary.
  - `get_settings() -> dict`: Returns `{"review_cap": int, "daily_new_words": int}`.
  - `save_settings(settings: dict)`: Validates and atomically writes settings to disk.
  - `save_word(word_id: str, data: dict)`: Atomically updates single word record.
  - `delete_word(word_id: str)`: Atomically moves word to trash.
  - `restore_word(word_id: str)`: Atomically moves word from trash to active words.

### SpellingJudge ↔ server.py / Dictation Flow
- `SpellingJudge.judge(user_input: str, target: str, accepted_answers: list[str]) -> tuple[bool, str]`:
  - Returns `(True, "correct")` if match succeeds.
  - Returns `(False, "capitalization_error")` if target is in `case_sensitive_words.json` and user input lacks initial uppercase.
  - Returns `(False, "spelling_error")` if letters mismatch.
- `scan_case_sensitive_candidates(words: list[dict]) -> list[str]`:
  - Scans and returns all vocabulary words containing uppercase characters.

### SessionManager ↔ server.py
- `generate_session(store: ModuleStore, section: str, scope: str, order: str) -> dict`:
  - Parameters:
    - `section`: section filter or `"all"`.
    - `scope`: `"due"`, `"only_review"`, `"only_new"`, `"errors"`, `"all"`.
    - `order`: `"review_first"`, `"new_first"`, `"random"`, `"order"`.
  - Returns session object: `{"queue": list[dict], "total": int, "created_at": str}`.

### AudioPlayer ↔ Web UI (`static/js/audio.js` ↔ `static/index.html`)
- `playWord(word: str) -> Promise<void>`:
  - Attempts HTMLAudioElement load: `/static/audio/<encoded_word>.mp3`.
  - On error or 404: catches event, calls `window.speechSynthesis.speak(utterance)` with `utterance.lang = "en-GB"`.
