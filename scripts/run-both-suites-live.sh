#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="/home/dev/tmp/kilo/personal/bookorbit-plugin-shelfmark/work"
FIXTURES_DIR="/home/dev/tmp/kilo/personal/bookorbit-plugin-shelfmark/fixtures"

mkdir -p "$WORK_DIR"

echo "=========================================================="
echo "Starting Full Live Evaluation for Suite 1 & Suite 2"
echo "Suite 1: $FIXTURES_DIR/bookorbit_first_suite_english_explicit_titles.json"
echo "Suite 2: $FIXTURES_DIR/bookorbit_second_suite_english_explicit_titles_max10.json"
echo "Start time: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "=========================================================="

CONCURRENCY=2 DELAY_MS=250 CORPUS_PATH="$FIXTURES_DIR/bookorbit_first_suite_english_explicit_titles.json" REPORT_PATH="$WORK_DIR/suite1-full-live-report.json" node "$DIR/scripts/run-corpus-test.mjs" > "$WORK_DIR/suite1-live.log" 2>&1 &
PID1=$!
echo "Suite 1 running in background with PID $PID1 (logging to $WORK_DIR/suite1-live.log)"

CONCURRENCY=2 DELAY_MS=250 CORPUS_PATH="$FIXTURES_DIR/bookorbit_second_suite_english_explicit_titles_max10.json" REPORT_PATH="$WORK_DIR/suite2-full-live-report.json" node "$DIR/scripts/run-corpus-test.mjs" > "$WORK_DIR/suite2-live.log" 2>&1 &
PID2=$!
echo "Suite 2 running in background with PID $PID2 (logging to $WORK_DIR/suite2-live.log)"

echo "Both suites launched successfully."
wait $PID1
echo "Suite 1 finished at $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
wait $PID2
echo "Suite 2 finished at $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "Full evaluation run complete."
