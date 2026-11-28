# Voice eval: test calls without a phone

`scripts/voice-eval.mjs` holds scripted phone calls with the 2B voice and
scores them, so a prompt, tool or model change can be measured instead of
judged from one live call.

```
node --env-file=.env scripts/voice-eval.mjs                         # every scenario, the .env settings
node --env-file=.env scripts/voice-eval.mjs --only tick-two --repeat 5
node --env-file=.env scripts/voice-eval.mjs --model gpt-realtime-2.1 --repeat 3 --label full
node --env-file=.env scripts/voice-eval.mjs --only brief-pasta,brief-last-call,brief-dentist --repeat 3 --no-briefing --label no-briefing
node --env-file=.env scripts/voice-eval.mjs --only calendar-add --day 2026-12-02   # another day (see "The day")
node scripts/voice-eval.mjs --compare agent/var/voice-eval/runs/<a> agent/var/voice-eval/runs/<b>
```

## What a test call is

- **The voice is real.** `voice-eval/openai-call.js` builds the same
  `makeRealtimeSession` a phone call uses, with the prompt in
  `agent/phone-voice.md`, and plays Telnyx's part: caller audio in as 20 ms
  mu-law frames in real time, Alfred's audio out on a playback clock, marks
  echoed when the audio before them would have played.
- **The caller is a script.** Each line is spoken by OpenAI text-to-speech once
  and cached in `agent/var/voice-eval/tts/`. A turn waits until Alfred has
  finished (quiet 2.5 s with nothing running), or cuts in (`pauseMs`,
  `bargeInMs`).
- **The tools are real, the data is not.** The voice's notion, calendar and
  get_time tools are the real `telnyx/voice-tools.js`, on an in-memory Notion
  and calendar (`voice-eval/fakes.js`). `use_tools` goes to a stand-in Alfred
  with canned answers per kind of request (his to-do file, email, new pages).
- **The day is the day of the run.** Each call's clock is 10:00 AM Eastern
  on it, and the world is built around it (`scenariosOn` in
  `voice-eval/scenarios.js`): the lab meeting is today, the gym and the call
  with Mom are tomorrow, and the thesis review is in two days. A weekday that
  a caller or a text names is one of that week: on a Wednesday, the dentist
  goes on "Friday at 3". OpenAI tells the model the real date itself, so a
  made-up day gives it two dates. Until #157 the clock was always Wednesday
  2 December 2026: in 4 of the 6 calls where mini wrote a date without
  get_time, it used the real day, and it booked "Friday" a week early. A
  real call never has the two dates disagree. `--day YYYY-MM-DD` runs
  another day, for a rerun of an old one, but with two dates again. The
  examples here are for a Wednesday, as in the tests.
- **Messages from elsewhere.** A turn can carry ledger rows (`{ rows, say }`):
  a text the user sent and Alfred's reply, built as `bot.js` builds them. Each
  call has its own ledger in a temp dir, written as the bot writes the real
  one, and the bot's live feed (`liveFeed` in `context.js`) puts the rows into
  the call as system items with no reply asked. Then the caller waits 2 s, in
  which the voice must stay quiet, and speaks. The `live-*` scenarios use it:
  a photo and the reply that names it, a texted "out of eggs", and a photo
  whose reply has not come, so the voice must not guess.
- **What the call starts knowing.** A scenario can carry a briefing world,
  all of it made up:

  ```js
  briefing: {
    user: "...",       // USER.md
    memory: "...",     // MEMORY.md
    yesterday: "...",  // yesterday's daily note (the day before the call)
    today: "...",      // today's daily note
    rows: [at("09:00", texted("I'm cooking pasta tonight")), at("09:00", replied("Sounds good."))],
  }
  ```

  Before the call, `seed()` writes the files where the bot keeps them, in the
  call's temp state dir, and the rows into its ledger at their times
  (`at("HH:MM", row)`, Eastern, on the day of the call; `texted`, `replied`,
  `callRow` and `toolRow` build them as the bot does). The call's prompt is
  then built by the bot's own builder (`callBriefing` in `context.js`), as on a
  real call: `phone-voice.md`, then the background. A real call always has a
  background, so a scenario without its own briefing gets `EVERYDAY` (the
  made-up USER, MEMORY and notes, and one text exchange that morning). The
  `brief-*` scenarios carry their own: pasta texted an hour before ("what am I
  making tonight?", no tool), a call 20 minutes before that put kale under
  Greens ("add spinach to the greens on the list we were adding to": spinach
  under Greens, no Alfred; a Garden list has Greens too, so only the briefing
  says which; the caller names the section, since the notion tool nests a line
  only then), the dentist by SMS ("when's the dentist?": Tuesday at 3, six
  days on, no tool, though the calendar does not have it), and two where the
  background is out of date: a text reply two hours ago listed the shopping
  list as milk, butter and limes (`brief-stale-list`: read the list fresh,
  say kefir and eggs too), and memory has the gym on Thursdays but not the
  call with Mom (`brief-calendar-fresh`: read the calendar, say both).
- **Control runs.** `--no-briefing` starts each call with the prompt alone (as
  `VOICE_OPENAI_BRIEFING=0`), and `--no-feed` tells a call nothing mid-call (as
  `VOICE_OPENAI_LIVE=0`); the scenario's world and rows are written all the
  same. Compared with a normal run, they show what the briefing and the feed
  add. A scenario whose other checks could pass without them by luck has a
  check that they arrived: `live-photo-pending` "was told of the photo
  mid-call", `brief-last-call` "started the call knowing the last call's kale
  under Greens". Those fail in a control run by design; the summary's checks
  column still shows how the rest did.

## How it is scored

- **Checks in code**, per scenario: what changed (lines added, ticked, gone;
  events moved; a page made; Alfred's to-do file), what was said, and whether
  Alfred was asked. Every call also gets the common checks: no false "I can't",
  no tool or system named, no failed tool call repeated as-is.
- **Numbers:** words spoken, first-audio wait after the caller stops, the
  wait for a `use_tools` answer, tool errors, cost. The cost is also split, in
  ¢ a minute, by part of the bill and by kind of answer, from the lines a call
  ends with (Cost in `docs/phone-design.md`): `summary.md` weighs each call by
  its length, `--compare` puts the parts side by side, and each call's `.json`
  keeps every answer's own bill (`usage` events), to see which ones read the
  call again at full price.
- **A Claude grader** (`claude -p`, Sonnet 5.5) scores done, honest, brief and
  smooth, 0–2 each, from the transcript, the starting data and the goal, and
  names the worst moment. The transcript shows what the call was told mid-call,
  and only for those calls the rubric says how to judge it (a guess at a photo
  is not honest), so the other calls are graded as before. In the same way, a
  call that started with a briefing shows the grader the background whole,
  with a rubric line that says answering from it with no tool is right; the
  saved `.txt` shows it before the call.

Each run saves `summary.md`, and per call a transcript (`.txt`), the full
record (`.json`) and a stereo recording (`.wav`, caller left, Alfred right) in
`agent/var/voice-eval/runs/<time>-<label>/`.

## Limits

- Text-to-speech callers are cleaner than a phone in a car: no road noise, no
  half-sentences unless a scenario scripts them.
- The stand-in Alfred answers instantly after a set delay and only the kinds of
  request the scenarios need; a vague request gets "say what you need".
- One run of a scenario is noisy. Compare with `--repeat 3` or more.
- The grader is a model too: read the transcripts behind a surprising score.
- A briefing world is small (about 1.5 KB of background); a real one is
  several times that, with more facts to pick from.

## Results so far

2026-11-24, 17 scenarios × 3 calls each, reasoning `low`, silent chains off.
"Before" is 2.39.0; "after" adds the fixes of #151: the date and time at the
top of the prompt, "Alfred runs on the computer", `create` with no page, and a
tick with no page finding the page.

| | mini before | mini after | full before | full after |
|---|---|---|---|---|
| calls that passed every check | 22/51 | 35/51 | 27/51 | 51/51 |
| grader /8 | 4.1 | 4.9 | 4.9 | 6.8 |
| words a call | 45 | 36 | 35 | 27 |
| first audio | 824 ms | 624 ms | 1199 ms | 993 ms |
| cost of the 51 calls | $0.47 | $0.40 | $1.81 | $1.43 |

- Most failures were the prompt and tools, not the model: both models gained
  on dates, new pages and the computer's to-do list once those were fixed.
- What was left is the model. Mini still runs long, treats a misheard "limes
  and kefir" (`Lines and Keffer`) as a search, and gets some calendar moves
  wrong; the full model handles the same audio.
- So the phone runs `gpt-realtime-2.1` (`VOICE_OPENAI_MODEL`), about 3¢ a
  25-second test call against 1¢; a real call of about two minutes is nearer
  20¢ against 6¢. Retry mini after the next prompt or tool change, with this
  suite.

### Phase two: the shared memory (#153), 2026-11-25

Full model, reasoning `low`. From here on every call starts with a background,
as a real call does (`EVERYDAY`, or the scenario's own), so the 17 old
scenarios now test the voice with its briefing in the prompt.

| run | calls that passed every check | grader /8 | words a call | cost |
|---|---|---|---|---|
| 25 scenarios × 3 | 71/75 | 6.8 | 24 | $1.97 |
| the 7 the last two fixes touch, × 3 | 20/21 | 7.3 | 20 | $0.54 |
| 25 scenarios × 1, final code | 25/25 | 7.1 | 23 | $0.63 |

- The old 17 passed 51/51 with the background in the prompt: it costs nothing
  on calls that do not need it.
- Live updates: a photo and the reply that names it, a texted "out of eggs",
  and a photo whose reply has not come (no guess; it asks and waits) all pass.
- What the call starts knowing: pasta texted an hour before, the list the last
  call was adding to, a stale list (read fresh, kefir and eggs said) and a
  partial memory of tomorrow (calendar read, both events said) all pass.
- The dentist by SMS took two rewordings of the briefing head. "Answer from it
  at once, not even a look" fixed it but would answer stale lists from the
  notes; "read lists and the calendar fresh" made the voice doubt the SMS when
  the calendar lacked it (0/3). The head now says both. In the last runs the
  voice still checks the calendar first in about 1 call of 3, then gives the
  SMS's time and says it is not on the calendar yet.
- `brief-last-call` found a tool bug: `under: 0` with no read put spinach at
  the end of the page. It now asks for the read, and the voice nests it.

### Mini's 16 failed calls, read again (#157)

The transcripts of "mini after" (2026-11-24, 35/51), one by one:

| calls | what happened | whose problem | now |
|---|---|---|---|
| 3 | a date from the real day, 24 November, not the call's 2 December | the eval's | the calls run on the day of the run |
| 1 | "when is that Friday?": asked, booked nothing | the eval's, most likely: two dates | as above |
| 1 | calendar `read` with no day, then asked the caller which day | the tool's | a read with no day reads today |
| 1 | `create` with the title as `page` (another call sent it as `title`, then fixed it) | the tool's | it takes both |
| 3 | `remove` by numbers for milk and butter only, after a read, so cheese was never said | the tool's description | it asks for every item named, in words, in one call |
| 3 | "Lines and Keffer" searched as a page title (2), or checked as lines 3 and 7 (1) | the tool's, in part | words match the one line that sounds like them; a search with no title names the page whose lines have them |
| 3 | only a last reply longer than 15 words | the model's | no change |
| 1 | the shopping list sent to Alfred as a file on the computer | the model's | no change (the stand-in Alfred cannot add to Notion; the real one can) |

Rerun on mini (25 scenarios × 3, 2026-11-27): 63/75 calls passed every check
(35/51 before), grader 5.8 (4.9 before), for $0.53 against the full model's
$1.97. The dates, calendar moves and new pages now pass. mini never used
`items`: it removed and ticked by line numbers, and twice the wrong ones
(Eggs for "cheese"; Milk and Butter for limes and kefir), so the near match
never ran. The phone stays on the full model; on it, the same code passed
25/25 (grader 6.8, $0.69).

### Cost cuts on the full model (#161), 2026-11-27

25 scenarios × 1 each, on the full model. "Baseline" is #159; the cuts read
answered caller turns as text, replay the kept greeting, and give the
still-working line no input.

| | baseline | cuts, reasoning low | cuts, reasoning minimal |
|---|---|---|---|
| calls that passed every check | 25/25 | 23/25 | 23/25 |
| grader /8 | 6.8 | 6.8 | 6.8 |
| cost of the 25 calls | $0.69 | $0.64 | $0.58 |
| the greeting, ¢/min | 0.89 | 0.09 | 0 |
| text in at full price, ¢/min | 1.77 | 1.35 | 1.29 |
| text out, ¢/min | 0.81 | 0.85 | 0.70 |
| audio in at full price, ¢/min | 0.61 | 0.64 | 0.65 |

- No API errors. 6 and 5 answered caller turns went in as text; the kept
  greeting played on 21 and 25 calls.
- `brief-dentist` read the calendar before answering, in both runs (the
  answer was right; it has passed about half the time on the full model).
  `goodbye` (low) ran past 8 words.
- With minimal reasoning, `calendar-move` asked "do you mean starting at
  3 PM?" instead of moving the meeting. So reasoning stays `low` for now.
- A test call is short, with one or two caller turns, so the text history
  barely shows here: audio in did not move. Real calls are longer; their
  `Where it went` lines will show it.
