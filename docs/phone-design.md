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
