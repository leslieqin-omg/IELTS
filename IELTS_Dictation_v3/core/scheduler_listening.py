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


def calculate_spot_check_quota(
    review_volume: int,
    min_ratio: float = 0.10,
    max_ratio: float = 0.20,
    default_count: int = 5
) -> int:
    """Computes spot check quota ensuring it represents 10% to 20% of daily review volume.

    Args:
        review_volume: Count of due review words (or daily review volume cap).
        min_ratio: Minimum ratio (default 0.10, 10%).
        max_ratio: Maximum ratio (default 0.20, 20%).
        default_count: Default count returned when review_volume <= 0 (default 5).

    Returns:
        int: Quota clamped to [10%, 20%] of review volume, or default_count when volume <= 0.
    """
    if review_volume <= 0:
        return default_count if default_count > 0 else 1

    if min_ratio > max_ratio:
        min_ratio, max_ratio = max_ratio, min_ratio

    target = round(review_volume * 0.15)
    lower = max(1, round(review_volume * min_ratio))
    upper = max(1, round(review_volume * max_ratio))

    if lower > upper:
        lower, upper = upper, lower

    return min(max(target, lower), upper)


def apply_pretest_result(
    word_dict: dict,
    is_correct: bool,
    current_date_shanghai: datetime.date = None,
    now_ts: int = None
) -> dict:
    """Apply pre-test result to a word.

    If is_correct (first try correct):
        Marked as pretest_status = "passed", stage = 6 (mastered / exempt from routine study).
        Does not enter daily new words queue.
    If not is_correct:
        Marked as pretest_status = "failed", stage = 0 (needs to be studied).
        Will be queued into daily new words / regular Ebbinghaus cycle.
    """
    if current_date_shanghai is None:
        current_date_shanghai = get_shanghai_today()
    elif isinstance(current_date_shanghai, str):
        current_date_shanghai = parse_date(current_date_shanghai)

    if now_ts is None:
        now_ts = int(time.time())

    word_dict["pretest_at"] = now_ts
    word_dict["last_review"] = now_ts
    word_dict["last_review_date"] = current_date_shanghai.strftime("%Y-%m-%d")

    if is_correct:
        word_dict["pretest_status"] = "passed"
        word_dict["stage"] = 6
        word_dict["review_count"] = word_dict.get("review_count", 0) + 1
        word_dict["correct_count"] = word_dict.get("correct_count", 0) + 1
        word_dict["consecutive_correct"] = 1
        word_dict["lapsed"] = False
        word_dict["next_review_date"] = "2099-12-31"
        word_dict["next_review"] = 4102329600
    else:
        word_dict["pretest_status"] = "failed"
        word_dict["stage"] = 0
        word_dict["review_count"] = 0  # remains an unstudied word to be learned
        word_dict["wrong_count"] = word_dict.get("wrong_count", 0) + 1
        word_dict["consecutive_correct"] = 0
        word_dict["lapsed"] = True
        word_dict["next_review_date"] = current_date_shanghai.strftime("%Y-%m-%d")
        word_dict["next_review"] = get_shanghai_midnight_ts(current_date_shanghai)

    return word_dict


def apply_spot_check_result(
    word_dict: dict,
    is_correct: bool,
    current_date_shanghai: datetime.date = None,
    now_ts: int = None
) -> dict:
    """Apply spot-check result to a pretest-passed word.

    If is_correct:
        Word is confirmed mastered! Retain pretest_status = "passed", stage = 6.
        Updates last_spot_check timestamp and spot_check stats.
    If not is_correct:
        Word was forgotten or guessed! Re-activate it into Ebbinghaus study queue:
        pretest_status = "failed", stage = 0, lapsed = True, comes due tomorrow for study.
    """
    if current_date_shanghai is None:
        current_date_shanghai = get_shanghai_today()
    elif isinstance(current_date_shanghai, str):
        current_date_shanghai = parse_date(current_date_shanghai)

    if now_ts is None:
        now_ts = int(time.time())

    word_dict["last_spot_check"] = now_ts
    word_dict["spot_check_count"] = word_dict.get("spot_check_count", 0) + 1

    if is_correct:
        word_dict["spot_check_correct"] = word_dict.get("spot_check_correct", 0) + 1
        word_dict["pretest_status"] = "passed"
        word_dict["stage"] = 6
        word_dict["next_review_date"] = "2099-12-31"
        word_dict["next_review"] = 4102329600
        word_dict["lapsed"] = False
        word_dict["correct_count"] = word_dict.get("correct_count", 0) + 1
    else:
        # Re-activate for learning!
        word_dict["spot_check_wrong"] = word_dict.get("spot_check_wrong", 0) + 1
        word_dict["pretest_status"] = "failed"
        word_dict["stage"] = 0
        word_dict["lapsed"] = True
        word_dict["wrong_count"] = word_dict.get("wrong_count", 0) + 1
        word_dict["consecutive_correct"] = 0
        tomorrow = current_date_shanghai + datetime.timedelta(days=1)
        word_dict["next_review_date"] = tomorrow.strftime("%Y-%m-%d")
        word_dict["next_review"] = get_shanghai_midnight_ts(tomorrow)

    return word_dict
