# Shared context: one ledger for the phone voice and Alfred

How the 2B phone voice and Alfred know what the other did (#153). The voice is
an OpenAI Realtime session, one per call (`telnyx/realtime.js`). Alfred is a
`claude -p` turn that resumes one session (`bot.js`). Before #153, the voice
started every call blank, and Alfred heard about a call only through an
in-memory list that a restart lost. Now both sides read one ledger.

The design review is `docs/phone-context-review.md`. Where the two differ, this
file says what was built.

## The ledger

`agent/var/messages.jsonl`, one JSON row per line, owned by `ledger.js`. Only
`bot.js` writes it, in one process. Append and archive share one lock, so a row
written during a `/clear` lands in the new file. Each row gets a `ts` later
than the row before, so a watermark on `ts` is exact. Readers read only the
end of the file (`tail`, 256 KB), one Eastern day (`readDay`), the rows after a
byte offset (`readFrom`), or the whole file (`readAll`, for the fold). The
ledger is also an emitter: `subscribe()` hears each row as it is written, in
file order, and each archive.

| field | meaning |
|---|---|
| `ts` | ISO time, set by `append()` |
| `dir` | `in` (the user, or the caller) or `out` (Alfred, or the voice) |
| `via` | `discord`, `sms` or `call`. Missing means Discord. Older out rows have none. |
| `src` | what wrote the row: `chat`, `call` or `tool`. Missing means `chat`. |
| `kind` | chat out rows: `reply`, `silent`, `cancelled`, `error`, `timeout`, `auth_error`. Call rows: `start`, `end`, `cut`, `late`, or none for a line. |
| `text` | the words |
| `files` | in rows: the saved files, as paths from `agent/`. Out rows: how many files the reply carried (a number). |
| `attachments` | in rows: how many files came (kept for older readers) |
| `callId`, `caller` | call and tool rows, and a call's `use_tools` turns |

The three sources:

| `src` | written by | what it is |
|---|---|---|
| `chat` | `handleTurn` in `bot.js` | a turn on any channel: the message and Alfred's answer. Alfred's session holds these already. |
| `call` | `logCallEvent`, from `onCallEvent` in `telnyx/realtime.js` | a 2B call as it happens: the start, each caller line as transcribed, each voice line as spoken, a line the caller talked over (`cut`), the end with its length, and an answer that came after the hangup (`late`) |
| `tool` | `notePhoneAction`, from `note()` in `telnyx/voice-tools.js` | a change the voice made with its own tools: `added "Kale" under "Greens" (Notion page "Shopping list")` |

Only what the caller heard is a call line. The text of a silent tool chain
never is, and the still-working filler is left out.

A call is in the ledger twice: its own rows, and its `use_tools` turns (chat
rows with `via: "call"` and the call's id), which retell the same requests and
answers. Every reader shows a call once, from its own rows (`retoldByCall` in
`ledger.js`, or a simpler filter, below).

## Daily notes: the fold

Every row is folded into the daily note of its own Eastern day, one time
(`fold.js`, `scripts/fold-day.mjs`, prompt in `agent/memory-prompt.md`). Each
day is one headless `claude -p` run that merges the day's transcript into
`agent/var/memories/dailies/<day>/daily.md`. It may open a listed image when the
words around it do not say what it shows.

Two runs do it:

- **Nightly**, from `dream.sh` at 3 AM, in this order: the fold of every row
  not folded yet, up to the end of yesterday; then the check for yesterday's
  note (no note, no dream); then the dream, which promotes yesterday's note
  into `MEMORY.md`; then the strength digest; then the `last-dream` stamp. A
  failed fold is logged, and the dream still runs.
- **On `/clear`**: the ledger is archived to `logs/<first>_to_<last>.jsonl`,
  and `bot.js` starts the same script, detached, for the archive's rows that
  no nightly pass folded (`logs/consolidate.log`).

`agent/var/fold-watermark.json` (`{ start, through }`) records how far folding
got. It moves only after a run worked, so a failed day is tried again by the
next run. Every run also reads the archives that hold rows after the
watermark, so a failed `/clear` fold is not lost. A missing watermark is set
to the last row of the newest archive: the old archives count as folded,
nothing in the live file does. `fold.lock` keeps two folds apart.

**Past days.** `scripts/backfill-dailies.mjs` folds the archived days from
before the fold into their own notes (`--days`, `--from`, `--to`,
`--dry-run`). It needs `--state-dir <copy>` or `--real-state`, reads only the
rows up to the watermark's `start`, and never moves the watermark. It has not
been run on the real data yet.

## Alfred catches up on the phone

Each Alfred turn, on any channel, starts with what was said and done on the
phone since his last turn (`makeCatchUp` in `context.js`): the rows with `src`
`call` or `tool` after his cursor, as one block after the via tag and before
the attachment block:

```
[What was said and done on the phone since your last message:
On Tuesday 24 November:
14:02 (a phone call started)
14:02 the user said (on the call): Add kale under greens on the shopping list.
14:02 you did (on the call): added "Kale" under "Greens" (Notion page "Shopping list")
14:02 you said (on the call): Done, kale is under Greens.
14:04 (the call ended after 2 min)
]
```

The cursor is `agent/var/ledger-cursor.json` (`{ "offset": <bytes> }`). It moves
only after a turn worked (not dropped, not a timeout, not a login lapse), and
only to the offset that turn read, so a row written during a turn waits for the
next one. A restart loses nothing. `/clear` sets it to 0; a missing, broken or
past-the-end cursor reads from 0. Over 12,000 characters the block keeps the
tool changes first, then the newest lines. A `use_tools` turn is a turn too, so
it carries the call so far, and Alfred reads the caller's own words next to the
request.

## A new Alfred session

A new session (after `/clear`, or the first turn after a dream pass) holds
nothing of the recent past, so `loadContext` (`sessionContext` in `context.js`)
gives it `SOUL.md`, `USER.md`, `MEMORY.md`, yesterday's and today's daily notes,
and the messages of the last 6 hours on every channel, word for word, as
`[RECENT MESSAGES]`. The turn's own message is left out (it follows), a call
shows once, and over 24,000 characters the oldest messages go first. The
catch-up block then leaves out the rows that the recent messages show.

## The voice, while a call is live

Each message the user sends by Discord or SMS during a call, and Alfred's reply
to it, goes into the call as it is written (`liveFeed` in `context.js`, the
`feed` option of `telnyx/realtime.js`). The call subscribes to the ledger as it
starts and stops as it ends. Each row is one `conversation.item.create`
system item, with no `response.create`, so the voice knows it from the
caller's next turn and never speaks up about it:

```
[Meanwhile, by text, the user said: "Thoughts on these?", and sent a photo. You answer it by text, not on the call: ...]
[You replied by text: "Those are Hoka Clifton 9s." Do not repeat it unless the caller asks.]
```

It is not a `session.update`, which would replace the instructions and their
cached prefix. The call never gets its own rows (`via: "call"`). `/clear`
during a call sends "forget earlier context". Items pushed before the session
is set up wait for it. `VOICE_OPENAI_LIVE=0` turns the feed off.

## The voice, as a call starts: the briefing

Each 2B call's prompt is `agent/phone-voice.md` and then a background block of
what the voice should know already (`callBriefing` in `context.js`, wired in
`bot.js` as the `buildInstructions` option of `telnyx/realtime.js`). The date
line stays first:

```
It is Wednesday, December 2, 2026 at 10:00 AM (Eastern) as the call starts.

<agent/phone-voice.md>

=== BACKGROUND: WHAT YOU KNOW FROM BEFORE THIS CALL ===
About the user, your memory, the daily notes of yesterday and today, and what
was said in the last 6 hours: by text, by SMS and on earlier calls. ...
It is background only. What it already says needs no tool; for anything to
look up or change, still use your tools. Do not recite it, or bring it up,
unless the caller asks.

[About the user]                         USER.md
[Your memory]                            MEMORY.md
[Yesterday's daily note: <day>]
[Today's daily note: <day>]
[The last 6 hours, oldest first. ...]    the ledger, as below

=== END OF BACKGROUND ===
```

The guidance lives in the code that builds the block, not in
`phone-voice.md`, which stays under its 400-word cap.

**What the messages show.** The ledger rows of the last 6 hours
(`briefingRows`), through the same renderer as Alfred's context:

- earlier calls from their own rows only (`src` `call` and `tool`), never their
  `use_tools` turns, so a call shows once;
- the chat of the other channels (`via` not `call`);
- not a turn that said nothing or failed (`silent`, `cancelled`, `error`,
  `timeout`, `auth_error`), and never the rows of the call being briefed;
- the last call whole, even when it began before the window.

Both sides are Alfred, so every line says "you": "you said (by text)", "you
said (by SMS)", "you said (on the call)", "you did (on the call)". No line
names a model, a service or another assistant; the end of a call leaves out
its reason, which can. A file is named by its kind ("(a photo sent with it)"),
never by its path or name: the voice cannot open it.

**Budget.** About 24,000 characters for the whole prompt
(`BRIEFING_MAX_CHARS`, about 6,000 tokens). OpenAI never cuts the
instructions, but the more they take, the fewer of the call's own turns fit in
its context. In order:

1. The prompt, `USER.md`, `MEMORY.md` and the last call stay whole.
2. Today's note, then yesterday's, each at most 4,000 characters
   (`BRIEFING_NOTE_MAX_CHARS`). A longer note keeps its end, from an entry
   heading, after "(The start of this note is left out.)".
3. The other messages, newest first: the oldest go first, and "(Earlier lines
   are left out.)" says so.

Only the parts kept whole can take it past the budget. Anything left out
gets one log line, so the log shows how often the cap is hit:

```
📞 Briefing cut to fit 24000 characters: cut yesterday's note to its last 3987 of 5089 characters; left out the 83 oldest lines of the messages
```

**Timing.** Nothing slow is on the call's path. The briefing starts when the
call's session starts, while the OpenAI socket connects, and reads a few small
files and the ledger's tail (a few ms). The socket's `open` handler waits for
it at most 1 s (`BRIEFING_WAIT_MS`) before the `session.update`; caller audio
and live updates wait with it. A briefing that fails, comes back empty or is
late is logged, and the call starts with the plain prompt:

```
📞 Briefing: 9120 characters, built in 6 ms
⚠️  The briefing failed: <why>. The call starts with the plain prompt
```

No model condenses anything: at these sizes there is nothing to condense.

**With the live feed.** The feed subscribes before the briefing reads the
ledger, so no row written as the call starts is missed. A row that both tell
(written after the subscription, before the read) goes once: the briefing
returns the `ts` of each row it shows, each live update carries its row's
`ts`, and a held update for a shown row is dropped (`📞 Dropped 1 live
update(s) that the briefing tells already`).

**Privacy.** The briefing goes to OpenAI with every call: `USER.md`,
`MEMORY.md`, two daily notes and up to 6 hours of chat. `VOICE_OPENAI_BRIEFING=0`
starts every call with the prompt alone, as before.

## Files

A file the user sends (Discord or MMS) is saved in the day's folder,
`agent/var/memories/dailies/<day>/<msgId>-<n>-<name>` (an MMS's id starts with
`sms-`), and its in row names it (`files`, paths from `agent/`) next to the old
count. So:

- **Alfred** gets the paths on the message itself (`[ATTACHMENTS]`), and a new
  session's recent messages list them, so he can open a photo again.
- **The fold** can open an image when the words around it do not say what it
  shows.
- **The voice** never gets a file. The live feed and the briefing say what
  kind it is ("a photo"). Alfred's text reply says what is in it, and reaches
  the call as he writes it. Until it does, the item tells the voice not to
  guess and to ask `use_tools`, which waits for that reply.

## Who reads what

| reader | when | rows | what it becomes |
|---|---|---|---|
| fold (`fold.js`) | nightly, and on `/clear` | every row not folded yet | each day's note |
| catch-up (`makeCatchUp`) | each Alfred turn | `call` and `tool` rows after the cursor | a block in front of his message |
| new session (`sessionContext`) | a new Alfred session | the last 6 hours, a call once | `[RECENT MESSAGES]` |
| live feed (`liveFeed`) | while a 2B call is live | each new chat row not of a call | a system item in the call |
| briefing (`callBriefing`) | a 2B call starts | the last 6 hours: calls from their own rows, other chat | the background in the call's prompt |

## Settings

| variable | default | what it does |
|---|---|---|
| `VOICE_OPENAI_LIVE` | on | `0`: texts and replies do not reach a live call |
| `VOICE_OPENAI_BRIEFING` | on | `0`: a call starts with `phone-voice.md` alone |
| `VOICE_OPENAI_TRANSCRIBE` | on | `0`: no caller transcript, so a call's rows hold only the voice's lines |

## State files

All under `agent/var/`, never in git: `messages.jsonl` (the ledger),
`logs/<first>_to_<last>.jsonl` (archives), `fold-watermark.json`, `fold.lock`,
`ledger-cursor.json`, `memories/dailies/<day>/daily.md`, and
`logs/consolidate.log` (the `/clear` fold's output).

## Tests

All on fake data in temp dirs: `test/ledger.test.js`, `test/fold.test.js`,
`test/context.test.js` (catch-up, new session, live feed, briefing),
`test/telnyx-realtime.test.js` and `test/telnyx-pipeline.test.js` (events, the
feed, the briefing hook), `test/voice-eval.test.js`. The voice eval
(`docs/voice-eval.md`) has scenarios for both: `live-*` (texts during a call)
and `brief-*` (what the call starts knowing).

## Not done yet

- The paid voice eval has not been run on the `live-*` and `brief-*`
  scenarios, and the "switch fast" test on a real phone
  (`docs/phone-context-review.md`, test matrix) has not been done.
- `scripts/backfill-dailies.mjs` has not been applied to the real data; that
  waits for the owner's go-ahead.
- The caller's newest line can miss the `use_tools` turn it led to: its
  transcript can arrive after the turn read the ledger. It then shows on
  Alfred's next turn.
- With caller transcription off (`VOICE_OPENAI_TRANSCRIBE=0`), the briefing
  shows an earlier call from the voice's lines and tool changes only: it
  leaves out the `use_tools` turns, which then are the only record of what was
  asked. The fold and a new session keep them in that case.
- No condenser. Add one only if the "Briefing cut to fit" line shows up often
  (`docs/phone-context-review.md`, "Condensing, if ever").
- No "Phone call" line in the daily note at the end of a call: the nightly
  fold writes the call into its day's note, and each direct-tool change still
  adds a "By phone" line at once.
- `agent/SOUL.md`'s startup checklist still tells Alfred to read `USER.md`,
  `MEMORY.md` and the notes himself, though a new session now gets them.
  Harmless, and a prompt change, so left alone.
- The v1, v2 and v3 call paths get no briefing and no live feed. Each of their
  turns is an Alfred turn in his own session, so he already has the context.
