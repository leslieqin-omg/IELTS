#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
IELTS Dictation Server (雅思单词中英默写 & 艾宾浩斯记忆系统)
- 零第三方依赖 (纯 Python 3 标准库)
- 自动递归扫描 section_* 目录下的 Excel (.xlsx) 与 CSV 文件
- 艾宾浩斯遗忘曲线多阶梯记忆复习调度 (Stage 0 ~ Stage 8)
- 电脑端与手机端同一局域网实时同步 (绑定 0.0.0.0:8765)
"""

import os
import sys
import re
import subprocess
import glob
import json
import time
import datetime
import socket
import zipfile
import urllib.parse
import socketserver
from http.server import HTTPServer, SimpleHTTPRequestHandler
import xml.etree.ElementTree as ET

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)
DATA_DIR = os.path.join(BASE_DIR, "data")
DATA_FILE = os.path.join(DATA_DIR, "words.json")
STATIC_DIR = os.path.join(BASE_DIR, "static")

PORT = 8765

# 艾宾浩斯复习间隔（秒）：
# Stage 0: 5分钟 (300s)
# Stage 1: 30分钟 (1800s)
# Stage 2: 12小时 (43200s)
# Stage 3: 1天 (86400s)
# Stage 4: 2天 (172800s)
# Stage 5: 4天 (345600s)
# Stage 6: 7天 (604800s)
# Stage 7: 15天 (1296000s)
# Stage 8: 30天 (完全掌握)
EBBINGHAUS_INTERVALS = [
    300,        # Stage 0 -> Stage 1 (5 mins)
    1800,       # Stage 1 -> Stage 2 (30 mins)
    43200,      # Stage 2 -> Stage 3 (12 hours)
    86400,      # Stage 3 -> Stage 4 (1 day)
    172800,     # Stage 4 -> Stage 5 (2 days)
    345600,     # Stage 5 -> Stage 6 (4 days)
    604800,     # Stage 6 -> Stage 7 (7 days)
    1296000,    # Stage 7 -> Stage 8 (15 days)
    2592000     # Stage 8+ (30 days)
]

def get_local_ip():
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

def parse_xlsx_file(filepath):
    items = []
    try:
        with zipfile.ZipFile(filepath, 'r') as z:
            namelist = z.namelist()
            shared_strings = []
            if 'xl/sharedStrings.xml' in namelist:
                tree = ET.fromstring(z.read('xl/sharedStrings.xml'))
                for si in tree.findall('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}si'):
                    text = "".join(t.text for t in si.iter('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t') if t.text)
                    shared_strings.append(text)

            sheet_xml_path = 'xl/worksheets/sheet1.xml'
            if sheet_xml_path not in namelist:
                sheets = [n for n in namelist if n.startswith('xl/worksheets/sheet')]
                if sheets:
                    sheet_xml_path = sheets[0]
                else:
                    return items

            sheet_tree = ET.fromstring(z.read(sheet_xml_path))
            rows = sheet_tree.findall('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}sheetData/{http://schemas.openxmlformats.org/spreadsheetml/2006/main}row')
            
            for row_idx, r in enumerate(rows):
                row_data = {}
                for c in r.findall('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c'):
                    r_coord = c.get('r')
                    if not r_coord:
                        continue
                    col_letter = "".join(ch for ch in r_coord if ch.isalpha())
                    t = c.get('t')
                    val = ""
                    if t == 's':
                        v = c.find('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}v')
                        if v is not None and v.text and v.text.isdigit():
                            idx = int(v.text)
                            if idx < len(shared_strings):
                                val = shared_strings[idx]
                    elif t == 'inlineStr':
                        is_el = c.find('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}is')
                        if is_el is not None:
                            val = "".join(t_el.text for t_el in is_el.iter('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t') if t_el.text)
                    else:
                        v = c.find('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}v')
                        if v is not None and v.text:
                            val = v.text
                    row_data[col_letter] = val.strip()

                word = row_data.get('A', '')
                if not word or word == '单词' or row_idx == 0:
                    continue

                meaning = row_data.get('B', '')
                sentence = row_data.get('C', '')
                tags = row_data.get('D', '')

                items.append({
                    "word": word,
                    "meaning": meaning,
                    "sentence": sentence,
                    "tags": [t.strip() for t in tags.split(',') if t.strip()] if tags else []
                })
    except Exception as e:
        print(f"[Error parsing xlsx {filepath}]: {e}", file=sys.stderr)
    return items

class WordDatabase:
    def __init__(self, data_file=DATA_FILE):
        self.data_file = data_file
        os.makedirs(os.path.dirname(self.data_file), exist_ok=True)
        self.words = {}
        self.trash = {}
        self.active_session = None
        self.meta = {
            "last_scan_time": None,
            "scanned_files": {}
        }
        self.checkins = {
            "daily_goal": 20,
            "records": {}
        }
        self.load()

    def load(self):
        if os.path.exists(self.data_file):
            try:
                with open(self.data_file, 'r', encoding='utf-8') as f:
                    content = json.load(f)
                    loaded_words = content.get("words", {})
                    if isinstance(loaded_words, list):
                        self.words = {}
                        for item in loaded_words:
                            w = item.get("word", "").strip().lower()
                            if w:
                                self.words[w] = item
                    elif isinstance(loaded_words, dict):
                        self.words = loaded_words
                    else:
                        self.words = {}
                    self.meta = content.get("meta", self.meta)
                    self.active_session = content.get("active_session", None)
                    self.trash = content.get("trash", {})
                    if not isinstance(self.trash, dict):
                        self.trash = {}
                    self.checkins = content.get("checkins", {
                        "daily_goal": 20,
                        "records": {}
                    })
                    if "records" not in self.checkins:
                        self.checkins["records"] = {}
                    if "daily_goal" not in self.checkins:
                        self.checkins["daily_goal"] = 20
                    today_key = datetime.datetime.now().strftime("%Y-%m-%d")
                    records = self.checkins.get("records", {})
                    if today_key in records:
                        t_rec = records[today_key]
                        if "completed_words" not in t_rec:
                            c_words = []
                            for k, w_item in self.words.items():
                                l_rev = w_item.get("last_review")
                                if l_rev and w_item.get("stage", 0) >= 3:
                                    if datetime.datetime.fromtimestamp(l_rev).strftime("%Y-%m-%d") == today_key:
                                        c_words.append(k)
                            t_rec["completed_words"] = c_words
                            t_rec["review_times"] = t_rec.get("count", 0)
                            t_rec["count"] = len(c_words)
                            t_rec["completed"] = (len(c_words) >= self.checkins.get("daily_goal", 20))
                    for k, w_item in self.words.items():
                        if w_item.get("source_file") == "手动添加 / 词库录入":
                            w_item.setdefault("custom_edited", True)
            except Exception as e:
                print(f"[Error loading db]: {e}", file=sys.stderr)
                self.words = {}
        else:
            self.words = {}

    def save(self):
        with open(self.data_file, 'w', encoding='utf-8') as f:
            json.dump({
                "words": self.words,
                "trash": self.trash,
                "active_session": self.active_session,
                "meta": self.meta,
                "checkins": self.checkins
            }, f, ensure_ascii=False, indent=2)

    def scan_sections(self, force=False):
        pattern = os.path.join(PROJECT_ROOT, "section_*", "*.xlsx")
        found_files = glob.glob(pattern)
        root_xlsx = glob.glob(os.path.join(PROJECT_ROOT, "*.xlsx"))
        all_files = sorted(list(set(found_files + root_xlsx)))

        new_count = 0
        updated_count = 0
        protected_custom_count = 0
        skipped_files_count = 0
        newly_scanned_files = []
        now_ts = int(time.time())
        scanned_records = self.meta.setdefault("scanned_files", {})

        for fpath in all_files:
            rel_path = os.path.relpath(fpath, PROJECT_ROOT)
            if not force and rel_path in scanned_records:
                skipped_files_count += 1
                continue
            mtime = os.path.getmtime(fpath)
            parts = rel_path.split(os.sep)
            section_name = parts[0] if len(parts) > 1 else "Root"

            items = parse_xlsx_file(fpath)
            for item in items:
                word_clean = item["word"].strip()
                if not word_clean:
                    continue
                word_key = word_clean.lower()
                if word_key in self.trash:
                    continue

                existing_entry = self.words.get(word_key)
                if not existing_entry:
                    for k, v in self.words.items():
                        orig_src = v.get("original_source_word", "").strip().lower()
                        if orig_src and orig_src == word_key:
                            existing_entry = v
                            break

                if existing_entry:
                    if existing_entry.get("custom_edited"):
                        protected_custom_count += 1
                        continue
                    if not existing_entry.get("meaning") and item["meaning"]:
                        existing_entry["meaning"] = item["meaning"]
                    if not existing_entry.get("sentence") and item["sentence"]:
                        existing_entry["sentence"] = item["sentence"]
                    if "tags" not in existing_entry:
                        existing_entry["tags"] = []
                    for t in item["tags"]:
                        if t not in existing_entry["tags"]:
                            existing_entry["tags"].append(t)
                    if not existing_entry.get("section") or existing_entry.get("section") == "自定义生词":
                        existing_entry["section"] = section_name
                    existing_entry["source_file"] = rel_path
                    updated_count += 1
                else:
                    self.words[word_key] = {
                        "id": word_key,
                        "word": word_clean,
                        "meaning": item["meaning"],
                        "sentence": item["sentence"],
                        "tags": item["tags"],
                        "section": section_name,
                        "source_file": rel_path,
                        "stage": 0,
                        "next_review": now_ts,
                        "last_review": None,
                        "review_count": 0,
                        "correct_count": 0,
                        "wrong_count": 0,
                        "consecutive_correct": 0,
                        "created_at": now_ts
                    }
                    new_count += 1

            self.meta["scanned_files"][rel_path] = {
                "mtime": mtime,
                "count": len(items),
                "last_scanned": now_ts
            }
            newly_scanned_files.append(rel_path)

        self.meta["last_scan_time"] = now_ts
        self.save()
        return {
            "found_files": [os.path.relpath(p, PROJECT_ROOT) for p in all_files],
            "newly_scanned_files": newly_scanned_files,
            "skipped_files_count": skipped_files_count,
            "new_count": new_count,
            "updated_count": updated_count,
            "protected_custom_count": protected_custom_count,
            "total_words": len(self.words)
        }


    def get_today_key(self):
        return datetime.datetime.now().strftime("%Y-%m-%d")

    def record_practice_checkin(self, word_key, is_correct=True, completed_today_stage=False):
        today = self.get_today_key()
        records = self.checkins.setdefault("records", {})
        if today not in records:
            records[today] = {
                "count": 0,
                "completed_words": [],
                "review_times": 0,
                "correct_count": 0,
                "wrong_count": 0,
                "completed": False,
                "completed_at": None,
                "date": today
            }
        rec = records[today]
        rec["review_times"] = rec.get("review_times", 0) + 1
        if is_correct:
            rec["correct_count"] = rec.get("correct_count", 0) + 1
        else:
            rec["wrong_count"] = rec.get("wrong_count", 0) + 1

        completed_words = rec.setdefault("completed_words", [])
        if completed_today_stage and word_key not in completed_words:
            completed_words.append(word_key)
            rec["count"] = len(completed_words)

        goal = self.checkins.get("daily_goal", 20)
        just_completed = False
        if rec["count"] >= goal and not rec.get("completed"):
            rec["completed"] = True
            rec["completed_at"] = int(time.time())
            just_completed = True
        return rec, just_completed

    def set_daily_goal(self, goal):
        try:
            goal = int(goal)
            if goal < 1:
                goal = 1
        except Exception:
            goal = 20
        self.checkins["daily_goal"] = goal
        today = self.get_today_key()
        records = self.checkins.setdefault("records", {})
        if today in records:
            rec = records[today]
            if rec["count"] >= goal and not rec.get("completed"):
                rec["completed"] = True
                rec["completed_at"] = int(time.time())
        self.save()
        return self.get_checkin_stats()

    def manual_checkin(self, completed=True, date_str=None):
        if not date_str:
            date_str = self.get_today_key()
        records = self.checkins.setdefault("records", {})
        now_ts = int(time.time())
        goal = self.checkins.get("daily_goal", 20)
        if date_str not in records:
            records[date_str] = {
                "count": goal if completed else 0,
                "completed_words": [],
                "review_times": 0,
                "correct_count": 0,
                "wrong_count": 0,
                "completed": completed,
                "completed_at": now_ts if completed else None,
                "date": date_str
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
        self.save()
        return self.get_checkin_stats()

    def get_checkin_stats(self):
        today = self.get_today_key()
        goal = self.checkins.get("daily_goal", 20)
        records = self.checkins.setdefault("records", {})
        today_rec = records.get(today, {
            "count": 0,
            "correct_count": 0,
            "wrong_count": 0,
            "completed": False,
            "completed_at": None,
            "date": today
        })

        now = datetime.datetime.now()
        streak = 0
        check_date = now
        if not today_rec.get("completed"):
            check_date = now - datetime.timedelta(days=1)

        while True:
            d_str = check_date.strftime("%Y-%m-%d")
            r = records.get(d_str)
            if r and r.get("completed"):
                streak += 1
                check_date -= datetime.timedelta(days=1)
            else:
                break

        weekdays = ["周一","周二","周三","周四","周五","周六","周日"]
        recent_days = []
        for i in range(13, -1, -1):
            d = now - datetime.timedelta(days=i)
            d_str = d.strftime("%Y-%m-%d")
            r = records.get(d_str, {"count": 0, "completed": False, "date": d_str})
            recent_days.append({
                "date": d_str,
                "day_label": d.strftime("%m/%d"),
                "weekday": weekdays[d.weekday()],
                "count": r.get("count", 0),
                "completed": r.get("completed", False),
                "is_today": (d_str == today)
            })

        total_checkin_days = sum(1 for r in records.values() if r.get("completed"))
        total_practice_words = sum(r.get("count", 0) for r in records.values())

        return {
            "daily_goal": goal,
            "today_count": today_rec.get("count", 0),
            "today_reviews": today_rec.get("review_times", today_rec.get("count", 0)),
            "today_completed": today_rec.get("completed", False),
            "today_completed_at": today_rec.get("completed_at"),
            "streak": streak,
            "total_checkin_days": total_checkin_days,
            "total_practice_words": total_practice_words,
            "recent_days": recent_days
        }

    def record_review(self, word_key, is_correct):
        word_key = word_key.strip().lower()
        if word_key not in self.words:
            return None
        w = self.words[word_key]
        now_ts = int(time.time())

        w["last_review"] = now_ts
        w["review_count"] = w.get("review_count", 0) + 1

        current_stage = w.get("stage", 0)
        completed_today_stage = False
        if is_correct:
            w["correct_count"] = w.get("correct_count", 0) + 1
            w["consecutive_correct"] = w.get("consecutive_correct", 0) + 1
            # 若为初学生词（首次答对），第一复习周期应为 5 分钟 (Stage 0)，巩固记忆起点
            if w.get("review_count", 0) <= 1 and w.get("wrong_count", 0) == 0:
                w["stage"] = 0
                interval_sec = EBBINGHAUS_INTERVALS[0]
                new_stage = 0
            else:
                next_stage = min(current_stage + 1, len(EBBINGHAUS_INTERVALS) - 1)
                w["stage"] = next_stage
                interval_sec = EBBINGHAUS_INTERVALS[next_stage]
                new_stage = next_stage
            w["next_review"] = now_ts + interval_sec
            if (current_stage < 3 and new_stage >= 3) or (current_stage >= 3):
                completed_today_stage = True
        else:
            w["wrong_count"] = w.get("wrong_count", 0) + 1
            w["consecutive_correct"] = 0
            w["stage"] = current_stage
            interval_sec = EBBINGHAUS_INTERVALS[current_stage]
            w["next_review"] = now_ts + interval_sec
            completed_today_stage = False

        rec, just_completed = self.record_practice_checkin(word_key, is_correct, completed_today_stage)

        self.save()
        return w, just_completed, self.get_checkin_stats()

    def update_word(self, original_key, updated_data):
        original_key = (original_key or '').strip().lower()
        if original_key not in self.words:
            for k, v in self.words.items():
                if v.get('id', '').lower() == original_key or v.get('word', '').lower() == original_key:
                    original_key = k
                    break
            else:
                return None

        old_entry = self.words[original_key]
        new_word_str = updated_data.get('word', '').strip()
        if not new_word_str:
            new_word_str = old_entry.get('word', original_key)

        new_key = new_word_str.lower()

        old_entry['custom_edited'] = True
        old_entry['last_edited_at'] = int(time.time())
        old_entry['word'] = new_word_str
        if 'meaning' in updated_data:
            old_entry['meaning'] = updated_data.get('meaning', '').strip()
        if 'sentence' in updated_data:
            old_entry['sentence'] = updated_data.get('sentence', '').strip()
        if 'section' in updated_data and updated_data['section'].strip():
            old_entry['section'] = updated_data['section'].strip()

        if 'stage' in updated_data:
            try:
                new_stage = int(updated_data['stage'])
                if 0 <= new_stage < len(EBBINGHAUS_INTERVALS):
                    old_entry['stage'] = new_stage
                    now_ts = int(time.time())
                    if new_stage == 0:
                        old_entry['next_review'] = now_ts
                    else:
                        old_entry['next_review'] = now_ts + EBBINGHAUS_INTERVALS[new_stage]
            except Exception:
                pass

        if 'tags' in updated_data:
            tags = updated_data['tags']
            if isinstance(tags, list):
                old_entry['tags'] = [str(t).strip() for t in tags if str(t).strip()]
            elif isinstance(tags, str):
                old_entry['tags'] = [t.strip() for t in tags.split(',') if t.strip()]

        if new_key != original_key:
            old_entry['id'] = new_key
            if 'original_source_word' not in old_entry:
                old_entry['original_source_word'] = original_key
            del self.words[original_key]
            self.words[new_key] = old_entry

        self.save()
        return old_entry

    def delete_word(self, word_key):
        if isinstance(word_key, str):
            word_keys = [word_key]
        else:
            word_keys = list(word_key) if word_key else []
        now_ts = int(time.time())
        deleted_count = 0
        for raw_k in word_keys:
            target_key = (raw_k or '').strip().lower()
            if not target_key:
                continue
            found_k = None
            if target_key in self.words:
                found_k = target_key
            else:
                for k, v in self.words.items():
                    if v.get('id', '').lower() == target_key or v.get('word', '').lower() == target_key:
                        found_k = k
                        break
            if found_k:
                entry = self.words.pop(found_k)
                entry['deleted_at'] = now_ts
                self.trash[found_k] = entry
                deleted_count += 1
        if deleted_count > 0:
            self.save()
            return True, deleted_count
        return False, 0

    def get_trash(self):
        trash_list = list(self.trash.values())
        trash_list.sort(key=lambda x: x.get('deleted_at', 0), reverse=True)
        return trash_list

    def restore_trash(self, word_keys=None):
        restored_count = 0
        if word_keys is None:
            word_keys = list(self.trash.keys())
        elif isinstance(word_keys, str):
            word_keys = [word_keys]
        for raw_k in word_keys:
            target_key = (raw_k or '').strip().lower()
            if not target_key:
                continue
            found_k = None
            if target_key in self.trash:
                found_k = target_key
            else:
                for k, v in self.trash.items():
                    if v.get('id', '').lower() == target_key or v.get('word', '').lower() == target_key:
                        found_k = k
                        break
            if found_k:
                entry = self.trash.pop(found_k)
                entry.pop('deleted_at', None)
                self.words[found_k] = entry
                restored_count += 1
        if restored_count > 0:
            self.save()
            return True, restored_count
        return False, 0

    def clear_trash(self, word_keys=None):
        purged_count = 0
        if word_keys is None:
            purged_count = len(self.trash)
            self.trash = {}
        else:
            if isinstance(word_keys, str):
                word_keys = [word_keys]
            for raw_k in word_keys:
                target_key = (raw_k or '').strip().lower()
                if not target_key:
                    continue
                found_k = None
                if target_key in self.trash:
                    found_k = target_key
                else:
                    for k, v in self.trash.items():
                        if v.get('id', '').lower() == target_key or v.get('word', '').lower() == target_key:
                            found_k = k
                            break
                if found_k:
                    del self.trash[found_k]
                    purged_count += 1
        if purged_count > 0:
            self.save()
            return True, purged_count
        return False, 0

    def add_word(self, word_data):
        word_clean = word_data.get('word', '').strip()
        if not word_clean:
            return None
        word_key = word_clean.lower()
        now_ts = int(time.time())
        stage = 0
        try:
            stage = int(word_data.get('stage', 0))
            if stage < 0 or stage >= len(EBBINGHAUS_INTERVALS):
                stage = 0
        except Exception:
            stage = 0
        entry = {
            'id': word_key,
            'word': word_clean,
            'meaning': word_data.get('meaning', '').strip(),
            'sentence': word_data.get('sentence', '').strip(),
            'tags': [t.strip() for t in word_data.get('tags', '').split(',') if t.strip()] if isinstance(word_data.get('tags'), str) else word_data.get('tags', []),
            'section': word_data.get('section', '自定义生词').strip() or '自定义生词',
            'source_file': '手动添加 / 词库录入',
            'custom_edited': True,
            'last_edited_at': now_ts,
            'stage': stage,
            'next_review': now_ts if stage == 0 else now_ts + EBBINGHAUS_INTERVALS[stage],
            'last_review': None,
            'review_count': 0,
            'correct_count': 0,
            'wrong_count': 0,
            'consecutive_correct': 0,
            'created_at': now_ts
        }
        self.words[word_key] = entry
        self.save()
        return entry

    def get_stats(self):
        now_ts = int(time.time())
        total = len(self.words)
        due_count = 0
        mastered_count = 0
        learning_count = 0
        new_words_count = 0
        due_review_count = 0
        error_books = []
        section_counts = {}

        for w in self.words.values():
            stage = w.get("stage", 0)
            sec = w.get("section", "未知Section")
            section_counts[sec] = section_counts.get(sec, 0) + 1

            is_new = (w.get("review_count", 0) == 0 or w.get("last_review") is None)
            is_due = (w.get("next_review", 0) <= now_ts)
            if is_new:
                new_words_count += 1
            elif is_due:
                due_review_count += 1

            if is_due:
                due_count += 1
            if stage >= 6:
                mastered_count += 1
            else:
                learning_count += 1

            if w.get("wrong_count", 0) > 0:
                error_books.append(w)

        error_books.sort(key=lambda x: x.get("wrong_count", 0), reverse=True)

        next_due_ts = None
        for w in self.words.values():
            nr = w.get("next_review", 0)
            if nr > now_ts:
                if next_due_ts is None or nr < next_due_ts:
                    next_due_ts = nr

        next_due_in_sec = max(0, next_due_ts - now_ts) if next_due_ts is not None else None
        next_due_count = 0
        next_due_samples = []
        if next_due_ts is not None:
            upcoming_words = [w for w in self.words.values() if w.get("next_review", 0) > now_ts]
            upcoming_words.sort(key=lambda x: x.get("next_review", 0))
            next_due_count = sum(1 for w in upcoming_words if w.get("next_review", 0) <= next_due_ts + 120)
            next_due_samples = [
                {
                    "word": w.get("word"),
                    "meaning": w.get("meaning", ""),
                    "stage": w.get("stage", 0),
                    "due_in_sec": max(0, w.get("next_review", 0) - now_ts)
                }
                for w in upcoming_words[:8]
            ]

        return {
            "total": total,
            "due_count": due_count,
            "mastered_count": mastered_count,
            "learning_count": learning_count,
            "error_count": len(error_books),
            "top_errors": error_books[:10],
            "sections": section_counts,
            "ebbinghaus_stages": [
                {"stage": i, "interval": EBBINGHAUS_INTERVALS[i], "count": sum(1 for w in self.words.values() if w.get('stage', 0) == i)}
                for i in range(len(EBBINGHAUS_INTERVALS))
            ],
            "next_due_in_sec": next_due_in_sec,
            "next_due_ts": next_due_ts,
            "next_due_count": next_due_count,
            "next_due_samples": next_due_samples,
            "new_words_count": new_words_count,
            "due_review_count": due_review_count,
            "trash_count": len(self.trash),
            "now_ts": now_ts
        }

db = WordDatabase()
if not db.words:
    print("[Server Init] Scanning sections for excel files...")
    db.scan_sections()


class ThreadingHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

class DictationRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/words":
            query = urllib.parse.parse_qs(parsed.query)
            section = query.get("section", [None])[0]
            only_due = query.get("only_due", ["false"])[0].lower() == "true"
            only_errors = query.get("only_errors", ["false"])[0].lower() == "true"
            only_new = query.get("only_new", ["false"])[0].lower() == "true"
            only_review = query.get("only_review", ["false"])[0].lower() == "true"
            limit = int(query.get("limit", [1000])[0])
            now_ts = int(time.time())

            word_list = list(db.words.values())
            if section and section != "all":
                word_list = [w for w in word_list if w.get("section") == section]
            if only_new:
                word_list = [w for w in word_list if w.get("review_count", 0) == 0 or w.get("last_review") is None]
            elif only_review:
                word_list = [w for w in word_list if w.get("review_count", 0) > 0 and w.get("last_review") is not None]
                if only_due:
                    word_list = [w for w in word_list if w.get("next_review", 0) <= now_ts]
            elif only_due:
                word_list = [w for w in word_list if w.get("next_review", 0) <= now_ts]
            if only_errors:
                word_list = [w for w in word_list if w.get("wrong_count", 0) > 0]

            self.send_json({
                "count": len(word_list),
                "words": word_list[:limit],
                "now": now_ts
            })
            return

        elif path == "/api/stats":
            stats = db.get_stats()
            local_ip = get_local_ip()
            stats["local_ip"] = local_ip
            stats["port"] = PORT
            stats["mobile_url"] = f"http://{local_ip}:{PORT}"
            self.send_json(stats)
            return

        elif path == "/api/checkin":
            stats = db.get_checkin_stats()
            self.send_json(stats)
            return

        elif path == "/api/scan":
            query = urllib.parse.parse_qs(parsed.query)
            force = query.get("force", ["false"])[0].lower() == "true"
            result = db.scan_sections(force=force)
            self.send_json({"success": True, "result": result})
            return

        elif path == "/api/trash":
            self.send_json({
                "success": True,
                "count": len(db.trash),
                "words": db.get_trash()
            })
            return

        elif path == "/api/session":
            self.send_json({
                "success": True,
                "session": db.active_session
            })
            return

        elif path == "/api/network":
            local_ip = get_local_ip()
            self.send_json({
                "local_ip": local_ip,
                "port": PORT,
                "mobile_url": f"http://{local_ip}:{PORT}"
            })
            return

        if path == "/" or path == "/index.html":
            index_path = os.path.join(STATIC_DIR, "index.html")
            if os.path.exists(index_path):
                with open(index_path, "rb") as f:
                    content = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(content)))
                self.send_header("Connection", "close")
                self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
                self.send_header("Pragma", "no-cache")
                self.end_headers()
                self.wfile.write(content)
                return
        
        rel = path.lstrip("/")
        full_path = os.path.join(STATIC_DIR, rel)
        if os.path.exists(full_path) and os.path.isfile(full_path):
            with open(full_path, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Connection", "close")
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.end_headers()
            self.wfile.write(content)
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length > 0 else b"{}"

        try:
            payload = json.loads(body.decode("utf-8"))
        except Exception:
            payload = {}

        if path == "/api/checkin/goal":
            goal = payload.get("goal", 20)
            res = db.set_daily_goal(goal)
            self.send_json({"success": True, "checkin": res})
            return

        elif path == "/api/checkin/manual":
            completed = bool(payload.get("completed", True))
            date_str = payload.get("date", None)
            res = db.manual_checkin(completed=completed, date_str=date_str)
            self.send_json({"success": True, "checkin": res})
            return

        elif path == "/api/review":
            word_key = payload.get("word")
            is_correct = bool(payload.get("correct"))
            if not word_key:
                self.send_json({"error": "missing word"}, status=400)
                return
            result = db.record_review(word_key, is_correct)
            if result:
                updated, just_completed, checkin_stats = result
                self.send_json({"success": True, "word": updated, "just_completed": just_completed, "checkin": checkin_stats})
            else:
                self.send_json({"error": "word not found"}, status=404)
            return

        elif path == "/api/scan":
            force = bool(payload.get("force", False))
            result = db.scan_sections(force=force)
            self.send_json({"success": True, "result": result})
            return

        elif path == "/api/reset_stage":
            word_key = payload.get("word")
            if word_key in db.words:
                db.words[word_key]["stage"] = 0
                db.words[word_key]["next_review"] = int(time.time())
                db.save()
                self.send_json({"success": True, "word": db.words[word_key]})
            else:
                self.send_json({"error": "not found"}, status=404)
            return

        elif path == "/api/word/update":
            orig = payload.get("original_word") or payload.get("id") or payload.get("word")
            updated = db.update_word(orig, payload)
            if updated:
                self.send_json({"success": True, "word": updated})
            else:
                self.send_json({"error": "word not found"}, status=404)
            return

        elif path == "/api/word/delete":
            targets = payload.get("words") or payload.get("word") or payload.get("id")
            ok, count = db.delete_word(targets)
            if ok:
                self.send_json({"success": True, "deleted_count": count, "trash_count": len(db.trash)})
            else:
                self.send_json({"error": "word not found"}, status=404)
            return

        elif path == "/api/trash/restore":
            targets = payload.get("words") or payload.get("word") or payload.get("id")
            all_flag = bool(payload.get("all", False))
            ok, count = db.restore_trash(None if all_flag else targets)
            self.send_json({"success": ok, "restored_count": count, "trash_count": len(db.trash)})
            return

        elif path == "/api/trash/clear":
            targets = payload.get("words") or payload.get("word") or payload.get("id")
            all_flag = bool(payload.get("all", False))
            ok, count = db.clear_trash(None if all_flag else targets)
            self.send_json({"success": ok, "cleared_count": count, "trash_count": len(db.trash)})
            return

        elif path == "/api/session":
            db.active_session = payload
            db.save()
            self.send_json({"success": True})
            return

        elif path == "/api/session/clear":
            db.active_session = None
            db.save()
            self.send_json({"success": True})
            return

        elif path == "/api/word/add":
            added = db.add_word(payload)
            if added:
                self.send_json({"success": True, "word": added})
            else:
                self.send_json({"error": "invalid word data"}, status=400)
            return

        self.send_json({"error": "not found"}, status=404)

    def send_json(self, data, status=200):
        out = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(out)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()
        self.wfile.write(out)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

def run_server():
    os.makedirs(STATIC_DIR, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)

    # 支持 --restart 或 -r 自动清理占用端口的旧进程
    if "--restart" in sys.argv or "-r" in sys.argv:
        try:
            import subprocess
            my_pid = str(os.getpid())
            out = subprocess.check_output(f"lsof -ti :{PORT}", shell=True).decode().strip()
            if out:
                for pid in out.split():
                    if pid != my_pid:
                        os.system(f"kill -9 {pid} 2>/dev/null")
                time.sleep(0.5)
                print(f"[*] 已清理占用端口 {PORT} 的旧进程。")
        except Exception:
            pass

    server_address = ("0.0.0.0", PORT)
    ThreadingHTTPServer.allow_reuse_address = True

    try:
        httpd = ThreadingHTTPServer(server_address, DictationRequestHandler)
    except OSError as e:
        local_ip = get_local_ip()
        if e.errno == 48:
            print("=" * 60)
            print(f"⚠️  提示：端口 {PORT} 已经被占用（通常是因为服务已在后台运行中）")
            print(f"👉 电脑端请直接在浏览器中打开:  http://127.0.0.1:{PORT}")
            print(f"👉 手机端局域网同步地址:        http://{local_ip}:{PORT}")
            print("-" * 60)
            print(f"💡 如果需要强制重启服务，可运行:")
            print(f"   python3 server.py --restart")
            print(f"   或者在终端中运行: lsof -ti :{PORT} | xargs kill -9")
            print("=" * 60)
            return
        else:
            raise e

    local_ip = get_local_ip()
    print("=" * 60)
    print(f" IELTS 雅思单词中英默写系统已启动！")
    print(f" 电脑浏览器访问:  http://127.0.0.1:{PORT}")
    print(f" 手机局域网同步:  http://{local_ip}:{PORT}")
    print(f" 词库已载入 {len(db.words)} 条核心考点单词")
    print(f" 艾宾浩斯科学记忆调度已开启")
    print("=" * 60)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("[Server stopped]")
        httpd.server_close()

if __name__ == "__main__":
    run_server()
