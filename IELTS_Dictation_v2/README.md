# IELTS Dictation v2 (雅思听力核心词汇科学记忆系统)

[![Python 3.7+](https://img.shields.io/badge/python-3.7+-blue.svg)](https://www.python.org/downloads/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-zero%20(stdlib%20only)-brightgreen.svg)]()
[![Port 8766](https://img.shields.io/badge/port-8766-orange.svg)]()
[![License: MIT](https://img.shields.io/badge/license-MIT-lightgrey.svg)]()

**IELTS Dictation v2** is an independent, dedicated **Listening Dictation** application for IELTS vocabulary mastery. It is deployed as a fully self-contained standalone project in `IELTS_Dictation_v2`, strictly isolating itself from the original `IELTS_Dictation` installation and binding to a dedicated port (`8766`).

---

## 🌟 Key Features

1. **Dedicated Listening Dictation (听力默写)**:
   - **British Audio Playback**: Plays British English (`en-GB`) pronunciation automatically on word load.
   - **Speech Synthesis Fallback**: When local MP3 is missing, transparently falls back to client-side Web Speech API (`window.speechSynthesis`, `lang: en-GB`).
   - **Veiled Chinese Meaning**: The Chinese definition is strictly concealed until the user types the English spelling and presses Enter.
   - **Error Retry ("错词强化重测")**: Misspelled words are re-queued 4–6 questions later in the session; passing promotes the word normally to the next stage.
   - **1,622 Filtered Words**: Filtered from 9fnn IELTS listening vocabulary, organized across Part 1–4 and Temporal sections.

2. **Scientific Calendar-Day Ebbinghaus Review**:
   - Review intervals: `[1, 2, 4, 7, 15, 30]` whole calendar days (zero second/minute jitter).
   - Anchored to **Asia/Shanghai (UTC+8)** with rollover at local midnight (00:00:00 CST).
   - Automatic backlog management: excess reviews carry over ordered by due date ascending.

3. **Two-Tier Spelling Evaluation**:
   - Standard words: trimmed, case-insensitive comparison.
   - Case-sensitive exceptions: mandatory initial uppercase for months and countries (configured via `data/case_sensitive_words.json`).
   - Startup scanner detects and outputs capitalized vocabulary entries for confirmation.

4. **Atomic Persistence & Thread-Safe Engine**:
   - Thread-safe storage with atomic persistence (`.tmp -> flush -> fsync -> os.replace`).
   - Active vocabulary and user progress persist in `data/listening.json`.

5. **Zero Third-Party Dependencies**:
   - Built exclusively with Python standard library (`ThreadingHTTPServer`, `urllib`, `json`, `datetime`, `socket`).

---

## 🚀 Quick Start

### 1. One-Click Startup Script

Run the executable startup script:

```bash
./start.sh
```

Or pass `--restart` (or `-r`) to automatically terminate any lingering processes on port 8766:

```bash
./start.sh --restart
```

### 2. Direct Python Execution

You can also run the server directly using Python 3:

```bash
python3 server.py
```

Optional runtime flags and environment variables:
- `PORT`: Override default listening port (default: `8766`).
- `HOST`: Override binding interface (default: `0.0.0.0`).
- `--restart` / `-r`: Terminate existing process listening on target port before starting.

### 3. Accessing the Application

- **Local Machine**: [http://127.0.0.1:8766](http://127.0.0.1:8766)
- **Local Area Network (LAN / Mobile)**: `http://<YOUR_LAN_IP>:8766` (printed in server startup banner).

---

## 📁 Data Storage & Code Layout

```
IELTS_Dictation_v2/
├── README.md                           # User and architecture manual
├── start.sh                            # Executable one-click start script (port 8766)
├── server.py                           # Threading HTTP server & Listening REST API
├── config.py                           # Central configuration, port 8766, intervals
├── core/
│   ├── __init__.py
│   ├── storage.py                      # ModuleStore engine with atomic persistence
│   ├── session_manager.py              # Session queue generator & review cap logic
│   ├── spelling_judge.py               # Two-tier case-sensitive spelling engine
│   └── scheduler_listening.py          # Whole-day Ebbinghaus calendar scheduler
├── scripts/
│   ├── import_listening.py             # 9fnn raw vocabulary importer & filter
│   └── download_audio.py               # British pronunciation downloader & retry
├── data/
│   ├── listening.json                  # Active listening vocabulary database (1,622 words)
│   ├── case_sensitive_words.json       # Months and countries capitalization dictionary
│   └── logs/
│       ├── excluded_words.log          # 170 excluded items log (numeric, name, identifier)
│       └── failed_audio.log            # Failed audio download retry log
├── static/
│   ├── index.html                      # Web frontend with 4 sub-tabs
│   ├── css/
│   │   └── app.css                     # Responsive styling & themes
│   ├── js/
│   │   ├── api.js                      # REST API client
│   │   ├── audio.js                    # Web Audio & SpeechSynthesis fallback
│   │   ├── module_listening.js         # Listening controller
│   │   └── app.js                      # Main application bootstrap
│   └── audio/                          # Local British pronunciation MP3s
└── tests/
    ├── test_original_hash.py           # Original directory cryptographic isolation (R1)
    ├── test_filtering.py               # 9fnn filtering & deduplication assertions (R3)
    ├── test_writing_removed.py         # Asserts writing endpoints return 404 & files deleted (R1)
    ├── test_scheduling_backlog.py      # Whole-day calendar intervals & backlog simulation (R6)
    ├── test_server_endpoints.py        # REST API endpoints & settings validation (R1, R6)
    ├── test_audio_fallback.py          # Audio serving & SpeechSynthesis fallback (R4)
    └── run_all_tests.py                # Master test runner with cryptographic isolation verification
```

---

## 🔄 Re-importing Vocabulary & Audio

All pipeline scripts are non-destructive and preserve data integrity:

### 1. Filtering & Re-importing Listening Vocabulary

To re-import or refresh the listening vocabulary from the read-only original file `9fnnn_listening_vocabulary.json`:

```bash
python3 scripts/import_listening.py
```

- **Category Filtering**: Excludes 170 items belonging to `numeric_value` (74), `name_spelling` (59), and `identifier_string` (37). Retains `regular` (1,466), `None` (126), and `temporal` (92).
- **Deduplication**: Case-insensitive and trimmed consolidation yields exactly 1,622 unique vocabulary items with complete definitions and sections.
- **Audit Logging**: Excluded items are logged to `data/logs/excluded_words.log`.
- **Atomic Writes**: Writes to a temporary file, flushes, fsyncs, and atomically renames to `data/listening.json`.

### 2. Downloading British MP3 Audio & Retrying

Fetches pre-downloaded British pronunciation audio into `static/audio/<word>.mp3`:

```bash
python3 scripts/download_audio.py
```

To retry failed downloads recorded in `data/logs/failed_audio.log`:

```bash
python3 scripts/download_audio.py --retry
```

---

## 📡 REST API Specification

The server provides a REST API under `/api/listening/*` (all `/api/writing/*` routes return HTTP 404 Not Found):

| Method | Endpoint | Description | Response Schema |
|--------|----------|-------------|-----------------|
| `GET` | `/api/listening/words` | Retrieve words with section/scope/order/search filters | `{"words": [...], "total": int}` |
| `GET` | `/api/listening/stats` | Stage distribution, due count, countdowns | `{"stage_counts": {"0": int, ...}, "due_count": int, "total": int}` |
| `GET` | `/api/listening/checkin` | Checkin status, daily streak & history | `{"today_count": int, "goal": int, "streak": int, "history": [...]}` |
| `GET` | `/api/listening/session` | Active study session state | `{"session": {...} \| null}` |
| `POST` | `/api/listening/session/start` | Generate new session queue | `{"queue": [...], "total": int, "ok": true}` |
| `POST` | `/api/listening/session/save` | Persist active session state | `{"ok": true}` |
| `POST` | `/api/listening/session/clear` | Clear active session | `{"ok": true}` |
| `POST` | `/api/listening/review` | Submit review attempt | `{"ok": true, "word": {...}}` |
| `GET` | `/api/listening/settings` | Retrieve user settings | `{"review_cap": int, "daily_new_words": int}` |
| `POST` | `/api/listening/settings` | Update settings (`review_cap >= 1`, `daily_new_words >= 0`) | `{"ok": true, "settings": {...}}` (HTTP 400 on invalid input) |
| `GET` | `/api/listening/trash` | List words in trash bin | `{"ok": true, "words": [...]}` |
| `POST` | `/api/listening/word/add` | Manually add a new vocabulary word | `{"ok": true, "word": {...}}` |
| `POST` | `/api/listening/word/update` | Edit word meaning/section/stage | `{"ok": true, "word": {...}}` |
| `POST` | `/api/listening/word/delete` | Move word to trash bin | `{"ok": true, "deleted_count": int}` |
| `POST` | `/api/listening/trash/restore` | Restore word from trash bin | `{"ok": true, "restored_count": int}` |
| `POST` | `/api/listening/trash/clear` | Permanently purge word from trash | `{"ok": true, "cleared_count": int}` |
| `GET` | `/api/network` | Server network status & LAN access URL | `{"local_ip": str, "port": int, "mobile_url": str}` |
| `POST` | `/api/judge` | Spelling judgment endpoint | `{"correct": bool, "feedback": str}` |
| `GET` | `/static/audio/<word>.mp3` | British MP3 audio file | Audio stream (HTTP 404 triggers SpeechSynthesis) |

### Settings Validation Rules
- `review_cap`: Integer $\ge 1$ (default: 40).
- `daily_new_words`: Integer $\ge 0$ (default: 10; $0$ disables new words).
- Rejects floats, strings, negative values, and boolean types with HTTP 400.

---

## 🧪 Testing & Verification

### Run Original Directory Hash Verification
Ensures `/Users/leslie/Documents/ChatGPT/IELTS/IELTS_Dictation` is strictly untouched:

```bash
python3 -m unittest tests/test_original_hash.py
```

### Run Full Test Suite

```bash
python3 tests/run_all_tests.py
```

---

## 🛡️ Integrity & Safety Guarantees

- **Original Directory Untouched**: The original codebase at `/Users/leslie/Documents/ChatGPT/IELTS/IELTS_Dictation` is strictly read-only. File hashes are cryptographically verified before and after every test run.
- **Port Isolation**: Binds to port `8766` to avoid conflicts with `IELTS_Dictation` running on port `8765`.
- **Atomic Disk Writes**: Prevents database corruption from unexpected power loss or process termination through atomic temporary files, buffer flush, and `fsync`.
