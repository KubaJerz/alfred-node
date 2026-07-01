#!/bin/bash
# dream.sh — Run nightly via cron to consolidate daily notes
# Crontab entry: 0 3 * * * /path/to/my-agent/dream.sh >> /path/to/my-agent/dream.log 2>&1

AGENT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$AGENT_DIR"

TODAY=$(date +%Y-%m-%d)
NOTES_FILE="memories/dailies/${TODAY}.md"

if [ ! -f "$NOTES_FILE" ]; then
  echo "$(date): No notes for today ($TODAY), skipping."
  exit 0
fi

echo "$(date): Starting dreaming pass for $TODAY..."

claude -p "You are Alfred's nightly dreaming pass — promote only durable facts into long-term memory.

1. Read today's daily note: memories/dailies/${TODAY}.md
2. Read current long-term memory: memories/MEMORY.md

Promote into memories/MEMORY.md only facts that stay true across sessions:
stable preferences, ongoing projects, key people, standing decisions. Prefer
items tagged <!-- PROMOTE -->.

Be strict — most daily lines should NOT be promoted. Skip anything one-off,
time-bound, or already in MEMORY.md. Remove memory items that are now outdated
or contradicted. One concise line per fact; keep MEMORY.md short.

Then append an entry to memories/changelog.json (read it first):
{ 'date', 'added_to_memory', 'removed_from_memory', 'summary' }." \
  --output-format json \
  --allowedTools "Bash,Read,Edit,Write" \
  --dangerously-skip-permissions

# Mark session as resolved after dreaming
cat > state.json <<EOF
{
  "last_session_id": null,
  "status": "resolved",
  "topic": "nightly dreaming pass",
  "timestamp": "$(date -Iseconds)"
}
EOF

echo "$(date): Dreaming complete."
