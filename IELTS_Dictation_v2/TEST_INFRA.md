# Test Infrastructure & Specification: IELTS_Dictation_v2

## 1. Test Philosophy

The testing infrastructure for **IELTS_Dictation_v2** is built around five fundamental engineering principles:

1. **Opaque-Box (Black-Box) Integrity**:
   Tests evaluate functional requirements, interface contracts, and observable behaviors specified in `ORIGINAL_REQUEST.md` and `PROJECT.md`. Tests do not depend on internal implementation private variables or hidden helper methods, ensuring that code refactoring does not break test validity.

2. **Absolute Non-Destructive Isolation (R1)**:
   The original production codebase at `/Users/leslie/Documents/ChatGPT/IELTS/IELTS_Dictation` is strictly treated as read-only. Every test run begins and ends with recursive SHA-256 hash assertions across all 14 files in the original directory. Any alteration, file addition, or deletion constitutes an immediate test suite failure.

3. **Isolated Test Fixtures & Progressive Testability**:
   Every test creates its own sandboxed environment using `tempfile.TemporaryDirectory()`. Tests do not share state, do not depend on execution order, and clean up all temporary files on teardown. During implementation milestones, tests are progressively runnable: tests verify both domain contracts directly and implementation modules when available.

4. **Zero Third-Party Dependencies**:
   Following the tech stack of the project, all tests are implemented strictly using the Python 3 standard library (`unittest`, `urllib`, `http.client`, `hashlib`, `json`, `datetime`, `threading`, `tempfile`). No external packages (`pytest`, `requests`) are required.

5. **Adversarial & Boundary Verification**:
   Tests explicitly target failure modes: negative integers, non-integer types, zero caps, case sensitivity boundaries for months and countries vs. regular vocabulary, colons in audio filenames (`10:15`), and multi-day backlog rescheduling.

---

## 2. Feature Inventory Coverage Matrix

The 25 features identified in `PROJECT.md` are mapped directly to automated test suites and manual verification checklists:

| # | Feature | Target Specification | Automated Test Module / Checklist | Test Class / Method |
|---|---------|----------------------|-----------------------------------|---------------------|
| 1 | Non-destructive Deployment | Zero modifications to original directory; distinct port 8766 | `tests/test_original_hash.py` | `TestOriginalHashIntegrity.test_original_directory_zero_modifications` |
| 2 | Standalone Execution | Runnable via `start.sh`, self-contained | `tests/test_server_endpoints.py`, `MANUAL_CHECKLIST.md` | `TestServerEndpoints.test_server_health_and_info` |
| 3 | Isolated Data Stores | `listening.json` & `writing.json` independent | `tests/test_isolation.py` | `TestModuleIsolation.test_listening_mutation_leaves_writing_untouched` |
| 4 | Atomic Persistence | `.tmp` + `flush` + `os.fsync` + `os.replace` | `tests/test_isolation.py` | `TestAtomicPersistence.test_atomic_write_replace_pattern` |
| 5 | Writing Dictation UX | Text-only, no audio, Chinese prompt first | `tests/test_migration.py`, `MANUAL_CHECKLIST.md` | `TestWritingMigration.test_writing_vocabulary_content`, Section 5 |
| 6 | Writing Ebbinghaus Rules | 9 stages `[300s, 1800s, ...]`, Stage 0/1 two-pass | `tests/test_scheduling_backlog.py` | `TestWritingScheduler.test_writing_intervals_and_lapsing` |
| 7 | Writing Migration Script | Idempotent, reads original only, creates backup | `tests/test_migration.py` | `TestWritingMigration.test_migration_idempotence` |
| 8 | 9fnn Vocabulary Filtering | Exclude `numeric_value`, `name_spelling`, `identifier_string` (170 items) | `tests/test_filtering.py` | `TestVocabularyFiltering.test_r4_category_filtering` |
| 9 | 9fnn Deduplication & Logging | Deduplicate to 1622 words, log 170 to `excluded_words.log` | `tests/test_filtering.py` | `TestVocabularyFiltering.test_deduplication_and_merging` |
| 10 | Listening Audio Playback | Primary en-GB local MP3 (`static/audio/<word>.mp3`) | `tests/test_audio_fallback.py`, `MANUAL_CHECKLIST.md` | `TestAudioFallback.test_static_audio_existing_returns_200`, Section 3 |
| 11 | Audio Fallback Engine | Web Speech API fallback on missing audio / 404 | `tests/test_audio_fallback.py` | `TestAudioFallback.test_static_audio_missing_returns_404` |
| 12 | Audio Replay Controls | UI replay button + Ctrl+R / Space shortcut | `MANUAL_CHECKLIST.md` | Section 3 (Audio Listening & Replay Verification) |
| 13 | Audio Downloader & Retry | Download script with `--retry` and `failed_audio.log` | `tests/test_audio_fallback.py` | `TestAudioFallback.test_failed_audio_log_and_retry_contract` |
| 14 | Two-Tier Spelling Judgment | General case-insensitive; months & countries capital | `tests/test_scheduling_backlog.py` | `TestSpellingJudge.test_two_tier_capitalization_judgment` |
| 15 | Case-Sensitive Config & Scan | `data/case_sensitive_words.json`, startup capital scan | `tests/test_scheduling_backlog.py` | `TestSpellingJudge.test_case_sensitive_config_loading` |
| 16 | Listening Whole-Day Review | Intervals `[1, 2, 4, 7, 15, 30]` whole days only | `tests/test_scheduling_backlog.py` | `TestListeningScheduler.test_whole_calendar_day_intervals` |
| 17 | Shanghai Midnight Rollover | Midnight rollover (00:00:00 CST, UTC+8) | `tests/test_scheduling_backlog.py` | `TestListeningScheduler.test_shanghai_midnight_rollover` |
| 18 | Session Review Cap | Listening default 40, Writing default 30; backlog due asc | `tests/test_scheduling_backlog.py` | `TestSchedulingBacklog.test_7day_backlog_simulation_order_and_cap` |
| 19 | Daily New Words Limit | Default 10 (0 disables), daily tracking in checkins | `tests/test_scheduling_backlog.py` | `TestSchedulingBacklog.test_daily_new_words_budget_and_disable` |
| 20 | Settings Isolation & Persistence | Validate non-negative int, `review_cap >= 1`, isolated | `tests/test_server_endpoints.py` | `TestSettingsEndpoints.test_settings_validation_and_isolation` |
| 21 | Unified Web UI Tabs | Single page with top tabs `[ 🎧 听力 ]` and `[ ✍️ 写作 ]` | `MANUAL_CHECKLIST.md`, `tests/test_server_endpoints.py` | Section 2, `TestServerEndpoints.test_index_page_serving` |
| 22 | Tab State Preservation | Dual containers maintain input & state across switches | `MANUAL_CHECKLIST.md` | Section 6 (Tab State Preservation Verification) |
| 23 | REST API Endpoints | Symmetric `/api/{module}/*` endpoints | `tests/test_server_endpoints.py` | `TestServerEndpoints.test_symmetric_module_routes` |
| 24 | Automated Test Suite | 7 automated test suites + master test runner | `tests/run_all_tests.py` | Master suite runner (`run_all_tests.py`) |
| 25 | Manual Verification Checklist | Step-by-step human verification checklist | `tests/MANUAL_CHECKLIST.md` | Complete manual verification checklist |

---

## 3. Four-Tier Testing Methodology

```
+-------------------------------------------------------------+
| Tier 4: Real-World Workload & Temporal Simulations          |
| (7-day backlog, actual review date rescheduling, idempotence)|
+-------------------------------------------------------------+
                              ▲
+-------------------------------------------------------------+
| Tier 3: Cross-Feature Pairwise & Data Isolation             |
| (listening vs writing data stores, concurrent lock checks)  |
+-------------------------------------------------------------+
                              ▲
+-------------------------------------------------------------+
| Tier 2: Boundary, Corner & Adversarial Edge Cases           |
| (negative caps, zero budget, category collisions, colons)   |
+-------------------------------------------------------------+
                              ▲
+-------------------------------------------------------------+
| Tier 1: Functional Feature Coverage                         |
| (9fnn filtering, migration, scheduling, endpoints, hashes)  |
+-------------------------------------------------------------+
```

### 3.1 Tier 1: Functional Feature Coverage
Tier 1 establishes baseline contract satisfaction for all functional units:
- **Hash Integrity**: Scans `/Users/leslie/Documents/ChatGPT/IELTS/IELTS_Dictation` and verifies SHA-256 for all 14 files before and after all operations.
- **Vocabulary Filtering**: Ingests raw `9fnnn_listening_vocabulary.json` (1,854 items), excludes 170 items (`numeric_value`: 74, `name_spelling`: 59, `identifier_string`: 37), keeps 1,684 items (`regular`: 1466, `None`: 126, `temporal`: 92), deduplicates to 1,622 unique vocabulary words, and logs 170 items into `excluded_words.log`.
- **Vocabulary Migration**: Migrates 230 words and 23 checkin dates from `words.json` into `data/writing.json` with default settings (`review_cap: 30`, `daily_new_words: 10`).
- **Scheduling Progressions**: Confirms Listening intervals use whole days `[1, 2, 4, 7, 15, 30]`, and Writing intervals use 9-stage minute/second intervals `[300s, 1800s, 43200s, ...]`.
- **REST Endpoints**: Confirms 200 OK responses for words, stats, checkin, and settings across both `/api/listening/*` and `/api/writing/*`.

### 3.2 Tier 2: Boundary, Corner & Adversarial Edge Cases
Tier 2 exercises extreme and invalid inputs:
- **Settings Validation Boundaries**:
  - `review_cap = 0`: Must be rejected (HTTP 400), as minimum review cap is 1.
  - `review_cap = -1`, `review_cap = "forty"`, `review_cap = 20.5`: Rejected with HTTP 400.
  - `daily_new_words = -1`: Must be rejected (HTTP 400).
  - `daily_new_words = 0`: Accepted (HTTP 200), disables new words for the session.
- **Category Collisions**:
  - Word `'station'`: Exists in both `regular` (meaning "n. 车站") and `name_spelling` (`'Station'`). Filtering must execute before deduplication so regular `'station'` is kept.
  - Words `'15'`, `'200'`, `'6'`: Collide between `numeric_value` and `None`/`temporal`.
- **Attribute Merging on Duplicates**:
  - Duplicate words with different `acceptedAnswers` (e.g., `animals`, `garden`, `sun`). Merging must compute the union of answers.
  - `glossZh` priority: `regular` non-null definition must be prioritized over `None` null definition.
- **Audio Filename Sanitization**:
  - Vocabulary phrases with spaces (`a newspaper`) or colons (`10:15`, `7:30pm`). Audio player handles URL encoding (`a%20newspaper.mp3`) and missing audio returns 404 without crashing server.
- **Spelling Capitalization Corner Cases**:
  - Months (`January`, `February`) and countries (`France`, `Japan`, `South Africa`): Lowercase input (`january`, `france`) is rejected as capitalization error.
  - Capitalized common nouns in raw dataset (`Carpets`, `Water`, `Danger`): Input in lowercase (`carpets`, `water`) is accepted as correct.

### 3.3 Tier 3: Cross-Feature Pairwise & Module Isolation
Tier 3 tests the interaction and independence between modules:
- **Data Store Isolation**:
  - Mutating `data/listening.json` (submitting reviews, updating checkins, changing settings) must cause zero byte changes to `data/writing.json`.
  - Mutating `data/writing.json` must cause zero byte changes to `data/listening.json`.
- **Atomic Replace Guarantee**:
  - Writes write to `<filename>.tmp`, invoke `flush()`, invoke `os.fsync()`, and invoke `os.replace()`.
- **Settings Isolation**:
  - Changing Listening `review_cap` from 40 to 60 leaves Writing `review_cap` at 30.
  - Changing Writing `daily_new_words` to 0 leaves Listening `daily_new_words` at 10.
- **Dual Lock Isolation**:
  - Operations on Listening lock do not hold or contend with Writing lock.

### 3.4 Tier 4: Real-World Workload & Temporal Simulations
Tier 4 simulates long-running user behavioral patterns:
- **7-Day Backlog Simulation**:
  1. Day 0: Student completes Batch A (10 words), due on Day 1.
  2. Day 1: Student completes Batch B (10 words), due on Day 2.
  3. Student takes 7 days off (returns on Day 7). Both Batch A and Batch B are overdue.
  4. Student opens app on Day 7 with `review_cap = 10`:
     - Overdue queue is sorted strictly by due date ascending (`Day 1 < Day 2`).
     - Session contains exclusively Batch A. Batch B carries over to next session.
  5. Student reviews Batch A on Day 7:
     - New due date is computed from **actual review date (Day 7)**: `Day 7 + INTERVAL[stage]`.
     - New due date is NOT calculated from the missed Day 1 target date.
- **Migration Idempotence**:
  - Running `scripts/migrate_writing.py` three times in succession produces identical data, zero duplicated words, and creates timestamped backups when target exists.
- **Shanghai Midnight Rollover (UTC+8)**:
  - At 23:59:59 CST, words due tomorrow are not due.
  - At 00:00:00 CST, words due tomorrow transition to due immediately.

---

## 4. Test Suite Execution Guide

### 4.1 Running All Automated Tests
To run the full E2E test suite with pre/post hash verification:

```bash
cd /Users/leslie/Documents/ChatGPT/IELTS/IELTS_Dictation_v2
python3 tests/run_all_tests.py
```

### 4.2 Running Individual Test Modules
Each test module is runnable standalone with standard Python:

```bash
cd /Users/leslie/Documents/ChatGPT/IELTS/IELTS_Dictation_v2

# 1. Original directory hash verification (14 files)
python3 -m unittest tests/test_original_hash.py

# 2. 9fnn vocabulary filtering, deduplication, and exclusion logs
python3 -m unittest tests/test_filtering.py

# 3. Cross-module write isolation and atomic persistence
python3 -m unittest tests/test_isolation.py

# 4. Writing vocabulary migration idempotence and backup
python3 -m unittest tests/test_migration.py

# 5. 7-day backlog simulation, whole-day intervals, Shanghai rollover
python3 -m unittest tests/test_scheduling_backlog.py

# 6. HTTP API endpoints and settings validation
python3 -m unittest tests/test_server_endpoints.py

# 7. Audio missing 404 and SpeechSynthesis fallback contract
python3 -m unittest tests/test_audio_fallback.py
```

---

## 5. Manual Verification Checklist (Summary)

For complete interactive testing details, refer to `tests/MANUAL_CHECKLIST.md`.

1. **Launch Server**: Run `./start.sh` and verify port 8766 is active without affecting port 8765.
2. **Top Tabs**: Open `http://127.0.0.1:8766` and verify tabs `[ 🎧 听力默写 ]` and `[ ✍️ 写作默写 ]`.
3. **Listening Dictation**: Click "开始默写", listen to British audio, verify word & Chinese meaning are hidden until Enter.
4. **Replay Controls**: Test replay button and keyboard shortcut (`Ctrl+R` or `Space`).
5. **Two-Tier Spelling**: Type lowercase month (`january`) -> verify rejected; type `January` -> verify accepted.
6. **Writing Dictation**: Switch tab, verify text-only prompt (Chinese shown, typing English) with no audio.
7. **Tab State Preservation**: Type half an answer in Listening, switch to Writing, switch back -> text is preserved.
8. **Settings Persistence**: Change Review Cap in Listening, verify Writing unchanged, restart server -> setting persists.
