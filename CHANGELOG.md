# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/), versioning is [SemVer](https://semver.org/).

## [Unreleased]

## [1.0.1] - 2026-06-28
### Fixed
- Prevent crash on transient DNS failure at boot. `start-alfred.sh` now waits
  for `discord.com` to resolve before launching (the `@reboot` cron job started
  the bot before the network was ready, causing `EAI_AGAIN` and an immediate
  exit that killed the tmux session). The bot is also wrapped in a restart loop
  so it self-heals on any crash and the tmux session stays up.
