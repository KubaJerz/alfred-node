# CLAUDE.md

**Alfred Node** — a personal AI assistant that bridges Discord and a headless
Claude Code instance. `bot.js` is the whole app. Alfred's own runtime
instructions (persona, memory rules, tone, sending files) live in `SOUL.md`.

> **Note:** this file is auto-loaded into Alfred's own prompt at runtime (the bot
> spawns `claude` in this directory), so keep it short and free of dev-process
> noise. The full contributor workflow lives in `CONTRIBUTING.md`, which is *not*
> auto-loaded.

## Developing this repo?

Read **`CONTRIBUTING.md`** before changing code — it covers the
issue → branch → PR → SemVer/CHANGELOG workflow, commit style, and the sanity
checks to run before opening a PR.

Two hard rules regardless: never commit secrets (`.env` is gitignored), and
never commit directly to `main`.
