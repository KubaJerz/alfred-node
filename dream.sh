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
#
# Eastern, explicitly, so this agrees with the rest of Alfred (dailies.js keys
# every day on America/New_York): the "day that just ended" must be the same day
# the notes were filed under. A named zone handles DST for free.
TARGET=$(TZ=America/New_York date -d yesterday +%Y-%m-%d)
NOTES_FILE="var/memories/dailies/${TARGET}/daily.md"

# Fold the chat ledger first: each message not folded yet, up to the end of
# yesterday, goes into the daily note of its own day (scripts/fold-day.mjs,
# fold.js). Before this, only /clear wrote a note from the chat, so most nights
# found no note and skipped. A failed fold is logged, and the dream still runs.
# The next fold tries the same rows again.
echo "$(date): Folding the ledger into the daily notes…"
node "$REPO_DIR/scripts/fold-day.mjs" --nightly --agent-dir "$AGENT_DIR" --state-dir "$STATE_DIR" \
  || echo "$(date): fold failed (non-fatal)"

if [ ! -f "$NOTES_FILE" ]; then
  echo "$(date): No note for $TARGET (the day that just ended), skipping."
  exit 0
fi

echo "$(date): Starting dreaming pass for $TARGET..."

# --tools is what holds the pass to Read, Edit and Write: with
# --dangerously-skip-permissions, --allowedTools holds nothing back (a test
# fold wrote its notes with Bash and python). The notes now carry the day's
# folded chat, mail and web text included, so the pass gets no shell and no
# MCP server, like the fold (claudeRunner in fold.js).
claude -p "You are Alfred's nightly dreaming pass — promote only durable facts into long-term memory.

1. Read the daily note for the day that just ended: var/memories/dailies/${TARGET}/daily.md
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
  --tools "Read,Edit,Write" --strict-mcp-config \
  --allowedTools "Read,Edit,Write" \
  --dangerously-skip-permissions

# Nightly strength digest: pull new Garmin lifts, interpret them with the Haiku
# pass, and recompute the rolling load. Runs here because dream.sh is the repo's
# one nightly hook; it self-skips when INTERVALS_API_KEY isn't set, and a failure
# must never abort the dreaming pass, so it's guarded.
echo "$(date): Strength digest…"
node "$REPO_DIR/strength/nightly.js" || echo "$(date): strength digest failed (non-fatal)"

# Record that a pass ran. The bot owns state.json — this used to overwrite it
# directly, which reset the session out from under an in-progress conversation
# if the pass landed mid-chat. The bot reads this stamp instead and starts a
# fresh session on the next message, so it picks up the rewritten memory.
date -Iseconds > "$STATE_DIR/last-dream"

echo "$(date): Dreaming complete."
