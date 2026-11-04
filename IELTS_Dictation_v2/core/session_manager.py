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
            "queue": list of word dicts for this session
            "total": total words in queue
            "due_count": count of due review words in queue
            "new_count": count of new unlearned words in queue
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
    # Listening module: date-based scheduling (whole calendar days)
    due_words = []
    for w in all_words:
        stage = w.get("stage", 0)
        lapsed = w.get("lapsed", False)
        if w.get("review_count", 0) > 0 or stage > 0 or lapsed:
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

    # 4. Append unlearned words (stage == 0 and review_count == 0) up to budget
    unlearned_words = [
        w for w in all_words
        if w.get("stage", 0) == 0 and w.get("review_count", 0) == 0
    ]
    selected_new_words = unlearned_words[:new_words_budget]

    # 5. Build session queue
    queue_list = [dict(w) for w in (capped_due_words + selected_new_words)]

    return {
        "queue": queue_list,
        "total": len(queue_list),
        "due_count": len(capped_due_words),
        "new_count": len(selected_new_words)
    }
