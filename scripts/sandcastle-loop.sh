#!/usr/bin/env bash
# Continuously runs `npm run sandcastle`, monitoring for queued work:
#   - exit 0   (a full cycle ran)        -> run again immediately
#   - exit 3   (idle, no work to do)     -> sleep, then re-check for new issues
#   - any other non-zero (a real error)  -> stop and propagate the code
# The loop only stops on a real failure or Ctrl-C; being idle is NOT a stop, so it
# keeps watching for newly-tagged issues.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

# Must match IDLE_EXIT_CODE exported by @copperbox/sandcastle-workflow.
IDLE_EXIT_CODE=3
# Seconds to wait before re-checking when there is no work (override with env).
IDLE_SLEEP_SECONDS="${SANDCASTLE_IDLE_SLEEP:-15}"

run=0
while true; do
  run=$((run + 1))
  echo "=== sandcastle run #$run ==="
  npm run sandcastle
  code=$?
  if [ "$code" -eq "$IDLE_EXIT_CODE" ]; then
    echo "=== no sandcastle work; sleeping ${IDLE_SLEEP_SECONDS}s before re-checking ==="
    sleep "$IDLE_SLEEP_SECONDS"
    continue
  fi
  if [ "$code" -ne 0 ]; then
    echo "=== sandcastle exited with code $code; stopping after $run run(s) ==="
    exit "$code"
  fi
done
