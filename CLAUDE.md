# CLAUDE.md

**Alfred Node** — a personal AI assistant bridging Discord and a headless Claude
Code instance. `bot.js` is the whole app.

This file is for whoever is *working on* this repo. Alfred never reads it — it
runs out of `agent/`, so Claude Code loads `agent/CLAUDE.md` instead. Dev-process
detail belongs here; keep it out of `agent/`.

## Layout

Four kinds of files, deliberately kept apart:

| path | what | in git? |
|---|---|---|
| repo root | the app + dev process — `bot.js`, `CLAUDE.md`, `CONTRIBUTING.md`, `TODO.md` | yes |
| `agent/` | Alfred's config — `SOUL.md`, `CLAUDE.md`, `memory-prompt.md`. Also its cwd. | yes |
| `agent/.claude/skills/` | per-capability instructions Claude Code loads on its own (`gmail`, `gcal`) | yes |
| `agent/var/` | Alfred's state — memories, transcripts, `state.json`, logs, `USER.md` | **never** |

`agent/var/` is personal data. One `.gitignore` rule covers the whole tree;
don't add exceptions to it, and don't move state files out of it.

`agent/.claude/skills/` is the one layer that is configuration Alfred reads but
that nobody put in a prompt. Each `<name>/SKILL.md` carries YAML frontmatter, and
its `description` is the entire trigger surface: Claude Code keeps only the
descriptions in context and loads the body when one matches what the user said.
So a skill is only as good as the words in its description — write those for the
phrasing a Discord message uses, not the vocabulary of this repo. It is tracked
in git, unlike `agent/var/`, so treat it as public and keep personal detail out.

One trap worth knowing: skill discovery is a plain walk **up** the directory tree
from Alfred's cwd, not a project-root lookup. A `.claude/skills/` at the repo
root would therefore load into Alfred too, and the "Alfred never reads this
layer" rule above would quietly stop being true. Keep the repo root free of one.

`bot.js` derives the paths from `REPO_DIR` (resolved from the module path, not
cwd). `AGENT_DIR` and `STATE_DIR` can be overridden by env var.

New files go in the layer that owns them: a new prompt in `agent/`, instructions
for a specific capability in `agent/.claude/skills/<name>/SKILL.md`, anything
Alfred writes at runtime under `agent/var/`, everything else at the root.

## Developing this repo?

Read **`CONTRIBUTING.md`** — it covers the issue → branch → PR → SemVer/CHANGELOG
workflow, commit style, and the sanity checks to run before opening a PR.
`TODO.md` is the working backlog.

Two hard rules regardless: never commit secrets (`.env` is gitignored), and
never commit directly to `main`.
