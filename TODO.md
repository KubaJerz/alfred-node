# TODO

Working backlog for improving Alfred. Dev-facing — like `CONTRIBUTING.md`, this
file is **not** auto-loaded into Alfred's runtime prompt.

Items graduate: **Now** → branch + PR (see `CONTRIBUTING.md`) → strike through
and move to **Done** with the PR number. Anything with a GitHub issue links to it.

---

## Now

- [ ] **Detect a lapsed headless-Claude login.** After ~a month idle, the first
      message came back as `Not logged in · Please run /login` delivered as a
      normal reply (`agent/var/memories/dailies/2026-08-01.md`). `runClaude`
      should recognize the auth-failure shape and surface it as a distinct
      bot-level error — ideally a startup/periodic health check so it's caught
      before a real message hits it.
- [ ] **Rotate `alfred.log`.** It's at ~194 MB (now at
      `agent/var/logs/alfred.log`). `start-alfred.sh` appends forever with no
      cap. Add rotation/truncation (size-capped, or logrotate).
- [ ] **Scrub `USER.md` from git history.** The restructure stopped *future*
      commits of personal data, but the initial commit still contains a real
      name and timezone, and the repo is on GitHub. Needs a `git filter-repo`
      pass + force-push, or accept it and move on — a deliberate call, not a
      silent one.

## Next

- [ ] **Guard against concurrent messages.** Two messages arriving while a
      `claude` run is in flight both spawn with the same `last_session_id` and
      race on `state.json`. Queue per-channel, or drop/park the second turn with
      a "still working" note.
- [ ] **`status: "resolved"` is set by a file clobber, not by the bot.**
      `dream.sh` overwrites `state.json` wholesale each night; `bot.js` says
      "claude can mark resolved via daily notes," which nothing implements. Two
      writers, no coordination — a dream pass landing mid-conversation silently
      resets the session. Pick one owner of that file.
- [ ] **Timeout UX.** `CLAUDE_TIMEOUT_MS` (120s) kills long runs with no partial
      output and a confusing error. At minimum reply with a clear "timed out
      after Ns" message; consider streaming or a longer cap for known-slow work.
- [ ] **Tiered memory (L1/L2).** `agent/var/memories/MEMORY.md` is injected into
      every new session; it's empty today, but the split plan is already noted in
      that file's header (issue #8). Do it when size actually becomes a problem.

## Someday / Maybe

- [ ] **Prune `agent/var/logs/` and `agent/var/memories/dailies/`.** Both grow
      without bound.
- [ ] **A task/todo store for Alfred himself** — a persistent list he can read
      and append to across sessions, plus rules in `agent/SOUL.md` for when to
      add and complete items. (Distinct from *this* file, which is for the repo.)
- [ ] **Sanity-check script.** `CONTRIBUTING.md` describes pre-PR checks but
      there's no test or lint entrypoint in `package.json`. The fresh-clone
      bootstrap path is the obvious first thing worth a real test.
- [ ] **Attachment tokens with no file extension** get named `attachment_0` with
      no suffix; Discord may not preview them.

## Done

- [x] **Split the repo into three layers** — app / `agent/` config / `agent/var/`
      state, so dev files and Alfred's runtime files stop sharing a namespace.
      Fixed the two leaks it was hiding: personal files tracked in git, and
      `memories/dailies/` neither tracked nor ignored. (v2.0.0)
