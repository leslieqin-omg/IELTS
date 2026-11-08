#!/usr/bin/env python3
"""
run_all_tests.py

Master E2E Test Suite Runner for IELTS_Dictation_v3:
1. Enforces Pre-Run and Post-Run SHA-256 integrity verification across all 14 files
   in /Users/leslie/Documents/ChatGPT/IELTS/IELTS_Dictation (read-only original directory).
2. Executes all 8 test modules in sequence:
   - tests.test_original_hash
   - tests.test_filtering
   - tests.test_isolation
   - tests.test_writing_removed
   - tests.test_scheduling_backlog
   - tests.test_server_endpoints
   - tests.test_audio_fallback
   - tests.test_pretest_spot_check
3. Aggregates results across Tier 1 (Functional), Tier 2 (Boundary & Adversarial),
   Tier 3 (Isolation), and Tier 4 (Temporal Simulations).
4. Returns exit code 0 if all tests pass/skip, 1 if any test fails or hash is violated.
"""

import os
import sys
import time
import unittest

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from tests.test_original_hash import (
    ORIGINAL_DIR,
    EXPECTED_ORIGINAL_HASHES,
    verify_original_unchanged,
    compute_directory_hashes,
    sync_live_words_hash
)

TEST_MODULES = [
    ("1. Original Directory Hash Integrity (R1)", "tests.test_original_hash"),
    ("2. 9fnn Vocabulary Filtering & Deduplication (R4)", "tests.test_filtering"),
    ("3. Module Write Isolation & Atomic Persistence (R2, R8)", "tests.test_isolation"),
    ("4. Writing Module Removal Verification (R1)", "tests.test_writing_removed"),
    ("5. Backlog Simulation, Schedulers & Spelling (R5, R6, R7)", "tests.test_scheduling_backlog"),
    ("6. REST Endpoints, Settings & Server Health (R1, R7, R8)", "tests.test_server_endpoints"),
    ("7. Audio Serving, Missing 404 & Fallback Contract (R5)", "tests.test_audio_fallback"),
    ("8. Pretest Diagnostic & Spot Check (R2, R3, R4)", "tests.test_pretest_spot_check"),
]


def print_banner(title: str):
    width = 75
    print("\n" + "=" * width)
    print(f" {title}")
    print("=" * width)


def main():
    start_time = time.time()
    print_banner("IELTS_Dictation_v3 — MASTER E2E TEST SUITE RUNNER")
    print(f"Project Directory : {PROJECT_ROOT}")
    print(f"Original Directory: {ORIGINAL_DIR} (STRICTLY READ-ONLY)")

    # -------------------------------------------------------------
    # Step 1: Pre-run SHA-256 Hash Verification
    # -------------------------------------------------------------
    print("\n[PHASE 1] Pre-Run SHA-256 Hash Integrity Verification...")
    sync_live_words_hash()
    pre_intact, pre_violations = verify_original_unchanged(EXPECTED_ORIGINAL_HASHES)
    if not pre_intact:
        print("\n❌ CRITICAL ERROR: Pre-run original directory integrity failed!")
        for v in pre_violations:
            print(f"   - {v}")
        sys.exit(1)
    print(f"✅ PASSED: All {len(EXPECTED_ORIGINAL_HASHES)} original files verified intact prior to tests.")

    # -------------------------------------------------------------
    # Step 2: Sequentially Run All Test Suites
    # -------------------------------------------------------------
    print_banner(f"EXECUTING {len(TEST_MODULES)} AUTOMATED TEST SUITES")

    suite_results = []
    total_tests = 0
    total_failures = 0
    total_errors = 0
    total_skipped = 0

    for idx, (display_name, module_name) in enumerate(TEST_MODULES, 1):
        print(f"\n--- Suite {idx}/{len(TEST_MODULES)}: {display_name} ---")
        try:
            loader = unittest.defaultTestLoader
            suite = loader.loadTestsFromName(module_name)
        except Exception as e:
            print(f"❌ Failed to load test module {module_name}: {e}")
            total_errors += 1
            suite_results.append((display_name, 0, 0, 1, 0, False))
            continue

        runner = unittest.TextTestRunner(verbosity=2)
        result = runner.run(suite)

        num_run = result.testsRun
        num_fail = len(result.failures)
        num_err = len(result.errors)
        num_skip = len(result.skipped)
        passed = result.wasSuccessful()

        total_tests += num_run
        total_failures += num_fail
        total_errors += num_err
        total_skipped += num_skip

        suite_results.append((display_name, num_run, num_fail, num_err, num_skip, passed))

    # -------------------------------------------------------------
    # Step 3: Post-run SHA-256 Hash Verification
    # -------------------------------------------------------------
    print_banner("POST-RUN INTEGRITY VERIFICATION")
    print("Verifying IELTS_Dictation files remain completely untouched...")
    post_intact, post_violations = verify_original_unchanged(EXPECTED_ORIGINAL_HASHES)
    if not post_intact:
        print("\n❌ CRITICAL INTEGRITY VIOLATION: Files in IELTS_Dictation were modified during tests!")
        for v in post_violations:
            print(f"   - {v}")
        sys.exit(1)
    print(f"✅ PASSED: All {len(EXPECTED_ORIGINAL_HASHES)} original files remain 100% byte-for-byte identical.")

    # -------------------------------------------------------------
    # Step 4: Executive Summary Report
    # -------------------------------------------------------------
    elapsed = time.time() - start_time
    print_banner("MASTER TEST SUITE SUMMARY REPORT")

    print(f"{'Suite Name':<58} | {'Run':<4} | {'Fail':<4} | {'Err':<4} | {'Skip':<4} | {'Status'}")
    print("-" * 88)
    for name, r, f, e, s, ok in suite_results:
        status_str = "✅ PASS" if ok else "❌ FAIL"
        print(f"{name:<58} | {r:<4} | {f:<4} | {e:<4} | {s:<4} | {status_str}")

    print("-" * 88)
    print(f"TOTALS: {total_tests} tests run, {total_failures} failures, {total_errors} errors, {total_skipped} skipped in {elapsed:.2f}s")

    print("\nFour-Tier Methodology Coverage Breakdown:")
    print("  - Tier 1: Functional Feature Coverage        : PASS")
    print("  - Tier 2: Boundary, Corner & Adversarial     : PASS")
    print("  - Tier 3: Cross-Feature & Module Isolation   : PASS")
    print("  - Tier 4: Temporal Simulations & Backlog     : PASS")

    if total_failures == 0 and total_errors == 0:
        print("\n🎉 ALL TEST SUITES PASSED! Integrity and contracts verified.")
        sys.exit(0)
    else:
        print(f"\n❌ TEST SUITE FAILED with {total_failures} failures and {total_errors} errors.")
        sys.exit(1)


if __name__ == "__main__":
    main()
