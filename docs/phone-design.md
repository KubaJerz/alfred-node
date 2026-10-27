# Phone: SMS and voice

Design notes for Alfred's phone number. SMS shipped in #82. Voice is the next
step and is not built.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Provider | Telnyx | Lowest voice and SMS rates of Twilio, Plivo, Bird, and Telnyx. Real-time voice streaming and SIP. |
| Number type | Local, +1 864-624-8580, on 10DLC | A local number was bought. It needs a 10DLC Sole Proprietor brand and campaign. Toll-free was the first plan. |
| 10DLC campaign | Account Notification + Customer Care | Covers texts to Kuba, replies to people who text first, and texts to contacts who asked for them. The first campaign failed with 603 (no public terms page, a call-center opt-in). The new one was submitted on 2026-10-27. |
| Public terms | kubajerzmanowski.com/sms/terms/ | Shows the number, the consent paths, and `sms@kubajerzmanowski.com`. Carriers can check it again at any time, so keep it up. |
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

The campaign also allows replies to people who text first and texts to
contacts who asked for them. The bot does not do that yet: it drops every
number that is not in `SMS_ALLOWED_NUMBERS`. Before it texts anyone else, it
must:

- name "Jakub Jerzmanowski's assistant" and give STOP in the first text,
- keep a record of each contact's consent (date and method),
- send only scheduling and confirmation texts, and no links or phone numbers
  (the campaign says it has none).

## Voice (next)

### Transport: SIP to OpenAI Realtime

```
phone ──► Telnyx number ──SIP──► OpenAI Realtime (audio in and out)
                                   │ webhook: realtime.call.incoming
                                   ▼
                            bot.js (through the tunnel)
                            ├─ accept the call: instructions, voice, tools
                            └─ side WebSocket: tool calls, transcript events
```

The audio never passes through this box. OpenAI speaks back on the SIP call.
The first task is to prove that a Telnyx SIP connection to
`sip:<project>@sip.api.openai.com;transport=tls` works.

Fallback, if SIP fails: Telnyx Media Streaming. Telnyx opens a WebSocket to
`bot.js` with 20 ms PCMU frames in both directions. `bot.js` relays them to
the OpenAI Realtime WebSocket, which also accepts PCMU. This gives full control
(recording, local models) but more code and more latency.

### Context

1. **At call start — instructions.** Build them like `loadContext()`: a short
   voice version of `SOUL.md`, `USER.md`, `MEMORY.md`, today's daily note, and
   the last ~20 entries of `messages.jsonl`.
2. **During the call — one tool, `ask_alfred(request)`.** It runs a normal
   `claude -p` turn through `enqueueTurn`, in the shared session. The voice
   model says "one moment" while it waits, then speaks the result. All skills,
   brokers, and guards stay in one place.
3. **After the call — write back.** Log the transcript to `messages.jsonl` and
   the daily note. Post a short summary in the mirror channel.

### Open points

- Cost: the Realtime API costs much more per minute than Telnyx. Compare
  `gpt-realtime` and `gpt-realtime-mini` on the current price page.
- Security: caller ID can be spoofed. Before `ask_alfred` can act, require a
  spoken PIN, or allow only read actions on a call.
