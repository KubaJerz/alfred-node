#!/usr/bin/env bash
# Launcher: keeps the bot alive under tmux. Started at boot from cron.

# Derive paths from this script's location so the repo can move without
# editing hardcoded paths here. The log is runtime state, so it lives in the
# gitignored var/ tree with everything else personal.
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$REPO_DIR/agent/var/logs"
LOG="$LOG_DIR/alfred.log"
mkdir -p "$LOG_DIR"

# Keep one generation back. Rotation runs before every launch rather than only
# at boot, because this script normally runs for months at a stretch.
MAX_LOG_BYTES="${MAX_LOG_BYTES:-52428800}" # 50 MB

rotate_log() {
  [ -f "$LOG" ] || return 0
  local size
  size=$(stat -c%s "$LOG" 2>/dev/null || echo 0)
  [ "$size" -gt "$MAX_LOG_BYTES" ] || return 0
  mv -f "$LOG" "$LOG.1"
  echo "=== rotated at $(date); previous log kept at $(basename "$LOG").1 ===" >> "$LOG"
}

say() { echo "$@" >> "$LOG" 2>/dev/null; }

# Resolve discord.com before launching. At @reboot cron starts us before the
# network is up, and after a suspend it can be down again — so this is checked
# before every launch, not just the first.
wait_for_dns() {
  local i
  for i in $(seq 1 60); do
    getent hosts discord.com >/dev/null 2>&1 && return 0
    [ "$i" = 1 ] && say "waiting for network/DNS..."
    sleep 2
  done
  return 1
}

rotate_log
say "=== alfred starting at $(date) ==="

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use default >> "$LOG" 2>&1

# This is a non-login shell, so it doesn't read ~/.profile — which is what
# normally puts ~/.local/bin on PATH. The bot shells out to `claude`, which
# lives there, so without this it fails to spawn (ENOENT / "Claude exited -2").
export PATH="$HOME/.local/bin:$PATH"
say "claude: $(command -v claude || echo NOT FOUND)"

cd "$REPO_DIR" || exit 1
say "node: $(command -v node) ($(node -v 2>&1))"

# Keep Alfred alive, but back off when he can't start. A flat 5s retry turned a
# single network outage into ~11k restarts a day, each one a stack trace in the
# log. Exit code 75 (EX_TEMPFAIL) means "no network yet" — expected, so it's
# logged as one quiet line rather than a crash.
BACKOFF_MIN=5
BACKOFF_MAX=300
HEALTHY_SECS=60 # ran at least this long => treat the next failure as fresh
backoff=$BACKOFF_MIN

while true; do
  rotate_log
  wait_for_dns || say "network still down after 2min — launching anyway"

  say "=== launching bot at $(date) ==="
  started=$(date +%s)
  npm start >> "$LOG" 2>&1
  code=$?
  ran=$(( $(date +%s) - started ))

  if [ "$ran" -ge "$HEALTHY_SECS" ]; then
    backoff=$BACKOFF_MIN
  else
    backoff=$(( backoff * 2 ))
    [ "$backoff" -gt "$BACKOFF_MAX" ] && backoff=$BACKOFF_MAX
  fi

  if [ "$code" = 75 ]; then
    say "=== no network at $(date); retrying in ${backoff}s ==="
  else
    say "=== bot exited (code $code) after ${ran}s at $(date); restarting in ${backoff}s ==="
  fi
  sleep "$backoff"
done
