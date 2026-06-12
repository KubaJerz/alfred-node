# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## What this is

**Alfred Node** is a personal AI assistant that bridges Discord and a headless
Claude Code instance. `bot.js` is the whole app: it listens for Discord
messages from authorized users, injects context (`SOUL.md`, `USER.md`, and the
memory files), runs `claude -p ...` as a subprocess, and replies with the
result. A nightly `dream.sh` pass consolidates daily notes into long-term memory.

- **Entry point:** `bot.js` (ES modules, `"type": "module"`)
- **Runtime:** Node.js (currently v24.x via nvm) + `discord.js` v14
- **Secrets:** live in `.env` (gitignored). Never commit real tokens. `env.example` documents the keys.
- **Runtime artifacts** (`alfred.log`, `state.json`, `node_modules/`) are gitignored — do not commit them.

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

## Sanity checks before opening a PR
- `node --check bot.js` — must pass (no syntax errors).
- Confirm no secrets (`.env`, tokens) are staged: `git diff --cached --stat`.
- There is no automated test suite yet; if you add one, wire it into `npm test` and run it before every PR.
