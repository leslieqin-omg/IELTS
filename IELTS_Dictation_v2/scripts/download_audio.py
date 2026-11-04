#!/usr/bin/env python3
"""British pronunciation audio downloader for IELTS_Dictation_v2.

Downloads en-GB pronunciation audio files for listening vocabulary words into
static/audio/<word>.mp3. Handles URL encoding of spaces and special characters.
Logs failed downloads to data/logs/failed_audio.log with error reasons.
Supports --retry to re-attempt downloads for failed entries.
"""

import os
import sys
import json
import time
import urllib.request
import urllib.error
import urllib.parse
import argparse
from typing import List, Tuple

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

try:
    from config import AUDIO_DIR, FAILED_AUDIO_LOG, LISTENING_DATA_FILE
except ImportError:
    AUDIO_DIR = os.path.join(PROJECT_ROOT, "static", "audio")
    FAILED_AUDIO_LOG = os.path.join(PROJECT_ROOT, "data", "logs", "failed_audio.log")
    LISTENING_DATA_FILE = os.path.join(PROJECT_ROOT, "data", "listening.json")

# Standard HTTP headers to avoid being blocked by TTS endpoints
HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "audio/mpeg, audio/*, */*",
    "Accept-Language": "en-GB,en;q=0.9",
}

# Google Translate TTS endpoint configured for British English (en-GB)
TTS_URL_TEMPLATE = "https://translate.google.com/translate_tts?ie=UTF-8&tl=en-GB&client=tw-ob&q={query}"


def get_safe_audio_filename(word: str) -> str:
    """Returns safe filename for audio file preserving spaces and hyphens."""
    # Strip leading and trailing whitespace
    clean_word = word.strip()
    return f"{clean_word}.mp3"


def download_single_word_audio(
    word: str,
    output_dir: str = AUDIO_DIR,
    timeout: float = 8.0,
    overwrite: bool = False
) -> Tuple[bool, str]:
    """Download British pronunciation MP3 for a single word or phrase.

    Args:
        word: The vocabulary word or phrase (e.g. 'creativity', 'a newspaper').
        output_dir: Target directory for storing MP3 files.
        timeout: Network request timeout in seconds.
        overwrite: Whether to re-download if file already exists.

    Returns:
        tuple (success: bool, detail: str)
    """
    clean_word = word.strip()
    if not clean_word:
        return False, "Empty word provided"

    # Reject path traversal or illegal directory separators in word
    if "/" in clean_word or "\\" in clean_word or clean_word.startswith(".."):
        return False, "Illegal characters in word (slash or path traversal)"

    os.makedirs(output_dir, exist_ok=True)
    filename = get_safe_audio_filename(clean_word)
    target_filepath = os.path.join(output_dir, filename)

    if os.path.exists(target_filepath) and not overwrite:
        file_size = os.path.getsize(target_filepath)
        if file_size > 0:
            return True, f"Already exists ({file_size} bytes)"

    encoded_query = urllib.parse.quote(clean_word)
    url = TTS_URL_TEMPLATE.format(query=encoded_query)

    req = urllib.request.Request(url, headers=HTTP_HEADERS, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            content_type = resp.headers.get("Content-Type", "")
            data = resp.read()

            if not data or len(data) < 32:
                return False, f"Invalid response payload ({len(data)} bytes)"

            # Atomically write to destination
            tmp_path = target_filepath + ".tmp"
            with open(tmp_path, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, target_filepath)
            return True, f"Downloaded {len(data)} bytes"

    except urllib.error.HTTPError as e:
        return False, f"HTTP Error {e.code}: {e.reason}"
    except urllib.error.URLError as e:
        return False, f"URL Error: {e.reason}"
    except TimeoutError:
        return False, "Request timed out"
    except Exception as e:
        return False, f"Error: {str(e)}"


def log_failure(log_path: str, word: str, error_msg: str) -> None:
    """Appends failure record to failed_audio.log using tab delimiter."""
    os.makedirs(os.path.dirname(os.path.abspath(log_path)), exist_ok=True)
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(f"{word}\t{error_msg}\n")


def parse_failed_words_from_log(log_path: str) -> List[Tuple[str, str]]:
    """Reads failed_audio.log and extracts list of (word, error) tuples."""
    if not os.path.exists(log_path):
        return []

    results = []
    with open(log_path, "r", encoding="utf-8") as f:
        for line in f:
            line_str = line.strip()
            if not line_str:
                continue
            parts = line_str.split("\t")
            word = parts[0].strip()
            err = parts[1].strip() if len(parts) > 1 else "Unknown error"
            results.append((word, err))
    return results


def run_downloader(
    words: List[str],
    output_dir: str = AUDIO_DIR,
    log_path: str = FAILED_AUDIO_LOG,
    delay: float = 0.1,
    overwrite: bool = False,
    limit: int | None = None
) -> Tuple[int, int, int]:
    """Downloads audio for list of words, logging failures.

    Returns:
        tuple (success_count, skipped_count, fail_count)
    """
    os.makedirs(output_dir, exist_ok=True)
    os.makedirs(os.path.dirname(os.path.abspath(log_path)), exist_ok=True)

    if limit is not None and limit > 0:
        words = words[:limit]

    success_count = 0
    skipped_count = 0
    fail_count = 0

    print(f"Starting audio download for {len(words)} words...")
    for idx, word in enumerate(words, 1):
        ok, msg = download_single_word_audio(
            word=word,
            output_dir=output_dir,
            overwrite=overwrite
        )

        if ok:
            if "Already exists" in msg:
                skipped_count += 1
            else:
                success_count += 1
                if delay > 0:
                    time.sleep(delay)
        else:
            fail_count += 1
            log_failure(log_path, word, msg)
            print(f"[{idx}/{len(words)}] FAILED '{word}': {msg}")

        if idx % 100 == 0 or idx == len(words):
            print(f"Progress: [{idx}/{len(words)}] (Success: {success_count}, Skipped: {skipped_count}, Failed: {fail_count})")

    return success_count, skipped_count, fail_count


def retry_failed_audio(
    output_dir: str = AUDIO_DIR,
    log_path: str = FAILED_AUDIO_LOG,
    delay: float = 0.2
) -> None:
    """Retries downloading all words listed in failed_audio.log."""
    if not os.path.exists(log_path):
        print(f"No failed audio log found at {log_path}. Nothing to retry.")
        return

    failed_entries = parse_failed_words_from_log(log_path)
    if not failed_entries:
        print("Failed audio log is empty. Nothing to retry.")
        return

    words_to_retry = [entry[0] for entry in failed_entries]
    print(f"Retrying audio download for {len(words_to_retry)} failed words from {log_path}...")

    # Clear log file to re-record current failures
    still_failed = []
    success_count = 0

    for idx, word in enumerate(words_to_retry, 1):
        ok, msg = download_single_word_audio(
            word=word,
            output_dir=output_dir,
            overwrite=True
        )
        if ok:
            success_count += 1
            print(f"[{idx}/{len(words_to_retry)}] RECOVERED '{word}': {msg}")
            if delay > 0:
                time.sleep(delay)
        else:
            still_failed.append((word, msg))
            print(f"[{idx}/{len(words_to_retry)}] STILL FAILED '{word}': {msg}")

    # Re-write log with remaining failed entries
    with open(log_path, "w", encoding="utf-8") as f:
        for word, msg in still_failed:
            f.write(f"{word}\t{msg}\n")

    print(f"Retry complete: {success_count} recovered, {len(still_failed)} still failing.")


def main():
    parser = argparse.ArgumentParser(
        description="Download British English (en-GB) pronunciation audio files for IELTS vocabulary."
    )
    parser.add_argument(
        "--source",
        "--data",
        dest="source",
        default=LISTENING_DATA_FILE,
        help=f"Path to listening.json (default: {LISTENING_DATA_FILE})"
    )
    parser.add_argument(
        "--output-dir",
        "--out",
        dest="output_dir",
        default=AUDIO_DIR,
        help=f"Path to audio output directory (default: {AUDIO_DIR})"
    )
    parser.add_argument(
        "--log",
        default=FAILED_AUDIO_LOG,
        help=f"Path to failed audio log file (default: {FAILED_AUDIO_LOG})"
    )
    parser.add_argument(
        "--retry",
        action="store_true",
        help="Retry downloading audio for failed words recorded in failed_audio.log"
    )
    parser.add_argument(
        "--word",
        type=str,
        help="Download audio for a single word only"
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Maximum number of words to download in this run"
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.1,
        help="Delay in seconds between requests (default: 0.1s)"
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite existing MP3 files"
    )

    args = parser.parse_args()

    if args.retry:
        retry_failed_audio(
            output_dir=args.output_dir,
            log_path=args.log,
            delay=args.delay
        )
        sys.exit(0)

    if args.word:
        ok, msg = download_single_word_audio(
            word=args.word,
            output_dir=args.output_dir,
            overwrite=args.overwrite
        )
        if ok:
            print(f"Successfully downloaded audio for '{args.word}': {msg}")
            sys.exit(0)
        else:
            log_failure(args.log, args.word, msg)
            print(f"Failed to download audio for '{args.word}': {msg}", file=sys.stderr)
            sys.exit(1)

    # Load words from listening.json or fallback list
    if os.path.exists(args.source):
        with open(args.source, "r", encoding="utf-8") as f:
            data = json.load(f)
        raw_words = data.get("words", {})
        if isinstance(raw_words, dict):
            words = [w.get("word", k) for k, w in raw_words.items()]
        elif isinstance(raw_words, list):
            words = [w.get("word", "") for w in raw_words if w.get("word")]
        else:
            words = []
    else:
        print(f"Source file {args.source} not found. Please run scripts/import_listening.py first.", file=sys.stderr)
        sys.exit(1)

    success, skipped, failed = run_downloader(
        words=words,
        output_dir=args.output_dir,
        log_path=args.log,
        delay=args.delay,
        overwrite=args.overwrite,
        limit=args.limit
    )

    print(f"Audio download completed: {success} downloaded, {skipped} skipped, {failed} failed.")


if __name__ == "__main__":
    main()
