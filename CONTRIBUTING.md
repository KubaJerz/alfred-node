# Contributing to Alfred Node

Guidance for Claude Code (and humans) working **on** this repository. The bot's
own runtime instructions live in `agent/SOUL.md`; this file is the dev workflow.

## What this is

**Alfred Node** is a personal AI assistant that bridges Discord and a headless
Claude Code instance. `bot.js` is the whole app: it listens for Discord
messages from authorized users, injects context (`agent/SOUL.md`,
`agent/var/USER.md`, and the memory files), runs `claude -p ...` as a
subprocess, and replies with the result. A nightly `dream.sh` pass consolidates
daily notes into long-term memory.

- **Entry point:** `bot.js` (ES modules, `"type": "module"`)
- **Runtime:** Node.js (currently v24.x via nvm) + `discord.js` v14
- **Secrets:** live in `.env` (gitignored). Never commit real tokens. `env.example` documents the keys.
- **Attachments:** Alfred can send files by emitting `{img:path}` / `{pdf:path}` / `{file:path}` in its reply; `bot.js` extracts these, attaches the files, and strips the tokens. Documented for the agent in `agent/SOUL.md`.

### Three layers, kept apart

See `CLAUDE.md` for the full table. The short version:

| path | holds | committed? |
|---|---|---|
| repo root | app + dev process | yes |
| `agent/` | Alfred's config; also its cwd | yes |
| `agent/var/` | memories, transcripts, logs, `USER.md` | **never** |

`agent/var/` is personal data, guarded by a single `.gitignore` rule. Don't add
exceptions to it, don't move state files out of it, and don't add anything to
`agent/` that a person editing this repo needs — that belongs at the root.
`bot.js` resolves all three from its own module path; `AGENT_DIR`/`STATE_DIR`
override them but should normally stay unset.

### CLI tools carry their own manual

Every CLI under `bin/` answers `--help` two ways: the whole surface as one line
per command, and a single command in full via `<command> --help` (with
`help <command>` as an alias). `help()` in `bin/lib/broker-client.js` does both
from a `name -> { use, detail }` table, so a new tool fills in the table rather
than writing help text.

Both spellings are ordinary — git, docker and cargo all take them. What's
deliberate is the *split*. Alfred's context is a budget, and a skill that
restates every flag spends it on the twenty commands he isn't running. So the
skill carries a one-line command list plus the rules a usage block can't express
(Eastern times, what the colours mean, withheld means stop), and the detail for
one command stays a shell call away. Progressive disclosure: he pulls the page
he needs, not the manual.

Three properties are easy to break and each one has bitten:

- **`--help` must work with no broker in the environment.** Check credentials on
  first use, not at import, or "run `--help` for the flags" is a dead pointer.
- **Help exits 0 on stdout.** It's an answer, not a failure — `set -e` and piped
  reads treat the difference as real.
- **Help is checked before dispatch.** `delete --help` once fell through into
  `delete`, so asking how a command worked *attempted* it. `test/cli.test.js`
  asserts help never reaches the broker; extend it when you add a command.

`--help <command>` is deliberately not a form. Nothing takes an argument to
`--help`, and inventing that would be a local convention to memorise.

## Working agreement (READ BEFORE CHANGING CODE)

This repo follows a lightweight **issue → branch → PR → version** flow. The goal
is that every meaningful change is traceable and `main` always works.

### 1. Branch — never commit directly to `main`
- Cut a branch for every change. Naming: `type/short-description`
  (e.g. `fix/dns-crash-resilience`, `feat/slash-status-command`, `chore/repo-bootstrap`).
- Allowed types: `feat`, `fix`, `chore`, `docs`, `refactor`.

### 2. Issue first — for features and bug fixes
- **Bugs and features** start as a GitHub issue describing the problem and intended outcome, then a PR that closes it.
  - Open it with `gh issue create`, and reference it in the PR body with `Closes #<n>`.
- **Trivial changes** (typos, comments, formatting, doc tweaks) may skip the issue and go straight to a small PR.
- When in doubt, open the issue — it's cheap and keeps history readable.

### 3. PR — one concern per PR
- Keep PRs focused on a single issue/concern. Don't mix a bug fix with unrelated refactors.
- Open with `gh pr create`. The body should explain **what** changed and **why**, and link the issue.
- Title uses Conventional-Commit style: `fix: prevent crash on transient DNS failure`.

### 4. Version — SemVer + CHANGELOG on every PR that changes behavior
- Versioning is [SemVer](https://semver.org/): `MAJOR.MINOR.PATCH` in `package.json`.
  - `PATCH` — bug fixes, no API/behavior change for the user.
  - `MINOR` — new backward-compatible features (e.g. a new command).
  - `MAJOR` — breaking changes (config format, removed commands, etc.).
- Every behavior-changing PR:
  1. Adds an entry under `## [Unreleased]` in `CHANGELOG.md` (categorized: Added / Changed / Fixed / Removed).
  2. Bumps the version in `package.json` to match.
- On release, move `[Unreleased]` entries under a new `## [x.y.z] - YYYY-MM-DD` heading and tag the commit: `git tag vx.y.z && git push --tags`.
- `chore`/`docs` PRs that don't change runtime behavior don't need a version bump.

## Commit messages
Use Conventional Commits: `type: summary` (e.g. `fix: catch sendTyping rejection`).
Keep the summary imperative and under ~72 chars.

## First-time setup

Install the pre-commit hook — one line, once per clone:

```sh
git config core.hooksPath .githooks
```

This runs `npm run check` before every commit and blocks anything personal from
being staged. It's opt-in because git won't run repo-supplied hooks without it.

## Sanity checks before opening a PR
- `node --check bot.js` — must pass (no syntax errors).
- `npm run check` — no personal files or secret-shaped content staged. The
  pre-commit hook runs this for you if you did the setup above.
- `npm test` — the suite under `test/` (node:test, no network, no real
  credentials). The pre-commit hook runs it too, so a failing test blocks the
  commit.

## Never in git

`.gitignore` keeps `.env`, `node_modules/` and `agent/var/` out, but a rule only
protects what someone remembers to look at — and Alfred runs in this repo with
`Bash`, `Write` and `--dangerously-skip-permissions`, so "nobody would do that"
isn't a guarantee here. `scripts/check-no-secrets.sh` enforces it on the staged
set instead:

1. Anything under `agent/var/` or named `.env`, by path — so a weakened
   `.gitignore` can't silently re-open the hole.
2. Any gitignored file that reached the index anyway, i.e. `git add -f`.
3. Secret-shaped content (private keys, `GOCSPX-`, `AIza…`, `ya29.`,
   refresh tokens, GitHub/OpenAI tokens, Discord bot tokens) in added lines,
   for credentials pasted into a file whose location is perfectly legitimate.
4. Runtime state at the repo root (`var/`, `logs/`, `state.json`) — a warning,
   not a block, since this one guesses.

`git commit --no-verify` bypasses it. If you need that, you almost certainly
want to fix the staging instead.
