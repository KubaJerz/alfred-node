# Phone: SMS and voice

Design notes for Alfred's phone number. SMS shipped in #82. Voice calls (#98)
use a Telnyx AI Assistant with bot.js as its model.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Provider | Telnyx | Lowest voice and SMS rates of Twilio, Plivo, Bird, and Telnyx. Real-time voice streaming and SIP. |
| Number type | Local, +1 864-624-8580, on 10DLC | A local number was bought. It needs a 10DLC Sole Proprietor brand and campaign. Toll-free was the first plan. |
| 10DLC campaign | Account Notification + Customer Care | One opt-in method: verbal consent given to Kuba, then a confirmation text. The first campaign failed with 603 (no public terms page, a call-center opt-in). The second failed Telnyx review twice on 2026-10-27/28 for listing more than one opt-in method; it now lists only verbal consent. After approval the message flow cannot change, so adding "text the number" later needs a new campaign. |
| Public terms | kubajerzmanowski.com/sms/terms/ | Shows the verbal consent script, the confirmation text, and `sms@kubajerzmanowski.com`. It does not show Alfred's number. Carriers can check it again at any time, so keep it up. |
| Google Voice | No | No API. Porting a number out of Google Voice makes it a local number, which needs 10DLC. |
| Inbound path | Webhook through a tunnel | Voice needs a real-time webhook anyway. The box has no public address. |
| Tunnel | Tailscale Funnel | Free, no domain, supports WebSockets. It also covers the remote-access item in `TODO.md`. |

US carriers block app-sent SMS from a number until its registration is
approved. This affects texts FROM Alfred only. Texts TO Alfred and voice calls
work before approval.

## SMS (built)

1. Kuba texts the number.
2. Telnyx posts a signed webhook. The tunnel forwards it to `telnyx/sms.js` on
   `127.0.0.1:8788`.
3. The server checks the Ed25519 signature and the timestamp. It drops a
   repeat of an event id that it saw before.
4. The route drops a text that is not from `SMS_ALLOWED_NUMBERS` or not to
   Alfred's number.
5. `bot.js` posts the text in `SMS_MIRROR_CHANNEL` and queues a normal turn
   with a `[via SMS]` tag.
6. The reply target sends the reply by SMS and to the mirror channel.

A message typed in the mirror channel also gets its reply by SMS, to the first
number in `SMS_ALLOWED_NUMBERS`. Other channels stay Discord only.

The messaging profile answers STOP, START, and HELP itself (Keywords tab).
Those texts start no turn. The reply texts there must stay the same as the
ones in the campaign.

Not built: MMS pictures in, and Alfred texting first (reminders).

The campaign allows texts only to people who gave Kuba verbal consent. Kuba
reads them this script:

> By providing your phone number, you agree to receive SMS notifications,
> scheduling, and confirmation messages from Jakub Jerzmanowski, sent by his
> AI assistant. Message frequency may vary. Standard message and data rates
> may apply. Reply STOP to opt out. Reply HELP for help. We will not share
> mobile information with third parties for promotional or marketing
> purposes.

The bot does not text anyone but Kuba yet: it drops every number that is not
in `SMS_ALLOWED_NUMBERS`. A stranger who texts first gets no reply, and that
must stay true. Before it texts anyone else, it must:

- start each new contact with the confirmation text ("You have agreed to
  receive SMS updates from Jakub Jerzmanowski. Msg freq may vary. Std msg &
  data rates apply. Reply STOP to opt out, HELP for help."),
- keep a record of each opt-in (number and date), and text only numbers on
  it that have not sent STOP since,
- name "Jakub Jerzmanowski's assistant" in its texts,
- send only scheduling and confirmation texts, and no links or phone numbers
  (the campaign says it has none).

## Voice (#98)

The plan changed from SIP to OpenAI Realtime. Telnyx sells the full voice loop
as an AI Assistant, and the assistant can use any OpenAI-compatible endpoint as
its model (`external_llm`). So Telnyx does the audio, and Alfred is the model.

### Flow

```
phone ──► Telnyx number ──► Telnyx AI Assistant
                              speech-to-text (Deepgram Flux)
                              turn detection, interruption
                              text-to-speech
                                 │ POST /telnyx/voice/v1/chat/completions
                                 │ Authorization: Bearer <VOICE_LLM_TOKEN>
                                 ▼  (Tailscale Funnel → 127.0.0.1:8788)
                              telnyx/voice.js → enqueueTurn → claude -p
```

1. Telnyx sends the whole conversation on each caller turn.
2. `voice.js` takes the caller messages after the last assistant message. It
   removes the ones that it already sent to Alfred.
3. bot.js runs them as one turn with a `[via phone call]` tag.
4. `voice.js` streams the reply as server-sent events. It sends an SSE comment
   every 5 seconds while Alfred works, so the stream stays open.

### Security

- The model route does not get the Ed25519 signature. It checks a bearer
  token in constant time. Telnyx stores the token as an integration secret.
- `forward_metadata` adds the caller number. The route refuses a number that
  is not in `VOICE_ALLOWED_NUMBERS`.
- Caller ID can be spoofed. Before calls can send, buy, or delete, add a
  spoken PIN.

### Interruption

Telnyx stops its speech when the caller talks over it. On our side, Telnyx may
close the stream, and a new request may arrive while a turn runs. An Alfred turn
is never killed. A reply that the caller did not hear goes to the mirror, and
the next turn tells Alfred.

### Test plan

See #98. In order:

1. Option 3, plain: every reply comes from Alfred. Measure latency. Find how
   long Telnyx waits for the first token.
2. `delegation_settings` (beta): a fast front model talks, and Alfred is the
   backend.
3. The Telnyx model with an `use_tools` tool.
4. Speech-to-speech models (OpenAI realtime, Gemini Live, Ultravox, Hume).

### Open points

- Alfred turns take seconds to tens of seconds. Silence that long may make
  Telnyx time out or make the call feel dead. Test 1 measures this.
- Telnyx's exact behavior on an interruption is not known. The route logs it.

## v2 pipeline (opt-in)

v1 costs about $0.055 a minute. $0.05 of that is the AI Assistant voice
engine. v2 removes the engine. Telnyx Call Control streams the raw call audio
to bot.js, and bot.js calls the Telnyx speech services itself. v2 does not
replace v1. The phone number setting in the Telnyx portal decides which path
answers a call.

### Flow

```
phone ──► Telnyx number ──► Call Control app "Alfred (phone pipeline)"
             │ signed webhook: call.initiated
             ▼  (Tailscale Funnel → 127.0.0.1:8788/telnyx/voice/events)
          telnyx/pipeline.js ── answer + media stream (PCMU 8 kHz, rtp) ──► Telnyx
             ▲ wss://<public>/telnyx/voice/media?token=… (Telnyx is the client)
             │
   caller audio ─► Telnyx STT WebSocket (Deepgram Flux, mu-law 8 kHz)
   Flux EndOfTurn ─► onCallTurn (same as v1) ─► enqueueTurn ─► claude -p
   reply ─► Telnyx TTS REST, one request per sentence (Ultra voice, PCM 24 kHz)
         ─► telnyx/audio.js: low-pass, 24 kHz → 8 kHz, mu-law
         ─► media frames, 100 ms each, at real-time pace ─► caller
```

1. `call.initiated` (incoming, parked) from a number in
   `VOICE_ALLOWED_NUMBERS`, to `TELNYX_PHONE_NUMBER`: the route answers with a
   bidirectional media stream. Any other caller gets a reject (`CALL_REJECTED`).
   A third call at the same time gets `USER_BUSY`.
2. Telnyx opens the media WebSocket. The "start" frame names the call. The
   session opens the STT WebSocket and speaks "Hey, it's Alfred."
3. Caller audio goes to STT with no conversion. Frames that come out of order
   are put back in order by their chunk number. If the chunk number starts
   again or jumps back, the order starts again from that frame.
4. Flux `EndOfTurn` starts a turn. The turn runs `onCallTurn`, the same
   function as v1, with the same `[via phone call]` tag and mirror channel.
5. The reply loses its markdown (`speakable`), and long replies stop at 1200
   characters with "The rest is in Discord." Each sentence is one TTS request.
   The next request starts while the current sentence streams.
6. After each reply the session sends a "mark". When Telnyx sends the mark
   back, the caller heard the whole reply. If the mark does not come back by
   the estimated end of the audio plus 1.5 seconds, the reply also counts as
   heard, and the log says that the echo was missing.
7. Each reply logs `Latency N ms: end of speech → first audio sent`, with the
   turn time and the speech time.

Barge-in: Flux `StartOfTurn` while Alfred speaks sends Telnyx the "clear"
event, aborts the TTS requests, and marks the reply as not heard. The next turn
tells Alfred, as in v1. A new caller turn while an old turn still runs drops the
old reply, and the next turn tells Alfred. A slow turn speaks a filler line
with the same timing and lines as v1 (`FILLER_MS`, `FILLER_REPEAT_MS` and
`FILLERS` in `telnyx/voice.js`; now 1 second, then every 5).
`VOICE_FILLER_MS` and `VOICE_FILLER_REPEAT_MS` change both paths. The greeting and the filler audio are
kept in memory after the first call, so they cost no TTS characters again.

### Security

- `/telnyx/voice/events` is a signed route. It gets the same Ed25519 check,
  replay window, and event-id de-duplication as SMS.
- The media WebSocket upgrade needs two things before the 101:
  - the `VOICE_PIPELINE_TOKEN` in the URL query, compared in constant time
  - a valid `telnyx-signature-ed25519` over `"<telnyx-timestamp>|<stream_url>"`
    with the account key. The server builds `stream_url` from
    `VOICE_PUBLIC_URL`, not from the Host header.
- A socket also needs an answered call that has no socket yet. Its "start"
  frame must name that call. One call has one session. A socket that sends no
  "start" in 10 seconds is closed.
- Frames over 64 KB close the socket. A frame that is not a JSON object is
  ignored, and an error in one frame is logged; it cannot stop the bot. A TTS reply over 8 MB stops.
- A lost media socket, a lost STT socket (after 3 tries in a row with no
  speech event between them), a `streaming.failed` event, or an answered
  call whose stream does not start in 15 seconds hangs up the call. Hangup ends the session and
  closes every socket and timer.
- Caller ID can be spoofed. The same caveat as v1 applies.

### Cost estimate

Per call minute, from telnyx.com/pricing (read 2026-11-06):

| Item | Rate |
|---|---|
| Voice API (Call Control) inbound | $0.002/min |
| Media streaming over WebSocket | $0.0025-0.0035/min (the page lists both) |
| STT, Deepgram Flux over WebSocket | $0.0074/min |
| TTS, Telnyx Ultra | $0.000032/char |
| SIP inbound (same for v1 and v2) | from $0.0032/min |

If Alfred talks 40% of a minute at about 15 characters a second, TTS is about
360 characters, or $0.0115. The total is about $0.024 a minute plus SIP, against
v1's $0.05 engine fee alone. The TTS part grows with how much Alfred talks, not
with the call length. A cheaper voice would bring it below $0.02.

### Switch the number between v1 and v2

The setup script creates the Call Control application only. It never moves
the number. Both paths can be on in bot.js at the same time.

1. Set `VOICE_PIPELINE_TOKEN` and `VOICE_PUBLIC_URL` in `.env`.
2. Run `node scripts/telnyx-voice-pipeline-setup.mjs https://<public> --dry-run`,
   then again without `--dry-run`.
3. Restart the bot. The log shows "Call pipeline v2 (Telnyx speech) is on" (with
   `VOICE_PIPELINE_ENGINE=telnyx`).
4. To use v2: portal > Numbers > the number > Voice settings > Connection or
   App = "Alfred (phone pipeline)".
5. To go back to v1: portal > AI Assistants > "Alfred (phone)" > Calling >
   assign the number again.

### Open points (need a live call)

- Does Telnyx sign the media WebSocket upgrade on every connection? If the log
  shows "no telnyx-signature-ed25519 header", set
  `VOICE_PIPELINE_SIGNED_MEDIA=0`. The token still guards the socket.
- Does Tailscale Funnel pass the WebSocket upgrade and its headers unchanged?
- Does Ultra REST give raw PCM for `response_format: "pcm"`, at what rate, and
  how fast is the first byte? The code reads a WAV header if one comes, and
  refuses MP3. If the voice is too slow or too deep, the rate is wrong. Change
  `VOICE_PIPELINE_TTS_RATE`.
- In rtp mode, does Telnyx want raw PCMU bytes (what we send) or full RTP
  packets? Do 100 ms frames at real-time pace avoid error 100005?
- Does the phone's own echo of Alfred's voice make Flux send `StartOfTurn`
  (a false barge-in)?
- Does the "chunk" number of inbound media count up by one per frame for the
  whole stream? The log shows out-of-order, late, and restart counts at the
  end of each call.
- In rtp mode, does Telnyx echo each mark when the audio before it has played?
  If the log shows "No mark echo", it does not, and "heard" comes from the
  time estimate only.
- If the stream cannot connect, does Telnyx send `streaming.failed`? If not,
  the call hangs up 15 seconds after the answer.
- The real latency of the whole chain. The log line gives it per reply.

## v3 local speech (opt-in, the pipeline default)

v3 is the v2 pipeline with the two paid speech engines replaced by models on
this machine. The call plumbing is the same code: Call Control, the media
WebSocket, the greeting, fillers, barge-in, marks, and `onCallTurn`. Only the
phone line and the media stream stay paid. Caller audio does not leave the
machine. `VOICE_PIPELINE_ENGINE` selects the engine: `local` (v3, the default)
or `telnyx` (v2).

### Flow

```
phone ──► Telnyx number ──► Call Control app "Alfred (phone pipeline)"
             ▼  (same answer, media socket, and checks as v2)
          telnyx/pipeline.js ── PCMU 8 kHz frames ──► voice/local-speech.js
                                                        │ JSON lines, base64 audio
                                                        ▼ (stdin / stdout pipes)
                                   voice/local_speech.py (one process, models in memory)
   caller audio ─► mu-law decode ─► VAD (Silero, 32 ms windows) ─► turn detector
   speech ≥ 200 ms ─► "speech_start" ─► StartOfTurn (barge-in, drop window)
   silence ≥ 650 ms ─► "eot" ─► Parakeet TDT 0.6B int8 on the utterance ─► "turn"
   "turn" ─► EndOfTurn ─► onCallTurn (same as v1/v2) ─► reply
   reply ─► one request per sentence ─► Kokoro (bm_george, en-gb), clause by clause
         ─► PCM16 24 kHz ─► telnyx/audio.js: low-pass, 8 kHz, mu-law ─► caller
```

1. bot.js starts the sidecar once, when the pipeline is on and the engine is
   `local`. It loads Parakeet, Kokoro and the VAD, and runs each model once
   (warm-up). The log shows `Local speech ready ... VAD silero`. Load takes
   about 3.5 s.
2. Each call opens one stream in the sidecar. Each media frame goes to it as it
   comes. A stream that opens while the sidecar loads waits, and keeps up to
   5 s of audio.
3. The turn detector has three states: idle, starting, speaking. 200 ms of
   speech (`VOICE_LOCAL_MIN_SPEECH_MS`) is a start. A gap over 120 ms before
   that is a noise blip, and the state goes back to idle. In "speaking", 650 ms
   of silence (`VOICE_LOCAL_EOT_MS`) ends the turn. A turn over 30 s ends
   by force. The utterance keeps 300 ms of audio from before the start and
   200 ms of the end silence.
4. Parakeet runs on the 8 kHz utterance. onnx_asr resamples it to 16 kHz.
5. The client gives the pipeline the same events as Flux: `StartOfTurn`, and
   `EndOfTurn` with the transcript, the end-of-speech time, and the STT time.
6. Text-to-speech: the pipeline sends one sentence per request, and asks for
   the next sentence while the current one plays, as in v2. The sidecar splits
   a long sentence at commas, semicolons, colons and dashes. The first clause
   is at least 20 characters. Later clauses are joined up to 120 characters,
   with 120 ms of silence between clauses. Kokoro gives no audio until a piece
   is done, so this brings the first audio of a long sentence from 2.6 s to
   0.7 s. An abort (barge-in) cancels the request in the sidecar.
7. The greeting and filler audio go in the same memory cache as in v2.

### Why pipes and JSON lines

The sidecar talks to bot.js over its stdin and stdout, one JSON object per
line, with audio as base64. A socket is not necessary:

- There is no port to guard. No other process can connect.
- The sidecar stops when its stdin closes, so it cannot outlive bot.js.
- The data rate is low: 8 kB/s of caller audio per call, plus 48 kB/s of TTS
  audio for a short time. Base64 adds a third.
- The format is text. A test can drive the client with a fake sidecar.

The sidecar writes its log lines to stderr. bot.js logs them with a
`sidecar:` prefix.

Requests: `open`, `audio`, `playing`, `close` (per call), `tts`, `cancel`,
`ping`. Events: `ready`, `speech_start`, `eot`, `turn`, `tts_chunk`,
`tts_done`, `tts_error`, `pong`, `error`. `voice/local_speech.py` has the full
list in its header.

### Failure handling

- Any error in the client is logged. It never stops the bot.
- If the sidecar stops, each open call stream gets a close. The pipeline tries
  again (3 times, 1 s apart, as for v2). Each open TTS request fails. The client
  starts the sidecar again after 1 s, then 2, 4, up to 60 s. A run of 60 s
  resets the delay. A stream that opens while the sidecar loads waits for it.
- If the sidecar cannot load its models, it exits with code 2, and the client
  tries again with the delay. A call in that time ends with "speech-to-text
  lost".
- An event line over 4 MB is dropped. A line that is not JSON is logged.
- One TTS sentence has 30 s. Then the request fails.

### Voice activity detection

`VOICE_LOCAL_VAD=auto` (the default) uses Silero if
`onnx_asr.load_vad("silero")` finds the model in the local cache, with
downloads off. Otherwise it uses the energy detector. The ready log line names
the VAD in use.

- **Silero** (active on this machine): the ONNX model streams at 8 kHz, in
  256-sample (32 ms) windows with its recurrent state. Speech starts at a
  score over 0.5 and stops under 0.35. One window takes 0.12 ms.
- **Energy** (the fallback): the RMS level of each 20 ms frame against a noise
  floor. The floor falls fast and rises slowly, only when there is no speech.
  Speech starts 12 dB over the floor and stops under 6 dB over it. A level
  under -50 dBFS is never speech.

To get Silero on another machine, download it once (2.3 MB):

```sh
source ~/.virenv/base/bin/activate
HF_HUB_OFFLINE=0 python -c "import onnx_asr; onnx_asr.load_vad('silero')"
```

### Echo

Telnyx sends only the caller's track (`stream_track: inbound_track`), and the
phone cancels most of the echo of Alfred's voice. For what is left, two guards
apply while Alfred plays:

1. For 500 ms after his audio starts (`VOICE_LOCAL_ECHO_GUARD_MS`), no speech
   counts. The audio reaches the phone some hundred ms after we send it.
2. Until his audio ends, a start needs more: a Silero score over 0.8, or 10 dB
   more energy.

A real barge-in is louder than an echo, so it still works after the guard.
The pipeline tells the sidecar "playing" when the first audio frame of an
utterance goes out, and "not playing" when no utterance is active.

### Drop window (the v1 fix from #103)

The silence timer can end a turn while the caller only paused. If the caller
starts to talk again within 1.5 s (`DROP_WINDOW_MS`) after the turn went to
Alfred, the pipeline aborts that turn with the `signal` of `onCallTurn`. The
turn leaves the queue, or its `claude` process stops. Its words go in front of
the next turn, also when the next speech has no words (a cough). The window is
measured to the start of the new speech: the end of the new turn comes at
least 650 ms later, so a window to the next end of turn would almost never
match. A start of speech after 1.5 s is a new question. The running turn then
finishes, and its reply is not spoken (as in v2). This works for both engines.

### Latency (measured)

Each reply logs one line:

```
📞 Latency N ms: end of speech → first audio sent (transcript A ms, Alfred B ms, speech C ms)
```

- transcript: from the end of speech to the transcript. This is the
  end-of-turn silence (650 ms) plus Parakeet.
- Alfred: the `onCallTurn` time.
- speech: from the reply to the first audio frame sent. This is Kokoro on the
  first clause.

The sidecar also logs `Parakeet: N ms of audio in M ms` and
`Kokoro: N chars, M ms of audio in K ms (RTF, first chunk)`.

Measured on this machine (i7-8700, 6 cores, no GPU), 2026-11-06, with
`python voice/local_speech_selftest.py --runs 5`. Phone audio is Kokoro speech
put through the 8 kHz mu-law path. Medians:

| Step | Time |
|---|---|
| Sidecar start: Parakeet load / Kokoro load / Silero / warm-up | 2.1 s / 0.7 s / 0.3 s / 0.5 s (3.4-3.6 s in all) |
| Parakeet, 2 s of audio | 229 ms (RTF 0.11) |
| Parakeet, 5 s of audio | 359 ms (RTF 0.07) |
| Parakeet, 10 s of audio | 749 ms (RTF 0.07) |
| Kokoro, short sentence (18 chars, 1.4 s audio): first chunk | 451 ms (RTF 0.33) |
| Kokoro, long sentence (169 chars, 10.9 s audio): first chunk | 743 ms, all 3.3 s (RTF 0.30). One piece: 3.6 s |
| Round trip, Node client and sidecar: end of speech → transcript (6.5 s utterance) | 1108 ms (672 ms silence + 436 ms Parakeet) |
| Sidecar memory (RSS) | 1.3 GB after load, 1.8 GB after the benchmark |

Round trip: Kokoro said "Please remind me to call the dentist on Friday at
three." Parakeet heard "Please remind me to call the dentist on Friday at 3."

With `--threads 4`, the numbers stay about the same (10 s: 617 ms, long
sentence first chunk 806 ms). With 4 other cores kept busy, the times grow by
about half: Parakeet 10 s 951 ms, Kokoro short first chunk 718 ms.

So, without Alfred's own time, a reply starts about 0.65 s (silence) + 0.2-0.5 s
(Parakeet) + 0.45-0.75 s (Kokoro) + about 0.1 s (frames, network) after the
caller stops: about 1.4-2 s. A slow turn speaks a filler line at 1 s.

### Streaming replies

`claude -p --output-format json` gives the reply only when Alfred is done.
Through Alfred's real setup, the first text comes 1.6-2.8 s after the start,
and the whole reply 3.0-4.1 s after it. So the pipeline speaks the reply while
Alfred writes it. This starts a reply about 1-2 s sooner, and more for a long
reply. `VOICE_STREAM_REPLY` is on by default. It works for both engines.

```
claude -p --output-format stream-json --include-partial-messages --verbose
   │ one JSON line per event (claude-stream.js reads them)
   ▼ text deltas ─► onCallTurn onText ─► pipeline: makeReplyChunker
   units (one sentence each) ─► speakable ─► one TTS request per unit
   all units are parts of ONE reply utterance (marks, barge-in, heard)
   "result" line ─► handleTurn as before: state.json, log, mirror post
```

1. Only a pipeline call turn uses stream-json. Discord, SMS, v1 calls and
   the strength follow-ups keep `--output-format json`. The last line of
   stream-json is the same "result" object as json mode, so the timeout,
   login check, abort and session id do not change.
2. The text deltas include text before a tool call ("Let me check.") and the
   text of each assistant message. The result has only the last text. The
   caller hears all of it. The parser adds a newline at the end of each text
   block. So the text before a tool call is a complete unit at once, and does
   not wait for the tool. In a real test run, "Let me check the time for
   you." was ready at 1.8 s, and not at 3.9 s after the tool.
3. The chunker ends a unit at a newline, or at `.` `!` `?` with a space after
   it. A unit under 12 characters, an abbreviation ("Dr.", "e.g.") or an
   initial does not end a unit. "3.5" has no space after the point, so it does
   not split. The sidecar splits long units at clauses, as before.
4. Tokens never reach speech, also when they come in two deltas. Text from
   `<` is held while it can be a tag, and a complete tag (`<no_reply>`) is
   dropped. Text from `{` is held while it can be `{img:…}`, `{pdf:…}`,
   `{file:…}` or `{bg:…}`, and the complete token is dropped. Other text is
   released ("3 < 5"). So a `<no_reply>` turn speaks nothing.
5. The first unit stops the filler lines and opens the reply utterance. The
   next unit is fetched while the current one plays. If no text comes for
   `VOICE_FILLER_REPEAT_MS` after the audio ends (a tool runs), a filler line
   plays in the same utterance. The echo guard hears "not playing" in the wait.
6. A barge-in clears all the audio of the reply, stops the TTS requests, and
   ignores later text. The reply counts as not heard. A turn cancelled in the
   drop window stops its speech and is not a missed reply. A newer turn
   stops the speech of an older one.
7. At the end, the rest of the stream is spoken. If the turn failed after
   some text (timeout, login), the held rest is dropped, and the error text
   is spoken. A default line ("On it — pulling your workout") is also spoken
   whole. The mirror channel gets the whole reply, as before.
8. The 1200-character cap counts the streamed units. At the cap, the reply
   ends with "The rest is in Discord."

Logs: `First streamed text N ms after the transcript (M ms after the end of
speech)`, then the usual `Latency` line with "— streamed" at the end. In it,
"Alfred" is the time to the first unit, not to the whole reply. Compare it
with the line of a turn with `VOICE_STREAM_REPLY=0`.

To turn it off, set `VOICE_STREAM_REPLY=0` and restart the bot.

### Cost

Per call minute, from telnyx.com/pricing (read 2026-11-06): Voice API inbound
$0.002, media streaming $0.0025-0.0035, SIP inbound from $0.0032. That is
about $0.008-0.009 a minute, with no speech fees. v2 is about $0.024 a minute,
and v1 is about $0.055.

### Enable v3

1. Make sure that the models are in the cache. The self-test shows it:
   `source ~/.virenv/base/bin/activate && python voice/local_speech_selftest.py --runs 1`.
2. In `.env`, set the v2 values (`VOICE_PIPELINE_TOKEN`, `VOICE_PUBLIC_URL`,
   and the Telnyx keys), and `VOICE_PIPELINE_ENGINE=local` (or leave it unset).
3. Run the setup script once, if the Call Control application does not exist:
   `node scripts/telnyx-voice-pipeline-setup.mjs https://<public> --dry-run`,
   then again without `--dry-run`.
4. Restart the bot. The log shows `Local speech ready ... VAD silero` and
   `Call pipeline v3 (local speech) is on`.
5. Portal > Numbers > the number > Voice settings > Connection or App =
   "Alfred (phone pipeline)".
6. To go back to v1: portal > AI Assistants > "Alfred (phone)" > Calling >
   assign the number again. To use v2 on the same number, set
   `VOICE_PIPELINE_ENGINE=telnyx` and restart the bot.

### Open points (need a live call)

- Turn quality against Flux. A fixed 650 ms silence cuts a caller who pauses
  to think, and waits too long after a short "yes". Flux uses the words to
  decide. The drop window covers the first case in part. Tune
  `VOICE_LOCAL_EOT_MS` from real calls.
- Parakeet on phone audio. The tests use clean Kokoro speech through the
  mu-law path. Real phone audio has noise and a narrow band. Parakeet writes
  numbers as digits ("7.15"). Alfred reads the text, so that is no problem.
- Echo: do the guards stop false barge-ins on a speakerphone, and do they let
  a real barge-in through?
- CPU: Parakeet, Kokoro and a `claude` turn share 6 cores. The timings grow by
  about half under load. Two calls at the same time share one sidecar: one
  Parakeet and one Kokoro job run at a time.
- Memory: the sidecar holds 1.3-1.9 GB for as long as the bot runs.
- Streaming replies: does the caller hear a gap between units, and does the
  text before a tool call sound natural? Does Alfred write text that the
  chunker splits badly?
- Kokoro voice: `bm_george` is the default. `bm_lewis` is the other candidate.
  Listen to both on a call.

## Option 2B: OpenAI Realtime with Alfred as a tool (opt-in, #107)

v3 showed that the waits on tool turns are the main problem: 9.7-14.8 s to
the first audio, with no filler. Option 2B puts a fast speech-to-speech model
in front of Alfred. It answers small talk itself and says a short line before
it asks Alfred, so the caller does not hear dead air.

### Flow

```
caller ─► Telnyx Call Control ─► media socket (PCMU 8 kHz) ─► telnyx/realtime.js
  ─► input_audio_buffer.append ─► OpenAI Realtime (semantic VAD, voice "cedar")
  ◄─ response.output_audio.delta (PCMU) ◄─
OpenAI calls use_tools(request) ─► onCallTurn (same session as v1) ─► reply
  ─► function_call_output + response.create ─► OpenAI says the reply
```

- The audio is PCMU in both directions, so there is no transcoding.
- Only one response runs at a time. A `response.create` that comes while one
  runs waits for its `response.done`.
- If Alfred takes 8 s or more, an out-of-band response (`conversation:
  "none"`, no tools) says a short "still working" line, at most every 8 s.
- On `input_audio_buffer.speech_started`, the pipeline clears the Telnyx
  queue and sends `conversation.item.truncate` at the point the caller heard
  (the time since the item's first chunk went out, at most its length).
- If the OpenAI socket closes, the call hangs up. If the caller hangs up while
  Alfred works, Alfred finishes, and his reply still goes to Discord.
- The caller only ever talks to Alfred. The tool is called `use_tools`, and
  the prompt has the voice say results in the first person, so it never says
  "I'm asking Alfred" or "Alfred says".
- Settled by test calls on 2026-11-11: `VOICE_OPENAI_SILENCE_MS=100` with
  reasoning `low`. From the caller's last sound to the first audio, that took
  about 0.83 s, against about 1.65 s with eagerness `high`. Minimal reasoning
  was no faster and chose worse, and a 300 ms timer added about 0.35 s.

### Cost

From openai.com pricing (read 2026-11-11), per 1M tokens:
`gpt-realtime-2.1-mini` audio $10 in, $0.30 cached, $20 out;
`gpt-realtime-2.1` audio $32 in, $0.40 cached, $64 out. Expect about
$0.02 a minute with the mini model, plus the line (about $0.005). The log line
at the end of each call shows the real token count and cost.

### Enable 2B

1. Put `OPENAI_API_KEY` in `.env`, and set `VOICE_PIPELINE_ENGINE=openai`.
2. Restart the bot. The log says "Call pipeline 2B (OpenAI Realtime, Alfred
   as a tool) is on".
3. Point the number to the Call Control app "Alfred (phone pipeline)".

To go back, set the number to the v1 assistant, or set the engine to `local`.
