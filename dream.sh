#!/bin/bash
# dream.sh — Run nightly via cron to consolidate daily notes
# Crontab entry: 0 3 * * * /path/to/alfred-node/dream.sh

# The script lives at the repo root, but the pass runs as Alfred: cwd is
# AGENT_DIR so `claude` picks up agent/CLAUDE.md, and all memory paths are
# relative to it, under the gitignored var/ tree.
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="${AGENT_DIR:-$REPO_DIR/agent}"
STATE_DIR="${STATE_DIR:-$AGENT_DIR/var}"
cd "$AGENT_DIR" || exit 1

# Consolidate the note for the day that just ENDED, not the calendar day the
# pass wakes on. Cron fires at 03:00, but daily notes are written through the
# day (afternoon/evening), so at 3am "today's" note does not exist yet while
# yesterday's is complete and waiting. Keying on today meant the guard below
# fired every night and MEMORY.md never filled.
TARGET=$(date -d yesterday +%Y-%m-%d)
NOTES_FILE="var/memories/dailies/${TARGET}.md"

if [ ! -f "$NOTES_FILE" ]; then
  echo "$(date): No note for $TARGET (the day that just ended), skipping."
  exit 0
fi

echo "$(date): Starting dreaming pass for $TARGET..."

claude -p "You are Alfred's nightly dreaming pass — promote only durable facts into long-term memory.

1. Read the daily note for the day that just ended: var/memories/dailies/${TARGET}.md
2. Read current long-term memory: var/memories/MEMORY.md

Promote into var/memories/MEMORY.md only facts that stay true across sessions:
stable preferences, ongoing projects, key people, standing decisions. Prefer
items tagged <!-- PROMOTE -->.

Be strict — most daily lines should NOT be promoted. Skip anything one-off,
time-bound, or already in MEMORY.md. Remove memory items that are now outdated
or contradicted. One concise line per fact; keep MEMORY.md short.

If nothing qualifies, that's completely fine — promote nothing and leave
MEMORY.md unchanged. Don't force a promotion just to have something to add.

Then append an entry to var/memories/changelog.json (read it first):
{ 'date', 'added_to_memory', 'removed_from_memory', 'summary' } — use empty
lists when nothing changed, so the log still records that the pass ran." \
  --output-format json \
  --allowedTools "Bash,Read,Edit,Write" \
  --dangerously-skip-permissions

# Record that a pass ran. The bot owns state.json — this used to overwrite it
# directly, which reset the session out from under an in-progress conversation
# if the pass landed mid-chat. The bot reads this stamp instead and starts a
# fresh session on the next message, so it picks up the rewritten memory.
date -Iseconds > "$STATE_DIR/last-dream"

echo "$(date): Dreaming complete."
