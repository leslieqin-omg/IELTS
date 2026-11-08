"""Session manager for IELTS_Dictation_v2.

Builds study queues by selecting due review words (ordered by overdue date/time ascending,
subject to per-module review_cap) and appending unlearned words according to the
daily new words budget.
Uses only Python standard library.
"""

import time
import datetime
from config import (
    SHANGHAI_TZ,
    DEFAULT_LISTENING_SETTINGS
)
from core.storage import ModuleStore
from core.scheduler_listening import calculate_spot_check_quota


def generate_session(
    store: ModuleStore,
    module_type: str = "listening",
    now_ts: int | None = None,
    current_date_shanghai: datetime.date | str | None = None
) -> dict:
    """Generate study session queue for listening module.

    Args:
        store: ModuleStore instance for the module.
        module_type: module identifier (defaults to "listening").
        now_ts: Current Unix timestamp in seconds (defaults to int(time.time())).
        current_date_shanghai: Current calendar date in Asia/Shanghai.

    Returns:
        dict containing:
            "queue": list of word dicts for this session (strictly deduplicated)
            "total": total words in queue
            "due_count": count of due review words in queue
            "new_count": count of new unlearned words in queue
            "spot_check_count": count of spot-check words in queue
    """
    if now_ts is None:
        now_ts = int(time.time())

    if current_date_shanghai is None:
        now_dt = datetime.datetime.fromtimestamp(now_ts, tz=SHANGHAI_TZ)
        current_date_shanghai = now_dt.date()
    elif isinstance(current_date_shanghai, str):
        current_date_shanghai = datetime.datetime.strptime(
            current_date_shanghai.strip(), "%Y-%m-%d"
        ).date()

    today_str = current_date_shanghai.strftime("%Y-%m-%d")

    all_words = store.get_words()
    settings = store.get_settings()

    # 1. Select due review words (words with review_count > 0, stage > 0, or lapsed)
    # Mastered words (pretest_status == "passed") are strictly excluded from regular due reviews
    due_words = []
    for w in all_words:
        stage = w.get("stage", 0)
        lapsed = w.get("lapsed", False)
        if (w.get("review_count", 0) > 0 or stage > 0 or lapsed) and w.get("pretest_status") != "passed":
            next_date = w.get("next_review_date")
            if not next_date:
                next_ts = w.get("next_review", 0)
                if next_ts:
                    next_date = datetime.datetime.fromtimestamp(
                        next_ts, tz=SHANGHAI_TZ
                    ).strftime("%Y-%m-%d")
                else:
                    next_date = today_str
            if next_date <= today_str:
                due_words.append(w)
    # Sort strictly by due date / timestamp ascending (oldest overdue first)
    due_words.sort(
        key=lambda w: (
            w.get("next_review_date") or "",
            w.get("next_review", 0)
        )
    )

    # 2. Apply review_cap
    default_cap = DEFAULT_LISTENING_SETTINGS["review_cap"]
    review_cap = settings.get("review_cap", default_cap)
    capped_due_words = due_words[:review_cap]

    # Pre-compute due word IDs across ALL due words (prior to capping)
    # to guarantee that excess overdue words are never misclassified as unlearned
    due_ids = {w.get("id") or w.get("word") for w in due_words if (w.get("id") or w.get("word"))}

    # 3. Compute daily new words budget
    checkins = store.get_checkins()
    today_record = None
    if "records" in checkins and isinstance(checkins["records"], dict):
        today_record = checkins["records"].get(today_str)
    if today_record is None and today_str in checkins:
        today_record = checkins.get(today_str)

    new_words_learned = 0
    if isinstance(today_record, dict):
        if isinstance(today_record.get("new_words_learned"), int):
            new_words_learned = today_record["new_words_learned"]
        elif isinstance(today_record.get("new_words"), list):
            new_words_learned = len(today_record["new_words"])
        elif isinstance(today_record.get("new_words"), int):
            new_words_learned = today_record["new_words"]

    daily_new_words = settings.get("daily_new_words", 10)
    if daily_new_words <= 0:
        new_words_budget = 0
    else:
        new_words_budget = max(0, daily_new_words - new_words_learned)

    # 4. Extract daily spot-check words from pretest-passed words (dynamic 10%-20% quota)
    spot_check_setting = settings.get("spot_check_count", 5)
    spot_check_words = []
    if spot_check_setting > 0:
        quota = calculate_spot_check_quota(
            review_volume=len(capped_due_words),
            default_count=spot_check_setting
        )
        if quota > 0:
            mastered_candidates = [
                w for w in all_words
                if w.get("pretest_status") == "passed"
                and w.get("stage", 0) >= 6
                and (w.get("id") or w.get("word")) not in due_ids
            ]
            # Prioritize least recently spot-checked words (LRU)
            mastered_candidates.sort(key=lambda x: (x.get("last_spot_check") or 0, x.get("id", "")))
            sample_count = min(quota, len(mastered_candidates))
            for sw in mastered_candidates[:sample_count]:
                item = dict(sw)
                item["_isSpotCheck"] = True
                spot_check_words.append(item)

    spot_ids = {w.get("id") or w.get("word") for w in spot_check_words if (w.get("id") or w.get("word"))}
    exclude_ids = due_ids | spot_ids

    # 5. Append unlearned words strictly excluding:
    # - Words already due for review (due_ids)
    # - Words with lapsed review status (failed pretests or lapsed stages)
    # - Words with any review or pre-test history (last_review)
    # - Words already mastered in pre-test (pretest_status == "passed")
    # - Words sampled for spot checks (spot_ids)
    unlearned_words = [
        w for w in all_words
        if w.get("stage", 0) == 0
        and w.get("review_count", 0) == 0
        and not w.get("lapsed", False)
        and not w.get("last_review")
        and w.get("pretest_status") != "passed"
        and (w.get("id") or w.get("word")) not in exclude_ids
    ]
    selected_new_words = unlearned_words[:new_words_budget]

    # 6. Build session queue with order-preserving deduplication guard (defense-in-depth)
    # Hierarchy: Due reviews -> Daily spot checks -> New unlearned words
    raw_queue = capped_due_words + spot_check_words + selected_new_words
    seen_ids = set()
    queue_list = []
    for w in raw_queue:
        w_id = w.get("id") or w.get("word")
        if w_id:
            if w_id in seen_ids:
                continue
            seen_ids.add(w_id)
        queue_list.append(dict(w))

    return {
        "queue": queue_list,
        "total": len(queue_list),
        "due_count": len(capped_due_words),
        "new_count": len(selected_new_words),
        "spot_check_count": len(spot_check_words)
    }
