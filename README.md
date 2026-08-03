# Alfred Node

Alfred Node is a phrygentic personal AI assistant built as a bridge between Discord and a headless Claude instance. It features a multi-tiered memory system and a nightly "dreaming" pass to maintain a lean, high-signal context.

## How it Works

- **Headless Claude**: Alfred runs Claude Code programmatically, managing sessions and context injection without a terminal UI.
- **Phrygentic Memory**:
    - **Daily Notes**: Active session context is logged to `agent/var/memories/dailies/`.
    - **Dreaming**: A nightly pass (`dream.sh`) consolidates daily notes into `agent/var/memories/MEMORY.md`, a single lean long-term store.
- **Context Injection**: New sessions automatically load `agent/SOUL.md` (instructions), `agent/var/USER.md` (preferences), and long-term memories.

## Layout

The app, Alfred's config, and Alfred's personal data are kept strictly apart:

```
alfred-node/          the app + dev docs        (git)
├── bot.js  dream.sh  start-alfred.sh
└── agent/            Alfred's config, and its working directory  (git)
    ├── SOUL.md  CLAUDE.md  memory-prompt.md
    └── var/          memories, transcripts, logs, USER.md   (NEVER git)
```

Everything personal lives under `agent/var/`, which is gitignored as a whole —
so nothing you tell Alfred can end up in a commit.

## Setup

1. **Clone and Install**
   ```bash
   cd ~/alfred-node
   npm install
   ```

2. **Set Environment Variables**
   ```bash
   cp env.example .env
   ```
   Fill in `DISCORD_TOKEN` and `ALLOWED_USER_IDS`. Leave the path variables
   commented out unless you deliberately relocate Alfred's files.

3. **Run the Bot**
   ```bash
   npm start
   ```
   On first run the bot creates `agent/var/` and seeds `agent/var/USER.md` from
   `agent/USER.md.example`. Edit that copy to tell Alfred who you are.

4. **Setup Nightly Dreaming (Optional)**
   Add a crontab entry to run the memory consolidation pass:
   ```bash
   0 3 * * * ~/alfred-node/dream.sh >> ~/alfred-node/agent/var/logs/dream.log 2>&1
   ```

## Commands

- **Any message**: Sends the prompt to Claude.
- **`/clear` or `/c`**: Resets the current session state. The next message will start a fresh Claude instance with full context.

## Requirements

- Node.js 18+
- [Claude CLI](https://github.com/anthropics/claude-code) installed and authenticated.
- Discord Bot Token with `Message Content Intent` enabled.
