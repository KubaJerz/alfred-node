#!/usr/bin/env bash
exec >> /home/koob/agents/alfred-node/alfred.log 2>&1
echo "=== alfred starting at $(date) ==="
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use default
cd /home/koob/agents/alfred-node || exit 1
echo "node: $(command -v node) ($(node -v 2>&1))"
exec npm start
