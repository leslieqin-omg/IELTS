#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
IELTS_Dictation_v2 Server
=========================
Independent, standalone HTTP and REST API server for IELTS_Dictation_v2.
Dedicated Listening dictation application.

Features:
- Standard library only (Python 3.7+ ThreadingHTTPServer, zero third-party dependencies).
- Runs on port 8766 (isolated from original application running on 8765).
- Dedicated Listening Module REST API (/api/listening/*): Audio-based dictation, 9fnn vocabulary,
  whole-calendar-day intervals ([1, 2, 4, 7, 15, 30] days), Shanghai midnight rollover.
- Full feature parity with original IELTS_Dictation UI (Home dashboard, Section/Scope/Order
  filtering, Word Bank CRUD, Batch Delete, Trash bin & Restore, 14-day Check-in Calendar,
  Ebbinghaus live countdown & stage distribution, LAN Mobile Sync, plus Settings).
- Thread-safe storage with atomic persistence (.tmp -> flush -> fsync -> os.replace).
- Complete settings isolation & boundary validation.
- Static file serving (HTML, CSS, JS, Audio) with path traversal security.
- Startup scan for capital letters in listening vocabulary for case-sensitivity confirmation.
"""

import os
import sys
import re
import glob
import json
import time
import datetime
import socket
import subprocess
import mimetypes
import urllib.parse
import signal
import threading
from http.server import HTTPServer, SimpleHTTPRequestHandler

try:
    from http.server import ThreadingHTTPServer
except ImportError:
    import socketserver

    class ThreadingHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
        daemon_threads = True
        allow_reuse_address = True

# Add project root to sys.path
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
IELTS_PARENT_ROOT = os.path.dirname(PROJECT_ROOT)
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import config
from core.storage import ModuleStore
from core.session_manager import generate_session
from core.spelling_judge import SpellingJudge, scan_case_sensitive_candidates
from core.scheduler_listening import apply_listening_review

# Initialize storage engine
listening_store = ModuleStore(config.LISTENING_DATA_FILE, config.DEFAULT_LISTENING_SETTINGS)

# Initialize spelling judge
spelling_judge = SpellingJudge(config.CASE_SENSITIVE_WORDS_FILE)


def get_local_ip() -> str:
    """Retrieve local network IP address for LAN access."""
    try:
        out = subprocess.check_output('/sbin/ifconfig en0', shell=True).decode('utf-8')
        m = re.search(r'inet\s+(\d+\.\d+\.\d+\.\d+)', out)
        if m and not m.group(1).startswith('127.'):
            return m.group(1)
    except Exception:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(('10.255.255.255', 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"


def compute_checkin_stats(checkins: dict) -> dict:
    """Compute today checkin progress, current streak, and 14-day history."""
    goal = checkins.get("daily_goal", 20)
    records = checkins.get("records", {})
    now_dt = datetime.datetime.now(config.SHANGHAI_TZ)
    today_str = now_dt.strftime("%Y-%m-%d")
    today_rec = records.get(today_str, {})
    today_count = today_rec.get("count", 0)
    today_completed = today_rec.get("completed", False) or (today_count >= goal)

    # Streak calculation
    streak = 0
    check_date = now_dt.date()
    if not today_completed:
        check_date -= datetime.timedelta(days=1)

    while True:
        d_str = check_date.strftime("%Y-%m-%d")
        r = records.get(d_str)
        if r and (r.get("completed", False) or (r.get("count", 0) >= goal)):
            streak += 1
            check_date -= datetime.timedelta(days=1)
        else:
            break

    # 14-day history
    weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    history = []
    for i in range(13, -1, -1):
        d = now_dt.date() - datetime.timedelta(days=i)
        d_str = d.strftime("%Y-%m-%d")
        r = records.get(d_str, {})
        history.append({
            "date": d_str,
            "day_label": d.strftime("%m/%d"),
            "weekday": weekdays[d.weekday()],
            "count": r.get("count", 0),
            "completed": r.get("completed", False) or (r.get("count", 0) >= goal),
            "is_today": (d_str == today_str)
        })

    total_checkin_days = sum(1 for r in records.values() if isinstance(r, dict) and (r.get("completed") or r.get("count", 0) >= goal))
    total_practice_words = sum(r.get("count", 0) for r in records.values() if isinstance(r, dict))

    return {
        "today_count": today_count,
        "today_reviews": today_rec.get("review_times", today_count),
        "today_new_learned": len(today_rec.get("new_words", [])),
        "goal": goal,
        "daily_goal": goal,
        "streak": streak,
        "history": history,
        "today_completed": today_completed,
        "today_completed_at": today_rec.get("completed_at"),
        "total_checkin_days": total_checkin_days,
        "total_practice_words": total_practice_words,
        "recent_days": history
    }


def is_word_due(w: dict, module: str, now_ts: int, today_str: str) -> bool:
    """Return True if a learned word is currently due for review."""
    stage = w.get("stage", 0)
    has_reviewed = (w.get("review_count", 0) > 0 or stage > 0 or w.get("lapsed", False) or w.get("last_review") is not None)
    if not has_reviewed:
        return False
    next_date = w.get("next_review_date")
    if not next_date:
        next_ts = w.get("next_review", 0)
        if next_ts:
            next_date = datetime.datetime.fromtimestamp(next_ts, tz=config.SHANGHAI_TZ).strftime("%Y-%m-%d")
        else:
            next_date = today_str
    return next_date <= today_str


def compute_module_stats(store: ModuleStore, module: str = "listening") -> dict:
    """Compute stage distribution, due count, sections, error books, and countdowns for a module."""
    words = store.get_words()
    total = len(words)
    max_stages = 7
    stage_counts = {str(i): 0 for i in range(7)}
    now_dt = datetime.datetime.now(config.SHANGHAI_TZ)
    now_ts = int(now_dt.timestamp())
    today_str = now_dt.strftime("%Y-%m-%d")

    due_count = 0
    new_count = 0
    mastered_count = 0
    error_books = []
    section_counts = {}

    for w in words:
        stage = w.get("stage", 0)
        s_key = str(stage)
        stage_counts[s_key] = stage_counts.get(s_key, 0) + 1

        sec = w.get("section") or "Part 1 (生活场景)"
        section_counts[sec] = section_counts.get(sec, 0) + 1

        is_new = (w.get("review_count", 0) == 0 and stage == 0 and not w.get("last_review"))
        if is_new:
            new_count += 1
        elif stage >= 5:
            mastered_count += 1

        if is_word_due(w, module, now_ts, today_str):
            due_count += 1

        if w.get("wrong_count", 0) > 0:
            error_books.append(w)

    error_books.sort(key=lambda x: x.get("wrong_count", 0), reverse=True)

    # Upcoming countdown & samples
    next_due_ts = None
    next_due_in_sec = None
    next_due_count = 0
    next_due_samples = []

    # Listening uses whole-calendar-day intervals rolling over at Asia/Shanghai midnight
    tomorrow_midnight = (now_dt + datetime.timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    upcoming_words = [
        w for w in words
        if (w.get("review_count", 0) > 0 or w.get("stage", 0) > 0)
        and (w.get("next_review_date") or "") > today_str
    ]
    if upcoming_words:
        upcoming_words.sort(key=lambda x: x.get("next_review_date") or "9999-99-99")
        earliest_date_str = upcoming_words[0].get("next_review_date")
        try:
            earliest_dt = datetime.datetime.strptime(earliest_date_str, "%Y-%m-%d").replace(tzinfo=config.SHANGHAI_TZ)
            next_due_ts = int(earliest_dt.timestamp())
            next_due_in_sec = max(0, next_due_ts - now_ts)
        except Exception:
            next_due_ts = int(tomorrow_midnight.timestamp())
            next_due_in_sec = max(0, next_due_ts - now_ts)
        next_due_count = sum(1 for w in upcoming_words if w.get("next_review_date") == earliest_date_str)
        for w in upcoming_words[:8]:
            nd_str = w.get("next_review_date", "")
            try:
                nd_dt = datetime.datetime.strptime(nd_str, "%Y-%m-%d").replace(tzinfo=config.SHANGHAI_TZ)
                sec_left = max(0, int(nd_dt.timestamp()) - now_ts)
            except Exception:
                sec_left = max(0, int(tomorrow_midnight.timestamp()) - now_ts)
            next_due_samples.append({
                "word": w.get("word"),
                "meaning": w.get("meaning") or w.get("glossZh") or "",
                "stage": w.get("stage", 0),
                "next_review_date": nd_str,
                "due_in_sec": sec_left
            })
    listening_intervals = [0] + [d * 86400 for d in config.LISTENING_INTERVALS]
    ebbinghaus_stages = [
        {"stage": i, "interval": listening_intervals[i] if i < len(listening_intervals) else 2592000, "count": stage_counts.get(str(i), 0)}
        for i in range(max_stages)
    ]

    local_ip = get_local_ip()
    return {
        "stage_counts": stage_counts,
        "due_count": due_count,
        "total": total,
        "new_count": new_count,
        "new_words_count": new_count,
        "due_review_count": due_count,
        "mastered_count": mastered_count,
        "learning_count": max(0, total - mastered_count),
        "error_count": len(error_books),
        "top_errors": error_books[:10],
        "sections": section_counts,
        "ebbinghaus_stages": ebbinghaus_stages,
        "next_due_in_sec": next_due_in_sec,
        "next_due_ts": next_due_ts,
        "next_due_count": next_due_count,
        "next_due_samples": next_due_samples,
        "trash_count": len(store.trash),
        "now_ts": now_ts,
        "settings": store.get_settings(),
        "local_ip": local_ip,
        "port": config.DEFAULT_PORT,
        "mobile_url": f"http://{local_ip}:{config.DEFAULT_PORT}"
    }


def filter_module_words(store: ModuleStore, module: str, query: dict) -> dict:
    """Filter words for GET /api/{module}/words with optional section, scope, and cap parameters."""
    section = query.get("section", [None])[0]
    only_due = query.get("only_due", ["false"])[0].lower() == "true"
    only_errors = query.get("only_errors", ["false"])[0].lower() == "true"
    only_new = query.get("only_new", ["false"])[0].lower() == "true"
    only_review = query.get("only_review", ["false"])[0].lower() == "true"
    apply_caps = query.get("apply_caps", ["false"])[0].lower() == "true"
    try:
        limit = int(query.get("limit", [10000])[0])
    except Exception:
        limit = 10000

    now_dt = datetime.datetime.now(config.SHANGHAI_TZ)
    now_ts = int(now_dt.timestamp())
    today_str = now_dt.strftime("%Y-%m-%d")

    all_words = store.get_words()
    # Normalize meaning/section on the fly if missing
    for w in all_words:
        if not w.get("meaning") and w.get("glossZh"):
            w["meaning"] = w["glossZh"]
        if not w.get("section"):
            w["section"] = "Part 1 (生活场景)"

    word_list = list(all_words)
    if section and section != "all":
        word_list = [w for w in word_list if w.get("section") == section]

    settings = store.get_settings()
    review_cap = settings.get("review_cap", 40)
    daily_new_words = settings.get("daily_new_words", 10)

    checkins = store.get_checkins()
    today_rec = checkins.get("records", {}).get(today_str, {})
    already_learned_new = len(today_rec.get("new_words", []))
    remaining_new_quota = max(0, daily_new_words - already_learned_new) if daily_new_words > 0 else 0

    def due_sort_key(w: dict):
        return (w.get("next_review_date") or "0000-00-00", w.get("id", ""))

    if only_new:
        word_list = [
            w for w in word_list
            if w.get("review_count", 0) == 0 and w.get("stage", 0) == 0 and not w.get("last_review")
        ]
        word_list.sort(key=lambda x: (x.get("created_at", 0), x.get("id", "")))
        if apply_caps:
            word_list = word_list[:daily_new_words]
    elif only_review:
        word_list = [
            w for w in word_list
            if (w.get("review_count", 0) > 0 or w.get("stage", 0) > 0 or w.get("last_review") is not None)
        ]
        if only_due:
            word_list = [w for w in word_list if is_word_due(w, module, now_ts, today_str)]
            word_list.sort(key=due_sort_key)
        if apply_caps:
            word_list = word_list[:review_cap]
    elif only_due:
        # "due" scope: due review words (sorted by due_date ascending, capped at review_cap) + new words (up to daily_new_words)
        due_reviews = [w for w in word_list if is_word_due(w, module, now_ts, today_str)]
        due_reviews.sort(key=due_sort_key)
        unlearned = [
            w for w in word_list
            if w.get("review_count", 0) == 0 and w.get("stage", 0) == 0 and not w.get("last_review")
        ]
        unlearned.sort(key=lambda x: (x.get("created_at", 0), x.get("id", "")))
        if apply_caps:
            due_reviews = due_reviews[:review_cap]
            new_quota = remaining_new_quota if remaining_new_quota > 0 else (daily_new_words if not due_reviews else 0)
            if daily_new_words == 0:
                new_quota = 0
            unlearned = unlearned[:new_quota]
        word_list = due_reviews + unlearned

    if only_errors:
        word_list = [w for w in word_list if w.get("wrong_count", 0) > 0]
        word_list.sort(key=lambda x: x.get("wrong_count", 0), reverse=True)

    sliced = word_list[:limit]
    return {
        "words": sliced,
        "total": len(sliced),
        "count": len(word_list),
        "now": now_ts,
        "settings": settings
    }


def add_module_word(store: ModuleStore, module: str, word_data: dict) -> dict | None:
    """Add or update a vocabulary word inside a specific module store."""
    with store.lock:
        word_clean = (word_data.get("word") or "").strip()
        if not word_clean:
            return None
        word_key = word_clean.lower()
        if word_key in store.trash:
            restored = store.trash.pop(word_key)
            restored.pop("deleted_at", None)
            store.words[word_key] = restored
        if word_key in store.words:
            return edit_module_word(store, module, word_key, word_data)

        now_dt = datetime.datetime.now(config.SHANGHAI_TZ)
        now_ts = int(now_dt.timestamp())
        today_str = now_dt.strftime("%Y-%m-%d")
        max_stage = 6
        try:
            stage = int(word_data.get("stage", 0))
            if stage < 0 or stage > max_stage:
                stage = 0
        except Exception:
            stage = 0

        meaning_val = (word_data.get("meaning") or "").strip()
        default_sec = "Part 1 (生活场景)"
        section_val = (word_data.get("section") or default_sec).strip() or default_sec
        tags_raw = word_data.get("tags", [])
        tags = [t.strip() for t in tags_raw.split(",") if t.strip()] if isinstance(tags_raw, str) else list(tags_raw or [])

        entry = {
            "id": word_key,
            "word": word_clean,
            "meaning": meaning_val,
            "glossZh": meaning_val,
            "sentence": (word_data.get("sentence") or "").strip(),
            "tags": tags,
            "section": section_val,
            "source_file": "手动添加 / 词库录入",
            "custom_edited": True,
            "last_edited_at": now_ts,
            "stage": stage,
            "last_review": None,
            "review_count": 0,
            "correct_count": 0,
            "wrong_count": 0,
            "consecutive_correct": 0,
            "lapsed": False,
            "created_at": now_ts,
            "acceptedAnswers": [word_clean]
        }
        if stage == 0:
            entry["next_review_date"] = None
        else:
            days = config.LISTENING_INTERVALS[min(stage - 1, len(config.LISTENING_INTERVALS) - 1)]
            entry["next_review_date"] = (now_dt.date() + datetime.timedelta(days=days)).strftime("%Y-%m-%d")

        store.words[word_key] = entry
        store.save()
        return entry


def edit_module_word(store: ModuleStore, module: str, original_key: str, updated_data: dict) -> dict | None:
    """Update an existing word in a module store and sync active session."""
    with store.lock:
        orig_k = (original_key or "").strip().lower()
        if orig_k not in store.words:
            for k, v in store.words.items():
                if v.get("id", "").lower() == orig_k or v.get("word", "").lower() == orig_k:
                    orig_k = k
                    break
            else:
                return None

        old_entry = store.words[orig_k]
        new_word_str = (updated_data.get("word") or "").strip()
        if not new_word_str:
            new_word_str = old_entry.get("word", orig_k)
        new_key = new_word_str.lower()

        now_dt = datetime.datetime.now(config.SHANGHAI_TZ)
        now_ts = int(now_dt.timestamp())

        old_entry["custom_edited"] = True
        old_entry["last_edited_at"] = now_ts
        old_entry["word"] = new_word_str
        if "meaning" in updated_data:
            m_val = (updated_data.get("meaning") or "").strip()
            old_entry["meaning"] = m_val
            old_entry["glossZh"] = m_val
        if "sentence" in updated_data:
            old_entry["sentence"] = (updated_data.get("sentence") or "").strip()
        if "section" in updated_data and (updated_data.get("section") or "").strip():
            old_entry["section"] = updated_data["section"].strip()

        if "stage" in updated_data:
            try:
                new_stage = int(updated_data["stage"])
                old_stage = old_entry.get("stage", 0)
                max_stage = 6
                if 0 <= new_stage <= max_stage and new_stage != old_stage:
                    old_entry["stage"] = new_stage
                    old_entry["lapsed"] = False
                    if new_stage == 0:
                        old_entry["next_review_date"] = now_dt.strftime("%Y-%m-%d")
                    else:
                        days = config.LISTENING_INTERVALS[min(new_stage - 1, len(config.LISTENING_INTERVALS) - 1)]
                        old_entry["next_review_date"] = (now_dt.date() + datetime.timedelta(days=days)).strftime("%Y-%m-%d")
            except Exception:
                pass

        if new_key != orig_k:
            old_entry["id"] = new_key
            if "original_source_word" not in old_entry:
                old_entry["original_source_word"] = orig_k
            del store.words[orig_k]
            store.words[new_key] = old_entry

        if isinstance(store.active_session, dict) and isinstance(store.active_session.get("queue"), list):
            for q_item in store.active_session["queue"]:
                if isinstance(q_item, dict):
                    qk = (q_item.get("id", "") or q_item.get("word", "")).strip().lower()
                    if qk in (orig_k, new_key):
                        for sync_field in ("id", "word", "meaning", "glossZh", "sentence", "section", "tags", "stage", "next_review", "next_review_date", "custom_edited"):
                            if sync_field in old_entry:
                                q_item[sync_field] = old_entry[sync_field]

        store.save()
        return old_entry


def delete_module_words(store: ModuleStore, word_keys) -> tuple[bool, int]:
    """Move one or more words to the module's trash bin."""
    with store.lock:
        if isinstance(word_keys, str):
            keys_list = [word_keys]
        else:
            keys_list = list(word_keys) if word_keys else []
        now_ts = int(time.time())
        deleted_count = 0
        deleted_keys_set = set()
        for raw_k in keys_list:
            target_key = (raw_k or "").strip().lower()
            if not target_key:
                continue
            found_k = None
            if target_key in store.words:
                found_k = target_key
            else:
                for k, v in store.words.items():
                    if v.get("id", "").lower() == target_key or v.get("word", "").lower() == target_key:
                        found_k = k
                        break
            if found_k:
                entry = store.words.pop(found_k)
                entry["deleted_at"] = now_ts
                store.trash[found_k] = entry
                deleted_keys_set.add(found_k)
                deleted_count += 1
        if deleted_count > 0:
            if isinstance(store.active_session, dict) and isinstance(store.active_session.get("queue"), list):
                old_queue = store.active_session["queue"]
                old_idx = store.active_session.get("currentIndex", 0)
                new_queue = []
                removed_before = 0
                for idx_q, q_item in enumerate(old_queue):
                    qk = (q_item.get("id", "") or q_item.get("word", "")).strip().lower() if isinstance(q_item, dict) else ""
                    if qk in deleted_keys_set:
                        if idx_q < old_idx:
                            removed_before += 1
                    else:
                        new_queue.append(q_item)
                new_idx = max(0, old_idx - removed_before)
                if not new_queue or new_idx >= len(new_queue):
                    store.active_session = None
                else:
                    store.active_session["queue"] = new_queue
                    store.active_session["currentIndex"] = new_idx
            store.save()
            return True, deleted_count
        return False, 0


def restore_module_trash(store: ModuleStore, word_keys=None) -> tuple[bool, int]:
    """Restore words from module trash back to active vocabulary."""
    with store.lock:
        restored_count = 0
        if word_keys is None:
            keys_list = list(store.trash.keys())
        elif isinstance(word_keys, str):
            keys_list = [word_keys]
        else:
            keys_list = list(word_keys)
        for raw_k in keys_list:
            target_key = (raw_k or "").strip().lower()
            if not target_key:
                continue
            found_k = None
            if target_key in store.trash:
                found_k = target_key
            else:
                for k, v in store.trash.items():
                    if v.get("id", "").lower() == target_key or v.get("word", "").lower() == target_key:
                        found_k = k
                        break
            if found_k:
                entry = store.trash.pop(found_k)
                entry.pop("deleted_at", None)
                store.words[found_k] = entry
                restored_count += 1
        if restored_count > 0:
            store.save()
            return True, restored_count
        return False, 0


def clear_module_trash(store: ModuleStore, word_keys=None) -> tuple[bool, int]:
    """Permanently purge words from module trash."""
    with store.lock:
        purged_count = 0
        if word_keys is None:
            purged_count = len(store.trash)
            store.trash = {}
        else:
            keys_list = [word_keys] if isinstance(word_keys, str) else list(word_keys)
            for raw_k in keys_list:
                target_key = (raw_k or "").strip().lower()
                if not target_key:
                    continue
                found_k = None
                if target_key in store.trash:
                    found_k = target_key
                else:
                    for k, v in store.trash.items():
                        if v.get("id", "").lower() == target_key or v.get("word", "").lower() == target_key:
                            found_k = k
                            break
                if found_k:
                    del store.trash[found_k]
                    purged_count += 1
        if purged_count > 0:
            store.save()
            return True, purged_count
        return False, 0


class DictationHandler(SimpleHTTPRequestHandler):
    """HTTP Request Handler for IELTS_Dictation_v2 REST API and static assets."""

    listening_store = listening_store
    spelling_judge = spelling_judge

    def log_message(self, format, *args):
        """Suppress standard HTTP server console logging during unit test runs."""
        if "unittest" in sys.modules or os.environ.get("NO_HTTP_LOG"):
            return
        super().log_message(format, *args)

    @classmethod
    def get_store(cls, module: str) -> ModuleStore | None:
        """Return module store corresponding to module name."""
        mod = (module or "").strip().lower()
        if mod == "listening":
            return cls.listening_store
        elif mod == "writing":
            return None
        return None

    def send_json(self, status_code: int, data: dict):
        """Send JSON response with UTF-8 encoding and CORS headers."""
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        """Handle CORS pre-flight requests."""
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def do_GET(self):
        """Handle HTTP GET requests for API routes and static assets."""
        parsed = urllib.parse.urlparse(self.path)
        url_path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # 1. Root / index.html serving
        if url_path in ["/", "/index.html"]:
            index_path = os.path.join(config.STATIC_DIR, "index.html")
            if os.path.exists(index_path) and os.path.isfile(index_path):
                with open(index_path, "rb") as f:
                    content = f.read()
            else:
                content = (
                    b"<!DOCTYPE html>\n"
                    b"<html><head><meta charset='utf-8'><title>IELTS Dictation v2</title></head>\n"
                    b"<body>\n"
                    b"<div id='tab-listening'></div>\n"
                    b"</body></html>"
                )
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.end_headers()
            self.wfile.write(content)
            return

        # 2. Network status endpoint
        if url_path == "/api/network":
            local_ip = get_local_ip()
            port = config.DEFAULT_PORT
            self.send_json(200, {
                "local_ip": local_ip,
                "port": port,
                "mobile_url": f"http://{local_ip}:{port}"
            })
            return

        # 3. REST API routing: /api/{module}/{resource}
        parts = url_path.strip("/").split("/")
        if len(parts) >= 3 and parts[0] == "api":
            module = parts[1].lower()
            resource = parts[2].lower()

            store = self.get_store(module)
            if store is not None:
                if resource == "words":
                    result = filter_module_words(store, module, query)
                    self.send_json(200, result)
                    return

                elif resource == "stats":
                    stats_data = compute_module_stats(store, module)
                    self.send_json(200, stats_data)
                    return

                elif resource == "checkin":
                    checkin_data = compute_checkin_stats(store.get_checkins())
                    self.send_json(200, checkin_data)
                    return

                elif resource == "session":
                    self.send_json(200, {
                        "ok": True,
                        "success": True,
                        "session": store.active_session,
                        "cleared_at": store.meta.get("last_session_cleared_at", 0)
                    })
                    return

                elif resource == "settings":
                    settings = store.get_settings()
                    self.send_json(200, {
                        "review_cap": settings.get("review_cap", 40),
                        "daily_new_words": settings.get("daily_new_words", 10)
                    })
                    return

                elif resource == "trash":
                    trash_list = list(store.trash.values())
                    trash_list.sort(key=lambda x: x.get("deleted_at", 0), reverse=True)
                    self.send_json(200, {
                        "ok": True,
                        "success": True,
                        "count": len(trash_list),
                        "words": trash_list
                    })
                    return

                elif resource == "scan":
                    from scripts.import_listening import import_listening_vocabulary
                    ok, msg = import_listening_vocabulary(target_path=store.data_file, default_settings=store.get_settings())
                    store.load()
                    self.send_json(200, {
                        "ok": ok,
                        "success": ok,
                        "message": msg,
                        "result": {
                            "newly_scanned_files": ["9fnnn_listening_vocabulary.json"] if ok else [],
                            "skipped_files_count": 0,
                            "new_count": 0,
                            "total_words": len(store.words)
                        }
                    })
                    return

        # 4. If path starts with /api/ but did not match valid endpoint -> 404 JSON
        if url_path.startswith("/api/"):
            self.send_json(404, {"error": "Not Found"})
            return

        # 5. Static asset serving with traversal defense
        unquoted = urllib.parse.unquote(url_path)
        if unquoted.startswith("/static/"):
            rel_path = unquoted[len("/static/"):]
        else:
            rel_path = unquoted.lstrip("/")

        static_root = os.path.abspath(config.STATIC_DIR)
        full_path = os.path.abspath(os.path.join(static_root, rel_path))

        # Check path traversal attack
        if not full_path.startswith(static_root + os.sep) and full_path != static_root:
            self.send_json(404, {"error": "Forbidden or Not Found"})
            return

        if os.path.exists(full_path) and os.path.isfile(full_path):
            content_type, _ = mimetypes.guess_type(full_path)
            if not content_type:
                if full_path.endswith(".mp3"):
                    content_type = "audio/mpeg"
                elif full_path.endswith(".js"):
                    content_type = "application/javascript; charset=utf-8"
                elif full_path.endswith(".css"):
                    content_type = "text/css; charset=utf-8"
                elif full_path.endswith(".html"):
                    content_type = "text/html; charset=utf-8"
                else:
                    content_type = "application/octet-stream"
            elif content_type == "text/html":
                content_type = "text/html; charset=utf-8"
            elif content_type == "text/css":
                content_type = "text/css; charset=utf-8"
            elif content_type in ["application/javascript", "text/javascript"]:
                content_type = "application/javascript; charset=utf-8"

            with open(full_path, "rb") as f:
                content = f.read()

            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(content)
            return

        # Missing static resource or unknown route
        self.send_json(404, {"error": "File Not Found"})

    def do_POST(self):
        """Handle HTTP POST requests for settings, reviews, word CRUD, trash, check-ins, and sessions."""
        parsed = urllib.parse.urlparse(self.path)
        url_path = parsed.path

        content_length = int(self.headers.get("Content-Length", 0))
        body_bytes = self.rfile.read(content_length) if content_length > 0 else b"{}"

        try:
            payload = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
        except Exception:
            self.send_json(400, {"error": "Malformed JSON payload"})
            return

        # 1. Spelling judge endpoint
        if url_path == "/api/judge":
            user_input = payload.get("user_input", "")
            target_word = payload.get("target_word", "")
            accepted = payload.get("accepted_answers", [])
            is_correct, reason = self.spelling_judge.judge(user_input, target_word, accepted)
            self.send_json(200, {"ok": is_correct, "reason": reason})
            return

        # 2. REST API routing: /api/{module}/{resource}
        parts = url_path.strip("/").split("/")
        if len(parts) >= 3 and parts[0] == "api":
            module = parts[1].lower()
            resource = parts[2].lower()
            subresource = parts[3].lower() if len(parts) >= 4 else None

            store = self.get_store(module)
            if store is not None:
                # POST /api/{module}/settings
                if resource == "settings":
                    review_cap = payload.get("review_cap")
                    daily_new_words = payload.get("daily_new_words")

                    if review_cap is None:
                        self.send_json(400, {"error": "review_cap is required"})
                        return
                    if isinstance(review_cap, bool) or not isinstance(review_cap, int) or review_cap < 1:
                        self.send_json(400, {"error": "review_cap must be an integer >= 1"})
                        return

                    if daily_new_words is None:
                        self.send_json(400, {"error": "daily_new_words is required"})
                        return
                    if isinstance(daily_new_words, bool) or not isinstance(daily_new_words, int) or daily_new_words < 0:
                        self.send_json(400, {"error": "daily_new_words must be an integer >= 0"})
                        return

                    ok, updated_settings = store.update_settings({
                        "review_cap": review_cap,
                        "daily_new_words": daily_new_words
                    })
                    if not ok:
                        self.send_json(400, {"error": str(updated_settings)})
                        return

                    self.send_json(200, {
                        "ok": True,
                        "success": True,
                        "settings": updated_settings
                    })
                    return

                # POST /api/{module}/session/start
                elif resource == "session" and subresource == "start":
                    session_data = generate_session(store, module)
                    queue = session_data.get("queue", [])
                    store.active_session = {
                        "queue": queue,
                        "currentIndex": 0,
                        "total": len(queue),
                        "started_at": int(time.time())
                    }
                    store.save()
                    self.send_json(200, {
                        "queue": queue,
                        "total": len(queue),
                        "ok": True,
                        "success": True
                    })
                    return

                # POST /api/{module}/session or /api/{module}/session/save
                elif resource == "session" and subresource in (None, "save"):
                    if isinstance(payload, dict):
                        with store.lock:
                            if subresource is None and isinstance(payload.get("queue"), list):
                                if len(payload["queue"]) > 0 and payload.get("currentIndex", 0) < len(payload["queue"]):
                                    updated_at = payload.get("updatedAt", 0)
                                    cleared_at = store.meta.get("last_session_cleared_at", 0)
                                    if not cleared_at or updated_at >= cleared_at:
                                        store.active_session = payload
                                        store.save()
                            else:
                                if isinstance(store.active_session, dict):
                                    store.active_session.update(payload)
                                else:
                                    store.active_session = payload
                                store.save()
                    self.send_json(200, {"ok": True, "success": True})
                    return

                # POST /api/{module}/session/clear
                elif resource == "session" and subresource == "clear":
                    with store.lock:
                        store.active_session = None
                        store.meta["last_session_cleared_at"] = int(time.time() * 1000)
                        store.save()
                    self.send_json(200, {"ok": True, "success": True})
                    return

                # POST /api/{module}/checkin/goal
                elif resource == "checkin" and subresource == "goal":
                    with store.lock:
                        try:
                            goal = int(payload.get("goal", 20))
                            if goal < 1:
                                goal = 1
                        except Exception:
                            goal = 20
                        checkins = store.get_checkins()
                        checkins["daily_goal"] = goal
                        today_str = datetime.datetime.now(config.SHANGHAI_TZ).strftime("%Y-%m-%d")
                        records = checkins.setdefault("records", {})
                        if today_str in records:
                            rec = records[today_str]
                            if rec.get("count", 0) >= goal and not rec.get("completed"):
                                rec["completed"] = True
                                rec["completed_at"] = int(time.time())
                        store.save()
                        res = compute_checkin_stats(checkins)
                    self.send_json(200, {"ok": True, "success": True, "checkin": res})
                    return

                # POST /api/{module}/checkin/manual
                elif resource == "checkin" and subresource == "manual":
                    with store.lock:
                        completed = bool(payload.get("completed", True))
                        now_dt = datetime.datetime.now(config.SHANGHAI_TZ)
                        date_str = payload.get("date") or now_dt.strftime("%Y-%m-%d")
                        now_ts = int(now_dt.timestamp())
                        checkins = store.get_checkins()
                        goal = checkins.get("daily_goal", 20)
                        records = checkins.setdefault("records", {})
                        if date_str not in records:
                            records[date_str] = {
                                "date": date_str,
                                "count": goal if completed else 0,
                                "completed_words": [],
                                "review_times": 0,
                                "correct_count": 0,
                                "wrong_count": 0,
                                "completed": completed,
                                "completed_at": now_ts if completed else None,
                                "new_words": []
                            }
                        else:
                            rec = records[date_str]
                            rec["completed"] = completed
                            if completed:
                                if not rec.get("completed_at"):
                                    rec["completed_at"] = now_ts
                                if rec.get("count", 0) < goal:
                                    rec["count"] = goal
                            else:
                                rec["completed_at"] = None
                                rec["count"] = len(rec.get("completed_words", []))
                        store.save()
                        res = compute_checkin_stats(checkins)
                    self.send_json(200, {"ok": True, "success": True, "checkin": res})
                    return

                # POST /api/{module}/word/add
                elif resource == "word" and subresource == "add":
                    added = add_module_word(store, module, payload)
                    if added:
                        self.send_json(200, {"ok": True, "success": True, "word": added})
                    else:
                        self.send_json(400, {"error": "invalid word data"})
                    return

                # POST /api/{module}/word/update
                elif resource == "word" and subresource == "update":
                    orig = payload.get("original_word") or payload.get("id") or payload.get("word")
                    updated = edit_module_word(store, module, orig, payload)
                    if updated:
                        self.send_json(200, {"ok": True, "success": True, "word": updated})
                    else:
                        self.send_json(404, {"error": "word not found"})
                    return

                # POST /api/{module}/word/delete
                elif resource == "word" and subresource == "delete":
                    targets = payload.get("words") or payload.get("word") or payload.get("id")
                    ok, count = delete_module_words(store, targets)
                    if ok:
                        self.send_json(200, {"ok": True, "success": True, "deleted_count": count, "trash_count": len(store.trash)})
                    else:
                        self.send_json(404, {"error": "word not found"})
                    return

                # POST /api/{module}/trash/restore
                elif resource == "trash" and subresource == "restore":
                    targets = payload.get("words") or payload.get("word") or payload.get("id")
                    all_flag = bool(payload.get("all", False))
                    ok, count = restore_module_trash(store, None if all_flag else targets)
                    self.send_json(200, {"ok": ok, "success": ok, "restored_count": count, "trash_count": len(store.trash)})
                    return

                # POST /api/{module}/trash/clear
                elif resource == "trash" and subresource == "clear":
                    targets = payload.get("words") or payload.get("word") or payload.get("id")
                    all_flag = bool(payload.get("all", False))
                    ok, count = clear_module_trash(store, None if all_flag else targets)
                    self.send_json(200, {"ok": ok, "success": ok, "cleared_count": count, "trash_count": len(store.trash)})
                    return

                # POST /api/{module}/scan
                elif resource == "scan":
                    from scripts.import_listening import import_listening_vocabulary
                    ok, msg = import_listening_vocabulary(target_path=store.data_file, default_settings=store.get_settings())
                    store.load()
                    self.send_json(200, {
                        "ok": ok,
                        "success": ok,
                        "message": msg,
                        "result": {
                            "newly_scanned_files": ["9fnnn_listening_vocabulary.json"] if ok else [],
                            "skipped_files_count": 0,
                            "new_count": 0,
                            "total_words": len(store.words)
                        }
                    })
                    return

                # POST /api/{module}/review
                elif resource == "review":
                    word_key = payload.get("word")
                    if not word_key or not isinstance(word_key, str):
                        self.send_json(400, {"error": "Missing or invalid 'word' parameter"})
                        return

                    correct = bool(payload.get("correct"))
                    practice = bool(payload.get("practice", False))
                    retry_pass = bool(payload.get("retry_pass", False))

                    with store.lock:
                        w = store.get_word(word_key)
                        if not w:
                            clean_k = word_key.strip().lower()
                            for cand in store.words.values():
                                if cand.get("id", "").strip().lower() == clean_k or cand.get("word", "").strip().lower() == clean_k:
                                    w = cand
                                    break
                        if not w:
                            w = {
                                "id": word_key,
                                "word": word_key,
                                "stage": 0,
                                "review_count": 0,
                                "correct_count": 0,
                                "wrong_count": 0,
                                "consecutive_correct": 0
                            }
                            store.words[word_key] = w

                        today_str = datetime.datetime.now(config.SHANGHAI_TZ).strftime("%Y-%m-%d")
                        checkins = store.get_checkins()
                        records = checkins.setdefault("records", {})
                        if today_str not in records:
                            records[today_str] = {
                                "date": today_str,
                                "count": 0,
                                "completed_words": [],
                                "review_times": 0,
                                "correct_count": 0,
                                "wrong_count": 0,
                                "completed": False,
                                "completed_at": None,
                                "new_words": []
                            }
                        today_rec = records[today_str]

                        just_completed = False
                        if practice:
                            today_rec["review_times"] = today_rec.get("review_times", 0) + 1
                            if correct:
                                today_rec["correct_count"] = today_rec.get("correct_count", 0) + 1
                            else:
                                today_rec["wrong_count"] = today_rec.get("wrong_count", 0) + 1
                            store.save()
                            checkin_stats = compute_checkin_stats(checkins)
                        else:
                            completed_today_stage = apply_listening_review(w, is_correct=correct)

                            today_rec["review_times"] = today_rec.get("review_times", 0) + 1
                            if correct:
                                today_rec["correct_count"] = today_rec.get("correct_count", 0) + 1
                            else:
                                today_rec["wrong_count"] = today_rec.get("wrong_count", 0) + 1

                            new_words_list = today_rec.setdefault("new_words", [])
                            if w.get("review_count", 0) == 1 and w["id"] not in new_words_list:
                                new_words_list.append(w["id"])
                                today_rec["new_words_learned"] = len(new_words_list)

                            completed_words = today_rec.setdefault("completed_words", [])
                            if completed_today_stage and w["id"] not in completed_words:
                                completed_words.append(w["id"])
                                today_rec["count"] = len(completed_words)

                            goal = checkins.get("daily_goal", 20)
                            if today_rec["count"] >= goal and not today_rec.get("completed"):
                                today_rec["completed"] = True
                                today_rec["completed_at"] = int(time.time())
                                just_completed = True

                            if isinstance(store.active_session, dict) and isinstance(store.active_session.get("queue"), list):
                                for q_item in store.active_session["queue"]:
                                    if isinstance(q_item, dict) and (q_item.get("id") == w["id"] or q_item.get("word") == w.get("word")):
                                        for k in ("stage", "next_review", "last_review", "review_count", "correct_count", "wrong_count", "consecutive_correct", "lapsed", "next_review_date"):
                                            if k in w:
                                                q_item[k] = w[k]

                            store.save()
                            checkin_stats = compute_checkin_stats(checkins)

                    self.send_json(200, {
                        "ok": True,
                        "success": True,
                        "word": w,
                        "just_completed": just_completed,
                        "checkin": checkin_stats
                    })
                    return

        self.send_json(404, {"error": "Not Found"})


def run_server(port: int = config.DEFAULT_PORT, host: str = config.DEFAULT_HOST):
    """Start HTTP Threading server on specified host and port."""
    os.makedirs(config.STATIC_DIR, exist_ok=True)
    os.makedirs(config.AUDIO_DIR, exist_ok=True)
    os.makedirs(config.DATA_DIR, exist_ok=True)
    os.makedirs(config.LOGS_DIR, exist_ok=True)

    # 1. Startup capital letter scan for listening vocabulary confirmation
    listening_words = listening_store.get_words()
    capital_candidates = scan_case_sensitive_candidates(listening_words)
    print("=" * 75, flush=True)
    print(f"[*] Startup Scan: {len(capital_candidates)} case-sensitive vocabulary entries identified:", flush=True)
    for cand in capital_candidates:
        print(f"    - {cand}", flush=True)
    print("=" * 75, flush=True)

    # 2. Port restart cleanup support
    if "--restart" in sys.argv or "-r" in sys.argv:
        try:
            my_pid = str(os.getpid())
            out = subprocess.check_output(f"lsof -ti :{port}", shell=True).decode().strip()
            if out:
                for pid in out.split():
                    if pid != my_pid:
                        os.system(f"kill -9 {pid} 2>/dev/null")
                time.sleep(0.5)
                print(f"[*] Terminated existing processes on port {port}.", flush=True)
        except Exception:
            pass

    server_address = (host, port)
    ThreadingHTTPServer.allow_reuse_address = True

    try:
        httpd = ThreadingHTTPServer(server_address, DictationHandler)
    except OSError as e:
        local_ip = get_local_ip()
        if e.errno == 48:
            print("=" * 75, flush=True)
            print(f"⚠️  Port {port} is currently occupied.", flush=True)
            print(f"👉 Local Access : http://127.0.0.1:{port}", flush=True)
            print(f"👉 LAN Access   : http://{local_ip}:{port}", flush=True)
            print(f"💡 To force restart: python3 server.py --restart", flush=True)
            print("=" * 75, flush=True)
            return
        raise e

    local_ip = get_local_ip()
    print("=" * 75, flush=True)
    print(f" IELTS_Dictation_v2 Server Started Successfully!", flush=True)
    print(f" Dedicated Standalone Listening Dictation Application", flush=True)
    print(f" Local Web Access : http://127.0.0.1:{port}", flush=True)
    print(f" LAN Mobile Sync  : http://{local_ip}:{port}", flush=True)
    print(f" Listening Store  : {len(listening_words)} words (Asia/Shanghai midnight calendar review)", flush=True)
    print(f" Data Isolation   : Strict independent JSON store & atomic persistence enabled", flush=True)
    print("=" * 75, flush=True)

    def handle_shutdown(signum, frame):
        print("\n[Server shutting down...]", flush=True)
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, handle_shutdown)
    signal.signal(signal.SIGTERM, handle_shutdown)

    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()


if __name__ == "__main__":
    run_server()
