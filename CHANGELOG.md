# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/), versioning is [SemVer](https://semver.org/).

## [Unreleased]
### Added
- `CLAUDE.md` documenting the project and the issue → branch → PR → version workflow.
- `CHANGELOG.md` (this file).
- Archive + memory consolidation on `/clear`: the just-ended conversation is
  copied to `logs/<firstTs>_to_<lastTs>.jsonl` (UTC, filename-safe), then a
  headless Claude is spawned (detached) to consolidate it into memory using the
  prompt in `memory-prompt.md` (`{{TRANSCRIPT}}` is replaced with the archive
  path). If `memory-prompt.md` is absent/empty the consolidation is skipped but
  the archive still happens. `messages.jsonl` resets after each archive so every
  archive is exactly one conversation. `logs/` is gitignored.
- Bot-level JSONL transcript: every turn through Alfred is appended to
  `messages.jsonl` — inbound (`dir:"in"`) and outbound (`dir:"out"`, with
  `kind` of reply/clear/silent/error). This is the bot's own log, separate from
  Claude Code's per-session `.jsonl`. Added `messages.jsonl` (and other runtime
  artifacts) to `.gitignore`.
- Alfred now responds to every message from an authorized user in any channel
  it can see, without needing an `@mention`. Access stays restricted to
  `ALLOWED_USER_IDS`.
- Silent opt-out: Alfred can emit `<no_reply>` (and nothing else) when a message
  isn't directed at it, and the bot stays completely silent instead of posting.
  Guidance for when to use it lives in `SOUL.md`.

### Changed
- Expanded `.gitignore` to cover `node_modules/`, `*.log`, and `state.json`.
- Collapsed the two-tier long-term memory (`MEMORY.md` + `OLD_MEMORY.md`) into a
  single `memories/MEMORY.md`. `loadContext` no longer injects an archive file,
  and `dream.sh` curates one lean store instead of demoting items between two.
  The hot/cold (L1/L2) split is deferred until memory is large enough to need it
  (tracked in #8).

### Removed
- `memories/OLD_MEMORY.md` and all code/doc references to it.

### Fixed
- Connection watchdog: after a long suspend, discord.js could end up silently
  disconnected (process alive, gateway dead) so Alfred stopped responding. The
  bot now exits when the gateway stays down past a grace period so the restart
  loop relaunches it with a fresh login. Also restarts on `invalidated`.
- Bot failed to spawn `claude` (exit -2 / ENOENT) when started from
  `start-alfred.sh`. The script is a non-login shell so it never reads
  `~/.profile`, which is what normally adds `~/.local/bin` (where `claude`
  lives) to PATH. Export it explicitly before launching.

## [1.0.1] - 2026-06-28
### Fixed
- Prevent crash on transient DNS failure at boot. `start-alfred.sh` now waits
  for `discord.com` to resolve before launching (the `@reboot` cron job started
  the bot before the network was ready, causing `EAI_AGAIN` and an immediate
  exit that killed the tmux session). The bot is also wrapped in a restart loop
  so it self-heals on any crash and the tmux session stays up.

## [1.0.0] - 2026-05-22
### Added
- Initial Alfred Node: Discord ↔ headless Claude Code bridge with context
  injection, multi-tiered memory, `/clear` command, and nightly `dream.sh` pass.
