// One test call against the 2B voice (OpenAI Realtime), with no phone.
//
// It plays Telnyx's part: makeRealtimeSession gets a fake media stream. The
// caller's scripted lines go in as 20 ms mu-law frames in real time, with
// silence between them as on a real line; Alfred's audio comes out through
// sendFrame and is "played" on a clock, and each mark is echoed when the audio
// before it would have finished playing, as Telnyx does. OpenAI hears, decides
// turns and talks exactly as on a call.
//
// The direct tools are the real ones (telnyx/voice-tools.js) on the fake world
// (fakes.js); use_tools goes to the fake Alfred.

import { makeRealtimeSession } from "../telnyx/realtime.js";
import { makeVoiceTools } from "../telnyx/voice-tools.js";
import { MULAW_SILENCE, PHONE_RATE } from "../telnyx/audio.js";
import { callerAudio, makeRecording } from "./audio.js";
import { fakeAlfred, fakeCalendar, fakeNotion } from "./fakes.js";

const FRAME = 160; // bytes: 20 ms at 8 kHz
const FRAME_MS = 20;
const QUIET_MS = 2500; // Alfred silent this long, with nothing running: his turn is over
const REPLY_WAIT_MS = 20000; // the longest we wait for any reply to a line
const TURN_MAX_MS = 60000; // the longest one exchange may take
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The clock the scenario's tools see: a fixed Wednesday morning, so dates in
// scenarios ("tomorrow", "Friday") always mean the same day.
export const EVAL_NOW = new Date("2026-12-02T15:00:00Z"); // 10:00 AM Eastern

export async function runOpenAICall(scenario, {
  apiKey,
  instructions,
  model,
  reasoning,
  eagerness,
  voice,
  noise,
  quietChains = false,
  callerVoice = "ash",
  ttsCache,
  alfredDelayMs = 4000,
}) {
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  const events = []; // { t, kind, ... }
  const logLines = [];
  const notion = fakeNotion(scenario.world?.pages);
  const calendar = fakeCalendar(scenario.world?.events);
  const alfred = fakeAlfred({ handlers: scenario.alfred, delayMs: alfredDelayMs, world: { computer: structuredClone(scenario.world?.computer || {}), notion, calendar } });
  const recording = makeRecording();

  // Every caller line as audio, before the call starts (the first fetch is the
  // slow one; later runs read the cache).
  const lines = [];
  for (const turn of scenario.turns) lines.push(await callerAudio(turn.say, { apiKey, voice: callerVoice, cacheDir: ttsCache }));

  let pending = 0; // tool calls and Alfred turns that run now
  let idleAt = 0; // when the latest of them finished: the answer is still to come
  let playEnd = 0; // when Alfred's queued audio finishes playing (ms)
  let lastOut = -1; // when Alfred's latest audio frame arrived
  let ended = false;
  let endReason = "";
  let endedByAlfred = false;

  const log = (line) => {
    const t = at();
    logLines.push({ t, line });
    let m;
    if ((m = /^🗣️ {1,2}Voice: (.*)$/.exec(line))) events.push({ t, kind: "voice", text: m[1] });
    else if ((m = /^📞 Caller: (.*)$/.exec(line))) events.push({ t, kind: "heard", text: m[1] });
    else if ((m = /^📞 Latency (\d+) ms/.exec(line))) events.push({ t, kind: "latency", ms: Number(m[1]) });
    else if ((m = /^📞 Barge-in.*heard (\d+) of (\d+) ms/.exec(line))) events.push({ t, kind: "barge-in", heard: Number(m[1]), of: Number(m[2]) });
    else if ((m = /^📞 Answer audio (\d+) ms after use_tools answered, (\d+) ms after/.exec(line)))
      events.push({ t, kind: "answer-latency", ms: Number(m[2]) });
    else if ((m = /^📞 Call session ended: (.*?) — .*about \$([\d.]+)/.exec(line))) {
      events.push({ t, kind: "end", reason: m[1], usd: Number(m[2]) });
    } else if (/^📞 end_call/.test(line)) endedByAlfred = true;
  };

  const tools = makeVoiceTools({
    notionRoutes: notion.routes,
    calendarRoutes: calendar.routes,
    fetchBlockChildren: notion.fetchBlockChildren,
    now: () => new Date(EVAL_NOW.getTime() + at()),
  });
  const directTools = {
    ...tools,
    async call(name, args) {
      pending++;
      const t = at();
      try {
        const result = await tools.call(name, args);
        events.push({ t, kind: "tool", name, args, result: String(result) });
        return result;
      } finally {
        pending--;
        idleAt = at();
      }
    },
  };
  const onTurn = async (a) => {
    pending++;
    const t = at();
    try {
      const reply = await alfred.onTurn(a);
      events.push({ t, kind: "use_tools", request: a.text, reply });
      return reply;
    } finally {
      pending--;
      idleAt = at();
    }
  };

  let session;
  const sendFrame = (frame) => {
    if (frame.event === "media") {
      const bytes = Buffer.from(frame.media.payload, "base64");
      const start = Math.max(playEnd, at());
      recording.add(1, start, bytes);
      playEnd = start + (bytes.length * 1000) / PHONE_RATE;
      lastOut = at();
    } else if (frame.event === "mark") {
      const name = frame.mark.name;
      setTimeout(() => session?.onFrame({ event: "mark", mark: { name } }), Math.max(0, playEnd - at())).unref?.();
    } else if (frame.event === "clear") {
      playEnd = at(); // the caller talked over Alfred: Telnyx drops what's queued
    }
  };

  session = makeRealtimeSession({
    callControlId: `eval-${scenario.id}`,
    caller: "+10000000000",
    sendFrame,
    onTurn,
    hangup: async () => {},
    onEnd: () => {
      ended = true;
    },
    log,
    apiKey,
    model,
    voice,
    eagerness,
    reasoning,
    noise,
    instructions,
    quietChains,
    directTools,
  });

  // The phone line: a frame every 20 ms, the caller's words when there are
  // some, silence otherwise.
  let speech = null; // { bytes, off, done }
  let chunk = 0;
  const line = setInterval(() => {
    if (ended) return;
    const due = Math.floor(at() / FRAME_MS);
    while (chunk < due) {
      let frame;
      if (speech && speech.off < speech.bytes.length) {
        frame = Buffer.alloc(FRAME, MULAW_SILENCE);
        speech.bytes.copy(frame, 0, speech.off, speech.off + FRAME);
        speech.off += FRAME;
        recording.add(0, chunk * FRAME_MS, frame);
        if (speech.off >= speech.bytes.length) speech.done();
      } else frame = Buffer.alloc(FRAME, MULAW_SILENCE);
      chunk++;
      session.onFrame({ event: "media", media: { track: "inbound", chunk: String(chunk), payload: frame.toString("base64") } });
    }
  }, FRAME_MS);

  const say = (bytes, text) =>
    new Promise((resolve) => {
      events.push({ t: at(), kind: "caller", text });
      speech = { bytes, off: 0, done: resolve };
    });

  const speaking = () => playEnd > at();
  // Alfred's turn is over: he has said something since `since`, nothing is
  // playing or running, and he has been quiet a while. A turn with no reply at
  // all ends after REPLY_WAIT_MS.
  const waitQuiet = async (since) => {
    const start = at();
    for (;;) {
      if (ended) return;
      const t = at();
      const replied = lastOut > since;
      const quietFor = t - Math.max(playEnd, since, idleAt);
      if (replied && pending === 0 && !speaking() && quietFor >= QUIET_MS) return;
      if (!replied && pending === 0 && t - start >= REPLY_WAIT_MS) return;
      if (t - start >= TURN_MAX_MS) return;
      await sleep(100);
    }
  };

  session.start();
  try {
    await waitQuiet(0); // the greeting
    for (let i = 0; i < scenario.turns.length && !ended; i++) {
      const turn = scenario.turns[i];
      if (turn.bargeInMs != null) {
        // Talk over Alfred: wait for his next reply to start, then cut in.
        const from = at();
        while (!ended && !(lastOut > from && speaking()) && at() - from < REPLY_WAIT_MS) await sleep(50);
        await sleep(turn.bargeInMs);
      } else if (turn.pauseMs) await sleep(turn.pauseMs);
      await say(lines[i], turn.say);
      // A next line that cuts in, or follows after a set pause, does not wait.
      const next = scenario.turns[i + 1];
      if (next?.bargeInMs == null && next?.pauseMs == null) await waitQuiet(at());
    }
  } finally {
    if (!ended) session.onFrame({ event: "stop" });
    clearInterval(line);
    endReason = endedByAlfred ? "Alfred hung up" : "test hung up";
    await sleep(300);
  }

  return {
    id: scenario.id,
    model,
    reasoning,
    quietChains,
    ms: at(),
    endReason,
    endedByAlfred,
    events: events.sort((a, b) => a.t - b.t),
    log: logLines,
    world: { notion: notion.dump(), calendar: calendar.events(), alfred: alfred.requests, computer: alfred.world.computer },
    notion,
    calendar,
    wav: recording.wav(),
  };
}
