"""Listening module review scheduler for IELTS_Dictation_v2.

Counts review intervals strictly in whole calendar days (e.g. [1, 2, 4, 7, 15, 30] days),
anchored to Asia/Shanghai (UTC+8) local midnight (00:00:00 CST) with zero minute/second jitter.
Reschedules from the actual review date.
Uses only Python standard library.
"""

import time
import datetime
from config import (
    SHANGHAI_TZ,
    LISTENING_INTERVALS
)


def get_shanghai_now() -> datetime.datetime:
    """Return current datetime in Asia/Shanghai timezone (UTC+8)."""
    return datetime.datetime.now(SHANGHAI_TZ)


def get_shanghai_today() -> datetime.date:
    """Return current calendar date in Asia/Shanghai timezone."""
    return get_shanghai_now().date()


def get_shanghai_midnight_ts(date_obj: datetime.date) -> int:
    """Return Unix timestamp for 00:00:00 CST (Asia/Shanghai) of date_obj.

    Guarantees zero minute/second jitter.
    """
    dt = datetime.datetime(
        date_obj.year, date_obj.month, date_obj.day,
        0, 0, 0, 0,
        tzinfo=SHANGHAI_TZ
    )
    return int(dt.timestamp())


def parse_date(date_val) -> datetime.date:
    """Parse date object or 'YYYY-MM-DD' string to datetime.date."""
    if isinstance(date_val, datetime.date):
        return date_val
    if isinstance(date_val, str):
        return datetime.datetime.strptime(date_val.strip(), "%Y-%m-%d").date()
    raise ValueError(f"Invalid date value: {date_val}")


def calculate_listening_next_review(
    current_stage: int,
    is_correct: bool,
    current_date_shanghai: datetime.date = None,
    intervals: list[int] = None
) -> tuple[int, str, int, bool]:
    """Calculate next review state for listening dictation.

    Args:
        current_stage: Current stage index (0 to len(intervals)-1).
        is_correct: Whether review passed.
        current_date_shanghai: Actual calendar date review took place (defaults to today in Shanghai).
        intervals: List of whole-day intervals (defaults to LISTENING_INTERVALS = [1, 2, 4, 7, 15, 30]).

    Returns:
        tuple of:
            next_stage: int
            next_review_date_str: str ("YYYY-MM-DD")
            next_review_midnight_ts: int (00:00:00 CST epoch timestamp)
            lapsed: bool
    """
    if current_date_shanghai is None:
        current_date_shanghai = get_shanghai_today()
    elif isinstance(current_date_shanghai, str):
        current_date_shanghai = parse_date(current_date_shanghai)

    if intervals is None:
        intervals = LISTENING_INTERVALS

    max_stage = len(intervals) - 1
    safe_stage = max(0, min(current_stage, max_stage))

    if is_correct:
        # Pass: interval determined by current stage
        days_to_add = intervals[safe_stage]
        next_stage = min(safe_stage + 1, max_stage)
        lapsed = False
    else:
        # Failure: stage stays unchanged, marked lapsed if stage >= 1, retry tomorrow
        next_stage = safe_stage
        lapsed = (safe_stage >= 1)
        days_to_add = 1  # comes due the very next calendar day

    # Next review date is calculated from actual review date
    next_review_date = current_date_shanghai + datetime.timedelta(days=days_to_add)
    next_review_date_str = next_review_date.strftime("%Y-%m-%d")
    next_review_midnight_ts = get_shanghai_midnight_ts(next_review_date)

    return next_stage, next_review_date_str, next_review_midnight_ts, lapsed


def apply_listening_review(
    word_dict: dict,
    is_correct: bool,
    current_date_shanghai: datetime.date = None,
    now_ts: int = None,
    intervals: list[int] = None
) -> bool:
    """Apply review result directly to a listening word dictionary in-place.

    Returns:
        completed_today_stage (bool): whether this review counts towards daily checkin completion.
    """
    if current_date_shanghai is None:
        current_date_shanghai = get_shanghai_today()
    elif isinstance(current_date_shanghai, str):
        current_date_shanghai = parse_date(current_date_shanghai)

    if now_ts is None:
        now_ts = int(time.time())

    word_dict["last_review"] = now_ts
    word_dict["last_review_date"] = current_date_shanghai.strftime("%Y-%m-%d")
    prev_review_count = word_dict.get("review_count", 0)
    word_dict["review_count"] = prev_review_count + 1

    current_stage = word_dict.get("stage", 0)
    if is_correct:
        word_dict["correct_count"] = word_dict.get("correct_count", 0) + 1
        word_dict["consecutive_correct"] = word_dict.get("consecutive_correct", 0) + 1
    else:
        word_dict["wrong_count"] = word_dict.get("wrong_count", 0) + 1
        word_dict["consecutive_correct"] = 0

    next_stage, next_date_str, next_midnight_ts, lapsed = calculate_listening_next_review(
        current_stage=current_stage,
        is_correct=is_correct,
        current_date_shanghai=current_date_shanghai,
        intervals=intervals
    )

    word_dict["stage"] = next_stage
    word_dict["next_review_date"] = next_date_str
    word_dict["next_review"] = next_midnight_ts
    word_dict["lapsed"] = lapsed

    # Word counts as completed today if scheduled for tomorrow or later and correct
    completed_today_stage = is_correct and (next_date_str > current_date_shanghai.strftime("%Y-%m-%d"))
    return completed_today_stage
