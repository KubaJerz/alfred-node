# Alfred Node

Alfred Node is a phrygentic personal AI assistant built as a bridge between Discord and a headless Claude instance. It features a multi-tiered memory system and a nightly "dreaming" pass to maintain a lean, high-signal context.

## How it Works

- **Headless Claude**: Alfred runs Claude Code programmatically, managing sessions and context injection without a terminal UI.
- **Phrygentic Memory**:
    - **Daily Notes**: Active session context is logged to `memories/dailies/`.
    - **Dreaming**: A nightly pass (`dream.sh`) consolidates daily notes into `memories/MEMORY.md`, a single lean long-term store.
- **Context Injection**: New sessions automatically load your `SOUL.md` (instructions), `USER.md` (preferences), and long-term memories.

## Setup

1. **Clone and Install**
   ```bash
   cd ~/alfred-node
   npm install
   ```

2. **Set Environment Variables**
   Create a `.env` file in the root directory:
   ```env
   DISCORD_TOKEN="your-discord-bot-token"
   ALLOWED_USER_IDS="your-discord-user-id"
   # Optional:
   CLAUDE_TIMEOUT_MS="120000"
   ```
   The bot uses `dotenv` to automatically load these variables at startup.

3. **Run the Bot**
   ```bash
   node bot.js
   ```

4. **Setup Nightly Dreaming (Optional)**
   Add a crontab entry to run the memory consolidation pass:
   ```bash
   0 3 * * * ~/alfred-node/dream.sh >> ~/alfred-node/dream.log 2>&1
   ```

## Commands

- **Any message**: Sends the prompt to Claude.
- **`/clear` or `/c`**: Resets the current session state. The next message will start a fresh Claude instance with full context.

## Requirements

- Node.js 18+
- [Claude CLI](https://github.com/anthropics/claude-code) installed and authenticated.
- Discord Bot Token with `Message Content Intent` enabled.
