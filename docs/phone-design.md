# Phone: SMS and voice

Design notes for Alfred's phone number. SMS shipped in #82. Voice calls (#98)
use a Telnyx AI Assistant with bot.js as its model.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Provider | Telnyx | Lowest voice and SMS rates of Twilio, Plivo, Bird, and Telnyx. Real-time voice streaming and SIP. |
| Number type | Toll-free, not 800 | Toll-free verification is free and accepts a sole proprietor. A local number needs paid 10DLC registration. 800 numbers cost $500 upfront. |
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

Not built: MMS pictures in, and Alfred texting first (reminders).

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
3. The Telnyx model with an `ask_alfred` tool.
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
3. Restart the bot. The log shows "Call pipeline v2 is on".
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
