# TODO

Working backlog for improving Alfred. Dev-facing — like `CONTRIBUTING.md`, this
file is **not** auto-loaded into Alfred's runtime prompt.

Items graduate: **Now** → branch + PR (see `CONTRIBUTING.md`) → strike through
and move to **Done** with the PR number. Anything with a GitHub issue links to it.

---

## Now

### Integrations — give Alfred hands

Today Alfred has Bash/Read/Edit/Write and nothing else. `agent/SOUL.md` claims
he "may have MCP access to Google Calendar (check `.mcp.json`)" — **there is no
`.mcp.json`**, so that line is a lie he's been improvising around. Fix that line
as part of whichever integration lands first.

- [ ] **Gmail → Alfred via Pub/Sub.** `users.watch()` publishes change
      notifications to a Cloud Pub/Sub topic. Use a **pull** subscription: this
      box is a laptop behind NAT, and pull needs no public endpoint or domain
      verification. Auth is OAuth as the user (done, `google/auth.js`) — a
      service account can't reach a personal mailbox without domain-wide
      delegation, which is Workspace-only. The service account is for draining
      the *subscription*, which is our own cloud resource.

      **Delivery is tiered; everything starts at tier 1.** Alfred isn't running
      between messages — `runClaude` spawns a fresh `claude -p` per turn — so
      there is nothing to interrupt, and the question is only whether mail
      creates a turn or waits for one.

      1. *Buffer, silently.* Append a line to `var/pending-mail.jsonl`. No agent,
         no Discord post. Prepended as a delimited digest to the next real turn
         (before the `"User Message: "` trailer `loadContext` ends with), then
         the buffer is cleared — it persists in the session transcript from then
         on, so re-injecting would only duplicate.
      2. *Ping without waking him.* bot.js posts to Discord itself. No LLM call.
         Most of the value of push is knowing mail arrived, and that needs no
         model.
      3. *Spawn a turn.* Narrow rules only. Note this lands inside the resumed
         session, so it pollutes the conversation unless given its own.

      Promote via a **Gmail label** — labelling a thread from your phone retunes
      what's urgent with no redeploy.

      **Never buffer sensitive mail** (verification codes, OTPs, password
      resets, sign-in alerts). Injecting one writes it to
      `~/.claude/projects/<cwd>/<session>.jsonl`, which is outside the repo and
      therefore outside `agent/var/`, `.gitignore` and the memory funnel alike.
      Match on subject/snippet and drop the content entirely — record only that
      *something* was withheld. Alfred can fetch a live code on request instead,
      which is better anyway since codes expire.

      Fails silently if you get these wrong: `watch()` expires after 7 days and
      just goes quiet; notifications carry only a `historyId`, and a stale one
      makes `users.history.list` 404 (needs full-resync fallback); a mailing-list
      burst or a bulk "mark read" from a phone floods the buffer without
      coalescing.
- [ ] **Google Calendar — read on demand, no subscription.** Pub/Sub is for mail
      only. Calendar entries are expected to change *through Alfred*, so there's
      no external stream to keep up with and nothing to subscribe to: he reads
      the window he needs when he needs it (`events.list` over a date range) and
      writes when asked. No watch channel, no polling loop, no background state
      to keep in sync — which also sidesteps the fact that `events.watch()` only
      delivers to an HTTPS webhook on a verified domain this host can't offer.
      If noticing edits made elsewhere (phone, web UI) ever matters, an
      incremental `syncToken` poll is the additive way in — deliberately not
      part of v1.
- [ ] **Calendar write access, governed by the rules Kuba is providing.**
      Read+write so Alfred can refactor the calendar, constrained by a ruleset
      from another repo. **Blocked:** need the repo/path. Open questions once it
      lands: do the rules live in `agent/` (Alfred reads them at runtime) or are
      they enforced in `bot.js`? Rules a model is asked to follow are guidance;
      rules in code are guarantees — destructive calendar edits probably want
      the latter.
- [ ] **Notion.** No official Notion CLI exists, so this is a build-or-adopt
      call: a small CLI wrapper over the Notion API that Alfred drives via Bash
      (fits his existing tools, no new runtime), or the Notion MCP server (less
      code, needs MCP wiring that doesn't exist yet). The MCP route pairs well
      with doing Google over MCP too.

- [ ] **Keep mail digests out of long-term memory.** Mostly free already:
      `logTurn` records `userMessage` before `handleTurn` builds `finalMessage`,
      so the digest never reaches `messages.jsonl` and the funnel can't see it.
      A conversation *about* an email is the user's own words and is logged
      normally — which is the wanted split. The hole is Alfred's *reply*: if he
      restates the digest, that's logged `dir:"out"` and can reach the daily
      note. Fix in `memory-prompt.md`, where filtering decisions already live.

## Next

- [ ] **Tiered memory (L1/L2).** `agent/var/memories/MEMORY.md` is injected into
      every new session; it's empty today, but the split plan is already noted in
      that file's header (issue #8). Do it when size actually becomes a problem.

## Someday / Maybe

### Later integrations (Kuba, 2026-08-02 — explicitly "for later")

- [ ] **Voice messages.** Discord voice notes arrive as `audio/ogg` attachments.
      `bot.js` currently reads `msg.content` only and ignores attachments
      entirely, so this is two pieces: notice inbound attachments at all, then
      transcribe (local Whisper keeps audio off third-party services, which
      matters more here than for text).
- [ ] **Proactive auth health check.** Auth lapses are now caught on the turn
      they happen (#20), but not before. A probe on boot was deliberately
      skipped: it would run inside the launcher's restart loop. A once-daily
      check, or one after a long idle gap, would catch it sooner.

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

## Decided against

- **Scrubbing `USER.md` from git history.** The initial commit contains a name,
  timezone, and "uses Google Calendar". Low sensitivity, already public for
  months, and a `filter-repo` + force-push would break every existing clone.
  Accepted deliberately (2026-08-02); `agent/var/` prevents any recurrence.
- **Attachment captions** (`{img:path | caption}`). Designed and declined —
  because files batch onto the last message, caption↔image adjacency only holds
  for a single figure. Don't re-propose unprompted.

## Done

- [x] **Stopped the crash loop and capped the log.** An unhandled `EAI_AGAIN`
      from `client.login()` meant a network outage restarted the bot every 5s
      forever — 383,295 restarts in 34 days, and the real reason `alfred.log`
      reached 186 MB. Added a caught login rejection, DNS re-check and
      exponential backoff in the launcher, and log rotation. (#22)
- [x] **Auth lapses and timeouts are reported as failures**, not relayed as
      things Alfred said. (#20)
- [x] **Serialized turns and gave `state.json` a single writer** — concurrent
      messages raced on session state, and `dream.sh` clobbered it
      mid-conversation. (#18)
- [x] **Split the repo into three layers** — app / `agent/` config / `agent/var/`
      state, so dev files and Alfred's runtime files stop sharing a namespace.
      Fixed the two leaks it was hiding: personal files tracked in git, and
      `memories/dailies/` neither tracked nor ignored. (v2.0.0)
