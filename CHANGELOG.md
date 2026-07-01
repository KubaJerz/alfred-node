# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/), versioning is [SemVer](https://semver.org/).

## [Unreleased]
### Added
- `CLAUDE.md` documenting the project and the issue → branch → PR → version workflow.
- `CHANGELOG.md` (this file).

### Changed
- Expanded `.gitignore` to cover `node_modules/`, `*.log`, and `state.json`.

### Fixed
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
