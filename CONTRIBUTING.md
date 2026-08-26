# Contributing to Alfred Node

Rules for Claude Code (and humans) working **on** this repo. The bot's own
runtime instructions live in `agent/SOUL.md`. This file is the dev workflow.

Write everything here — code comments, commit messages, PR text, and chat with
the user about this project — in Simplified Technical English. See the last
section.

## What this is

**Alfred Node** bridges Discord and a headless Claude Code instance. `bot.js` is
the whole app. It listens for Discord messages from authorized users, injects
context (`agent/SOUL.md`, `agent/var/USER.md`, the memory files), runs
`claude -p ...` as a subprocess, and replies. A nightly `dream.sh` pass folds
daily notes into long-term memory.

- **Entry point:** `bot.js` (ES modules, `"type": "module"`)
- **Runtime:** Node.js v24.x via nvm, `discord.js` v14
- **Secrets:** live in `.env` (gitignored). Never commit real tokens.
  `env.example` documents the keys.
- **Attachments:** Alfred sends files with `{img:path}` / `{pdf:path}` /
  `{file:path}` tokens in its reply. `bot.js` extracts the files and strips the
  tokens. See `agent/SOUL.md`.

## Three layers, kept apart

| path | holds | committed? |
|---|---|---|
| repo root | app + dev process | yes |
| `agent/` | Alfred's config; also its cwd | yes |
| `agent/var/` | memories, transcripts, logs, `USER.md` | **never** |

- `agent/var/` is personal data. One `.gitignore` rule guards it. Do not add
  exceptions. Do not move state files out of it.
- Do not add anything to `agent/` that a person editing this repo needs. That
  belongs at the root.
- `bot.js` resolves all three paths from its own module path. `AGENT_DIR` and
  `STATE_DIR` override them but must normally stay unset.

See `CLAUDE.md` for the full table.

## CLI tools carry their own help

Every CLI under `bin/` answers `--help` two ways: the whole surface as one line
per command, and one command in full via `<command> --help` (or
`help <command>`). `help()` in `bin/lib/broker-client.js` builds both from a
`name -> { use, detail }` table. A new tool fills in the table.

Three rules, each enforced by `test/cli.test.js`:

1. `--help` must work with no broker in the environment. Check credentials on
   first use, not at import.
2. Help exits 0 on stdout.
3. Help runs before dispatch. Extend `test/cli.test.js` when you add a command.

`--help <command>` is not a form. Nothing takes an argument to `--help`.

## The system map is part of the change

`SYSTEM-MAP.md` is a set of Mermaid diagrams of the live system. Its "Reading
this map" section states the visual grammar.

- **Design against it.** Point at where a change lands and which boxes or arrows
  it adds, moves, or deletes.
- **Update it in the same PR as the change, and only then.** Most changes touch
  nothing on it. Dev-side changes (a worktree helper, a `TODO.md` note, these
  docs) add no box. The map tracks the *system* — the app Alfred runs.
- **Run `npm run map:check` before the PR.** It flags drift. It is not in the
  pre-commit hook.

The map is hand-written. The checker verifies that it is accurate, not complete.

## Working agreement (READ BEFORE CHANGING CODE)

Flow: **issue → worktree branch → PR → version**. `main` always works.

### 1. Work in a worktree — always

Do all code work in a git worktree, one per branch. Never work directly in the
primary checkout, and never commit to `main`.

Use the helper. It cuts the branch, places the tree, and runs `npm install`:

```sh
scripts/worktree.sh feat/slash-status      # cut branch + worktree + npm install
scripts/worktree.sh ls                     # list them
scripts/worktree.sh rm feat/slash-status   # remove when merged (branch is kept)
```

Three rules:

- **A worktree is a clean checkout. Treat it as dev-only.** `.env`,
  `node_modules/`, and `agent/var/` are gitignored, so a fresh tree has none of
  them. Run `npm install` before the tests (the helper does it). Do not run the
  live bot from a worktree. Do not copy `.env` or `agent/var/` into it.
- **Worktrees live as siblings, never nested in the repo.** The helper puts them
  under `../alfred-node.worktrees/<branch>`.
- **Hooks come for free.** `core.hooksPath` lives in shared git config, so a new
  worktree runs the hooks with no setup. `npm run map:check` still does not run
  itself — run it before the PR.

Remove merged worktrees with `scripts/worktree.sh rm ...`. A stale worktree
keeps its branch checked out and blocks deleting it.

### 2. Branch naming

- Format: `type/short-description` (e.g. `fix/dns-crash-resilience`,
  `feat/slash-status-command`).
- Allowed types: `feat`, `fix`, `chore`, `docs`, `refactor`.

### 3. Issue first — for features and bug fixes

- Bugs and features start as a GitHub issue. Open it with `gh issue create`.
  Reference it in the PR body with `Closes #<n>`.
- Trivial changes (typos, comments, formatting, doc tweaks) skip the issue.
- When in doubt, open the issue.

### 4. PR — one concern per PR

- Keep each PR on a single concern. Do not mix a bug fix with an unrelated
  refactor.
- Open with `gh pr create`. The body explains **what** changed and **why**, and
  links the issue.
- Title uses Conventional-Commit style: `fix: prevent crash on transient DNS
  failure`.

### 5. Version — SemVer + CHANGELOG on every behavior change

- Version is [SemVer](https://semver.org/) `MAJOR.MINOR.PATCH` in
  `package.json`:
  - `PATCH` — bug fixes, no behavior change for the user.
  - `MINOR` — new backward-compatible features.
  - `MAJOR` — breaking changes.
- Every behavior-changing PR:
  1. Adds an entry under `## [Unreleased]` in `CHANGELOG.md`
     (Added / Changed / Fixed / Removed).
  2. Bumps the version in `package.json`.
- On release, move `[Unreleased]` under a new `## [x.y.z] - YYYY-MM-DD` heading
  and tag: `git tag vx.y.z && git push --tags`.
- `chore`/`docs` PRs that do not change runtime behavior need no version bump.

## Commit messages

- Use Conventional Commits: `type: summary` (e.g. `fix: catch sendTyping
  rejection`). Keep the summary imperative and under ~72 chars.
- One commit per change — the smallest thing someone might revert or find with
  `git log`.
- Notes and doc edits ride with the work they describe. Amend them onto the
  branch with `git commit --amend`. Start a second docs commit only after the
  first is pushed and reviewed.

`scripts/check-commit-hygiene.sh` enforces two rules:

1. Commits on `main`/`master` are blocked.
2. A duplicate subject across `--all` is blocked. `HEAD` is excluded, so
   `git commit --amend` never collides.

A second docs-only commit on a branch warns and continues.

## First-time setup

Install the hooks — one line, once per clone:

```sh
git config core.hooksPath .githooks
```

This installs `pre-commit` (branch check, secrets, test suite) and `commit-msg`
(duplicate-subject check). Hooks live in the working tree, so an older branch
checks out that branch's hooks.

## Sanity checks before opening a PR

- `node --check bot.js` — no syntax errors.
- `npm run check` — no personal files or secret-shaped content staged. The
  pre-commit hook runs this.
- `npm test` — the suite under `test/` (node:test, no network, no real
  credentials). The pre-commit hook runs it.
- `npm run map:check` — `SYSTEM-MAP.md` still matches the tree. Not in the hook.

## Never in git

`.gitignore` keeps `.env`, `node_modules/`, and `agent/var/` out. Alfred runs in
this repo with `Bash`, `Write`, and `--dangerously-skip-permissions`, so a rule
alone is not enough. `scripts/check-no-secrets.sh` enforces it on the staged
set:

1. Anything under `agent/var/` or named `.env`, by path.
2. Any gitignored file added with `git add -f`.
3. Secret-shaped content (private keys, `GOCSPX-`, `AIza…`, `ya29.`, refresh
   tokens, GitHub/OpenAI tokens, Discord bot tokens) in added lines.
4. Runtime state at the repo root (`var/`, `logs/`, `state.json`) — a warning,
   not a block.

`git commit --no-verify` bypasses it. If you need that, fix the staging instead.

## Simplified Technical English (required)

When you talk with the user about this project and when you develop it, always
write in Simplified Technical English (ASD-STE100). This applies to code
comments, commit messages, PR and issue text, docs, error strings, and chat
replies. It does not apply to Alfred's own persona output in `agent/` — that
text has a voice on purpose.

STE removes the two biggest sources of misreading: words with more than one
meaning, and sentences with more than one possible structure. It keeps text
short, active, and literal so an agent or a non-native reader cannot misparse it.

### Structural rules — apply every time

- **Active voice.** "The agent deletes the file", not "The file is deleted".
- **No phrasal verbs.** "Remove the panel", "start the job" — not "take off the
  panel", "spin up the job".
- **One instruction per sentence.** "Open the file. Read line 3." — not "Open
  the file and read line 3, then check it."
- **Short sentences.** ≤20 words for instructions, ≤25 words for descriptions.
- **No semicolons.** Split into separate sentences. The em dash is allowed but
  often signals a sentence to split.
- **Simple tenses only.** Infinitive, imperative, simple present, simple past,
  simple future, past participle as adjective. Avoid present perfect ("we
  received the report", not "we have received"). Keep the compound form only
  when it carries information the simple form cannot — for example a hedge, "may
  have failed".
- **Keep modality.** Do not promote a hedge to a fact. "The request **may have**
  failed" stays "may have". Never add a fact the source did not state.
- **Noun clusters ≤3 words.** "fuel pump valve", not "high pressure fuel pump
  inlet valve assembly".
- **No ellipsis.** Keep the subject, verb, and article explicit.
- **Lists for sequences.** Use a numbered or bulleted list for 3+ steps.
- **One topic per paragraph**, ≤6 sentences.

### Lexical rules — direction of travel

- **One word, one meaning.** Pick one verb for one action and reuse it. Do not
  rotate "check" / "verify" / "confirm" for the same action.
- **Verb, not noun.** "Analyze the log", not "perform an analysis of the log".
- **Domain terms.** Keep necessary technical terms. Define each once if it is
  not common English.

### Scan for these six habits

1. **Synonym rotation** — the same thing gets several names ("the user", "the
   customer", "the client"). Pick one name.
2. **Hedge stacking** — "it is important to note that this may potentially
   help". State the claim, or delete it.
3. **Nominalization** — "perform an analysis of". Use the verb, "analyze".
4. **Marketing adjectives** — seamless, robust, powerful, blazing-fast. Delete,
   or replace with a measurement.
5. **Run-on sentences** — several ideas joined by semicolons or em dashes. One
   idea per sentence.
6. **Soft phrasal verbs** — spin up, reach out, dive into, kick off. Use the
   plain verb: start, contact, read, begin.

Stop when the sentence is unambiguous, not when it is shortest. STE fixes the
form of a text, not its substance. Source: the `asd-ste100` skill, which encodes
the rule categories of ASD-STE100 Issue 9 (Jan 2025).
