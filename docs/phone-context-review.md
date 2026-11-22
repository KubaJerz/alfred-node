# Phone ↔ Alfred shared context — design review (Part 2)

Reviewed 2026-11-22 against `bot.js`, `telnyx/realtime.js`, `telnyx/pipeline.js`,
`agent/phone-voice.md`, `dailies.js` and the Part 2 item in `TODO.md`. Sizes
below are from the live `agent/var/` (shapes and byte counts only).

## The numbers first

| thing | size now | ≈ tokens |
|---|---|---|
| `messages.jsonl`, whole file (449 rows since 2026-09-16, no `/clear` in 2 months) | 190 KB | 47k |
| … rows from the last 24 h | 28 rows, 5 KB | 1.3k |
| … last 7 days | 62 rows, 16 KB | 4k |
| … last 30 days | 355 rows, 89 KB | 22k |
| `MEMORY.md` | 4.6 KB | 1.1k |
| `USER.md` | 0.5 KB | 0.1k |
| a daily note | ~0.35 KB | 0.1k |
| `phone-voice.md` | 2.6 KB | 0.65k |
| one 5-minute call, both sides verbatim (call rows average 136 chars) | ~2.5 KB | 0.6k |

Realtime mini text pricing (from `realtime.js` PRICES): $0.60/M in, $0.06/M
cached. A 4k-token briefing costs $0.0024 on the first response and ~$0.0002
on each later one (the prefix is cached). A 10-turn call: about half a cent.
Audio on the same call is 20–50× that. Instruction text is not where the money
is. The real cap is the Realtime context window (32k): instructions are never
truncated, old conversation items are, so a briefing over ~6–8k tokens starts
to eat the call's own working memory. **Cap by size, ~24 KB of text, not by
cost.**

Consequence: at these volumes there is nothing to condense. The voice needs
the last 24–48 h plus the last call (≈2–3k tokens). Alfred's resumed session
already holds everything else. A "running summary" already exists and already
runs nightly — it is `MEMORY.md` via `dream.sh`. **Drop Haiku from Part 2
entirely.** Build the size cap; if the log shows the cap being hit regularly,
add a condenser later as a cache (section "Condensing, if ever").

## What is wrong or over-built in the agreed plan

1. **"Keep a ready briefing file."** Over-built. It exists only to keep a
   slow Haiku run off the critical path; with no Haiku there is nothing slow.
   Reading the tail of a 200 KB file and three small files takes a few ms,
   and the call is already waiting for the OpenAI socket to open (hundreds of
   ms). Build the briefing when the media socket opens, in parallel with the
   connect, and put it in the `session.update` sent on `open`. No file, no
   staleness, no "was the file rebuilt after that message" bug class.
2. **"At call end, transcript to messages.jsonl."** Write per utterance, not
   at call end. Live rows mean: a bot crash mid-call loses nothing; a Discord
   message mid-call sees the call so far; and a `use_tools` turn mid-call can
   carry the caller's verbatim words to Alfred (the separate TODO item "send
   Alfred the caller's own words" falls out for free).
3. **"A summary prefixed to Alfred's next message."** The prefix is right,
   the summary is not. 600 tokens of verbatim transcript beats any summary,
   needs no model, and cannot misreport. Truncate only above ~3k tokens (keep
   direct-tool rows and the last N lines). What also matters: the prefix must
   be derived from a **persisted cursor**, not an in-memory "pending" buffer,
   or a restart between call and next message loses it.
4. **Daily-note line at call end.** Fine, but mechanical:
   `## 14:02 — Phone call (4 min)` + the first caller line + each direct-tool
   action. The `/clear` memory pass later reads the archived ledger (which now
   has the call rows) and is told to merge, so no duplication problem.
5. **Missing: the voice must not see itself twice.** Today every `use_tools`
   request and reply is logged as `via:"call"` chat rows (138 of them). Once
   the verbatim transcript is logged too, a briefing that renders both shows
   each call twice, in two wordings. Tag rows by source (below) and render
   calls from the transcript only.
6. **Missing: persona.** Both sides are "Alfred". In the voice's briefing,
   Alfred's Discord replies are "you said (by text)". In Alfred's prefix, the
   voice's lines are "you said (on the call)". `phone-voice.md` already
   forbids naming another assistant; the briefing wording must obey it too.
7. **Missing: new Alfred sessions.** `dreamedSince` starts a fresh session
   after every nightly pass and `loadContext()` gives it `MEMORY.md` + today's
   (usually empty) daily — the previous evening's chat is gone. The same
   "recent tail" builder fixes this: append the last ~24 h of the ledger to
   `loadContext()`. Free win from the same code; do it in phase 5.
8. **Partly wrong premise: "messages.jsonl is reset on /clear."** True, but a
   dream-pass new session does *not* reset it (hence 2 months in one file).
   Good for the ledger; it just means readers must tail by bytes (read the
   last 256 KB), never slurp and parse the whole file forever.

## Architecture: one ledger, two cursors

**Ledger** = `agent/var/messages.jsonl`, unchanged file, one new field. It is
the single source of truth for "what happened on any channel". One writer:
`logTurn()` in `bot.js` (move it and the readers into a small `ledger.js`).
`realtime.js` and the direct tools never touch the file — they call back.

Row shape (existing fields kept; `src` missing ⇒ `"chat"`, so old rows parse):

```
{ts, dir:"in"|"out", via:"discord"|"sms"|"call", src, text, kind?, user?, channel?, callId?}
src:"chat"  handleTurn in/out — Alfred's own turns, already in his session
src:"call"  caller utterance (dir in) / voice utterance (dir out), verbatim
src:"tool"  direct tool action from the voice, dir out,
            text: "notion: added 'kale' under Greens on Shopping list"
```

`realtime.js` already has both transcripts in hand and only logs them:
`conversation.item.input_audio_transcription.completed` (caller) and
`response.output_audio_transcript.done` (voice). Emit them through an
`onEvent({dir, text})` option; the pipeline passes it through like `onTurn`.
Each direct tool emits one `src:"tool"` row after it succeeds.

**Readers**

- *Alfred's cursor* — a byte offset in `agent/var/ledger-cursor` (its own
  file, like `last-dream`; `writeState()` replaces `state.json` wholesale, so
  do not put it there). At the top of `handleTurn`, read rows after the cursor
  with `src != "chat"`, render them, and prepend as one block to the message
  body, next to the `VIA_TAGS` tag and the attachment block (the same "rides on
  this message" pattern the code already uses). Advance the cursor to the
  file length **only after** the Claude turn succeeded (not `is_aborted`, not
  `infraFailed`), so a dropped turn replays. Cursor > file length ⇒ treat as 0
  (that is what `/clear` looks like).
- *The voice's briefing* — built at call start, in memory for the call, from:
  `phone-voice.md`, `USER.md`, `MEMORY.md`, today's daily note, then the
  ledger tail newest-first until the size budget: `src:"call"` and
  `src:"tool"` rows of earlier calls, and `src:"chat"` rows with `via !=
  "call"`. Skip `kind` cancelled/error/silent rows. Add two lines of guidance:
  "Background only. For anything to look up or change, still use your tools.
  Do not recite this unless asked."
- *Live push into a call* — the ledger module is also an in-process emitter.
  A live Realtime session subscribes for rows with `via != "call"` (so it
  never hears its own rows or Alfred's answers to it, which it got as tool
  output) and sends each as `conversation.item.create` with
  `{type:"message", role:"system", content:[{type:"input_text", text:"[Meanwhile, by text, the user said: …] [You replied: …]"}]}`
  and **no** `response.create`. The model sees it on its next turn. Do **not**
  use `session.update` for this: it replaces the instruction prefix and
  invalidates the cached prefix for the rest of the call, and it is
  semantically "settings", not "something happened". Because the push is
  "any ledger append while a call is live", the case "Discord reply lands
  60 s after the call started" needs no special code.

**Instructions become per call.** `realtime.instructions` is read once at
boot (`readPhoneVoicePrompt()`) and passed as a string. Make it a
`buildInstructions({caller})` async hook; `makeRealtimeSession` starts it in
`start()` and awaits it in the socket `open` handler before `sessionUpdate`.
The file reads finish long before the socket does.

**`/clear`.** Already archives + truncates the ledger and resets the session.
Add: reset the cursor to 0 and, if a call is live, give it one system item
"The user cleared the conversation; forget earlier context." The pre-clear
history is in `logs/`; both sides honour the clear the same way. The call's
own rows keep appending to the fresh ledger.

**New Alfred session** (dream pass): `loadContext()` appends the last 24 h of
the ledger, rendered with the same function as the briefing. Cursor logic is
unchanged — rows after the cursor still arrive as the prefix on the first
message (they may overlap the tail; harmless).

**Races.**
- *Two writers:* there is one process. `bot.js`, the pipeline and the
  Realtime session share it; `dream.sh` and the detached memory pass write
  `MEMORY.md` / the daily note, never the ledger. `appendFile` of one short
  line with `O_APPEND` is atomic on a local fs. Keep it that way: no second
  process ever appends to `messages.jsonl`.
- *Call row vs `/clear` archive:* `archiveConversation` reads, writes the
  archive, then truncates; an append in that window is lost. Route appends
  through the same tiny async mutex the archive takes (a promise chain in
  `ledger.js`). Cheap, closes the hole.
- *Call starts while a long Alfred turn runs:* briefing misses the in-flight
  reply; the live push delivers it when it lands. Covered.
- *`/clear` mid-`use_tools`:* the turn finishes in the old session (it is
  queued), the next one starts fresh. Existing behaviour, acceptable.
- *Condensing vs call start:* none, because nothing condenses.

## Condensing, if ever

Only if the ~24 KB budget is hit often (log a line whenever rows are dropped
for budget). Then: a condenser writes `agent/var/ledger-summary.json`
`{upTo: <byte offset>, text}` atomically (temp + rename). Briefing = summary +
raw rows after `upTo`. A call that starts mid-run reads the old summary and a
longer raw tail — still correct, just bigger. The summary is a cache, never
the source of truth, so it can be deleted at any time. Run it from the turn
queue after a reply, never on the call path. Haiku or `claude -p` both work.

## Token budget for the briefing

`phone-voice.md` 0.65k + `USER` 0.1k + `MEMORY` 1.1k + daily 0.1k + last call
0.6k + 24 h chat 1.3k ≈ **4k tokens typical**, cap at 6k (24 KB). Order when
trimming: keep the prompt, USER, MEMORY and the last call whole; drop oldest
chat first. Cost ≈ $0.005 per call on mini. Cached after the first response.

## Test matrix — "switch fast"

Run with mirror on, watch `messages.jsonl` and the bot log. "Knows" = the
side answers correctly without the user re-explaining.

| # | sequence | expect |
|---|---|---|
| 1 | Call A: add "Greens" section + kale. Hang up. Call B within 2 min: "add spinach to the list we were adding to" | voice resolves Greens from the briefing, uses `notion` directly, no `use_tools` |
| 2 | Call: direct `notion` add. Hang up. Discord: "what did I just add?" | Alfred's prefix carries the `src:"tool"` row; he names it |
| 3 | Discord: "I'm cooking pasta tonight." Call 30 s later: "what am I making tonight?" | voice answers from briefing, no tool call |
| 4 | SMS: "remind me the dentist is Tuesday." Call: "when's the dentist?" | voice answers from briefing (SMS rows are `via:"sms"` chat) |
| 5 | During a call, send a Discord message; then on the call "what did I just text you?" | live push (`conversation.item.create`); voice knows without hanging up |
| 6 | Call: caller says X, voice retells it as Y to `use_tools` | Alfred's prefix shows the caller's verbatim line; he acts on X |
| 7 | Call, hang up, bot restarts, Discord message | prefix still arrives (cursor is on disk) |
| 8 | Call, then `/clear`, then call again | second call's briefing has MEMORY/USER/daily only; cursor reset; no stale rows |
| 9 | Chat in the evening, dream pass runs, morning Discord message | new session, and Alfred still knows last night's chat (24 h tail) |
| 10 | Two calls back to back, second starts while the first's `use_tools` is still running | second briefing lacks the late reply; late answer still goes by SMS (`onLateCallAnswer`); nothing duplicated |
| 11 | Long call (15+ min) | briefing not truncated by the server; call still coherent at the end (context window) |
| 12 | Voice-only chatter, no tools, hang up, Discord "how was the call?" | Alfred has both sides verbatim, says "you said … and I said …" (one persona) |

## Build order, smallest first

1. **`ledger.js` + `src` field** (inside Part 1, not after it). Move
   `logTurn`/`archiveConversation` there, add the mutex and a `tail({bytes,
   since, filter})` reader. `realtime.js` emits caller/voice utterances via
   `onEvent`; each direct tool logs a `src:"tool"` row. Nothing reads yet.
   Verify by eye in `messages.jsonl`. Part 1's "simple note" should be this,
   so it is not thrown away.
2. **Alfred ← ledger.** `ledger-cursor` file, prefix block in `handleTurn`,
   advance on success, reset on `/clear`. Mechanical daily-note line at call
   end. Tests 2, 6, 7, 8, 12.
3. **Voice ← ledger.** `buildInstructions` hook, briefing with budget and
   source filtering, persona wording. Tests 1, 3, 4, 8, 11.
4. **Live push.** Emitter in `ledger.js`, subscription per live call,
   `conversation.item.create` system items, `/clear` notice. Tests 5, 10.
5. **New-session tail** in `loadContext()`. Test 9.
6. **Condenser** — only if step 3's budget log says so.

Each step ships on its own and is useful alone; none depends on a later one.
