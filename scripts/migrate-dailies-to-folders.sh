#!/usr/bin/env bash
# One-time migration: flat daily notes -> per-day folders.
#
#   var/memories/dailies/2026-08-14.md   ->   var/memories/dailies/2026-08-14/daily.md
#
# Alfred moved from one .md file per day to one folder per day (so a day's note
# and the files the user sent that day live and prune together). This moves the
# existing flat notes into the new layout. It touches gitignored personal state
# under agent/var/, never tracked files, so it uses plain `mv`.
#
# Idempotent: a note already migrated is skipped, so it's safe to re-run. Run it
# AFTER the bot is on the new code (a still-running old process reads the flat
# path and won't find a migrated note until it restarts).
#
# Usage:
#   scripts/migrate-dailies-to-folders.sh                 # default live dailies
#   scripts/migrate-dailies-to-folders.sh <dailies-dir>   # e.g. a test fixture
set -euo pipefail

DAILIES="${1:-agent/var/memories/dailies}"
[ -d "$DAILIES" ] || { echo "No dailies dir at $DAILIES — nothing to do."; exit 0; }

shopt -s nullglob
moved=0
for f in "$DAILIES"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].md; do
  date="$(basename "$f" .md)"
  dir="$DAILIES/$date"
  if [ -e "$dir/daily.md" ]; then
    echo "skip   $date  (already has $date/daily.md)"
    continue
  fi
  mkdir -p "$dir"
  mv "$f" "$dir/daily.md"
  echo "moved  $date.md -> $date/daily.md"
  moved=$((moved + 1))
done

echo "Done. Migrated $moved note(s)."
