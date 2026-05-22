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

claude -p "You are running a nightly memory consolidation pass. Do the following:

1. Read today's daily notes: memories/dailies/${TODAY}.md
2. Read memories/MEMORY.md and memories/OLD_MEMORY.md
3. Look for items marked with <!-- PROMOTE --> or facts that are durable and useful across sessions
4. Update memories:
   - Append promoted items to memories/MEMORY.md (keep it concise, one line per fact)
   - Move older or less high-signal items from memories/MEMORY.md to memories/OLD_MEMORY.md to keep MEMORY.md lean
   - Remove any items from memories/MEMORY.md that are now outdated or contradicted
5. Update memories/changelog.json:
   - Append a new entry for today's date
   - The entry must include: 'date', 'added_to_memory', 'removed_from_memory', 'added_to_old_memory', and a brief 'summary'
   - Read the existing file first to ensure you append to the JSON array correctly

Be selective. memories/MEMORY.md should stay short and high-signal." \
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
