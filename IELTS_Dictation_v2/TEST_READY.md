# Milestone 2 Test & Verification Readiness (TEST_READY.md)

## 1. Overview
Milestone 2 (Data Migration, Vocabulary Ingestion & Audio Fetch Pipelines) is fully implemented, verified, and integrated into `IELTS_Dictation_v2`.

All three core pipeline scripts have been constructed with genuine logic:
- `scripts/migrate_writing.py`: Safe, idempotent migration of writing vocabulary, review progress, and checkin records with timestamped target backup.
- `scripts/import_listening.py`: Strictly filtered 9fnn vocabulary pipeline excluding 170 non-vocabulary items (`numeric_value`, `name_spelling`, `identifier_string`), retaining 1684 items (`regular`, `None`, `temporal`), deduplicating to 1622 unique vocabulary words, logging 170 excluded items to `data/logs/excluded_words.log`, and saving atomically to `data/listening.json`.
- `scripts/download_audio.py`: British English (en-GB) pronunciation audio downloader saving to `static/audio/<word>.mp3`, handling URL-encoded spaces and phrases, logging failures to `data/logs/failed_audio.log`, and providing `--retry` recovery capability.

---

## 2. Test Execution Commands

### A. Master Test Runner (Runs All 7 Suites with Pre/Post Hash Verification)
```bash
cd /Users/leslie/Documents/ChatGPT/IELTS/IELTS_Dictation_v2
NO_PROXY='127.0.0.1,localhost' python3 tests/run_all_tests.py
```

### B. Individual Milestone 2 Verification Suites
```bash
cd /Users/leslie/Documents/ChatGPT/IELTS/IELTS_Dictation_v2

# 1. Writing Migration Suite (R3)
python3 -m unittest tests/test_migration.py

# 2. 9fnn Vocabulary Filtering & Deduplication Suite (R4)
python3 -m unittest tests/test_filtering.py

# 3. Audio Serving, Missing 404 & Fallback Contract (R5)
NO_PROXY='127.0.0.1,localhost' python3 -m unittest tests/test_audio_fallback.py

# 4. Original Directory Hash & Non-Destructive Integrity (R1)
python3 -m unittest tests/test_original_hash.py
```

### C. Foundation & Isolation Suites (Milestone 1 Core)
```bash
cd /Users/leslie/Documents/ChatGPT/IELTS/IELTS_Dictation_v2

# Core Foundation Unit Tests
python3 -m unittest tests/test_m1_core.py

# Cross-Module Storage Isolation & Atomic Persistence Tests
python3 -m unittest tests/test_isolation.py

# Backlog Simulation, Schedulers & Spelling Evaluation Tests
python3 -m unittest tests/test_scheduling_backlog.py

# Server REST API & Settings Endpoints Tests
NO_PROXY='127.0.0.1,localhost' python3 -m unittest tests/test_server_endpoints.py
```

*Note on macOS Environment*: If a system-wide HTTP proxy is configured (e.g., `127.0.0.1:1082`), prefixing commands with `NO_PROXY='127.0.0.1,localhost'` ensures loopback requests to ephemeral test servers bypass proxy redirection.

---

## 3. Four-Tier Methodology & Test Coverage

| Tier | Category | Scope & Invariants Tested | Status |
|------|----------|---------------------------|--------|
| **Tier 1** | Functional Feature Coverage | - Correct vocabulary schema and field preservation.<br>- Writing migration populates `data/writing.json` (229/230 words, 23 checkin records).<br>- 9fnn category filtering (1684 kept, 170 excluded).<br>- Deduplication to 1622 unique vocabulary items.<br>- Atomic write replace semantics (`.tmp` + flush + fsync + os.replace).<br>- Audio serving returning HTTP 200 for existing files. | **PASS** |
| **Tier 2** | Boundary, Corner & Adversarial | - Case-sensitivity filtering priority (e.g. 'station' kept from regular, excluded from name_spelling).<br>- Multi-word phrases ('a newspaper') and hyphens ('eye-contact').<br>- Attribute union on duplicates (merging acceptedAnswers, parts, glossZh priority).<br>- URL encoding for space characters (`%20`).<br>- Directory traversal protection on audio requests.<br>- Settings validation rejecting invalid integers, floats, negatives, and booleans. | **PASS** |
| **Tier 3** | Cross-Module & Storage Isolation | - SHA-256 pre/post verification of all 14 files in original `IELTS_Dictation`.<br>- Zero modifications to read-only directory.<br>- Zero cross-module write contamination (mutations in listening leave writing untouched, and vice versa).<br>- Independent thread locking (`DB_LOCK`). | **PASS** |
| **Tier 4** | Temporal Simulations & Schedulers | - 7-day backlog simulation with review cap ordering strictly by due date ascending.<br>- Rescheduling from actual review date (Day 7 + interval).<br>- Whole calendar days Ebbinghaus scheduling for Listening with Asia/Shanghai midnight rollover.<br>- Minute/second 9-stage Ebbinghaus intervals for Writing. | **PASS** |

---

## 4. Master E2E Test Results Summary

```
===========================================================================
 MASTER TEST SUITE SUMMARY REPORT
===========================================================================
Suite Name                                                 | Run  | Fail | Err  | Skip | Status
----------------------------------------------------------------------------------------
1. Original Directory Hash Integrity (R1)                  | 5    | 0    | 0    | 0    | ✅ PASS
2. 9fnn Vocabulary Filtering & Deduplication (R4)          | 8    | 0    | 0    | 0    | ✅ PASS
3. Module Write Isolation & Atomic Persistence (R2, R8)    | 5    | 0    | 0    | 0    | ✅ PASS
4. Writing Migration & Backup Idempotence (R3)             | 6    | 0    | 0    | 0    | ✅ PASS
5. Backlog Simulation, Schedulers & Spelling (R5, R6, R7)  | 15   | 0    | 0    | 0    | ✅ PASS
6. REST Endpoints, Settings & Server Health (R1, R7, R8)   | 7    | 0    | 0    | 0    | ✅ PASS
7. Audio Serving, Missing 404 & Fallback Contract (R5)     | 6    | 0    | 0    | 1    | ✅ PASS
----------------------------------------------------------------------------------------
TOTALS: 52 tests run, 0 failures, 0 errors, 1 skipped in 1.65s

Four-Tier Methodology Coverage Breakdown:
  - Tier 1: Functional Feature Coverage        : PASS
  - Tier 2: Boundary, Corner & Adversarial     : PASS
  - Tier 3: Cross-Feature & Module Isolation   : PASS
  - Tier 4: Temporal Simulations & Backlog     : PASS

🎉 ALL TEST SUITES PASSED! Integrity and contracts verified.
```
*(Suite 7 skip is `test_05_client_side_speech_synthesis_contract`, scheduled for Milestone 4 UI implementation).*

---

## 5. Artifacts Produced in Milestone 2

1. **`scripts/migrate_writing.py`**:
   - Supports CLI flags: `--source`, `--target` / `--output`, `--review-cap`, `--daily-new-words`.
   - Creates timestamped `.backup_<YYYYMMDD_HHMMSS>` when target already exists.
   - Atomically updates `data/writing.json`.

2. **`scripts/import_listening.py`**:
   - Supports CLI flags: `--source`, `--target` / `--output`, `--log`, `--review-cap`, `--daily-new-words`.
   - Ingests 1854 entries from `9fnnn_listening_vocabulary.json`.
   - Excludes 170 items (`numeric_value`: 74, `name_spelling`: 59, `identifier_string`: 37).
   - Retains 1684 items (`regular`: 1466, `None`: 126, `temporal`: 92).
   - Deduplicates case-insensitively to 1622 unique vocabulary items with attribute merging.
   - Writes 170 excluded entries with categories to `data/logs/excluded_words.log`.
   - Atomically updates `data/listening.json` with initial settings `{"review_cap": 40, "daily_new_words": 10}`.

3. **`scripts/download_audio.py`**:
   - Supports CLI flags: `--source`, `--output-dir`, `--log`, `--retry`, `--word`, `--limit`, `--delay`, `--overwrite`.
   - Fetches en-GB pronunciation audio into `static/audio/<word>.mp3`.
   - Logs failures to `data/logs/failed_audio.log`.
   - Parses and re-attempts failed entries via `--retry`.

4. **Generated Data Stores**:
   - `data/writing.json`: 229 words, 23 checkin records, review_cap=30, daily_new_words=10.
   - `data/listening.json`: 1622 unique vocabulary words, review_cap=40, daily_new_words=10.
   - `data/logs/excluded_words.log`: Exactly 170 excluded entries formatted as `<word>\t<category>`.
