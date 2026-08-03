# CLAUDE.md

**Alfred Node** — a personal AI assistant bridging Discord and a headless Claude
Code instance. `bot.js` is the whole app.

This file is for whoever is *working on* this repo. Alfred never reads it — it
runs out of `agent/`, so Claude Code loads `agent/CLAUDE.md` instead. Dev-process
detail belongs here; keep it out of `agent/`.

## Layout

Three kinds of files, deliberately kept apart:

| path | what | in git? |
|---|---|---|
| repo root | the app + dev process — `bot.js`, `CLAUDE.md`, `CONTRIBUTING.md`, `TODO.md` | yes |
| `agent/` | Alfred's config — `SOUL.md`, `CLAUDE.md`, `memory-prompt.md`. Also its cwd. | yes |
| `agent/var/` | Alfred's state — memories, transcripts, `state.json`, logs, `USER.md` | **never** |

`agent/var/` is personal data. One `.gitignore` rule covers the whole tree;
don't add exceptions to it, and don't move state files out of it.

`bot.js` derives all three from `REPO_DIR` (resolved from the module path, not
cwd). `AGENT_DIR` and `STATE_DIR` can be overridden by env var.

New files go in the layer that owns them: a new prompt in `agent/`, anything
Alfred writes at runtime under `agent/var/`, everything else at the root.

## Developing this repo?

Read **`CONTRIBUTING.md`** — it covers the issue → branch → PR → SemVer/CHANGELOG
workflow, commit style, and the sanity checks to run before opening a PR.
`TODO.md` is the working backlog.

Two hard rules regardless: never commit secrets (`.env` is gitignored), and
never commit directly to `main`.
