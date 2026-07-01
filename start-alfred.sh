#!/usr/bin/env bash
exec >> /home/koob/agents/alfred-node/alfred.log 2>&1
echo "=== alfred starting at $(date) ==="

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use default

# This is a non-login shell, so it doesn't read ~/.profile — which is what
# normally puts ~/.local/bin on PATH. The bot shells out to `claude`, which
# lives there, so without this it fails to spawn (ENOENT / "Claude exited -2").
export PATH="$HOME/.local/bin:$PATH"
echo "claude: $(command -v claude || echo NOT FOUND)"

cd /home/koob/agents/alfred-node || exit 1
echo "node: $(command -v node) ($(node -v 2>&1))"

# At @reboot, cron starts us before the network/DNS is ready, so the bot
# would crash with EAI_AGAIN and the tmux session would die instantly.
# Wait (up to ~2 min) until discord.com resolves before launching.
for i in $(seq 1 60); do
  if getent hosts discord.com >/dev/null 2>&1; then
    echo "network ready after $i check(s)"
    break
  fi
  echo "waiting for network/DNS... ($i)"
  sleep 2
done

# Keep Alfred alive: if the bot exits or crashes for any reason, restart it.
# This loop never returns, so the tmux session stays up permanently.
while true; do
  echo "=== launching bot at $(date) ==="
  npm start
  echo "=== bot exited (code $?) at $(date); restarting in 5s ==="
  sleep 5
done
