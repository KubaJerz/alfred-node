# TODO

Working backlog for improving Alfred. Dev-facing — like `CONTRIBUTING.md`, this
file is **not** auto-loaded into Alfred's runtime prompt.

Items graduate: **Now** → branch + PR (see `CONTRIBUTING.md`) → strike through
and move to **Done** with the PR number. Anything with a GitHub issue links to it.

---

## Now

### Keeping context live

- [ ] **A change bus — everything publishes, Alfred subscribes and drains per
      turn.** _Deprioritized 2026-08-30 — see **Status** below. Kept for when it
      actually bites._ Alfred's context is a snapshot taken **once**, at
      fresh-session start: `loadContext` injects `MEMORY.md` + today's daily note
      (+ mail) only on the new-session branch of `handleTurn`; a **resumed**
      session re-injects nothing (`finalMessage = messageBody`). So anything that
      changes on disk *after* the session starts — buffered mail, a file a command
      just wrote, a freshly-appended memory line, exercise data — is invisible to
      the live thread until it restarts (`/clear`, a dream, or the day's first
      message). Throwing away the conversation just to see a new file is the whole
      annoyance. The original proof was tier-1 mail: `drainMailDigest()` ran only
      on the fresh branch, so buffered mail waited for a restart. That proof is
      gone now (see **Status**), which is why this item dropped down the list.

      **The design is an internal pub/sub — the same shape as the Gmail one, one
      layer in.** Everything that can change *publishes* a small event to one
      queue: "mail arrived from X", "wrote `var/.../run-2026-08-24.json`",
      "`MEMORY.md` gained a line", "the metrics command reran". Alfred is the
      *subscriber*: at the top of **every** turn — resumed or fresh — he drains
      everything published since the last turn into a delimited context block,
      then clears it. **Empty queue → nothing injected: no block, no added tokens,
      no thinking.** The common case costs nothing, which is what makes it safe to
      run on every turn. Producers don't know or care whether a session is open —
      they publish and move on.

      **Two refinements worth keeping:**
      - **Notify by path, not by value.** An event is "`x` changed — read it if
        this turn needs it," not the file's contents. Small, always-current, and
        Alfred pulls the live version with his Read tool. Same move as the
        `[ATTACHMENTS]` block handing a path instead of bytes.
      - **New vs. rewrite decides the channel.** *Additive* artifacts (new mail, a
        new data file) inject safely into the live session. *In-place rewrites* of
        already-loaded context (`MEMORY.md` edited by the dream pass) do **not** —
        the stale copy is still in his context and may win — so those keep forcing
        a fresh session (`dreamedSince`), as today. Rule: **new → publish;
        edited-in-place → restart.**

      **Mechanics.** `claude -p --resume` has no channel but the prompt — there is
      no system-append mid-session — so a drained event becomes a block prepended
      to the next message, framed so Alfred reads it as ambient context, not as
      the user speaking. Drain-and-clear: once injected an event lives in the
      transcript, so re-injecting only duplicates. On a *fresh* session the queue
      is drained-and-**discarded** — `loadContext` already reloaded the current
      files, so the events are redundant there; the queue only ever covers the gap
      *between* restarts.

      **This subsumes the tier-1 mail buffer:** mail stops being a special case
      and becomes the first producer on the bus. **Traps:** coalesce bursts (a
      cron that writes ten files is one event, not ten); never emit an empty block;
      and keep the payload a delta, never the whole world.

      **Status (2026-08-30).** The flagship use case — tier-1 mail waiting for a
      restart — is gone. Ronnie already surfaces mail live: Priority pings Discord
      over a webhook, the rest lands in Gmail labels. So the mail buffer became
      near-empty and was removed (v2.12.0); mail no longer needs the bus. What
      remains are the *quieter* cases — a file a command wrote, a memory line, new
      exercise data. Alfred resets every night (the dream forces a fresh session),
      so the blindness window is at most one day, and "go look for it" covers most
      of these. Not worth building yet. Revisit if the quiet cases start to annoy.

      **Phase two, when this comes back — point at Gmail, don't build a store.**
      The robust "more context on that email" path is *notify by path* aimed at
      Gmail: teach the `gmail` skill the Ronnie label convention (`Priority` =
      pinged, `Interesting`, `Bulk`, plus topic children), so "that email Ronnie
      flagged" is a `label:Priority newer_than:Nd` search, newest first. Gmail is
      the live, always-current store; Alfred already reads it; the ping already
      carries the message id. Do **not** build a "recent pings" file — that just
      re-creates the buffer we removed, as a stale copy of what Gmail holds live.

### Security — isolate Alfred, and push risky work onto their own agents

The #2 priority. Two halves of one idea: give Alfred a hard boundary, and hand
risky jobs to small least-privilege agents instead of widening his reach.

- [ ] **Run the agent as a separate Unix user.** This is what turns the broker
      from a strong default into a guarantee. Alfred currently runs as the same
      user as `bot.js`, so he can read `agent/var/google/token.json` and call
      Google directly, bypassing every restriction the broker enforces. No
      application code fixes that, and Claude Code's own deny rules don't
      survive Bash. Needs: a second user with its own authenticated Claude Code,
      a NOPASSWD sudoers rule, `chmod 700` on the credentials dir, and group
      sharing so memories stay writable.

## Next

### Reliability — nightly jobs that fail at 3am

- [ ] **Scheduled-job health — flag failures, and recycle where safe.** `bot.js`
      is supervised (`start-alfred.sh` restarts it on crash with backoff); cron
      jobs are not. `dream.sh` fires at 3am and fails silently on a bad night —
      and worse, it stamps `last-dream` **unconditionally**, so a *failed* pass
      marks itself done and the next session trusts memory that was never
      written. As nightly jobs multiply (dream, the workout pull, Ronnie, mail
      sync) the blind spots multiply with them.

      Two wants:
      - **Report.** A failed job publishes a failure event that `bot.js` surfaces
        to Discord. This *is* the change bus aimed at failures instead of new
        files, and the proactive-auth-check item (below) is one instance of it.
        Cron can't reach Discord — only `bot.js` holds the client — so the job
        leaves a marker and the bot drains it, same as any other producer.
      - **Recycle.** Retry with backoff, or catch up a *missed* run (the dream
        off-by-one fix was a hand-rolled, one-off version of this).

      Do it in one pass, not piecemeal. First casualty to fix: jobs marking
      themselves done on failure (the `last-dream` stamp). Shape: a thin wrapper
      every scheduled job runs under — run the job, and on non-zero exit publish
      the failure and decide retry-vs-defer — rather than each job hand-rolling
      its own.

## Someday / Maybe

- [ ] **Tiered memory (L1/L2).** `agent/var/memories/MEMORY.md` is injected into
      every new session; it's empty today, but the split plan is already noted in
      that file's header (issue #8). Do it when size actually becomes a problem.
- [ ] **Give Alfred a phone number.** A number he can text — and be texted at —
      so he reaches Kuba outside Discord: reminders and nudges over a channel
      that's open even when Discord isn't. Settle the provider first, because it
      sets the whole surface: **Google Voice has no official API**, so "a Google
      number" specifically means either a supported path (Workspace telephony) or
      an unofficial route that can break; Twilio is the friction-free alternative
      if "Google" isn't load-bearing. Inbound texts would ride the same
      buffer-vs-turn tiering as the Pub/Sub mail path.
- [ ] **Food logging + a database.** Let Kuba log meals to Alfred (a Discord line
      first, a photo later) and keep them queryable — what and when, ideally
      calories/macros. Two open questions: the schema, and whether Alfred
      *estimates* nutrition from a description (a model in the loop, proposing
      rather than recording as fact) or looks it up against a food database. Photo
      input rides on **Read inbound attachments** (shipped, #40).
- [ ] **Proactive auth health check.** Auth lapses are now caught on the turn
      they happen (#20), but not before. A probe on boot was deliberately
      skipped: it would run inside the launcher's restart loop. A once-daily
      check, or one after a long idle gap, would catch it sooner.

- [ ] **Prune `agent/var/logs/` and `agent/var/memories/dailies/`.** Both grow
      without bound.
- [ ] **A task/todo store for Alfred himself** — a persistent list he can read
      and append to across sessions, plus rules in `agent/SOUL.md` for when to
      add and complete items. (Distinct from *this* file, which is for the repo.)
- [ ] **A fresh-clone bootstrap test.** `package.json` now carries `test`,
      `check` and `map:check`, so the pre-PR checks `CONTRIBUTING.md` describes
      are runnable entrypoints. What's still missing is a test of the fresh-clone
      bootstrap path itself — the obvious first thing worth asserting.
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

- [x] ~~**Forwarded calendar invites add themselves — one model path, no `.ics`
      parser.**~~ Built as the redesign above described, and it deleted more than
      it added: the hand-rolled RFC-5545 parser (`ronnie/ics.js`) and the
      `POST /calendar/import` route are gone. Past the unchanged DKIM + owner gate,
      a Haiku pass (`ronnie/invite.js`) reads the forward — prose or `.ics` — and
      returns add / delete / none; an add is deduped by *reading* the day and
      letting the model judge a match (leaning toward adding when unsure), then
      created with the same `POST /calendar/events` insert `bin/gcal.js` uses; a
      delete finds and removes the matching event; none triages as ordinary mail.
      Ronnie's broker traded import/remove for the gcal trio — a read-only
      `GET /calendar/events` (dedupe only) plus `POST`/`DELETE` — so its reach is
      list/add/delete, no edit. The undo handle is the created event id. Handles
      the inline-Outlook-forward case that has no `.ics` at all, which is what
      made a model the *only* sensible path. The surviving trap — a zoneless time
      is Eastern wall-clock — lives in the prompt now, with the same-day channel
      post as the safety net. Still worth a real end-to-end forward before it's
      trusted in the wild.
- [x] ~~**Ronnie — the inbound-mail worker, and the separate-agent security
      half.**~~ The pub/sub arc's tier-2/3 runtime, split off from `bot.js` as its
      own broker client: it drains the pull subscription, prefilters and
      classifies with a **Haiku** circuit breaker, and acts through a *narrow*
      broker (label + calendar import/remove only) that holds no general token —
      capability is the containment, not the prompt. A DKIM + owner-address gate,
      checked in trusted code, decides the spawn profile (untrusted → label-only;
      verified forward-from-Kuba → +calendar-write), so Ronnie never grants
      themselves permission. Adds run idempotently on the `.ics` UID; deletes are
      posted to Discord over a write-only webhook and undone by reply
      (`cal:<uid>`, caught by bot.js). Ships a queue + meter and a `/ronnie-metrics`
      usage dashboard. This is the *separate-agents* half of the Security
      direction, now real — only the *separate-user* item there remains. (PRs #47,
      #49; extension `feat/ronnie-topic-labels` — per-topic Gmail labels — still
      open.)
- [x] ~~**Gmail → Alfred via Pub/Sub.**~~ `users.watch()` publishes change
      notifications to a Cloud Pub/Sub topic, drained over a **pull** subscription
      (no public endpoint, works behind NAT), OAuth as the user. Delivery is
      tiered: buffer silently (tier 1 — appended to `pending-mail.jsonl`, drained
      into the next real turn as a delimited digest, then cleared), ping without
      waking him, or spawn a turn. Sensitive mail (codes/OTPs/resets) never
      buffers — the same `classify()` chokepoint the read path uses. Tiers 2–3 run
      inside Ronnie. (PRs #25, #37)
- [x] ~~**Garmin data + a workout database.**~~ Reached via **Intervals.icu**
      rather than an unofficial Garmin-Connect client (the item's feared route):
      it has an official API and already ingests Garmin Connect, so the watch →
      Connect → Intervals.icu → Alfred chain needs nothing brittle. An `intervals`
      skill + `bin/intervals.js` read activities and wellness, **read-only by
      construction** (`intervals/client.js` exposes GET only — no write route
      exists). On top of it a `strength/` subsystem turns Garmin lifting into
      rolling per-muscle load in a SQLite DB (`agent/var/strength.db`,
      `node:sqlite`, no native dep) across raw/interpreted/view layers — a headless
      **Haiku** pass names exercises while code keeps the numbers exact — exposed
      as ACWR + trend with `digest`/`load`/`sets`/`plot` and a nightly pull. Off
      unless `INTERVALS_API_KEY` is set. (PR #48 + strength load)
- [x] ~~**Voice messages → text.**~~ A voice note (lone Opus attachment, the
      `IsVoiceMessage` flag) is transcribed on-device and the transcript *becomes*
      the user message, so everything downstream is blind to whether the turn was
      typed or spoken. `voice/transcribe.js` → `voice/transcribe.py`: ffmpeg
      decodes Opus → 16 kHz mono, then **Parakeet-TDT-0.6B int8** via onnx-asr on
      onnxruntime, loaded from the HF cache with downloads off so a live turn
      never touches the network. The predicted numbers were the risk the item
      flagged ("time it before designing around it") — measured on this CPU-only
      box they came in *better*: RTF ~0.06 (11 s note → 0.7 s) + ~2 s model load,
      **630 MB** on disk after pruning the fp32 pair — under the ~1 GB estimate.
      `ffmpeg` turned out to already be in the venv (a static build), so no sudo
      after all. The bot echoes `🎙️ heard: …` before the turn — the action-echo
      guard, done deterministically in `bot.js` rather than left to the model.
      Whisper stays not-taken per the item's reasoning. `scripts/setup-voice.sh`
      provisions deps + model; unset, a note draws a graceful reply and no turn.
      Reuses the #40 download primitive. (PR pending)
- [x] ~~**Read inbound attachments — and the day-folder + Eastern-date arc it
      pulled in.**~~ Alfred was send-only: a message with files but no caption hit
      `if (!userMessage) return` and was dropped, `msg.attachments` never read.
      Now any file (no type whitelist — single-user, high-trust, gated by
      `ALLOWED_USER_IDS`) downloads into that day's folder and its path reaches
      the turn in an `[ATTACHMENTS]` block, on the **message body** so it survives
      a resumed session (a photo mid-chat). Two changes rode along because the
      storage location forced them: dailies went from `YYYY-MM-DD.md` to
      **one folder per day** (`YYYY-MM-DD/daily.md` + that day's files, so a prune
      is one `rm -rf` and the tiers are named — `MEMORY.md` is memory, dailies are
      *context*, which is why binaries belong there); and every "day" now keys on
      **Eastern** (`America/New_York`, DST-aware) through one helper (`dailies.js`),
      which also fixed a latent bug where `loadContext` (UTC) and `dream.sh`
      (local) disagreed near midnight. `scripts/migrate-dailies-to-folders.sh`
      moves existing notes over. Pure logic unit-tested; cron unchanged (3am
      Eastern). Voice stays separate, sharing only the download primitive. (#40)
- [x] ~~**Personal memory state was loose at the repo root.**~~ A daily note
      (`memories/dailies/2026-08-11.md`) sat at the repo root, outside the one
      `.gitignore` rule that guards `agent/var/`. Moved it back under
      `agent/var/memories/dailies/`. The writer wasn't the production code —
      `consolidateMemory` and `dream.sh` both scope to `var/` with `cwd=AGENT_DIR`,
      and the consolidation log has no entry for that date; it was a stray
      dev-time/manual `claude -p` write from the wrong cwd. The split now holds
      structurally: the pre-commit guard's check #4 recognized repo-root state
      names (`memories/`, `logs/`, `state.json`, …) but only *warned*, which is
      how the note reached a staged commit before a manual unstage caught it — it
      now **blocks**. (PR pending)
- [x] ~~**Mail digests stay out of long-term memory — by construction.**~~ No
      code needed: the digest lives inside `finalMessage` (context + the raw
      `userMessage`), which goes to `runClaude` and is *never* logged.
      `messages.jsonl` only ever receives the raw `userMessage` and Alfred's
      reply, so `archiveConversation` → `consolidateMemory` → dailies can never
      see a digest — it's invisible to the memory funnel structurally, not by a
      filter that could be forgotten. The one residual is narrow and accepted: if
      Alfred *restates* a digest in his reply, that reply is logged — but it's his
      own words about mail, logged like any conversation about an email, not the
      digest itself. Nothing to build; the property already holds and will still
      hold once Pub/Sub prepends the digest to the context.
- [x] ~~**Calendar write access, governed.**~~ Read+write ships over the broker
      (`create`/`update`/`delete`), and the "guidance vs. guarantee" question the
      item posed is settled: what reaches real people if wrong is enforced in
      code (`calendar-rules.js` — the invitation-by-mistake guard, colour
      validation, the all-day/`timeZone` combination, timezone stamping), and the
      rest is guidance in the `gcal` skill body (colours as categories, never
      invent a time, guest-delete refusal, the 30-day Trash window, one event per
      series, not one per occurrence). No separate ruleset repo was needed — the
      rules live with the skill and the code, not in `agent/`. (#25)
- [x] ~~**Credential filter: narrowed to actual login codes.**~~ The rule is now
      simply "withhold mail that carries a login code," and sign-in *alerts* are
      explicitly not that — "New sign-in to Firefox", "signed in from a new
      device" all pass, because nothing leaks by letting Alfred see one and they
      were notifications Kuba wanted. Dropped the lone `sign-in attempt`/`new
      sign-in` wording rule that used to suppress them arbitrarily (Firefox
      withheld, TaxAct/Slack not — same category, opposite outcomes). A sign-in
      *code* is still caught. The `ghr@otp.workday.com` subdomain gap was left as
      a low-value backstop only: a real code from that sender is already caught
      by the wording/bare-digit rules on the content, independent of who sent it.
      Test moved the alert from `MUST_SUPPRESS` to `MUST_PASS` and added a
      code-bearing sign-in to hold the line. (PR pending)
- [x] ~~**Deleted the `bin/google.js` shim.**~~ The removal gate — no live
      session predating the CLI split — is met now that a fresh session is up.
      Took its dedicated `cli.test.js` block with it and dropped the two doc
      references (`CONTRIBUTING.md`, `SYSTEM-MAP.md`); `map:check` still passes.
      (PR pending)
- [x] ~~**Recurrence beyond a plain interval.**~~ `--days MO,WE,FR` builds
      `BYDAY=MO,WE,FR`, and the `--rrule 'FREQ=...'` escape hatch covers "third
      Thursday" and anything else nobody enumerated. Editing one occurrence of a
      series already worked. The one uncovered piece, `EXDATE`, is only reachable
      via a forwarded `.ics`, so it moved to the forwarded-invites item. (#25)
- [x] ~~**Google Calendar — read on demand.**~~ `GET /calendar/events`
      (`events.list` over a `--from`/`--to` window, with `--query` text search)
      via `gcal.js events`. No watch channel, no polling loop — he reads the
      window when asked. (#25)

- [x] ~~**Notion.**~~ Built the broker route, as #25 pointed to: token in
      `bot.js`, six loopback operations, `bin/notion.js` holding nothing, a
      `notion` skill on description match — mounted on the same server as Google.
      The reversibility question resolved the surface: `set` (a property
      overwrite) is the one irreversible write and Notion keeps no API-reachable
      history, so it reads-before-writes and reports `from → to`; comment/delete/
      archive are absent (comment reaches people and can't be unsent; page
      removal and body edits are a later, larger surface). Access is bounded by
      per-page sharing, not a scope. (#31)

- [x] ~~**Notion body edits.**~~ The "later, larger surface" above, the body half
      of it: Alfred was append-only on a page; now `read --ids` surfaces each
      line's block id and `check`/`uncheck`, `edit`, `remove` change one line by
      it. Two routes (`PATCH`/`DELETE /notion/block`), eight Notion routes total.
      Same reversibility logic sorted the surface: `edit` overwrites in place and
      reports `from → to` like `set`; `remove` lands in Notion's Trash and is
      recoverable, so it's allowed where a comment isn't. Still no whole-page
      delete or archive — that's the other, rarer half. (#35)

- [x] ~~**Email replies.**~~ `gmail.js reply <id>` builds the draft from the
      original — `Reply-To` over `From`, a `Re:` that doesn't stack, and the
      `In-Reply-To`/`References` headers that actually thread it. The old
      `--thread` flag took an id nothing ever printed, so every reply arrived
      as a new conversation. Verified against a real message: all four headers
      correct, and replying to a withheld message refused. (#25)
- [x] ~~**Calendar delete.**~~ Deferred while the rules were unwritten; they
      now exist and load themselves. The deciding fact is recoverability —
      Google keeps deleted events in Trash for 30 days, unlike Gmail, whose
      delete needs the scope that empties Trash permanently. Deleting an event
      with guests is refused, because Google says cancellation mail "might
      still be sent" regardless of the notification setting. Both paths
      verified live. (#25)

- [x] ~~**Exercise the write paths.**~~ All of them, against the real account:
      `draft` (multi-line body, round-tripped through `read`), `label`,
      `mark-read`, `archive` (proven by adding `INBOX` to the probe message
      first, so no real mail was moved), `cal create` timed and all-day,
      `cal update` across summary/times/colour with untouched fields
      preserved, plus both refusals and a rejected colour that created nothing.
      Two bugs fell out, both pre-existing and neither reachable by reading:
      `PATCH` bodies were never parsed, and non-ASCII subjects were mangled.
      Test artifacts are labelled `to delete` in Gmail and named `TO DELETE`
      on the calendar — there is no delete route, which is the point. (#25)

- [x] ~~**Split the CLI per service, and pair each with a skill.**~~ `bin/gmail.js`
      and `bin/gcal.js` over a shared `bin/lib/broker-client.js`, each paired
      with a skill in `agent/.claude/skills/`. Skills *do* resolve in headless
      `claude -p` — verified by planting one and watching an unprompted
      invocation fire off the description alone; `agent/SOUL.md` previously
      claimed otherwise and was wrong. So the command surface, Gmail's query
      syntax and the whole calendar ruleset now load on a trigger instead of a
      pointer Alfred has to remember to follow. `agent/calendar-rules.md` folded
      into the `gcal` skill; SOUL.md keeps only the constraints that must hold
      on a turn where no skill fires. `bin/notion.js` slots in the same way.
      (#25)
- [x] **Google access, end to end** — OAuth (not a service account; personal
      Gmail can't use one), a credential broker holding the tokens so the agent
      never does, mail/calendar CLI, credential screening at a single chokepoint,
      and the calendar ruleset with the invitation rule enforced in code rather
      than requested. 21 hermetic tests asserting the absences. (#25)
- [x] **Personal files can't be committed.** `scripts/check-no-secrets.sh` plus a
      repo-tracked pre-commit hook — path checks, force-add detection,
      secret-shaped content, and the test suite. Verified against three
      deliberate leak attempts and a planted failing test. (#25)

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
