import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import {
  makeRealtimeSession,
  sessionUpdate,
  turnDetection,
  frameRms,
  VOICE_RMS,
  heardMs,
  addUsage,
  usageCost,
  ALFRED_TOOL,
  GREETING,
} from "../telnyx/realtime.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await sleep(5);
  }
};

// A stand-in for the OpenAI Realtime socket. It records what we send, and the
// test plays server events into it.
class FakeWs extends EventEmitter {
  static last = null;
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.readyState = 0;
    this.sent = [];
    FakeWs.last = this;
    setImmediate(() => {
      this.readyState = 1;
      this.emit("open");
    });
  }
  send(s) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.readyState = 3;
  }
  server(ev) {
    this.emit("message", Buffer.from(JSON.stringify(ev)), false);
  }
  types() {
    return this.sent.map((e) => e.type);
  }
}

function setup(over = {}) {
  const frames = [];
  const logs = [];
  const turns = [];
  let hungUp = 0;
  let ended = 0;
  const session = makeRealtimeSession({
    callControlId: "v3:abc",
    caller: "+15551234567",
    sendFrame: (f) => frames.push(f),
    onTurn: async (t) => {
      turns.push(t);
      return over.reply ?? "You have two meetings today.";
    },
    hangup: async () => {
      hungUp++;
    },
    onEnd: () => ended++,
    log: (l) => logs.push(l),
    apiKey: "sk-test",
    WebSocketImpl: FakeWs,
    ...over.opts,
  });
  session.start();
  const ws = FakeWs.last;
  return { session, ws, frames, logs, turns, hung: () => hungUp, ended: () => ended };
}

const ulaw = (ms) => Buffer.alloc((ms * 8000) / 1000, 0x55).toString("base64");

test("sessionUpdate asks for PCMU both ways, semantic VAD, and the ask_alfred tool", () => {
  const ev = sessionUpdate({ voice: "cedar", eagerness: "low" });
  assert.equal(ev.type, "session.update");
  assert.equal(ev.session.type, "realtime");
  assert.deepEqual(ev.session.audio.input.format, { type: "audio/pcmu" });
  assert.deepEqual(ev.session.audio.output.format, { type: "audio/pcmu" });
  assert.equal(ev.session.audio.output.voice, "cedar");
  assert.equal(ev.session.audio.input.turn_detection.type, "semantic_vad");
  assert.equal(ev.session.audio.input.turn_detection.eagerness, "low");
  assert.deepEqual(ev.session.tools, [ALFRED_TOOL]);
  assert.equal(sessionUpdate({ transcribeModel: "" }).session.audio.input.transcription, null);
  assert.equal(ev.session.reasoning, undefined, "unset leaves OpenAI's default");
  assert.deepEqual(sessionUpdate({ reasoning: "minimal" }).session.reasoning, { effort: "minimal" });
});

test("silenceMs switches turn detection to a server_vad silence timer", () => {
  assert.deepEqual(turnDetection({ eagerness: "high" }), {
    type: "semantic_vad",
    eagerness: "high",
    create_response: true,
    interrupt_response: true,
  });
  const t = sessionUpdate({ silenceMs: "350" }).session.audio.input.turn_detection;
  assert.equal(t.type, "server_vad");
  assert.equal(t.silence_duration_ms, 350);
  assert.equal(t.eagerness, undefined);
});

test("the log shows how long turn detection waited after the caller's last sound", async () => {
  let t = 1000;
  const { session, ws, logs } = setup({ opts: { greeting: "", now: () => t } });
  await waitFor(() => ws.readyState === 1);
  const loud = Buffer.alloc(160, 0x00).toString("base64"); // mu-law 0x00 is near full scale
  const quiet = Buffer.alloc(160, 0xff).toString("base64"); // mu-law 0xff is zero
  assert.ok(frameRms(loud) > VOICE_RMS && frameRms(quiet) < VOICE_RMS);
  session.onFrame({ event: "media", media: { track: "inbound", chunk: "1", payload: loud } });
  t = 1300;
  session.onFrame({ event: "media", media: { track: "inbound", chunk: "2", payload: quiet } });
  t = 1700;
  ws.server({ type: "input_audio_buffer.speech_stopped" });
  assert.ok(logs.includes("📞 Turn end decided 700 ms after the caller's last sound"), logs.join("\n"));
  session.end("test", { hang: false });
});

test("the call logs its OpenAI settings", async () => {
  const { session, ws, logs } = setup({ opts: { greeting: "", eagerness: "high", reasoning: "minimal" } });
  await waitFor(() => ws.sent.length >= 1);
  assert.ok(logs.some((l) => l === "📞 OpenAI settings: gpt-realtime-2.1-mini, voice cedar, eagerness high, reasoning minimal"), logs.join("\n"));
  assert.deepEqual(ws.sent[0].session.reasoning, { effort: "minimal" });
  session.end("test", { hang: false });
});

test("heardMs is the time since the first chunk, capped at the item length", () => {
  assert.equal(heardMs(null, 5000, 3000), 0);
  assert.equal(heardMs(1000, 2500, 3000), 1500);
  assert.equal(heardMs(1000, 9000, 3000), 3000);
  assert.equal(heardMs(1000, 900, 3000), 0);
});

test("usage adds up and prices the mini model", () => {
  const t = { audioIn: 0, audioCached: 0, textIn: 0, textCached: 0, audioOut: 0, textOut: 0 };
  addUsage(t, {
    input_token_details: { audio_tokens: 600, text_tokens: 1000, cached_tokens_details: { audio_tokens: 100, text_tokens: 800 } },
    output_token_details: { audio_tokens: 1200, text_tokens: 50 },
  });
  assert.deepEqual(t, { audioIn: 500, audioCached: 100, textIn: 200, textCached: 800, audioOut: 1200, textOut: 50 });
  const usd = usageCost(t, "gpt-realtime-2.1-mini");
  // 500*10 + 100*0.3 + 200*0.6 + 800*0.06 + 1200*20 + 50*2.4, per 1M
  assert.ok(Math.abs(usd - 0.029318) < 1e-6, String(usd));
  assert.ok(usageCost(t, "gpt-realtime-2.1") > usd);
});

test("on open: session.update, held caller audio, then the greeting", async () => {
  const { session, ws } = setup();
  session.onFrame({ event: "media", media: { track: "inbound", chunk: "1", payload: ulaw(20) } });
  await waitFor(() => ws.sent.length >= 3);
  assert.deepEqual(ws.types().slice(0, 3), ["session.update", "input_audio_buffer.append", "response.create"]);
  assert.match(ws.url, /model=gpt-realtime-2\.1-mini/);
  assert.equal(ws.opts.headers.Authorization, "Bearer sk-test");
  assert.match(ws.sent[2].response.instructions, new RegExp(GREETING));
  // Caller audio passes through as is, no transcoding.
  session.onFrame({ event: "media", media: { track: "inbound", chunk: "2", payload: "AAAA" } });
  assert.deepEqual(ws.sent.at(-1), { type: "input_audio_buffer.append", audio: "AAAA" });
  // Outbound frames from Telnyx are ignored.
  session.onFrame({ event: "media", media: { track: "outbound", chunk: "3", payload: "BBBB" } });
  assert.notEqual(ws.sent.at(-1).audio, "BBBB");
  session.end("test", { hang: false });
});

test("model audio goes to Telnyx as media frames", async () => {
  const { session, ws, frames, logs } = setup({ opts: { greeting: "" } });
  await waitFor(() => ws.readyState === 1);
  ws.server({ type: "input_audio_buffer.speech_stopped" });
  ws.server({ type: "response.created" });
  ws.server({ type: "response.output_audio.delta", item_id: "it1", delta: ulaw(200) });
  assert.ok(frames.some((f) => f.event === "media"));
  assert.ok(logs.some((l) => /Latency \d+ ms: end of speech → first audio sent \(OpenAI\)/.test(l)));
  session.end("test", { hang: false });
});

test("barge-in clears Telnyx and truncates the item at the heard point", async () => {
  const { session, ws, frames } = setup({ opts: { greeting: "" } });
  await waitFor(() => ws.readyState === 1);
  ws.server({ type: "response.created" });
  ws.server({ type: "response.output_audio.delta", item_id: "it1", delta: ulaw(3000) });
  await sleep(50);
  ws.server({ type: "input_audio_buffer.speech_started" });
  assert.ok(frames.some((f) => f.event === "clear"));
  const tr = ws.sent.find((e) => e.type === "conversation.item.truncate");
  assert.ok(tr, "sent a truncate");
  assert.equal(tr.item_id, "it1");
  assert.equal(tr.content_index, 0);
  assert.ok(tr.audio_end_ms >= 40 && tr.audio_end_ms < 3000, String(tr.audio_end_ms));
  session.end("test", { hang: false });
});

test("ask_alfred runs onTurn and returns the reply as the function output", async () => {
  const { session, ws, turns } = setup({ opts: { greeting: "" } });
  await waitFor(() => ws.readyState === 1);
  ws.server({ type: "response.created" });
  ws.server({
    type: "response.function_call_arguments.done",
    name: "ask_alfred",
    call_id: "call_1",
    arguments: JSON.stringify({ request: "What's on my calendar today?" }),
  });
  await waitFor(() => turns.length === 1);
  assert.equal(turns[0].text, "What's on my calendar today?");
  assert.equal(turns[0].caller, "+15551234567");
  await waitFor(() => ws.sent.some((e) => e.type === "conversation.item.create"));
  const out = ws.sent.find((e) => e.type === "conversation.item.create");
  assert.deepEqual(out.item, { type: "function_call_output", call_id: "call_1", output: "You have two meetings today." });
  // The function-call response is still active, so response.create waits for response.done.
  assert.equal(ws.sent.filter((e) => e.type === "response.create").length, 0);
  ws.server({ type: "response.done", response: { status: "completed" } });
  assert.equal(ws.sent.filter((e) => e.type === "response.create").length, 1);
  session.end("test", { hang: false });
});

test("an empty Alfred reply still answers the function call", async () => {
  const { session, ws } = setup({ reply: "", opts: { greeting: "" } });
  await waitFor(() => ws.readyState === 1);
  ws.server({ type: "response.function_call_arguments.done", name: "ask_alfred", call_id: "c2", arguments: '{"request":"hi"}' });
  await waitFor(() => ws.sent.some((e) => e.type === "conversation.item.create"));
  const out = ws.sent.find((e) => e.type === "conversation.item.create");
  assert.match(out.item.output, /nothing to add/);
  assert.ok(ws.sent.some((e) => e.type === "response.create"));
  session.end("test", { hang: false });
});

test("a slow Alfred gets a spoken still-working line", async () => {
  let release;
  const frames = [];
  const session = makeRealtimeSession({
    callControlId: "v3:x",
    caller: "+1",
    sendFrame: (f) => frames.push(f),
    onTurn: () => new Promise((r) => (release = r)),
    hangup: async () => {},
    log: () => {},
    apiKey: "sk-test",
    WebSocketImpl: FakeWs,
    greeting: "",
    updateMs: 60,
  });
  session.start();
  const ws = FakeWs.last;
  await waitFor(() => ws.readyState === 1);
  ws.server({ type: "response.function_call_arguments.done", name: "ask_alfred", call_id: "c3", arguments: '{"request":"slow"}' });
  await waitFor(() => ws.sent.some((e) => e.type === "response.create" && e.response?.conversation === "none"));
  const upd = ws.sent.find((e) => e.response?.conversation === "none");
  assert.equal(upd.response.tool_choice, "none");
  release("done");
  session.end("test", { hang: false });
});

test("the call ends and hangs up when the OpenAI socket closes", async () => {
  const { ws, hung, ended, logs } = setup();
  await waitFor(() => ws.readyState === 1);
  ws.emit("close", 1006);
  assert.equal(ended(), 1);
  await waitFor(() => hung() === 1);
  assert.ok(logs.some((l) => /OpenAI connection closed \(1006\)/.test(l)));
});

test("a Telnyx stop ends the session without a hangup and logs the cost", async () => {
  const { session, ws, hung, ended, logs } = setup();
  await waitFor(() => ws.readyState === 1);
  ws.server({ type: "response.done", response: { usage: { output_token_details: { audio_tokens: 1000 } } } });
  session.onFrame({ event: "stop" });
  assert.equal(ended(), 1);
  assert.equal(hung(), 0);
  assert.ok(session.ended);
  assert.ok(logs.some((l) => /1000 audio out tokens, about \$0\.0200/.test(l)), logs.join("\n"));
});

test("the settings log names the silence timer when it is on", async () => {
  const { session, ws, logs } = setup({ opts: { greeting: "", silenceMs: 400 } });
  await waitFor(() => ws.sent.length >= 1);
  assert.ok(logs.some((l) => /turn end after 400 ms of silence, reasoning default \(low\)/.test(l)), logs.join("\n"));
  session.end("test", { hang: false });
});

test("no API key is a clear error", () => {
  assert.throws(() => makeRealtimeSession({ sendFrame() {}, onTurn() {}, hangup() {} }), /OPENAI_API_KEY/);
});

test('the pipeline takes engine "openai" and needs its API key', async () => {
  const { makeVoicePipeline, ENGINES } = await import("../telnyx/pipeline.js");
  assert.ok(ENGINES.includes("openai"));
  const base = { publicUrl: "https://box.example.ts.net", token: "t", publicKey: "k", apiKey: "telnyx", onTurn() {} };
  assert.throws(() => makeVoicePipeline({ ...base, engine: "openai" }), /OPENAI_API_KEY/);
  const p = makeVoicePipeline({ ...base, engine: "openai", realtime: { apiKey: "sk-test" } });
  assert.equal(p.engine, "openai");
  p.close();
});
