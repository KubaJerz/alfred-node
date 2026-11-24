# Voice eval: test calls without a phone

`scripts/voice-eval.mjs` holds scripted phone calls with the 2B voice and
scores them, so a prompt, tool or model change can be measured instead of
judged from one live call.

```
node --env-file=.env scripts/voice-eval.mjs                         # every scenario, the .env settings
node --env-file=.env scripts/voice-eval.mjs --only tick-two --repeat 5
node --env-file=.env scripts/voice-eval.mjs --model gpt-realtime-2.1 --repeat 3 --label full
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
  The clock is Wednesday 2 December 2026, 10:00 AM Eastern.

## How it is scored

- **Checks in code**, per scenario: what changed (lines added, ticked, gone;
  events moved; a page made; Alfred's to-do file), what was said, and whether
  Alfred was asked. Every call also gets the common checks: no false "I can't",
  no tool or system named, no failed tool call repeated as-is.
- **Numbers:** words spoken, first-audio wait after the caller stops, the
  wait for a `use_tools` answer, tool errors, cost.
- **A Claude grader** (`claude -p`, Sonnet 5.5) scores done, honest, brief and
  smooth, 0–2 each, from the transcript, the starting data and the goal, and
  names the worst moment.

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
