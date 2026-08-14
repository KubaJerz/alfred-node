# TODO

Working backlog for improving Alfred. Dev-facing — like `CONTRIBUTING.md`, this
file is **not** auto-loaded into Alfred's runtime prompt.

Items graduate: **Now** → branch + PR (see `CONTRIBUTING.md`) → strike through
and move to **Done** with the PR number. Anything with a GitHub issue links to it.

---

## Now

### Integrations — give Alfred hands

Google access is live as of #25: OAuth consented, credentials held by a broker in
`bot.js`, and `bin/gmail.js` / `bin/gcal.js` as the agent-facing CLIs, each paired
with a skill under `agent/.claude/skills/`. What follows is what's left rather
than what's missing.

- [ ] **Run the agent as a separate Unix user.** This is what turns the broker
      from a strong default into a guarantee. Alfred currently runs as the same
      user as `bot.js`, so he can read `agent/var/google/token.json` and call
      Google directly, bypassing every restriction the broker enforces. No
      application code fixes that, and Claude Code's own deny rules don't
      survive Bash. Needs: a second user with its own authenticated Claude Code,
      a NOPASSWD sudoers rule, `chmod 700` on the credentials dir, and group
      sharing so memories stay writable.

- [ ] **Gmail → Alfred via Pub/Sub.** _Tier 1 is built (branch
      `feat/gmail-pubsub`, PR pending) — see the Done entry for what shipped.
      What's left in this item: the cloud go-live (topic + pull subscription +
      service-account key), then tiers 2–3, then forwarded invites, which ride
      the same path. The notes below stay the reference for all of that._
      `users.watch()` publishes change
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
      resets) — the same `classify()` chokepoint the read path uses, so sign-in
      *alerts* buffer normally now while a code never does. Injecting one writes
      it to
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
- [ ] **Forwarded calendar invites add themselves.** Kuba gets invites at other
      addresses; he forwards one here and it lands on the calendar. Rides on the
      Pub/Sub path above — same trigger, different handler.

      **Why this doesn't already happen.** Gmail auto-adds an invite when you are
      in the `.ics` `ATTENDEE` list. Forwarding doesn't rewrite that list, so the
      forwarded copy names the original invitees and Gmail correctly ignores it.
      The gap is real, not a setting someone forgot to tick.

      **⚠️ Tested 2026-08-04, and it changes the design: an inline forward from
      Outlook has no `.ics` at all.** Kuba forwarded a real one; the message came
      through as plain `multipart/alternative` — `text/plain` + `text/html`,
      nothing else. Five *natively received* invitations in the same mailbox all
      carry `text/calendar; name=invite.ics`, so the part exists right up until
      the forward drops it. Everything below about `events.import` is correct and
      applies to nothing, unless one of these holds:

      - **Forward as attachment** (Outlook: Forward as Attachment; Gmail: Forward
        as attachment) wraps the original as `message/rfc822`, `.ics` intact.
        Parser has to descend into the nested message. This is the good path and
        it costs Kuba one different menu item — establish whether it survives
        before building anything else.
      - **Parse the human-readable body.** The forwarded text *did* carry
        everything needed: `When: Occurs every Tuesday from 10:30 AM to 12:30 PM
        effective 6/30/2026 until 11/24/2026. There are 16 more occurrences.
        America/New_York`. That is a sentence, not a data format — regexes will
        pass the demo and fail on the next locale, so this is the one branch
        where a model belongs, and it must propose rather than write.

      So the handler is two-path: `.ics` present → deterministic import; no
      `.ics` → Alfred reads the text, proposes an event, Kuba confirms. Don't
      auto-write from prose.

      Also worth noting from the same test: the message forwarded was an
      `Accepted:` reply (`METHOD:REPLY`), not an invitation (`METHOD:REQUEST`).
      Check `METHOD` before importing, or an acceptance notice becomes an event.

      **Use `events.import`, not `events.insert`.** It takes the `.ics` file's
      own `iCalUID`, and re-importing the same UID updates the existing event
      instead of making a second one. That is duplicate protection and reschedule
      handling for free — forward the same invite twice, or forward the "updated
      invitation" a week later, and the calendar stays right. Doing this with
      `insert` means hand-rolling a UID→eventId map, which is the same job done
      worse. Needs a new broker route; `POST /calendar/events` can't set a UID.

      **Only act on mail Kuba forwarded himself.** Otherwise anyone who knows the
      address can write to the calendar by emailing an attachment, and a
      malicious `.ics` is a plausible thing to send. Gate on the sender being one
      of his own addresses, or require a Gmail label he applies. This is the one
      decision here with a security consequence.

      Traps, most of which are the six-hours-off bug wearing a different hat:
      - `DTSTART` comes in three shapes — UTC (`...Z`), a `TZID=` parameter, or
        *floating* with no zone at all. Floating means wall-clock time and has to
        be read as Eastern; treating it as UTC lands the event four hours out.
      - `DTSTART;VALUE=DATE` is all-day and must not carry a `timeZone`.
      - `RRULE` is on most real invites, since recurring meetings are the common
        case. The recurrence builder that was a blocker here has shipped
        (`toRecurrence`, `--days`/`--rrule`), so a weekly standup no longer
        imports as a single event. **The one recurrence piece still missing is
        `EXDATE`** — the skipped weeks a `.ics` carries for a holiday or a
        cancelled session, which prose can't express. It's only reachable
        through a forwarded invite, so it belongs to *this* feature, not a
        standalone recurrence item.
      - `METHOD:CANCEL` is a forwarded cancellation. With the UID in hand the
        event is findable, and deleting it is allowed because an imported event
        carries no attendees.
      - Colour can't be inferred — nothing in an `.ics` maps to Kuba's six
        categories. Open question: a dedicated "imported, not yet filed" colour
        makes the backlog visible and reviewable, but it isn't one of the six.

      Attendees need no special handling: the broker has no path to that field,
      so the invitees land in `--description` as text, which is already the
      convention. The guarantee holds without anyone remembering it.

      **No model in the loop — on the `.ics` path.** Parsing an `.ics` is
      deterministic, so that branch belongs in `bot.js` on the Pub/Sub path, not
      in a turn, which also means it works while Kuba is asleep. The prose branch
      is the opposite: it needs Alfred, and it proposes rather than writes. Post
      what was added to Discord either way, so a bad parse is visible the same
      day rather than at the meeting.

## Next

- [ ] **Read inbound attachments.** `bot.js:467` takes `msg.content` and nothing
      else — `msg.attachments` is never touched, so every file sent to Alfred is
      silently dropped. Outbound already works (`extractAttachments`, the
      `{img:}` tokens); this is the missing direction. Download to `agent/var/`,
      hand the path to the turn. Pays off well beyond voice — whiteboard photos,
      PDFs, a forwarded `.ics`. **Prerequisite for voice messages below.**
- [ ] **Tiered memory (L1/L2).** `agent/var/memories/MEMORY.md` is injected into
      every new session; it's empty today, but the split plan is already noted in
      that file's header (issue #8). Do it when size actually becomes a problem.

## Someday / Maybe

### New integration ideas (Kuba, 2026-08-12 — unscoped, capture-only)

- [ ] **Give Alfred a phone number.** A number he can text — and be texted at —
      so he reaches Kuba outside Discord: reminders and nudges over a channel
      that's open even when Discord isn't. Settle the provider first, because it
      sets the whole surface: **Google Voice has no official API**, so "a Google
      number" specifically means either a supported path (Workspace telephony) or
      an unofficial route that can break; Twilio is the friction-free alternative
      if "Google" isn't load-bearing. Inbound texts would ride the same
      buffer-vs-turn tiering as the Pub/Sub mail path.
- [ ] **Garmin connection + a workout database.** Pull activities (runs, lifts,
      HR, sleep) from Garmin into a store under `agent/var/` that Alfred can
      query — "how far did I run this week", "am I recovered enough to train".
      Open first: **Garmin has no official consumer API** (the Health/Activity
      APIs are a partner program), so the practical route is an unofficial client
      against Garmin Connect, which breaks when they change the site. Then the
      schema — what one workout row is — and nightly pull vs. on-demand. ("galin"
      in the ask; read as Garmin — correct if wrong.)
- [ ] **Food logging + a database.** Let Kuba log meals to Alfred (a Discord line
      first, a photo later) and keep them queryable — what and when, ideally
      calories/macros. Two open questions: the schema, and whether Alfred
      *estimates* nutrition from a description (a model in the loop, proposing
      rather than recording as fact) or looks it up against a food database. Photo
      input rides on **Read inbound attachments** (Next).

### Later integrations (Kuba, 2026-08-02 — explicitly "for later")

- [ ] **Voice messages → text.** Discord voice notes are Ogg/Opus attachments,
      so this is blocked on inbound attachments (**Next**). Transcribe locally:
      audio is a different privacy category than text.

      **Model: NVIDIA Parakeet-TDT-0.6B, via ONNX rather than NeMo** (Kuba,
      2026-08-04). NeMo's dependency tree is built for GPU training; the int8
      ONNX export is ~1 GB on `onnxruntime`.

      *Whisper considered and not taken.* It is genuinely smaller — `tiny.en`
      39 M, `base.en` 74 M, `small.en` 244 M against Parakeet's 600 M — and
      `pip install faster-whisper` is far less install friction than community
      ONNX exports. Three things outweighed that: RAM and disk aren't scarce
      here (62 GB / 415 GB free), so a 1 GB model costs nothing; Whisper pads
      every clip to a **fixed 30 s window**, so a 4-second note costs the same
      as a 30-second one and the size advantage largely evaporates on exactly
      the clips we'd send; and its silence-hallucination is worst at `tiny`/
      `base`, which is the wrong failure mode for a transcript that *takes
      actions*. Revisit only if the ONNX route proves unworkable — the
      transcriber sits behind a `path -> text` call, so swapping it is cheap.

      **This box is CPU-only** — no GPU, i7-8700 (6c/12t, AVX2, no VNNI), so
      int8 buys ~1.5–2× not 4×: quantize for footprint, not speed. Estimated
      RTF ~0.1 — 10 s note ≈ 1–2 s, 30 s ≈ 3–5 s, plus 1–2 s model load once
      the file is in page cache. Unmeasured, and estimates on 2017 silicon run
      optimistic; time it before designing around it. Either way it's small
      next to a 10–30 s `claude -p` turn, so don't build streaming up front.

      Needs `ffmpeg` (not installed) to decode Opus → 16 kHz mono PCM.

      The transcript becomes the user message; Alfred never learns it was
      spoken. One guard: echo what was heard when the turn takes an action — a
      misheard "cancel Thursday's meeting" otherwise acts on the mishearing.
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
