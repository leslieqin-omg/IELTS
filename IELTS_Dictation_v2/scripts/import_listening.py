#!/usr/bin/env python3
"""Listening vocabulary ingestion and filtering pipeline for IELTS_Dictation_v2.

Reads 9fnnn_listening_vocabulary.json in strict read-only mode, filters out
non-vocabulary categories (numeric_value, name_spelling, identifier_string),
retains valid categories (regular, None, temporal, missing), deduplicates on
lowercased/trimmed words, unions acceptedAnswers/parts, prioritizes non-null glossZh,
logs excluded entries to excluded_words.log, and saves atomically to data/listening.json.
"""

import os
import sys
import json
import shutil
import argparse
import datetime
from collections import Counter, defaultdict

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

try:
    from config import (
        ORIGINAL_LISTENING_FILE,
        LISTENING_DATA_FILE,
        EXCLUDED_WORDS_LOG,
        DEFAULT_LISTENING_SETTINGS
    )
except ImportError:
    ORIGINAL_LISTENING_FILE = "/Users/leslie/Documents/ChatGPT/IELTS/IELTS_Dictation/data/9fnnn_listening_vocabulary.json"
    LISTENING_DATA_FILE = os.path.join(PROJECT_ROOT, "data", "listening.json")
    EXCLUDED_WORDS_LOG = os.path.join(PROJECT_ROOT, "data", "logs", "excluded_words.log")
    DEFAULT_LISTENING_SETTINGS = {"review_cap": 40, "daily_new_words": 10}

EXCLUDED_CATEGORIES = {"numeric_value", "name_spelling", "identifier_string"}
KEPT_CATEGORIES = {"regular", "None", "temporal"}
CATEGORY_PRIORITY = {"regular": 3, "temporal": 2, "None": 1}

FALLBACK_MEANINGS = {
    "advisors": "n. 顾问，指导老师",
    "afternoon": "n. 下午",
    "america": "n. 美洲；美国 (首字母大写)",
    "antifreeze": "n. 防冻剂",
    "april": "n. 四月 (首字母大写)",
    "april 9": "4月9日 (月份首字母大写)",
    "audiences": "n. 观众，听众",
    "august": "n. 八月 (首字母大写)",
    "autumn": "n. 秋天，秋季",
    "axe": "n. 斧头",
    "barbecue area": "n. 烧烤区",
    "centuries": "n. 世纪，百年",
    "changes": "n. 变化，改变",
    "cheffins": "n. 切芬斯 (专有名词)",
    "classical": "adj. 古典的；经典的",
    "composer": "n. 作曲家",
    "countryside living": "n. 乡村生活",
    "day": "n. 一天，白昼",
    "e": "字母 E",
    "early mornings": "n. 清晨",
    "emily carlton": "艾米丽·卡尔顿 (人名)",
    "expectations": "n. 期望，预期",
    "february 27": "2月27日 (月份首字母大写)",
    "feminism": "n. 女性主义，女权主义",
    "four days": "四天",
    "friday": "n. 星期五",
    "glue": "n. 胶水；v. 粘贴",
    "good restaurant": "n. 好餐厅",
    "gw432ha": "邮编/编号 GW432HA",
    "higher": "adj. 更高的",
    "immigration": "n. 移民，移居",
    "industries": "n. 行业，工业",
    "instinct": "n. 本能，直觉",
    "interaction": "n. 互动，交流",
    "irish music": "n. 爱尔兰音乐 (Irish首字母大写)",
    "january": "n. 一月 (首字母大写)",
    "january 12th": "1月12日 (月份首字母大写)",
    "january 13th": "1月13日 (月份首字母大写)",
    "january 22": "1月22日 (月份首字母大写)",
    "jobs": "n. 工作，职位",
    "july": "n. 七月 (首字母大写)",
    "june": "n. 六月 (首字母大写)",
    "june 18th": "6月18日 (月份首字母大写)",
    "june 27": "6月27日 (月份首字母大写)",
    "keogh": "基奥 (专有名词)",
    "kierke": "基尔克 (专有名词)",
    "kindness": "n. 善良，好意",
    "last summer": "去年夏天",
    "leather": "n. 皮革",
    "likelihood": "n. 可能性",
    "loudness": "n. 响度，音量",
    "marriage": "n. 婚姻，结婚",
    "may 8th": "5月8日 (月份首字母大写)",
    "middle class": "n. 中产阶级",
    "months": "n. 月份，几个月",
    "morning": "n. 早晨，上午",
    "neighbours": "n. 邻居 (英式拼写)",
    "next tuesday": "下周二",
    "night": "n. 夜晚，夜间",
    "northeast": "n. 东北方向；东北部的",
    "notebook": "n. 笔记本",
    "november 1": "11月1日 (月份首字母大写)",
    "november 22nd": "11月22日 (月份首字母大写)",
    "obligation": "n. 义务，责任",
    "october": "n. 十月 (首字母大写)",
    "october 15th": "10月15日 (月份首字母大写)",
    "october 29th": "10月29日 (月份首字母大写)",
    "peak season": "n. 旺季，高峰期",
    "pillow": "n. 枕头",
    "poverty": "n. 贫困，贫穷",
    "process": "n. 过程，流程；v. 处理",
    "quiet": "adj. 安静的，僻静的",
    "rack": "n. 挂架，置物架",
    "rain": "n. 雨，雨水；v. 下雨",
    "rationally": "adv. 理性地，合理地",
    "reduce": "v. 减少，降低",
    "saturday": "n. 星期六",
    "saturdays": "n. 每个星期六",
    "several days": "几天，数日",
    "skirt": "n. 短裙，裙子",
    "smithers": "史密瑟斯 (专有名词)",
    "spring": "n. 春天；泉水；弹簧",
    "starvation": "n. 饥饿，饿死",
    "stressful": "adj. 压力大的，紧张的",
    "sunday": "n. 星期日",
    "the coast": "n. 海岸，海滨地区",
    "three months": "三个月",
    "thursday": "n. 星期四",
    "tourists": "n. 游客，观光客",
    "toy": "n. 玩具",
    "tuesday": "n. 星期二",
    "tuesdays": "n. 每个星期二",
    "two years": "两年",
    "warm": "adj. 温暖的，暖和的",
    "week": "n. 周，星期",
    "weekend": "n. 周末",
    "weekends": "n. 周末 (复数)",
    "winter": "n. 冬天，冬季",
    "zippers": "n. 拉链",
    "1 hour": "1小时",
    "10 years": "10年",
    "11 july": "7月11日 (月份首字母大写)",
    "13 june": "6月13日 (月份首字母大写)",
    "14 days": "14天",
    "14 september": "9月14日 (月份首字母大写)",
    "14th july": "7月14日 (月份首字母大写)",
    "15 minutes": "15分钟",
    "17th may": "5月17日 (月份首字母大写)",
    "18 may": "5月18日 (月份首字母大写)",
    "1860s": "19世纪60年代 (1860年代)",
    "1st century": "公元1世纪",
    "2 pockets": "两个口袋",
    "23rd april": "4月23日 (月份首字母大写)",
    "24th august": "8月24日 (月份首字母大写)",
    "25th february": "2月25日 (月份首字母大写)",
    "26 september": "9月26日 (月份首字母大写)",
    "28th august": "8月28日 (月份首字母大写)",
    "29th may": "5月29日 (月份首字母大写)",
    "3 days": "3天",
    "3 hours": "3小时",
    "30 march": "3月30日 (月份首字母大写)",
    "30-40 minutes": "30至40分钟",
    "4 decades": "40年 (四个十年)",
    "4 weeks": "4周",
    "40 minutes": "40分钟",
    "5 hours": "5小时",
    "5th may": "5月5日 (月份首字母大写)",
    "6 months": "6个月",
}


def compute_listening_section(item: dict) -> str:
    """Assign a human-friendly Section unit for filtering in the UI."""
    if item.get("category") == "temporal":
        return "日期与时间 (Temporal)"
    parts = sorted(set(str(p).strip() for p in (item.get("parts") or []) if str(p).strip()))
    if not parts:
        return "Part 1 (生活场景)"
    if parts == ["1"]:
        return "Part 1 (生活场景)"
    if parts == ["2"]:
        return "Part 2 (个人独白)"
    if parts == ["3"]:
        return "Part 3 (学术讨论)"
    if parts == ["4"]:
        return "Part 4 (学术讲座)"
    return "Part " + "&".join(parts) + " (多场景高频)"


def compute_listening_meaning(word_text: str, item: dict) -> str:
    """Ensure every listening word has a Chinese meaning for post-judgment reveal and word bank."""
    existing = (item.get("meaning") or item.get("glossZh") or "").strip()
    if existing:
        return existing
    norm = word_text.strip().lower()
    if norm in FALLBACK_MEANINGS:
        return FALLBACK_MEANINGS[norm]
    if ":" in norm or "." in norm:
        return f"时间/时刻: {word_text}"
    if norm.isdigit():
        return f"数字/年份: {word_text}"
    return word_text


def filter_and_deduplicate(words: list[dict]) -> tuple[list[dict], list[dict], list[dict]]:
    """Filter non-vocabulary categories and deduplicate vocabulary entries.

    Returns:
        tuple (kept_raw, excluded, deduplicated)
    """
    excluded = []
    kept_raw = []

    # Step 1: Category filtering
    for entry in words:
        cat = str(entry.get("category"))
        if cat in EXCLUDED_CATEGORIES:
            excluded.append(entry)
        else:
            kept_raw.append(entry)

    # Step 2: Deduplication on trimmed, lowercased word
    groups = defaultdict(list)
    for entry in kept_raw:
        norm_key = entry.get("word", "").strip().lower()
        groups[norm_key].append(entry)

    deduplicated = []
    for norm_key, items in groups.items():
        if len(items) == 1:
            deduplicated.append(items[0])
            continue

        # Sort by category priority descending
        items.sort(
            key=lambda x: CATEGORY_PRIORITY.get(str(x.get("category")), 0),
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


def import_listening_vocabulary(
    source_path: str = ORIGINAL_LISTENING_FILE,
    target_path: str = LISTENING_DATA_FILE,
    log_path: str = EXCLUDED_WORDS_LOG,
    default_settings: dict | None = None
) -> tuple[bool, str]:
    """Execute listening vocabulary import and filtering pipeline.

    Args:
        source_path: Path to original 9fnnn_listening_vocabulary.json (read-only).
        target_path: Destination path for listening.json.
        log_path: Path to write excluded_words.log.
        default_settings: Default settings dictionary for listening module.

    Returns:
        tuple (success: bool, message: str)
    """
    if not os.path.exists(source_path):
        return False, f"Source file does not exist: {source_path}"

    settings = default_settings or dict(DEFAULT_LISTENING_SETTINGS)

    # Step 1: Read source in strict read-only mode
    with open(source_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    raw_words = data.get("words", [])
    if not raw_words:
        return False, "Source dataset contains no words"

    # Step 2: Filter and deduplicate
    kept_raw, excluded, deduplicated = filter_and_deduplicate(raw_words)

    # Step 3: Write excluded words log
    os.makedirs(os.path.dirname(os.path.abspath(log_path)), exist_ok=True)
    with open(log_path, "w", encoding="utf-8") as f:
        for entry in excluded:
            word = entry.get("word", "")
            cat = str(entry.get("category", ""))
            f.write(f"{word}\t{cat}\n")

    # Step 4: Build words dictionary for storage (preserving existing progress if target exists)
    existing_words = {}
    existing_trash = {}
    existing_checkins = {"daily_goal": 20, "records": {}}
    existing_settings = dict(settings)
    if os.path.exists(target_path):
        try:
            with open(target_path, "r", encoding="utf-8") as f:
                old_data = json.load(f)
            if isinstance(old_data.get("words"), dict):
                existing_words = old_data["words"]
            if isinstance(old_data.get("trash"), dict):
                existing_trash = old_data["trash"]
            if isinstance(old_data.get("checkins"), dict):
                existing_checkins = old_data["checkins"]
            if isinstance(old_data.get("settings"), dict):
                existing_settings.update(old_data["settings"])
        except Exception:
            pass

    words_dict = {}
    import_ts = int(datetime.datetime.now().timestamp())
    for item in deduplicated:
        base = dict(item)
        word_text = base.get("word", "").strip()
        norm_key = word_text.lower()
        base["id"] = norm_key
        base["word"] = word_text
        meaning_val = compute_listening_meaning(word_text, base)
        base["meaning"] = meaning_val
        if not base.get("glossZh"):
            base["glossZh"] = meaning_val
        base["section"] = base.get("section") or compute_listening_section(base)
        base.setdefault("sentence", "")
        base.setdefault("stage", 0)
        base.setdefault("review_count", 0)
        base.setdefault("correct_count", 0)
        base.setdefault("wrong_count", 0)
        base.setdefault("consecutive_correct", 0)
        base.setdefault("next_review_date", None)
        base.setdefault("last_review", None)
        base.setdefault("lapsed", False)
        base.setdefault("created_at", import_ts)

        if norm_key in existing_words:
            old_w = existing_words[norm_key]
            for k_preserve in (
                "stage", "review_count", "correct_count", "wrong_count",
                "consecutive_correct", "next_review_date", "next_review",
                "last_review", "lapsed", "custom_edited"
            ):
                if k_preserve in old_w and old_w[k_preserve] is not None:
                    base[k_preserve] = old_w[k_preserve]
            if old_w.get("custom_edited"):
                for k_edit in ("word", "meaning", "sentence", "section"):
                    if old_w.get(k_edit):
                        base[k_edit] = old_w[k_edit]

        words_dict[norm_key] = base

    # Step 5: Backup target if already exists
    os.makedirs(os.path.dirname(os.path.abspath(target_path)), exist_ok=True)
    if os.path.exists(target_path):
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = f"{target_path}.backup_{timestamp}"
        if os.path.exists(backup_path):
            timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S_%f")
            backup_path = f"{target_path}.backup_{timestamp}"
        shutil.copy2(target_path, backup_path)

    # Step 6: Construct payload and write atomically
    payload = {
        "settings": existing_settings,
        "words": words_dict,
        "trash": existing_trash,
        "active_session": None,
        "meta": {
            "source": source_path,
            "raw_total": len(raw_words),
            "kept_raw": len(kept_raw),
            "excluded_count": len(excluded),
            "unique_words": len(words_dict),
            "imported_at": datetime.datetime.now().isoformat()
        },
        "checkins": existing_checkins
    }

    tmp_path = target_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, target_path)

    # Calculate category statistics
    kept_counts = Counter(str(w.get("category")) for w in kept_raw)
    excluded_counts = Counter(str(w.get("category")) for w in excluded)

    stats_report = (
        f"\nCategory Statistics:"
        f"\n  Kept Categories ({len(kept_raw)} raw items -> {len(words_dict)} unique words):"
    )
    for cat in sorted(kept_counts.keys()):
        stats_report += f"\n    - {cat:<20}: {kept_counts[cat]}"
    stats_report += f"\n  Excluded Categories ({len(excluded)} items logged to {log_path}):"
    for cat in sorted(excluded_counts.keys()):
        stats_report += f"\n    - {cat:<20}: {excluded_counts[cat]}"

    return True, f"Ingested {len(words_dict)} unique listening words into {target_path}.{stats_report}"


def main():
    parser = argparse.ArgumentParser(
        description="Ingest, filter, deduplicate 9fnn listening vocabulary into data/listening.json"
    )
    parser.add_argument(
        "--source",
        default=ORIGINAL_LISTENING_FILE,
        help=f"Path to original 9fnnn_listening_vocabulary.json (default: {ORIGINAL_LISTENING_FILE})"
    )
    parser.add_argument(
        "--target",
        "--output",
        dest="target",
        default=LISTENING_DATA_FILE,
        help=f"Path to output listening.json (default: {LISTENING_DATA_FILE})"
    )
    parser.add_argument(
        "--log",
        default=EXCLUDED_WORDS_LOG,
        help=f"Path to excluded_words.log (default: {EXCLUDED_WORDS_LOG})"
    )
    parser.add_argument(
        "--review-cap",
        type=int,
        default=DEFAULT_LISTENING_SETTINGS.get("review_cap", 40),
        help="Initial review cap setting (default: 40)"
    )
    parser.add_argument(
        "--daily-new-words",
        type=int,
        default=DEFAULT_LISTENING_SETTINGS.get("daily_new_words", 10),
        help="Initial daily new words setting (default: 10)"
    )

    args = parser.parse_args()

    settings = {
        "review_cap": args.review_cap,
        "daily_new_words": args.daily_new_words
    }

    ok, message = import_listening_vocabulary(
        source_path=args.source,
        target_path=args.target,
        log_path=args.log,
        default_settings=settings
    )

    if ok:
        print(f"[Listening Import] {message}")
        sys.exit(0)
    else:
        print(f"[Listening Import ERROR] {message}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
