# TODO

Working backlog for improving Alfred. Dev-facing — like `CONTRIBUTING.md`, this
file is **not** auto-loaded into Alfred's runtime prompt.

Items graduate: **Now** → branch + PR (see `CONTRIBUTING.md`) → strike through
and move to **Done** with the PR number. Anything with a GitHub issue links to it.

---

## Now

### Calendar

- [ ] **Keep Google's "Events from Gmail" off.** A forwarded invite can land on
      the calendar twice: Ronnie's guest-less add, and Google's own auto-add,
      which copies the organizer and every attendee from the `.ics` and keeps the
      `FW:` subject as the title. The `FW: Lab Meeting` series (Anna Chupak as
      organizer, 8 guests) was Google's — the log shows Ronnie only labelled
      those forwards Interesting, with no `📅` line. Ronnie never adds guests and
      writes with `sendUpdates: "none"`. Google Calendar → Settings → Events from
      Gmail.

### Ronnie — mail tiers, after #84

#84 split Bulk into Records and General and added Meetings. The rest of the
redesign, from a five-agent audit of the 1,777-message backfill:

- [x] ~~**Topics.**~~ Done in #86. Make `ut` a real topic (424 backfill messages carry it, but
      the code has no `ut`). Add `health` (Prisma/MyChart; reaches Priority),
      `research` (lab, AI Institute, Leo's group; needs Haiku), `usc` (alumni
      and admin senders only, not people at `email.sc.edu`), `receipts` (Uber,
      Square, travel) and `benefits` (Empower, SurePayroll, PEBA, USC HR). Add
      the subtopics the audit found under Records and Interesting. Fix the
      misses: FreeTaxUSA/TaxAct/IRS → taxes; Optiver, Akuna, iCIMS, Handshake,
      `indeedemail.com` → jobs.
- [x] ~~**Novelty ledger.**~~ Done in #90. Thresholds as built: 1st or 60+ days
      → Priority, 2nd–3rd → Interesting, 4th on → Records. A JSON tally per sender brand × mail kind (statement,
      autopay reminder, payment confirmed, …) with distinct-day count and
      last-seen date. First time ever → Priority. Roughly yearly, or a gap over
      60 days → Priority. A steady cadence (about the 4th time) → Records.
      Failed payments, bills due and security mail never become routine. Seed
      from the backfill — Gmail ids carry the date.
- [x] ~~**ToS check.**~~ Done in #94: a separate Opus run with WebSearch and an
      allowlisted WebFetch, links stripped from the email, re-checked at 48h.
- [ ] **ToS check: more early sources.** A live run found ConductAtlas (a ToS
      change tracker) through search but could not open it. Vet it and add it to
      `FIXED_SITES`, and add big services the owner uses to
      `RONNIE_POLICY_FETCH_DOMAINS` so their own change pages can be read.
- [ ] **ToS check, later: Twitter.** Also look at what people on Twitter say
      about the change before deciding. The free mirrors (Nitter, XCancel) are
      gone; the X API is pay-per-use (about $0.005 a read). If added, bot.js
      fetches the posts and passes them in as untrusted text — the model gets
      no new tool.
- [ ] **Job assessments into Jobs.** Assessment invites are Priority now. Later,
      file them so all job mail is in one place to review.
- [ ] **Re-sort the existing inbox.** Run `scripts/ronnie-backfill.mjs` again
      (dry run first) so old Interesting receipts and statements move to Records.

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
      pinged, `Interesting`, `Records`, `General`, `Meetings`, plus topic
      children), so "that email Ronnie
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
- [ ] **Revisit: the Tailscale operator is Alfred's user.** Set 2026-10-08
      (`sudo tailscale set --operator=koob`) for a phone viewer we then did not
      build. Any process running as that user, Alfred included, can change
      Tailscale settings without `sudo`: `tailscale serve`, or `tailscale
      funnel`, which publishes a port to the whole internet. Left in place on
      purpose for now. Undo with `sudo tailscale set --operator=`. The separate
      Unix user above also closes this.
- [ ] **A file Alfred can read is not a secret.** Gitignored files (`.env`, a
      local `.secrets`) stay out of git but not out of Alfred's reach, since he
      runs as the same user. Real secrets go in a password manager or a
      root-owned file until the separate user exists.

#### Phone and SMS (from the MMS review, 2026-11-23)

SMS and MMS are not end to end encrypted: the carrier and Telnyx see every
text and file, and Telnyx keeps them. Caller ID can be spoofed, so the
allow list stops strangers, not a determined attacker. These close the gaps.

- [ ] **Per-number permissions.** Today `SMS_ALLOWED_NUMBERS` is one tier: a
      number in it can do anything Kuba can. Make it a table, so more people
      can text Alfred, each with only what they need. For each number: may it
      start a turn at all, send photos and files (MMS in), get files back (MMS
      out), send voice messages, and which tools its turns may use (read-only,
      calendar, mail…). Kuba's numbers keep full rights; a friend might get
      text-only scheduling and nothing else. Ties into the verbal-consent list
      the 10DLC campaign needs before Alfred texts anyone new.
- [ ] **A PIN for risky actions by text and by call.** Sending mail,
      deleting, buying, paying, or changing settings from SMS or a call needs
      a spoken or texted PIN in the same turn. Closes caller-ID spoofing for
      anything that matters. Same idea as the open point in
      `docs/phone-design.md` for calls.
- [ ] **Limit which files can go out by MMS.** `extractAttachments` takes any
      path Alfred names, so a tricked turn could text `.env` or a token file,
      in the clear, through the carrier. Allow only files under `agent/`
      (dailies, screenshots, generated files) and never `agent/var/google/`,
      `.env`, or dotfiles.
- [ ] **Shorter MMS file links.** `MEDIA_TTL_MS` is 1 hour. Telnyx fetches in
      seconds; cut to about 10 minutes, and drop a link after its first
      successful fetch if Telnyx does not retry.
- [ ] **No secrets by text.** A rule in `agent/SOUL.md`'s SMS section: never
      text passwords, codes, ID numbers, or financial documents; say "sent in
      Discord" instead.
- [ ] **Treat text in photos as data.** An MMS photo or file is untrusted
      content, like an email. Make sure the attachment block says so, so
      instructions written in a picture never steer a turn.

## Next

### Phone — 2B on OpenAI

- [ ] **Try GPT-Live (`gpt-live-1`) as a 2B engine.** OpenAI's newer voice model
      is built for this shape: full duplex, and "client delegation" sends the
      backend work to us (Alfred), with results spoken as commentary. It takes
      PCMU over WebSocket, so Telnyx stays the same. On hold: it is a flat
      $0.05/min, about twice our Realtime cost ($0.019–0.029/min), it has no
      documented turn-detection settings, and Realtime works well now. A/B it
      with the standard test call in `docs/phone-design.md`. It is also the only
      way to use a voice designed from a description (prompt-to-voice); Realtime
      takes only named voices or recording-based ones.

### Phone — 2B direct tools and turn detection

- [ ] **Test semantic VAD (eagerness high) for a few days** (from 2026-11-16).
      The 100 ms timer split one request into 3–4 turns, and the voice
      answered half requests ("unchecked" became "checked"). Compare split
      requests, noise cut-offs and latency (was ~0.83 s on the timer, ~1.65 s
      on eagerness high), then decide. If noise still cuts in, try OpenAI's
      `noise_reduction` and the `server_vad` threshold.
- [ ] **Later, if noise still cuts in: ignore short sounds.** Turn off
      OpenAI's `interrupt_response` and do our own barge-in: stop Alfred only
      for sound longer than ~400 ms, or sound with words. Today a bump or road
      noise cancels his reply, and he starts the answer over.
- [ ] **Part 1: direct tools for the voice (#124).** `notion` (search, read
      with numbered lines, add under a section, check/uncheck, edit, remove,
      create subpage; any shared page), `calendar` (read, add, edit, delete),
      `get_time`. `use_tools` stays for everything else. Each direct write
      leaves Alfred a line in the daily note, and a `src: "tool"` row in the
      ledger that his next message starts with (part 2, #153, replaced the
      in-memory line).
- [x] **Make the voice terse and conversational (#130).** Prompt only for
      now: quick tools get no words, "Done." after an action, one short line
      before `use_tools`. Code ideas, held until a test call shows the prompt
      isn't enough:
  - [ ] Cut speech the voice queued just before a quick tool call: clear the
    player and truncate the item, as a barge-in does (`realtime.js`).
  - [ ] Cap the length of the reply after a quick-tool *change*
    (`max_output_tokens` on that `response.create`), never after a read.
  - [ ] notion tool: if the title is known, read it directly; search is for
    a half-remembered title (saves a ~0.4 s round trip).
  - [ ] Filler nudge: maybe 6 s instead of 8, and "this is the one time you
    may speak" if the new prompt makes it go quiet.
- [ ] **More engines for the voice eval (#151).** `scripts/voice-eval.mjs`
      drives OpenAI Realtime only. Next, each as an engine with the same
      scenarios and scoring: (1) a Claude "brain" (Haiku/Sonnet/Opus 5.5 with
      the voice tools, text in and out) behind a speech front end such as
      Telnyx's custom-LLM endpoint, which needs an Anthropic API key for real
      latency; (2) Gemini Live; (3) GPT-Live (`gpt-live-1`, its own protocol);
      (4) a robot call that dials a Telnyx assistant from our number and plays
      the script, as the end-to-end check.
- [ ] **Look for a voice model or serving setup that restates less.**
      `gpt-realtime-2.1-mini` pads every result ("Done. Bread has been added
      to your shopping list.") and narrates between tool calls whatever the
      prompt says. Compare other realtime models, or a cascaded setup (STT →
      LLM → TTS) where the spoken text can be trimmed before it is voiced.
- [x] **Part 2: one shared context for the voice and Alfred (#153).** Either
      side knows what happened on the other, through one ledger,
      `agent/var/messages.jsonl`; `docs/shared-context.md` has the whole
      picture, and `docs/phone-context-review.md` the review it follows. No
      model condenses anything (the review dropped Haiku: at these sizes there
      is nothing to condense), and nothing writes into Claude Code's session
      files. Shipped, in five steps:
  - [x] Every day with messages gets a daily note: the nightly pass folds the
    ledger into each row's own day before it dreams, with a watermark, and
    `/clear` folds what it archives. Inbound rows name their saved files.
    `scripts/backfill-dailies.mjs` folds past days on request.
  - [x] A 2B call writes itself into the ledger as it happens: caller and
    voice lines verbatim, start and end, direct tool changes (`src` `call`
    and `tool`), so no call is lost to a crash or a restart.
  - [x] **Phone → Alfred:** each turn on any channel starts with the call
    lines and tool changes since his last turn, from a cursor on disk; a new
    session gets yesterday's and today's notes and the last 6 hours on every
    channel.
  - [x] **Alfred → phone, live:** a text or SMS during a call, and Alfred's
    reply, go into the call as they are written (system items, no reply
    asked); `/clear` tells the call to forget.
  - [x] **Alfred → phone, at call start:** the voice's prompt gets a briefing
    (USER, MEMORY, the two notes, the last 6 hours), built while the socket
    opens, about 24,000 characters at most, with the oldest messages dropped
    first and a log line when anything is.
  - [ ] **Run the voice eval** on the new `live-*` and `brief-*` scenarios
    (paid; not run yet), and compare a few runs with the briefing off
    (`--no-briefing`) and the live feed off (`--no-feed`).
  - [ ] **Test it live:** a fast back-and-forth between call, Discord and
    SMS, checking each side knows what the other just did (the test matrix
    in `docs/phone-context-review.md`).
  - [ ] **Apply the backfill** to the real notes, after a dry run on a copy
    is read and approved.
  - [ ] **Watch the briefing's budget.** If "Briefing cut to fit" shows up
    in the log often, add a condenser as a cache ("Condensing, if ever" in
    the review).
  - [ ] **The caller's newest line can miss its own `use_tools` turn.** The
    transcript of a caller line can come after the turn read the ledger; it
    then shows on Alfred's next turn. Waiting briefly for the transcript
    before the turn reads would close it.
  - [ ] `agent/SOUL.md`'s startup checklist still tells Alfred to read
    USER.md, MEMORY.md and the notes himself, though a new session now gets
    them. Trim it, or leave it as a reminder for a resumed session.
- [x] **Send Alfred the caller's own words** with each `use_tools` request,
      so a request the voice retold wrong can be checked against them. Done by
      the catch-up (#153): a `use_tools` turn is a turn, so it starts with the
      call so far, the caller's lines word for word. The one gap is the race
      in the Part 2 list above.

### Web access — debug Alfred's browser, find the best web tools for agents

A big one. Alfred's headed Chrome (agent-browser, own profile,
`AutomationControlled` off) gets bot-blocked by some big stores, and the block
is disguised: patagonia.com (Akamai Bot Manager) serves a static "System
maintenance is in progress" page, so Alfred told Kuba the site was down
(2026-11-23). Facts so far: Kuba's Mac on the same public IP gets the real
store; Alfred's Chrome, the same Chrome with a fresh empty profile, and curl
all get the maintenance page, while Firefox on the box gets in. So it is not
the IP, the machine, or stale cookies; it is how the automated Chrome looks.

- [ ] **Patagonia as the test case.** Open the product page with (1) a plain
      Chrome on the box, no automation, (2) Alfred's Chrome after clearing
      only patagonia.com cookies, (3) whatever replaces it below. Pass = the
      price shows.
- [ ] **Research the field.** Search (X, GitHub, blogs) for how people give
      agents reliable web access in 2026: stealth Chrome builds and CDP-leak
      fixes (e.g. patchright, nodriver, camoufox), connecting to a real
      everyday Chrome, hosted browser APIs (Browserbase, Browser Use cloud,
      Anchor, Hyperbrowser, Steel), scraping/search APIs (Firecrawl, Exa,
      Tavily, Jina reader), and the vendors' own agent-browsing products.
      Compare cost, reliability against Akamai/Cloudflare/DataDome, login
      handling, and privacy (who sees the pages and cookies).
- [ ] **Pick a combination.** Likely tiers: a fetch/search API first, the
      local browser for logged-in sites, a hosted stealth browser as the
      fallback for blocked stores.
- [ ] **Honesty rule now.** In the browser skill: a "maintenance", "access
      denied" or challenge page on a site that is otherwise up means "this
      site blocks my browser", not "the site is down"; fall back to search.

### Remote access to the box

- [x] **Reach the machine from anywhere — Tailscale + SSH.** Done by
      2026-10-08: Tailscale is up (the box is `opti`), and `sshd` runs, so
      `ssh koob@opti` works over the tailnet and `sudo` no longer waits until
      Kuba is at the machine. Left to check: key-only login for `sshd`.

      Keep `sudo` behind a password. Remote access is for Kuba, not for Alfred.

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

### SMS

- [ ] **Group texts.** Kuba asked (2026-11-12) to put Alfred in group chats.
      Today `telnyx/sms.js` drops any sender not in `SMS_ALLOWED_NUMBERS`, and
      replies go only to `SMS_ALLOWED_NUMBERS[0]` (`bot.js` `smsTarget`), so in a
      group Alfred hears only Kuba and answers him alone. Needs: read the group's
      participant list from the inbound `to`, reply to the whole group (group
      MMS), decide who in a group may trigger a turn, and keep personal data
      out of replies others can see. Check Telnyx support for group MMS on our
      number first.
- [ ] **Typing bubbles: "👀 On it" now, RCS later.** Plain SMS/MMS has no
      typing indicator (Telnyx `POST /v2/messages` has no such field). Until
      RCS, `smsTarget.typing()` sends one "👀 On it…" text when a turn is
      still running after ~10 s (≈ $0.008 each).
- [ ] **Someday: an RCS agent (research 2026-11-23).** RCS gives typing
      bubbles (`agent_message.event.event_type: IS_TYPING` on
      `POST /v2/messages/rcs`, needs an approved `agent_id`), read receipts,
      a branded sender, and richer media. What it takes:
      - A separate branded sender (agent id), not our 10DLC number; the number
        can be the `sms_fallback`. A new thread on the phone.
      - Paperwork: EIN (free, IRS), business website with privacy and terms,
        business-domain email, 224×224 logo, 1440×448 banner, public demo
        video. Aegis verifies identity (EIN ↔ legal name), then Google, then
        each carrier one by one. Weeks to months. Sole proprietor is an
        allowed legal type at Telnyx.
      - Telnyx cost: $500 one-time T-Mobile/U.S. Cellular activation, $100/yr
        vetting, **$100/month agent maintenance** (Telnyx's own fee), rich
        text $0.0065 + carrier per segment, rich media $0.016 + carrier.
        About $1,800 the first year.
      - Others (unverified, mostly competitor blogs): Twilio reportedly no
        monthly fee, $500 onboarding + $200/yr Aegis, ~$0.0083/segment;
        Plivo ~$0.0077; SimplyRCS $0.0039 + $250 setup. Ask Twilio and Plivo
        directly before choosing; RCS could live on one provider and SMS on
        Telnyx.
      - Unconfirmed: that Telnyx relays IS_TYPING end to end, and that an
        iPhone shows a business agent's typing bubble.
      - Sources: telnyx.com/pricing/messaging/us,
        support.telnyx.com/en/articles/16624343-rcs-fees-and-charges,
        developers.telnyx.com/api-reference/rcs/send-an-rcs-message.
- [ ] **PDFs from an iPhone can't reach Alfred by text (tested 2026-11-24).**
      Alfred → iPhone PDF over MMS works (delivered and opened). iPhone →
      Alfred never leaves the phone: Telnyx shows no inbound record. Apple's
      Messages only attaches photos, video, audio and contact cards to a
      green-bubble text; files go over iMessage or RCS only. Not a Telnyx or
      carrier problem. Android (Google/Samsung Messages) can likely attach a
      PDF to MMS within the carrier's ~1 MB cap, untested. For now: send PDFs
      on Discord or by email, or screenshot the pages.
      - RCS: the RBM inbound path accepts PDFs (Google `userFile`, Telnyx
        `payload.body.user_file`, AWS lists `application/pdf`), but no doc or
        first-hand report confirms an iPhone can attach a file in a business
        RCS chat. Needs a real test if we ever build the RCS agent.
- [ ] **Someday: blue-bubble iMessage (research 2026-11-24).** Would let the
      iPhone send Alfred PDFs and any file. Options:
      - **Mac mini + BlueBubbles Server** (recommended): used Apple Silicon
        mini ~$150–350, ~7 W, free software, actively maintained. Dedicated
        email-only Apple ID (a phone number needs a SIM in an iPhone, so the
        Telnyx number can't be used). Webhook to `bot.js` on new messages,
        REST API to fetch attachments and send. Data stays on our hardware.
        Low ban risk for one person at low volume. Lighter fallback: `imsg`
        (openclaw/imsg), attachment metadata only.
      - **Hosted iMessage API** with a real number: Blooio $39/mo (free
        20-message trial), Sendblue ~$100/mo. Grey area (vendor Mac/iPhone
        farms), every message passes through them, a flagged line can change
        number. PDF inbound unconfirmed — test on a trial first.
      - **Ruled out:** Apple Messages for Business (needs an Apple-approved
        MSP, enterprise-oriented, no bot-only deployments, customer-initiated
        only); a macOS VM on this box (spoofed serials, fragile, against the
        licence); Matrix bridges (still need a Mac); AirMessage (stalled);
        pypush (no iMessage yet).
      - Apple's iMessage terms bar commercial use; Beeper's Macs were cut off
        in 2024. Keep Telnyx SMS/MMS as the fallback either way.
      - Sources: docs.bluebubbles.app, github.com/openclaw/imsg,
        blooio.com/integrations/api/pricing,
        docs.sendblue.com/getting-started/receiving-messages,
        register.apple.com/resources/messages/messaging-documentation,
        developers.telnyx.com/docs/messaging/messages/receiving-rcs-webhooks.

### Reminders

- [x] ~~**Reminders and recurring jobs.**~~ Built for #150. One list in
      `agent/var/reminders.json`. `bin/remind.js` (and the 2B voice's
      `reminders` tool) change it through broker routes, so `bot.js` is the
      only writer. A tick in `bot.js` fires what is due, once a minute.
      Delivery is at least once: Discord counts when the send resolves, SMS
      when the Telnyx report says `delivered`. Repeats keep their clock time
      across daylight saving. Each reminder gets a one-way copy in Google
      Calendar. Jobs run only from files in `agent/jobs/` that git committed.
      `SYSTEM-MAP.md` has the full picture. A Fable review compared four
      shapes (Google Calendar as the source of truth, a separate scheduler
      process, CalDAV, and this one) and backed this one.
- [ ] **SMS reminders to other people.** Today another contact gets a
      reminder by Discord only. The 10DLC campaign needs four steps before the
      number texts anyone but Kuba (`docs/phone-design.md`): a confirmation
      text to each new contact, an opt-in record, a STOP list, and "Jakub
      Jerzmanowski's assistant" in each text.
- [ ] **Must-acknowledge reminders.** Keep firing every 6 hours (tunable per
      reminder) until someone acknowledges, e.g. by replying on Discord or SMS.
- [ ] **Website.** A page listing reminders and jobs. Start with a
      `/reminders` command that posts a rendered HTML page to Discord, like
      the Ronnie dashboard. A real site listens on the Tailscale address only:
      not on port 8788, which Funnel publishes to the internet, and not
      through `tailscale serve`, since Alfred is the Tailscale operator and
      could switch it to Funnel.
- [ ] **Jobs and the same-user gap.** Alfred runs as the same Unix user as
      `bot.js`, so he could edit `reminders.json` directly and skip the tool.
      A job file must be committed with no change since, which keeps free text
      out of the job list. The separate-user item (Security, above) closes the
      rest.
- [ ] **Move `dream.sh` into the job list.** A code job that is done only on
      exit 0 fixes the unconditional `last-dream` stamp. It needs the crontab
      line removed by hand, in the same step.
- [ ] **Two-way calendar sync, later.** Today Alfred writes the copy and never
      reads it back. First step: look for deleted copies every ten minutes and
      cancel them. Write the conflict rule down before more (Calendar wins on
      time, the list wins on who and how). Google Tasks cannot carry a timed
      reminder: its API stores a due date but no time.
- [ ] **Phone-call reminders.** Alfred cannot place an outgoing call yet. That
      is its own build.

## Someday / Maybe

- [ ] **Tiered memory (L1/L2).** `agent/var/memories/MEMORY.md` is injected into
      every new session; it's empty today, but the split plan is already noted in
      that file's header (issue #8). Do it when size actually becomes a problem.
- [ ] **Give Alfred a phone number — voice calls (#98).** A Telnyx AI
      Assistant does the audio, and bot.js is its model. The test plan is in
      #98 and `docs/phone-design.md`.
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
