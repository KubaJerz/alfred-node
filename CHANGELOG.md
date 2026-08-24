# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/), versioning is [SemVer](https://semver.org/).

## [Unreleased]

## [2.9.0] - 2026-08-24
### Added
- **Strength load tracking — Garmin lifting → rolling per-muscle load.** A new
  `strength/` subsystem and `strength` skill turn Garmin strength workouts into
  progressive-overload signal. Reps and weight aren't in Intervals.icu's JSON
  (it recomputes from streams and drops the FIT set records), so a broker route
  downloads the original FIT and decodes the message-225 sets (`@garmin/fitsdk`);
  weights come back as the whole pounds entered (Garmin stores kg at 1/16-kg
  precision). Data lands in SQLite (`agent/var/strength.db`, `node:sqlite`, no
  native dep) across an immutable raw layer, a model-interpreted layer, and
  deterministic views. A headless **Claude Haiku 4.5** pass reads each workout
  against the program templates + that day's note and names the exercises, while
  the code enforces the misfire rule and applies the muscle factor map itself, so
  the numbers stay exact; load is assist-scaled `Σ factor × reps × lb` (a pulldown
  half-credits biceps), exposed as 7-/28-day ACWR and a 14-day trend per muscle.
  `bin/strength.js` gives Alfred `digest` (pull + interpret, nightly via
  `dream.sh` and on-command), `load`, `sets`, and `plot` (a dark mobile
  dashboard PNG — whole-body ACWR against a detrain→build→spike band, a
  per-muscle breakdown with 30-day acute sparklines, and the 90-day total-load
  chart — rendered in matplotlib and sent via `{img:}`). An optional
  `STRENGTH_LOG_CHANNEL` captures Discord
  workout notes immutably to feed the interpreter. Off unless `INTERVALS_API_KEY`
  is set. Design: `docs/strength-load-design.md`.
- **Alfred can read training and wellness data from Intervals.icu.** An
  `intervals` skill and `bin/intervals.js` over the same credential broker Google
  and Notion use: `activities` and `activity` for completed workouts, `wellness`
  for daily sleep, HRV, resting HR and readiness. This is how Garmin data reaches
  him — the watch syncs to Garmin Connect, which syncs to Intervals.icu, which
  this reads. The whole surface is **read-only by construction**: `intervals/
  client.js` exposes GET and nothing else, so there is no route that could edit an
  activity or push a workout back to the watch — a missing capability, not a
  declined one, mirroring "no send route" for mail. `intervals/broker.js` windows
  every list to the last 30 days by default and projects a curated handful of
  fields (an Intervals.icu activity carries ~200), so a bare query can't drag
  years of second-by-second data into the transcript. The key
  (`INTERVALS_API_KEY`, from Settings → Developer) lives only in bot.js's
  environment; athlete `0` means "the key's own athlete", so no id is needed. Off
  unless the key is set, so a box without it runs exactly as before.
- **`/c` (and `/clear`) now takes a message inline.** The command used to be an
  exact match — you cleared, waited for the "Session cleared" reply, then sent
  your question as a second message. It's now a **prefix**: `/c` alone still
  clears and waits, but `/c <text>` clears *and* runs `<text>` as the fresh
  session's first turn, so one message both resets and asks. The clear is
  acknowledged with a 🧹 reaction instead of a second message, and a file sent
  with `/c` (even captionless) rides into the fresh turn too. The parse lives in
  a small pure module (`commands.js`, unit-tested); a word boundary keeps
  look-alikes like `/create` from matching. The inbound turn is now logged
  *after* the clear archives the transcript, so the new message lands in the
  fresh note rather than the one it just ended.
- **Alfred can receive files, not just send them.** A message with attachments
  used to be dropped whenever it had no text (`msg.attachments` was never read);
  now every attached file — any type — is downloaded into that day's folder and
  its path is handed to the turn in an `[ATTACHMENTS]` block, which Alfred opens
  with its Read tool. The block rides on the message, so a file dropped into an
  ongoing (resumed) conversation reaches that turn too. Single-user, high-trust
  channel (gated by `ALLOWED_USER_IDS`), so no type whitelist. Voice notes stay a
  separate future item, sharing only this download path. (#40)
- **Inbound mail reaches Alfred over Pub/Sub (tier 1 — buffer silently).**
  `bot.js` registers a Gmail `users.watch()` on the INBOX and drains change
  notifications from a **pull** subscription (`google/gmail-push.js`), so no
  public endpoint is needed on a NAT'd laptop. A notification is treated as a
  trigger, not data: each one re-reads `users.history.list` from a local cursor
  (`agent/var/google/gmail-sync.json`), filtered to `messageAdded` so a phone's
  "mark all read" can't flood it. New mail is buffered to
  `agent/var/pending-mail.jsonl` (`google/gmail-buffer.js`, capped) and prepended
  as a digest to the **next new session's** context, then cleared — no Discord
  post, no model call, nothing logged (the digest rides inside `finalMessage`,
  which `runClaude` never writes to `messages.jsonl`). Every message passes the
  same `classify()` chokepoint the read path uses, so a login code becomes a
  "withheld" marker before it can reach the buffer; the path fetches metadata
  only, never the body, so nothing but sender + subject can rest on disk.
  Sender/subject are sanitized against digest-delimiter forgery. Draining the
  subscription uses a service-account key (`agent/var/google/pubsub-sa.json`)
  that by construction cannot read the mailbox. Off unless
  `GMAIL_PUBSUB_TOPIC` / `GMAIL_PUBSUB_SUBSCRIPTION` and the key are present, so
  a box without the cloud setup runs exactly as before. `npm run gmail:watch`
  registers/renews the watch by hand.
- **Alfred can read and write Notion.** A `notion` skill and `bin/notion.js` over
  the same credential broker Google uses: `search` and `read` and `query` to find
  and render pages and database rows as markdown, `create` and `append` to
  capture, and `set` to change a row's typed columns. The integration secret
  (`NOTION_TOKEN`) lives in `bot.js`; the CLI holds nothing. Eight loopback routes,
  mounted alongside Google's on the one server. Three things are deliberately
  absent — no comment (it reaches people and can't be unsent, the `send` of
  Notion), no whole-page delete, no archive (removing a page is a later, larger
  surface). The one irreversible write is `set`: a property overwrite Notion keeps
  no API-reachable history of, so that route reads the old value first and reports
  the `from → to`, which is the only undo there is. The access boundary isn't a
  scope but **per-page sharing** — the integration sees only pages connected to it
  in Notion, so an unshared page is absent, not merely restricted.
- **Notion body edits, not just append.** Alfred was append-only on a page body;
  now he can change existing lines. `read <page> --ids` surfaces each line's block
  id, and `check`/`uncheck <blockId>` tick a to-do line off, `edit <blockId>`
  replaces a line's text, and `remove <blockId>` deletes one line. Two new loopback
  routes (`PATCH`/`DELETE /notion/block`). The line held for `set` holds here too:
  `edit` overwrites in place and reports the `from → to`, the only undo. `remove`
  is the opposite — the block lands in Notion's Trash and is restorable, the same
  reversible footing as a calendar delete. `edit` keeps a line's kind (Notion
  can't recast a bullet as a heading in place, so a mismatch is refused, not
  forced), and checking a to-do *line* is distinct from `set Done=true` on a
  row's *column*.
- **The CLIs stopped being narrower than the services behind them.** A class
  meeting Monday/Wednesday/Friday is one series (`--days MO,WE,FR`), not three;
  `--rrule` takes raw iCalendar for shapes nobody enumerated in advance ("third
  Thursday"); `label` takes several labels at once because Gmail always did;
  drafts take `--cc`/`--bcc`, which reach nobody since there is still no send
  route; `events --query` forwards Google's own text search. These were limits
  invented here, not by Google, and none of them prevented a mistake worth
  preventing — a wrong recurring event is one delete away.
- **Attachments are visible.** `read` lists every non-body part and `--part`
  prints a text one. A forwarded calendar invite looked like it carried no
  calendar data when the `.ics` was sitting right there, unlisted. Parts go
  through the same screening as the body.
- **Per-command help.** `gcal.js delete --help` explains delete and nothing
  else; `gcal.js help delete` is the same thing, since both are what someone
  reaches for. (`--help delete` deliberately isn't a form — no tool takes an
  argument to `--help`, and inventing one would be a local convention to
  memorise.) The overview stays one line per command. Checked before dispatch,
  so asking how a command works never runs it.
- **`--help` works, on stdout, exiting 0, with no broker running.** The env check
  used to run at import, so asking a CLI what it does failed with a broker error
  and printed nothing. The skills now point at `--help` rather than restating
  flags, which only works if reading the manual doesn't require the tool to be
  plugged in.
- **Repeating calendar events.** `gcal.js create --repeat weekly --until
  2026-11-24` creates one event Google expands, instead of one event per
  occurrence. A Tuesday class running to November was 16 separate creates and 16
  separate deletes to undo; it is now one of each. The weekday is taken from
  `--start` rather than asked for, so the day and the date cannot disagree, and
  `UNTIL` is emitted in the form the start requires — UTC for a timed series, a
  bare date for an all-day one, which is the RFC 5545 mismatch Google rejects
  with an unexplained 400.
- **Alfred can read mail and run the calendar.** OAuth against a personal Google
  account (not a service account — those can't reach personal Gmail without
  domain-wide delegation, which is Workspace-only). The credentials are held by
  a broker inside `bot.js` that listens on loopback and exposes eight
  operations; the agent gets the address and a per-boot secret through its
  environment, so nothing lands on disk for a stray `cat` to find.
- **Two CLIs, `bin/gmail.js` and `bin/gcal.js`,** each paired with a skill under
  `agent/.claude/skills/`. Skills load on a description match, so the calendar
  ruleset arrives when a conversation turns to the calendar instead of being a
  pointer Alfred has to remember to follow. Verified: telling it "Wednesday the
  21st" when the 21st is a Friday gets the conflict caught and a question
  asked, from a file that is never read up front.
- **Credential screening at a single chokepoint.** Verification codes, OTPs,
  password resets and magic links are classified and stripped inside the
  broker — on search, on read, and on any path added later — because anything
  reaching the prompt is written to `~/.claude/projects/`, which sits outside
  `agent/var/`, `.gitignore` and the memory funnel at once. It fails closed. A
  sign-in *alert* ("new sign-in", "signed in from a new device") is deliberately
  not in that set — it carries no secret, so it passes rather than being withheld
  arbitrarily; a sign-in *code* is still caught. Audited against the real
  mailbox: no code passed.
- **A pre-commit hook that blocks personal files.** Path checks, force-added
  ignored files, secret-shaped content, and the test suite. Verified against
  three deliberate leak attempts and a planted failing test.

- **Real replies.** `gmail.js reply <id> --text "…"` builds the draft from the
  original: recipient (honouring `Reply-To` over `From`), a `Re:` subject that
  doesn't stack, and the `In-Reply-To`/`References` headers that make the
  recipient's client file it in the existing conversation. Previously the only
  option was `draft`, whose `--thread` flag took an id nothing ever printed, so
  every "reply" arrived as a new conversation. Replying to a withheld message
  is refused — a reply quotes and addresses the original, which would route
  screened content back out through an unscreened path.
- **`gcal.js delete <id>`.** Held back while the calendar rules were unwritten;
  the rules now exist and load themselves, and the deciding fact is that Google
  keeps deleted events in a Trash for 30 days and restores them intact. Gmail
  deletion stays absent because it needs the scope that empties Trash for good.
  The line is reversibility, not the verb.

### Changed
- **Dailies are one folder per day, not one file.** `dailies/YYYY-MM-DD.md`
  became `dailies/YYYY-MM-DD/daily.md`, and that folder now also holds any files
  the user sent that day, so pruning a day is one `rm -rf` and a day's note and
  its attachments age together. This names the tiers explicitly: `MEMORY.md` is
  curated long-term memory, the dailies are daily *context* — which is why
  arbitrary files live there and never in `MEMORY.md`.
  `scripts/migrate-dailies-to-folders.sh` moves existing flat notes over
  (idempotent). (#40)
- **Deleting an event that has guests is refused.** Google's documentation says
  of the notification controls that "some emails might still be sent even if you
  set the value to false", so on an event with attendees, cancellation mail
  reaching real people isn't fully controllable. Everything else here is built
  so nobody gets email because of Alfred; this is the case that can't be
  guaranteed, so it's the case that's carved out.
- **Sending mail isn't a permission, it's an absence.** There is no send route
  in the broker at all, so `gmail.js send` names the command only to explain
  the design and exits 1 without reaching the network. Invitations go further —
  `attendees` is unreachable from caller input rather than rejected, so "never
  invite anyone" holds even if Alfred asks for it or never read the rules.

### Fixed
- **The daily note keyed on two different dates.** `loadContext` computed
  "today" in UTC while `dream.sh` used the box's local time, so near midnight
  they could pick different notes — a turn seeded with one day's note while the
  pass consolidated another. Everything now keys on Eastern (`America/New_York`,
  DST-aware) through one helper, so the note a turn reads and the note the pass
  writes are always the same day. (#40)
- **The nightly dreaming pass never ran — `MEMORY.md` sat empty for months.**
  `dream.sh` fires at 03:00 and consolidated *that calendar day's* note, but
  daily notes are written through the day (afternoon/evening), so at 3am the
  note keyed on `TODAY` did not exist yet and the guard `exit`ed before `claude`
  was ever invoked. The log shows 40+ consecutive "No notes for today,
  skipping"; long-term `MEMORY.md` never left its placeholder line and no
  `last-dream` stamp was ever written, despite a dozen `<!-- PROMOTE -->` tags
  waiting. It now targets *yesterday's* note (`date -d yesterday`) — complete
  and present at 3am. The already-written dailies were never consolidated, so
  that backlog is handled as a one-off, separate from this fix.
- **Personal state at the repo root no longer only warns — it blocks the commit.**
  The pre-commit guard recognized Alfred's state names (`memories/`, `logs/`,
  `state.json`, …) appearing at the repo root, outside the one `.gitignore` rule
  that guards `agent/var/`, but check #4 was advisory. So when a memory pass wrote
  a daily note to `memories/` at the root (a model with `Write` +
  `--skip-permissions`, run from the wrong cwd) it got staged into a commit and
  only a manual unstage kept it out of git. Those names are Alfred's state, never
  this app's code, so the check now fails the commit instead of shrugging. The
  stray note was moved back under `agent/var/`; the production writers
  (`consolidateMemory`, `dream.sh`) were already correct.
- **Calendar update never worked.** The broker read request bodies for `POST`
  but not `PATCH`, so every update arrived empty and came back "nothing to
  change" — indistinguishable from asking for nothing. Found by an audit, not
  by use, because the write paths had never been exercised.
- **Non-ASCII subject lines were mangled in drafts.** Headers were written as
  raw UTF-8, which is not valid RFC 5322, so the receiving client read the
  bytes as latin-1 and `TO DELETE — probe` arrived as `TO DELETE â€” probe`.
  Subjects are RFC 2047 encoded-words now and the body carries an explicit
  base64 transfer encoding. Nothing errored — it just looked wrong, and Alfred
  writes the kind of prose full of em dashes and curly quotes that trips it.
- **`gcal.js events --from 2026-08-05` failed with "Bad Request".** Google's
  `timeMin`/`timeMax` require an offset, so a plain date — the obvious thing to
  type — was rejected, and the error said nothing about why. Found by Alfred in
  a live turn: he tried a date, tried a date with a time on it, then gave up and
  listed the whole calendar unfiltered. Bare dates and offset-less times are now
  interpreted in `America/New_York`, DST included.
- **Calendar times were six hours off.** `events.list` formats in the
  *calendar's* default zone, and the account's was `Europe/Warsaw`. Reads now
  request `America/New_York` explicitly, matching what writes stamp.
- **A network outage no longer crash-loops the bot.** `client.login()` rejects
  with `EAI_AGAIN` when DNS is unavailable (suspended laptop, dropped Wi-Fi).
  The rejection was unhandled, so Node dumped a stack and exited, and the
  wrapper relaunched 5s later — forever. The logs show **383,295 restarts**
  between 2026-06-29 and 2026-08-02, which is what actually produced the 186 MB
  `alfred.log`. Now: the login rejection is caught and exits quietly with code
  75 (`EX_TEMPFAIL`), `start-alfred.sh` re-checks DNS before every launch, and
  failed starts back off 5s → 300s, resetting after a run that stays up a
  minute. Worst case drops from ~11k restarts/day to ~200, each one line.
- **`alfred.log` is capped.** Rotation runs before every launch (not just at
  boot, since the launcher runs for months), keeping one generation at
  `alfred.log.1`. Size limit is `MAX_LOG_BYTES`, default 50 MB.
- **A lapsed Claude login is now named as such.** `claude -p` reports an expired
  session as an ordinary-looking message, so Alfred relayed
  `Not logged in · Please run /login` as if it were a considered reply (seen for
  real on 2026-08-01). The bot now recognizes the auth-failure shapes and
  answers with what to actually do, logs it as `kind:"auth_error"`, and doesn't
  overwrite session state with the dud turn. Matching is deliberately narrow so
  a genuine reply that discusses logging in isn't swallowed.
- **Timeouts say so.** `spawn`'s `timeout` kills the child rather than
  returning an error, so hitting `CLAUDE_TIMEOUT_MS` surfaced as an empty or
  garbled reply. A killed-with-no-output run now reports how long it waited and
  suggests raising the limit or splitting the request.
- **Concurrent messages no longer race on session state.** A turn reads
  `state.json`, spawns `claude --resume <id>`, and writes the new id back; two
  messages arriving close together both resumed the same session and clobbered
  each other's write. Turns are now chained and run strictly one at a time in
  arrival order, with a ⏳ reaction marking a message that's waiting. A failing
  turn doesn't stall the ones behind it.
- **`state.json` has a single writer again.** `dream.sh` overwrote it wholesale
  each night, so a pass landing mid-conversation silently reset the session.
  It now stamps `agent/var/last-dream` instead, and the bot starts a fresh
  session on the next message when a dream has run since the last turn — which
  is what forcing a reset was actually for: picking up rewritten memory.

### Added
- `bootstrap()` creates `agent/var/` and seeds `USER.md` (from the new tracked
  `agent/USER.md.example`), `MEMORY.md`, and `changelog.json` on first run, so a
  fresh clone works with `npm install && npm start` and no manual setup.
- Startup check that fails loudly when `AGENT_DIR` has no `SOUL.md`, instead of
  running with an empty context.
- `TODO.md` — working backlog for improvements to Alfred.
- Alfred can send file attachments. It emits `{img:path}`, `{pdf:path}`, or
  `{file:path}` inline in a reply; `bot.js` extracts the tokens, attaches the
  real files (renamed `attachment_<i>.<ext>` to avoid collisions), and strips
  the tokens from the visible text. Any readable path works (absolute, or
  relative to `AGENT_DIR`). Missing/oversized files (>`MAX_FILE_BYTES`, default
  8 MB) become an inline note; total capped at `MAX_ATTACHMENTS` (default 30);
  files batch to Discord's 10-per-message limit. Documented in `SOUL.md`.
- `CLAUDE.md` documenting the project and the issue → branch → PR → version workflow.
- `CHANGELOG.md` (this file).
- Alfred now responds to every message from an authorized user in any channel
  it can see, without needing an `@mention`. Access stays restricted to
  `ALLOWED_USER_IDS`.
- Silent opt-out: Alfred can emit `<no_reply>` (and nothing else) when a message
  isn't directed at it, and the bot stays completely silent instead of posting.
  Guidance for when to use it lives in `SOUL.md`.
- Bot-level JSONL transcript: every turn through Alfred is appended to
  `messages.jsonl` — inbound (`dir:"in"`) and outbound (`dir:"out"`, with
  `kind` of reply/clear/silent/error). This is the bot's own log, separate from
  Claude Code's per-session `.jsonl`. Added `messages.jsonl` (and other runtime
  artifacts) to `.gitignore`.
- Two-stage memory funnel. On `/clear` the just-ended conversation is copied to
  `logs/<firstTs>_to_<lastTs>.jsonl` (UTC, filename-safe), then a headless Claude
  is spawned (detached) to fold it into **today's daily note** using the prompt in
  `memory-prompt.md` — loose filter: just summarize what happened. Placeholders:
  `{{TRANSCRIPT}}` → archive path, `{{DAILY_PATH}}` → today's note path, `{{DAILY}}`
  → its current contents (so the pass merges instead of overwriting). If
  `memory-prompt.md` is absent/empty the consolidation is skipped but the archive
  still happens. `messages.jsonl` resets after each archive so every archive is
  exactly one conversation. `logs/` is gitignored. The nightly `dream.sh` pass is
  the second stage — strict filter promoting only durable facts from dailies into
  `memories/MEMORY.md`.

### Changed
- **BREAKING — repo restructured into three layers.** The app, Alfred's config,
  and Alfred's personal data no longer share one directory:
  - `agent/` holds Alfred's config (`SOUL.md`, `memory-prompt.md`, and its own
    `CLAUDE.md`) and is now the cwd for every spawned `claude`.
  - `agent/var/` holds everything personal — `USER.md`, `memories/`, `logs/`,
    `state.json`, `messages.jsonl` — and is gitignored as a whole.
  - The repo root keeps the app and dev docs; Alfred never reads them.
  - `bot.js` resolves `REPO_DIR` from its own module path (not cwd) and derives
    `AGENT_DIR`/`STATE_DIR` from it; both remain env-overridable.

  **Upgrading:** unset `AGENT_DIR` in your `.env` — an existing value pointing at
  the repo root now silently starves the bot of context, so the bot refuses to
  start if `SOUL.md` isn't found there. Update any crontab that writes
  `dream.log` to `agent/var/logs/dream.log`.
- Split dev guidance out of `CLAUDE.md` into `CONTRIBUTING.md`. `CLAUDE.md` is
  auto-loaded by Claude Code from the working dir — and since `bot.js` spawns
  `claude` in that same dir, the full issue→PR→SemVer workflow was leaking into
  Alfred's runtime prompt on every message. `CLAUDE.md` is now a short stub that
  points to `CONTRIBUTING.md` (not auto-loaded) for the workflow.
- Both memory passes now explicitly permit a no-op: `memory-prompt.md` and the
  `dream.sh` prompt tell the model it's fine to make no edits when nothing is
  worth logging/promoting, so it doesn't invent filler entries.
- Expanded `.gitignore` to cover `node_modules/`, logs, `state.json`, and `messages.jsonl`.
- Collapsed the two-tier long-term memory (`MEMORY.md` + `OLD_MEMORY.md`) into a
  single `memories/MEMORY.md`. `loadContext` no longer injects an archive file,
  and `dream.sh` curates one lean store instead of demoting items between two.
  The hot/cold (L1/L2) split is deferred until memory is large enough to need it
  (tracked in #8).

### Removed
- `memories/OLD_MEMORY.md` and all code/doc references to it.

### Fixed
- **Personal data is no longer tracked in git.** `USER.md`,
  `memories/MEMORY.md`, and `memories/changelog.json` were committed;
  `memories/dailies/` was untracked *and* un-ignored, so any `git add -A` would
  have committed conversation notes. All now live under the ignored
  `agent/var/`. (Note: `USER.md` contents remain in git *history* from the
  initial commit.)
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
