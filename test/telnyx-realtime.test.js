import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeLedger, callRow, inboundRow } from "../ledger.js";
import { liveFeed, callBriefing, CLEARED_UPDATE } from "../context.js";
import {
  makeRealtimeSession,
  sessionUpdate,
  turnDetection,
  frameRms,
  VOICE_RMS,
  heardMs,
  addUsage,
  usageCost,
  emptyUsage,
  costLines,
  fileClips,
  USE_TOOLS,
  END_CALL,
  DEFAULT_INSTRUCTIONS,
  BRIEFING_WAIT_MS,
  toolOutput,
  oneLine,
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

test("sessionUpdate asks for PCMU both ways, semantic VAD, and the use_tools tool", () => {
  const ev = sessionUpdate({ voice: "cedar", eagerness: "low" });
  assert.equal(ev.type, "session.update");
  assert.equal(ev.session.type, "realtime");
  assert.deepEqual(ev.session.audio.input.format, { type: "audio/pcmu" });
  assert.deepEqual(ev.session.audio.output.format, { type: "audio/pcmu" });
  assert.equal(ev.session.audio.output.voice, "cedar");
  assert.equal(ev.session.audio.input.turn_detection.type, "semantic_vad");
  assert.equal(ev.session.audio.input.turn_detection.eagerness, "low");
  assert.deepEqual(ev.session.tools, [USE_TOOLS, END_CALL]);
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

test("the noise filter is far_field by default, and can be near_field or off", () => {
  const nr = (o) => sessionUpdate(o).session.audio.input.noise_reduction;
  assert.deepEqual(nr({}), { type: "far_field" });
  assert.deepEqual(nr({ noise: "near_field" }), { type: "near_field" });
  assert.equal(nr({ noise: "off" }), null);
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
  assert.ok(logs.some((l) => l === "📞 OpenAI settings: gpt-realtime-2.1-mini, voice cedar, eagerness high, reasoning minimal, noise filter far_field, silent tool chains on"), logs.join("\n"));
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

test("costLines splits a call's cost by part and by kind of answer, in cents a minute", () => {
  const reply = { audioIn: 500, audioCached: 1000, textIn: 2000, textCached: 10000, audioOut: 800, textOut: 100 };
  const still = { ...emptyUsage(), audioOut: 200 };
  const usage = emptyUsage();
  for (const u of [reply, still]) for (const k of Object.keys(usage)) usage[k] += u[k];
  // Full prices per 1M: audio 32 in (0.4 cached), 64 out; text 4 in (0.4 cached), 24 out.
  const lines = costLines({ usage, byKind: { still_working: still, reply }, model: "gpt-realtime-2.1", mins: 2, cutShare: 0.25, speechMs: 41_400 });
  assert.deepEqual(lines, [
    "📞 Where it went, ¢/min: her voice 3.20 (talked over 0.80) · audio in 0.80 full, 0.02 cached · " +
      "text in 0.40 full, 0.20 cached · text out 0.12 · caller spoke 41 s",
    "📞 By answer, ¢/min: reply 4.10 · still_working 0.64",
  ]);
  assert.deepEqual(costLines({ usage, mins: 0 }), [], "a call that never started has no rate");
  assert.equal(costLines({ usage, mins: 1 }).length, 1, "no kinds, no second line");
});

test("the end of a call logs where the money went, and onUsage gets each answer's bill", async () => {
  let t = 0;
  const billed = [];
  const { session, ws, logs } = setup({ opts: { now: () => t, model: "gpt-realtime-2.1", onUsage: (u) => billed.push(u) } });
  await waitFor(() => ws.sent.some((e) => e.type === "response.create"));
  assert.equal(ws.sent.find((e) => e.type === "response.create").response.metadata.kind, "greeting");
  // The greeting, 1 s of audio, heard whole.
  ws.server({ type: "response.output_audio.delta", item_id: "g", delta: ulaw(1000) });
  ws.server({
    type: "response.done",
    response: { id: "r1", metadata: { kind: "greeting" }, usage: { input_token_details: { text_tokens: 2000 }, output_token_details: { audio_tokens: 500 } } },
  });
  // The caller speaks for 3 s; a reply of 1 s, which the caller talks over at once.
  t = 2000;
  ws.server({ type: "input_audio_buffer.speech_started", audio_start_ms: 1500 });
  ws.server({ type: "input_audio_buffer.speech_stopped", audio_end_ms: 4500 });
  t = 5000;
  ws.server({ type: "response.output_audio.delta", item_id: "a", delta: ulaw(1000) });
  ws.server({
    type: "response.done",
    response: {
      id: "r2",
      usage: {
        input_token_details: { audio_tokens: 300, text_tokens: 2100, cached_tokens_details: { text_tokens: 1920 } },
        output_token_details: { audio_tokens: 500 },
      },
    },
  });
  ws.server({ type: "input_audio_buffer.speech_started", audio_start_ms: 5000 });
  t = 60_000;
  session.end("test", { hang: false });
  // Full prices: her voice 1000 × 64; half her audio was cut, so half of it was not heard.
  assert.ok(
    logs.includes(
      "📞 Where it went, ¢/min: her voice 6.40 (talked over 3.20) · audio in 0.96 full, 0.00 cached · " +
        "text in 0.87 full, 0.08 cached · text out 0.00 · caller spoke 3 s"
    ),
    logs.join("\n")
  );
  assert.ok(logs.includes("📞 By answer, ¢/min: reply 4.31 · greeting 4.00"), logs.join("\n"));
  assert.deepEqual(billed, [
    { kind: "greeting", id: "r1", usage: { ...emptyUsage(), textIn: 2000, audioOut: 500 } },
    { kind: "reply", id: "r2", usage: { ...emptyUsage(), audioIn: 300, textIn: 180, textCached: 1920, audioOut: 500 } },
  ]);
});

test("the prompt opens with the date and time the call starts", async () => {
  const { session, ws } = setup({ opts: { greeting: "", clock: () => new Date("2026-12-02T15:00:00Z") } });
  await waitFor(() => ws.sent.length >= 1);
  const { instructions } = ws.sent[0].session;
  assert.match(instructions, /^It is Wednesday, December 2, 2026 at 10:00 AM \(Eastern\) as the call starts\.\n\nYou are Alfred/);
  session.end("test", { hang: false });
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

test("the prompt keeps the voice in character as Alfred", async () => {
  const { readFileSync } = await import("fs");
  const file = readFileSync(new URL("../agent/phone-voice.md", import.meta.url), "utf8").trim();
  assert.equal(DEFAULT_INSTRUCTIONS, file);
  assert.match(file, /never mention a\s+tool/);
  assert.match(file, /Before use_tools, say one short line/);
  assert.match(file, /Before a change with notion or calendar, say just "Got it\." or "Will do\."/);
  assert.equal(file.match(/Got it/g).length, 1, '"Got it" only in the before-a-change rule');
  assert.match(file, /Say nothing\s+before\s+a read or get_time/);
  assert.match(file, /When a change is done, say "Done\." and what changed in a few words/);
  assert.match(file, /If it failed, try to fix it\s+yourself/);
  assert.match(file, /Every use_tools result gets told/);
  assert.doesNotMatch(file, /Let me check/);
  assert.match(USE_TOOLS.description, /^Slow: say one short line first/);
  assert.match(file, /do\s+not\s+start\s+with\s+"yes" or "no"/);
  assert.doesNotMatch(file, /real Alfred|Alfred's voice/);
  assert.match(file, /read in full, every\s+item in order/);
  // About half the first #130 pass: a long prompt makes the small model
  // wordy, and the tool descriptions already carry the per-tool rules.
  assert.ok(file.split(/\s+/).length <= 400, `${file.split(/\s+/).length} words`);
  assert.doesNotMatch(USE_TOOLS.description, /Alfred/);
  // Each quick tool of the prompt is named in what use_tools is not for, so
  // the two never disagree about a reminder.
  for (const tool of ["notion", "calendar", "reminders", "get_time"]) {
    assert.match(file, new RegExp(`\\b${tool}\\b`), tool);
    assert.match(USE_TOOLS.description.split(":")[1], new RegExp(`\\b${tool}\\b`), tool);
  }
  assert.match(file, /notion holds the user's own pages/);
  assert.doesNotMatch(file, /Shopping list|Greens/i);
});

test("a tool turn logs the full wait until the answer is heard", async () => {
  let t = 1000;
  const { session, ws, logs } = setup({ opts: { greeting: "", now: () => t } });
  await waitFor(() => ws.readyState === 1);
  const loud = Buffer.alloc(160, 0x00).toString("base64");
  session.onFrame({ event: "media", media: { track: "inbound", chunk: "1", payload: loud } });
  t = 1400;
  ws.server({ type: "input_audio_buffer.speech_stopped" });
  ws.server({ type: "response.function_call_arguments.done", name: "use_tools", call_id: "c9", arguments: '{"request":"list"}' });
  await waitFor(() => ws.sent.some((e) => e.type === "conversation.item.create"));
  const repliedAt = t;
  t = repliedAt + 600;
  ws.server({ type: "response.output_audio.delta", item_id: "ans", delta: ulaw(200) });
  assert.ok(logs.includes(`📞 Answer audio 600 ms after use_tools answered, ${t - 1000} ms after the caller finished asking`), logs.join("\n"));
  session.end("test", { hang: false });
});

test("a mark after a barge-in clear is not counted as hugely late", async () => {
  let t = 1000;
  const { session, ws, logs } = setup({ opts: { greeting: "", now: () => t } });
  await waitFor(() => ws.readyState === 1);
  ws.server({ type: "response.output_audio.delta", item_id: "x", delta: ulaw(300) });
  ws.server({ type: "input_audio_buffer.speech_started" }); // clear: playEndAt is 0
  ws.server({ type: "response.output_audio.done", item_id: "x" });
  session.onFrame({ event: "mark", mark: { name: "x:end" } });
  assert.ok(!logs.some((l) => /later than expected/.test(l)), logs.join("\n"));
  session.end("test", { hang: false });
});

test("transcripts log on one line", () => {
  assert.equal(oneLine(" Right, let me look.\n\nVilla Tronco is open.\n"), "Right, let me look. Villa Tronco is open.");
});

test("the end of a reply flushes the last part chunk and sends a mark", async () => {
  const { session, ws, frames } = setup({ opts: { greeting: "" } });
  await waitFor(() => ws.readyState === 1);
  ws.server({ type: "response.created" });
  // 130 ms: one full 100 ms chunk, and 30 ms the player holds back.
  ws.server({ type: "response.output_audio.delta", item_id: "it1", delta: ulaw(130) });
  const media = () => frames.filter((f) => f.event === "media").reduce((n, f) => n + Buffer.from(f.media.payload, "base64").length, 0);
  assert.equal(media(), 800);
  ws.server({ type: "response.output_audio.done", item_id: "it1" });
  assert.ok(media() >= 1040, String(media()));
  assert.deepEqual(frames.at(-1), { event: "mark", mark: { name: "it1:end" } });
  session.end("test", { hang: false });
});

test("a reply Telnyx never plays gets a warning; a late one gets a log line", async () => {
  let t = 1000;
  const { session, ws, logs } = setup({ opts: { greeting: "", now: () => t, markLateMs: 30 } });
  await waitFor(() => ws.readyState === 1);
  ws.server({ type: "response.output_audio.delta", item_id: "a", delta: ulaw(100) });
  ws.server({ type: "response.output_audio.done", item_id: "a" });
  await waitFor(() => logs.some((l) => /Telnyx has not played reply a 30 ms after its end/.test(l)), 1000);
  t = 5000;
  ws.server({ type: "response.output_audio.delta", item_id: "b", delta: ulaw(100) });
  ws.server({ type: "response.output_audio.done", item_id: "b" });
  t = 7100; // due at 5100
  session.onFrame({ event: "mark", mark: { name: "b:end" } });
  assert.ok(logs.some((l) => l === "⚠️  Telnyx played a reply 2000 ms later than expected"), logs.join("\n"));
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

test("use_tools runs onTurn and returns the reply as the function output", async () => {
  const { session, ws, turns } = setup({ opts: { greeting: "" } });
  await waitFor(() => ws.readyState === 1);
  ws.server({ type: "response.created" });
  ws.server({
    type: "response.function_call_arguments.done",
    name: "use_tools",
    call_id: "call_1",
    arguments: JSON.stringify({ request: "What's on my calendar today?" }),
  });
  await waitFor(() => turns.length === 1);
  assert.equal(turns[0].text, "What's on my calendar today?");
  assert.equal(turns[0].caller, "+15551234567");
  await waitFor(() => ws.sent.some((e) => e.type === "conversation.item.create"));
  const out = ws.sent.find((e) => e.type === "conversation.item.create");
  assert.equal(out.item.type, "function_call_output");
  assert.equal(out.item.call_id, "call_1");
  assert.equal(out.item.output, toolOutput("What's on my calendar today?", "You have two meetings today."));
  assert.match(out.item.output, /^Result for "What's on my calendar today\?":\nYou have two meetings today\.\n\nGive the caller this result now/);
  // The function-call response is still active, so response.create waits for response.done.
  assert.equal(ws.sent.filter((e) => e.type === "response.create").length, 0);
  ws.server({ type: "response.done", response: { status: "completed" } });
  assert.equal(ws.sent.filter((e) => e.type === "response.create").length, 1);
  session.end("test", { hang: false });
});

test("an empty Alfred reply still answers the function call", async () => {
  const { session, ws } = setup({ reply: "", opts: { greeting: "" } });
  await waitFor(() => ws.readyState === 1);
  ws.server({ type: "response.function_call_arguments.done", name: "use_tools", call_id: "c2", arguments: '{"request":"hi"}' });
  await waitFor(() => ws.sent.some((e) => e.type === "conversation.item.create"));
  const out = ws.sent.find((e) => e.type === "conversation.item.create");
  assert.match(out.item.output, /nothing more to report/);
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
  ws.server({ type: "response.function_call_arguments.done", name: "use_tools", call_id: "c3", arguments: '{"request":"slow"}' });
  await waitFor(() => ws.sent.some((e) => e.type === "response.create" && e.response?.conversation === "none"));
  const upd = ws.sent.find((e) => e.response?.conversation === "none");
  assert.equal(upd.response.tool_choice, "none");
  release("done");
  session.end("test", { hang: false });
});

// A slow use_tools call whose still-working line has been asked for.
async function slowWithUpdate(opts = {}) {
  let release;
  const logs = [];
  const session = makeRealtimeSession({
    callControlId: "v3:x",
    caller: "+1",
    sendFrame: () => {},
    onTurn: () => new Promise((r) => (release = r)),
    hangup: async () => {},
    log: (l) => logs.push(l),
    apiKey: "sk-test",
    WebSocketImpl: FakeWs,
    greeting: "",
    updateMs: 60,
    ...opts,
  });
  session.start();
  const ws = FakeWs.last;
  await waitFor(() => ws.readyState === 1);
  ws.server({ type: "response.function_call_arguments.done", name: "use_tools", call_id: "c9", arguments: '{"request":"slow"}' });
  ws.server({ type: "response.done", response: { id: "r_call", status: "completed" } });
  await waitFor(() => ws.sent.some((e) => e.response?.metadata?.kind === "still_working"));
  const cancels = () => ws.sent.filter((e) => e.type === "response.cancel");
  const answers = () => ws.sent.filter((e) => e.type === "response.create" && !e.response);
  return { session, ws, logs, release: (r) => release(r), cancels, answers };
}

test("a still-working line reads only its own instruction, not the call or the tools", async () => {
  const { session, ws, release } = await slowWithUpdate();
  const line = ws.sent.find((e) => e.response?.metadata?.kind === "still_working").response;
  assert.equal(line.conversation, "none");
  assert.deepEqual(line.input, []);
  assert.deepEqual(line.tools, []);
  assert.match(line.instructions, /still on it/);
  release("Done.");
  session.end("test", { hang: false });
});

test("a still-working line that has not played is cancelled when the answer comes", async () => {
  const { session, ws, logs, release, cancels, answers } = await slowWithUpdate();
  ws.server({ type: "response.created", response: { id: "r_upd", metadata: { kind: "still_working" } } });
  release("Done.");
  await waitFor(() => cancels().length === 1);
  assert.deepEqual(cancels()[0], { type: "response.cancel", response_id: "r_upd" });
  assert.ok(logs.some((l) => /Dropped a still-working line/.test(l)));
  // The answer waits for the cancelled line to end, then goes.
  assert.equal(answers().length, 0);
  ws.server({ type: "response.done", response: { id: "r_upd", status: "cancelled" } });
  assert.equal(answers().length, 1);
  session.end("test", { hang: false });
});

test("an answer before response.created still cancels the still-working line", async () => {
  const { session, ws, release, cancels } = await slowWithUpdate();
  release("Done.");
  await waitFor(() => ws.sent.some((e) => e.type === "conversation.item.create"));
  assert.equal(cancels().length, 0);
  ws.server({ type: "response.created", response: { id: "r_upd", metadata: { kind: "still_working" } } });
  assert.deepEqual(cancels()[0], { type: "response.cancel", response_id: "r_upd" });
  session.end("test", { hang: false });
});

test("a still-working line that has started playing is left to finish", async () => {
  const { session, ws, release, cancels, answers } = await slowWithUpdate();
  ws.server({ type: "response.created", response: { id: "r_upd", metadata: { kind: "still_working" } } });
  ws.server({ type: "response.output_audio.delta", response_id: "r_upd", item_id: "it_upd", delta: ulaw(200) });
  release("Done.");
  await waitFor(() => ws.sent.some((e) => e.type === "conversation.item.create"));
  assert.equal(cancels().length, 0);
  ws.server({ type: "response.done", response: { id: "r_upd", status: "completed" } });
  assert.equal(answers().length, 1);
  session.end("test", { hang: false });
});

test("a result that comes back after the call ended goes to onLate", async () => {
  let release;
  const late = [];
  const logs = [];
  const session = makeRealtimeSession({
    callControlId: "v3:x",
    caller: "+1",
    sendFrame: () => {},
    onTurn: () => new Promise((r) => (release = r)),
    onLate: (x) => late.push(x),
    hangup: async () => {},
    log: (l) => logs.push(l),
    apiKey: "sk-test",
    WebSocketImpl: FakeWs,
    greeting: "",
  });
  session.start();
  const ws = FakeWs.last;
  await waitFor(() => ws.readyState === 1);
  ws.server({ type: "response.function_call_arguments.done", name: "use_tools", call_id: "c8", arguments: '{"request":"read the list"}' });
  await waitFor(() => release);
  session.end("hung up", { hang: false });
  release("Milk, eggs.");
  await waitFor(() => late.length === 1);
  assert.deepEqual(late[0], { request: "read the list", reply: "Milk, eggs.", caller: "+1" });
  assert.ok(logs.some((l) => /answered after the call ended/.test(l)));
});

test("end_call hangs up once the goodbye has played", async () => {
  const { session, ws, frames, hung, ended, logs } = setup({ opts: { greeting: "" } });
  await waitFor(() => ws.readyState === 1);
  ws.server({ type: "response.created", response: { id: "r_bye" } });
  ws.server({ type: "response.output_audio.delta", response_id: "r_bye", item_id: "it_bye", delta: ulaw(400) });
  ws.server({ type: "response.function_call_arguments.done", name: "end_call", call_id: "c_end", arguments: "{}" });
  ws.server({ type: "response.done", response: { id: "r_bye", status: "completed" } });
  assert.ok(logs.some((l) => /end_call: Alfred hangs up/.test(l)));
  // Not while the goodbye still plays.
  await sleep(100);
  assert.equal(hung(), 0);
  await waitFor(() => hung() === 1, 3000);
  assert.equal(ended(), 1);
  assert.ok(frames.some((f) => f.event === "media"));
  assert.ok(logs.some((l) => /Call session ended: Alfred hung up \(end_call\)/.test(l)));
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

test("a direct tool answers without Alfred, and its result goes straight back", async () => {
  const calls = [];
  const directTools = ({ caller }) => ({
    defs: [{ type: "function", name: "get_time", parameters: { type: "object", properties: {} } }],
    names: ["get_time"],
    call: async (name, args) => {
      calls.push({ name, args, caller });
      return "Sunday 3:04 PM";
    },
  });
  const { session, ws, turns, logs } = setup({ opts: { greeting: "", directTools } });
  await waitFor(() => ws.readyState === 1);
  assert.deepEqual(ws.sent[0].session.tools.map((t) => t.name), ["use_tools", "end_call", "get_time"]);
  ws.server({ type: "response.created", response: { id: "r1" } });
  ws.server({ type: "response.function_call_arguments.done", name: "get_time", call_id: "c_t", arguments: "{}" });
  await waitFor(() => ws.sent.some((e) => e.type === "conversation.item.create"));
  const out = ws.sent.find((e) => e.type === "conversation.item.create");
  assert.deepEqual(out.item, { type: "function_call_output", call_id: "c_t", output: "Sunday 3:04 PM" });
  assert.equal(turns.length, 0, "Alfred was not asked");
  assert.equal(calls[0].caller, "+15551234567");
  assert.ok(logs.some((l) => /📞 get_time \{\} → \d+ ms: Sunday 3:04 PM/.test(l)), logs.join("\n"));
  ws.server({ type: "response.done", response: { id: "r1", status: "completed" } });
  const creates = ws.sent.filter((e) => e.type === "response.create");
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].response, { metadata: { kind: "quiet" }, output_modalities: ["text"] }, "the reply after a quick tool is silent text");
  session.end("test", { hang: false });
});

test("with quietChains off, the reply after a quick tool is plain audio", async () => {
  const directTools = { defs: [], names: ["get_time"], call: async () => "Sunday 3:04 PM" };
  const { session, ws, logs } = setup({ opts: { greeting: "", directTools, quietChains: false } });
  await waitFor(() => ws.readyState === 1);
  assert.ok(logs.some((l) => /silent tool chains off/.test(l)), logs.join("\n"));
  ws.server({ type: "response.created", response: { id: "r1" } });
  ws.server({ type: "response.function_call_arguments.done", name: "get_time", call_id: "c_t", arguments: "{}" });
  await waitFor(() => ws.sent.some((e) => e.type === "conversation.item.create"));
  ws.server({ type: "response.done", response: { id: "r1", status: "completed" } });
  const creates = ws.sent.filter((e) => e.type === "response.create");
  assert.equal(creates.length, 1);
  assert.equal(creates[0].response, undefined, "a plain response.create: the session's audio");
  session.end("test", { hang: false });
});

// A quick tool whose result is back, so the next response.create is the quiet one.
async function quietChain(over = {}) {
  const directTools = {
    defs: [{ type: "function", name: "notion", parameters: { type: "object", properties: {} } }],
    names: ["notion"],
    call: async () => "Done: removed \"Bread\".",
  };
  const t = setup({ opts: { greeting: "", directTools, ...over } });
  await waitFor(() => t.ws.readyState === 1);
  t.ws.server({ type: "response.created", response: { id: "r1" } });
  t.ws.server({ type: "response.function_call_arguments.done", name: "notion", call_id: "c1", arguments: "{}" });
  await waitFor(() => t.ws.sent.some((e) => e.type === "conversation.item.create"));
  t.ws.server({ type: "response.done", response: { id: "r1", status: "completed" } });
  t.ws.server({ type: "response.created", response: { id: "q1", metadata: { kind: "quiet" } } });
  return t;
}
const say = (ws) => ws.sent.filter((e) => e.type === "response.create" && e.response?.metadata?.kind === "say");
const message = (text) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });

test("a quiet reply that calls another tool stays silent; its text is only logged", async () => {
  const { session, ws, logs } = await quietChain();
  ws.server({
    type: "response.done",
    response: { id: "q1", status: "completed", metadata: { kind: "quiet" }, output: [message("Now the eggs."), { type: "function_call", name: "notion", call_id: "c2" }] },
  });
  assert.equal(say(ws).length, 0);
  assert.ok(logs.some((l) => l === "🤫 Voice (silent): Now the eggs."), logs.join("\n"));
  session.end("test", { hang: false });
});

test("a quiet reply with no tool call is the answer, said out of band", async () => {
  const { session, ws } = await quietChain();
  ws.server({
    type: "response.done",
    response: { id: "q1", status: "completed", metadata: { kind: "quiet" }, output: [message("Done, bread is off the list.")] },
  });
  const [s] = say(ws);
  assert.ok(s, "the answer is spoken");
  assert.equal(s.response.conversation, "none");
  assert.deepEqual(s.response.input, [], "it reads only the text to say, not the call again");
  assert.deepEqual(s.response.tools, []);
  assert.deepEqual(s.response.output_modalities, ["audio"]);
  assert.equal(s.response.tool_choice, "none");
  assert.match(s.response.instructions, /^Say exactly this and nothing else: "Done, bread is off the list\."$/);
  session.end("test", { hang: false });
});

test("a quiet reply cut off by the caller says nothing", async () => {
  const { session, ws } = await quietChain();
  ws.server({
    type: "response.done",
    response: { id: "q1", status: "cancelled", metadata: { kind: "quiet" }, output: [message("Done, bread")] },
  });
  assert.equal(say(ws).length, 0);
  session.end("test", { hang: false });
});

test("a quiet goodbye with end_call is said, then the call hangs up", async () => {
  const { session, ws, hung } = await quietChain();
  ws.server({ type: "response.function_call_arguments.done", name: "end_call", call_id: "c_end", arguments: "{}" });
  ws.server({
    type: "response.done",
    response: { id: "q1", status: "completed", metadata: { kind: "quiet" }, output: [message("Goodbye."), { type: "function_call", name: "end_call", call_id: "c_end" }] },
  });
  assert.equal(say(ws).length, 1, "the goodbye is spoken");
  await sleep(50);
  assert.equal(hung(), 0, "not before the goodbye");
  ws.server({ type: "response.created", response: { id: "s1", metadata: { kind: "say" } } });
  ws.server({ type: "response.done", response: { id: "s1", status: "completed", metadata: { kind: "say" } } });
  await waitFor(() => hung() === 1, 3000);
  session.end("test", { hang: false });
});

// ── The call in the ledger (onCallEvent) ────────────────────────────────────

const WHO = { callId: "v3:abc", caller: "+15551234567" };

test("call events: the start, the caller's and the voice's lines as they come, and the end with its length", async () => {
  let t = 1000;
  const events = [];
  const { session, ws } = setup({ opts: { greeting: "", now: () => t, onCallEvent: (e) => events.push(e) } });
  assert.deepEqual(events, [{ type: "start", ...WHO }], "the start comes as the session starts");
  await waitFor(() => ws.readyState === 1);
  ws.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "in1", transcript: " Add kale to the list. " });
  ws.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "in2", transcript: "  " });
  ws.server({ type: "response.created", response: { id: "r1" } });
  ws.server({ type: "response.output_audio_transcript.done", response_id: "r1", item_id: "out1", transcript: "Got it." });
  assert.equal(events.length, 3, "each line goes as it comes, not at the end of the call");
  t += 125_000;
  session.end("call hung up", { hang: false });
  session.end("again", { hang: false });
  assert.deepEqual(events.slice(1), [
    { type: "line", dir: "in", text: "Add kale to the list.", ...WHO },
    { type: "line", dir: "out", text: "Got it.", ...WHO },
    { type: "end", reason: "call hung up", ms: 125_000, ...WHO },
  ]);
});

test("the text of a silent tool chain is never a line; the answer the caller heard is", async () => {
  const events = [];
  const { session, ws } = await quietChain({ onCallEvent: (e) => events.push(e) });
  // Narration between tool calls: silent text, never audio.
  ws.server({
    type: "response.done",
    response: { id: "q1", status: "completed", metadata: { kind: "quiet" }, output: [message("Now the eggs."), { type: "function_call", name: "notion", call_id: "c2" }] },
  });
  ws.server({ type: "response.created", response: { id: "q2", metadata: { kind: "quiet" } } });
  ws.server({
    type: "response.done",
    response: { id: "q2", status: "completed", metadata: { kind: "quiet" }, output: [message("Done, bread is off the list.")] },
  });
  assert.equal(events.filter((e) => e.type === "line").length, 0, "nothing was said yet");
  // The answer is said out of band; its audio transcript is what was heard.
  ws.server({ type: "response.created", response: { id: "s1", metadata: { kind: "say" } } });
  ws.server({ type: "response.output_audio_transcript.done", response_id: "s1", item_id: "s_it", transcript: "Done, bread is off the list." });
  assert.deepEqual(events.filter((e) => e.type === "line").map((e) => [e.dir, e.text]), [["out", "Done, bread is off the list."]]);
  session.end("test", { hang: false });
});

test("a still-working line is filler, not a line of the call", async () => {
  const events = [];
  const { session, ws, release } = await slowWithUpdate({ onCallEvent: (e) => events.push(e) });
  ws.server({ type: "response.created", response: { id: "r_upd", metadata: { kind: "still_working" } } });
  ws.server({ type: "response.output_audio.delta", response_id: "r_upd", item_id: "it_upd", delta: ulaw(200) });
  ws.server({ type: "response.output_audio_transcript.done", response_id: "r_upd", item_id: "it_upd", transcript: "Still on it." });
  ws.server({ type: "response.done", response: { id: "r_upd", status: "completed" } });
  release("Two meetings.");
  await waitFor(() => ws.sent.some((e) => e.type === "conversation.item.create"));
  ws.server({ type: "response.created", response: { id: "r_ans" } });
  ws.server({ type: "response.output_audio_transcript.done", response_id: "r_ans", item_id: "it_ans", transcript: "You have two meetings." });
  assert.deepEqual(events.filter((e) => e.type === "line").map((e) => e.text), ["You have two meetings."]);
  session.end("test", { hang: false });
});

test("a line the caller talked over says how much they heard, before or after its transcript came", async () => {
  let t = 1000;
  const events = [];
  const { session, ws } = setup({ opts: { greeting: "", now: () => t, onCallEvent: (e) => events.push(e) } });
  await waitFor(() => ws.readyState === 1);
  // The transcript first, then the caller cuts in 400 ms into 3 s of audio.
  ws.server({ type: "response.created", response: { id: "r1" } });
  ws.server({ type: "response.output_audio.delta", response_id: "r1", item_id: "a", delta: ulaw(3000) });
  ws.server({ type: "response.output_audio_transcript.done", response_id: "r1", item_id: "a", transcript: "Milk, eggs, bread, kale and spinach." });
  t += 400;
  ws.server({ type: "input_audio_buffer.speech_started" });
  // The caller cuts in first; the transcript of the cut reply comes after.
  t = 5000;
  ws.server({ type: "response.created", response: { id: "r2" } });
  ws.server({ type: "response.output_audio.delta", response_id: "r2", item_id: "b", delta: ulaw(2000) });
  t += 250;
  ws.server({ type: "input_audio_buffer.speech_started" });
  ws.server({ type: "response.output_audio_transcript.done", response_id: "r2", item_id: "b", transcript: "Sure, the list has" });
  // A reply heard to the end is a plain line.
  t = 9000;
  ws.server({ type: "response.created", response: { id: "r3" } });
  ws.server({ type: "response.output_audio.delta", response_id: "r3", item_id: "c", delta: ulaw(500) });
  ws.server({ type: "response.output_audio_transcript.done", response_id: "r3", item_id: "c", transcript: "Kale is on it." });
  assert.deepEqual(ws.sent.filter((e) => e.type === "conversation.item.truncate").map((e) => [e.item_id, e.audio_end_ms]), [["a", 400], ["b", 250]]);
  assert.deepEqual(events.slice(1).map(({ callId, caller, ...e }) => e), [
    { type: "line", dir: "out", text: "Milk, eggs, bread, kale and spinach." },
    { type: "cut", heardMs: 400, totalMs: 3000 },
    { type: "line", dir: "out", text: "Sure, the list has", heardMs: 250, totalMs: 2000 },
    { type: "line", dir: "out", text: "Kale is on it." },
  ]);
  session.end("test", { hang: false });
});

test("use_tools gets the call's id, and an answer after the hangup is a late event", async () => {
  const run = async (answer) => {
    let release;
    const events = [];
    const turns = [];
    const session = makeRealtimeSession({
      callControlId: "v3:late",
      caller: "+1",
      sendFrame: () => {},
      onTurn: (t) => {
        turns.push(t);
        return new Promise((r) => (release = r));
      },
      onCallEvent: (e) => events.push(e),
      hangup: async () => {},
      log: () => {},
      apiKey: "sk-test",
      WebSocketImpl: FakeWs,
      greeting: "",
    });
    session.start();
    const ws = FakeWs.last;
    await waitFor(() => ws.readyState === 1);
    ws.server({ type: "response.function_call_arguments.done", name: "use_tools", call_id: "c8", arguments: '{"request":"read the list"}' });
    await waitFor(() => release);
    session.end("call hung up", { hang: false });
    release(answer);
    await sleep(20);
    return { events, turns };
  };
  const { events, turns } = await run("Milk, eggs.");
  assert.equal(turns[0].callId, "v3:late");
  assert.deepEqual(events.map((e) => e.type), ["start", "end", "late"]);
  assert.deepEqual(events[2], { type: "late", request: "read the list", text: "Milk, eggs.", callId: "v3:late", caller: "+1" });
  // An empty answer sends nothing, so there is nothing to keep.
  assert.deepEqual((await run("  ")).events.map((e) => e.type), ["start", "end"]);
});

test("the direct tools are made for the call: its caller and its id", () => {
  let made = null;
  const directTools = (who) => {
    made = who;
    return { defs: [], names: [], call: async () => "" };
  };
  const { session } = setup({ opts: { greeting: "", directTools } });
  assert.deepEqual(made, WHO);
  session.end("test", { hang: false });
});

test("an onCallEvent that throws or rejects is logged, and the call goes on", async () => {
  const throws = () => {
    throw new Error("disk full");
  };
  const rejects = async () => {
    throw new Error("disk full");
  };
  for (const onCallEvent of [throws, rejects]) {
    const { session, ws, turns, logs, ended } = setup({ opts: { greeting: "", onCallEvent } });
    await waitFor(() => ws.readyState === 1);
    assert.equal(ws.sent[0].type, "session.update", "the start event's failure did not stop the connect");
    ws.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "i1", transcript: "What's on today?" });
    ws.server({ type: "response.created", response: { id: "r1" } });
    ws.server({ type: "response.output_audio_transcript.done", response_id: "r1", item_id: "o1", transcript: "One moment." });
    ws.server({ type: "response.function_call_arguments.done", name: "use_tools", call_id: "c1", arguments: '{"request":"today"}' });
    await waitFor(() => ws.sent.some((e) => e.type === "conversation.item.create"));
    assert.equal(turns.length, 1, "use_tools still reached Alfred");
    session.end("test", { hang: false });
    assert.equal(ended(), 1);
    await waitFor(() => logs.filter((l) => /^⚠️ {2}Call event \w+ failed: disk full$/.test(l)).length === 4);
    assert.deepEqual(
      logs.map((l) => /Call event (\w+) failed/.exec(l)?.[1]).filter(Boolean),
      ["start", "line", "line", "end"],
    );
  }
});

// ── The live feed ───────────────────────────────────────────────────────────

// The texts of the system items sent to OpenAI.
const systemItems = (ws) =>
  ws.sent.filter((e) => e.type === "conversation.item.create" && e.item?.role === "system").map((e) => e.item.content[0].text);
const asItem = (text) => ({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text }] } });

test("the feed starts with the call's id and caller, and stops once when the call ends", async () => {
  const started = [];
  let stops = 0;
  const feed = (who) => {
    started.push(who);
    return () => stops++;
  };
  const { session, ws } = setup({ opts: { greeting: "", feed } });
  assert.equal(started.length, 1);
  assert.equal(started[0].callId, "v3:abc");
  assert.equal(started[0].caller, "+15551234567");
  assert.equal(typeof started[0].push, "function");
  await waitFor(() => ws.readyState === 1);
  assert.equal(stops, 0);
  session.end("call hung up", { hang: false });
  session.end("again", { hang: false });
  assert.equal(stops, 1);
});

test("a push before the socket opens is held, then goes in right after the session.update", async () => {
  let push;
  const feed = (f) => {
    push = f.push;
    f.push('[Meanwhile, by text, the user said: "one".]');
    return () => {};
  };
  const { session, ws, logs } = setup({ opts: { feed } });
  push('[You replied by text: "two"]');
  assert.equal(ws.sent.length, 0, "nothing goes before the socket is open");
  await waitFor(() => ws.sent.length >= 4);
  assert.deepEqual(ws.types().slice(0, 4), ["session.update", "conversation.item.create", "conversation.item.create", "response.create"]);
  assert.deepEqual(ws.sent[1], asItem('[Meanwhile, by text, the user said: "one".]'));
  assert.deepEqual(ws.sent[2], asItem('[You replied by text: "two"]'));
  assert.match(ws.sent[3].response.instructions, new RegExp(GREETING), "the only response is the greeting");
  assert.ok(logs.includes('📞 Live update for the call (held until the socket opens): [Meanwhile, by text, the user said: "one".]'), logs.join("\n"));
  session.end("test", { hang: false });
});

test("a push during the call is a system item and nothing more: no response.create, no session.update", async () => {
  let push;
  const { session, ws } = setup({ opts: { greeting: "", feed: (f) => ((push = f.push), () => {}) } });
  await waitFor(() => ws.sent.length >= 1);
  push('[Meanwhile, by SMS, the user said: "eggs".]');
  assert.deepEqual(ws.sent.at(-1), asItem('[Meanwhile, by SMS, the user said: "eggs".]'));
  // While a response runs, the item goes in and the response is left alone.
  ws.server({ type: "response.created", response: { id: "r1" } });
  push('[You replied by SMS: "ok"]');
  ws.server({ type: "response.done", response: { id: "r1", status: "completed" } });
  push("  "); // no words: nothing
  assert.deepEqual(systemItems(ws), ['[Meanwhile, by SMS, the user said: "eggs".]', '[You replied by SMS: "ok"]']);
  assert.deepEqual(ws.types().filter((t) => t !== "conversation.item.create"), ["session.update"], "no response asked, none cut, settings unchanged");
  session.end("test", { hang: false });
});

test("after the call ends, a push is dropped, and what was held never goes", async () => {
  let push;
  const { session, ws, logs } = setup({ opts: { greeting: "", feed: (f) => ((push = f.push), () => {}) } });
  push("[held]");
  session.end("call hung up", { hang: false }); // before the socket opened
  await sleep(10); // the socket opens, and the call closes it at once
  push("[too late]");
  assert.deepEqual(ws.sent, []);
  assert.equal(logs.filter((l) => /Live update/.test(l)).length, 1);
});

test("a feed that throws at the start, or whose stop throws, is logged, and the call goes on", async () => {
  const fails = setup({ opts: { greeting: "", feed: () => { throw new Error("no ledger"); } } });
  await waitFor(() => fails.ws.sent.length >= 1);
  assert.equal(fails.ws.sent[0].type, "session.update");
  assert.ok(fails.logs.includes("⚠️  The call's live feed did not start: no ledger"), fails.logs.join("\n"));
  fails.ws.server({ type: "response.function_call_arguments.done", name: "use_tools", call_id: "c1", arguments: '{"request":"today"}' });
  await waitFor(() => fails.turns.length === 1);
  fails.session.end("test", { hang: false });
  assert.equal(fails.ended(), 1);

  const stuck = setup({ opts: { greeting: "", feed: () => () => { throw new Error("already gone"); } } });
  await waitFor(() => stuck.ws.readyState === 1);
  stuck.session.end("call hung up", { hang: false });
  assert.equal(stuck.ended(), 1, "the call still ended");
  assert.ok(stuck.logs.includes("⚠️  The call's live feed did not stop: already gone"), stuck.logs.join("\n"));
});

test("through a real ledger: a text during the call reaches the voice, its own lines never do, /clear tells it to forget", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "alfred-live-"));
  const ledger = makeLedger({ file: path.join(dir, "messages.jsonl"), logsDir: path.join(dir, "logs") });
  const writes = [];
  // As bot.js wires it: the call writes its own rows, and the feed tells it the rest.
  const { session, ws } = setup({
    opts: {
      greeting: "",
      feed: ({ push }) => liveFeed({ ledger, push }),
      onCallEvent: (ev) => {
        const row = callRow(ev);
        if (row) writes.push(ledger.append(row));
      },
    },
  });
  await waitFor(() => ws.sent.length >= 1);
  ws.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "i1", transcript: "Hang on, I'm texting you." });
  ws.server({ type: "response.created", response: { id: "r1" } });
  ws.server({ type: "response.output_audio_transcript.done", response_id: "r1", item_id: "o1", transcript: "Of course." });
  await Promise.all(writes);
  const who = { tag: "kuba", id: "1", channel: "c1" };
  await ledger.append(inboundRow({ who, via: "discord", text: "Thoughts on these?", agentDir: dir, attachments: [path.join(dir, "var", "9-0-shoes.jpg")] }));
  await ledger.append({ dir: "out", via: "discord", kind: "reply", text: "Hoka Clifton 9s, in blue.", files: 0 });
  await ledger.archive();
  const items = systemItems(ws);
  assert.equal(items.length, 3, items.join("\n"));
  assert.match(items[0], /^\[Meanwhile, by text, the user said: "Thoughts on these\?", and sent a photo\./);
  assert.match(items[1], /^\[You replied by text: "Hoka Clifton 9s, in blue\."/);
  assert.equal(items[2], CLEARED_UPDATE);
  assert.equal(ws.sent.filter((e) => e.type === "response.create").length, 0);
  // The call's lines are in the ledger (they went to the archive), never in the call.
  assert.equal(items.some((t) => /texting you|Of course/.test(t)), false);
  // The end stops the feed: a text after the call does not reach it.
  session.end("call hung up", { hang: false });
  await Promise.all(writes);
  await ledger.append(inboundRow({ who, via: "sms", text: "after the call", agentDir: dir }));
  assert.equal(systemItems(ws).length, 3);
});

// ── The briefing (buildInstructions) ────────────────────────────────────────

const DATE_LINE = "It is Wednesday, December 2, 2026 at 10:00 AM (Eastern) as the call starts.";
const AT_TEN = () => new Date("2026-12-02T15:00:00Z");
// A promise the test settles itself.
const later = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

test("the briefing starts with the call and is awaited before the session.update: the date line first, then the briefing", async () => {
  const asked = [];
  const built = later();
  const buildInstructions = (a) => {
    asked.push(a);
    return built.promise;
  };
  const { session, ws, logs } = setup({ opts: { buildInstructions, instructions: "PLAIN", clock: AT_TEN } });
  await waitFor(() => asked.length === 1);
  assert.deepEqual(asked[0], { callId: "v3:abc", caller: "+15551234567", prompt: "PLAIN" }, "the plain prompt goes to the builder");
  await waitFor(() => ws.readyState === 1);
  // The socket is open, the briefing is not ready: no settings, no audio yet.
  session.onFrame({ event: "media", media: { track: "inbound", chunk: "1", payload: ulaw(20) } });
  await sleep(20);
  assert.deepEqual(ws.sent, [], "nothing goes before the briefing");
  built.resolve({ text: "PLAIN\n\nBACKGROUND", shown: new Set() });
  await waitFor(() => ws.sent.length >= 3);
  assert.deepEqual(ws.types().slice(0, 3), ["session.update", "input_audio_buffer.append", "response.create"]);
  assert.equal(ws.sent[0].session.instructions, `${DATE_LINE}\n\nPLAIN\n\nBACKGROUND`);
  assert.ok(logs.some((l) => /^📞 Briefing: 17 characters, built in \d+ ms$/.test(l)), logs.join("\n"));
  // From now on, caller audio goes straight in.
  session.onFrame({ event: "media", media: { track: "inbound", chunk: "2", payload: "AAAA" } });
  assert.deepEqual(ws.sent.at(-1), { type: "input_audio_buffer.append", audio: "AAAA" });
  session.end("test", { hang: false });
});

test("a briefing as a plain string is the prompt too; with no instructions, the builder gets the default prompt", async () => {
  let prompt = null;
  const { session, ws } = setup({ opts: { greeting: "", clock: AT_TEN, buildInstructions: async (a) => ((prompt = a.prompt), "BRIEFED") } });
  await waitFor(() => ws.sent.length >= 1);
  assert.equal(prompt, DEFAULT_INSTRUCTIONS);
  assert.equal(ws.sent[0].session.instructions, `${DATE_LINE}\n\nBRIEFED`);
  session.end("test", { hang: false });
});

test("a briefing that fails, throws, comes back empty or is late: the call starts with the plain prompt, and the log says why", async () => {
  const cases = [
    ["rejects", async () => { throw new Error("disk on fire"); }, "⚠️  The briefing failed: disk on fire. The call starts with the plain prompt"],
    ["throws", () => { throw new Error("no ledger"); }, "⚠️  The briefing failed: no ledger. The call starts with the plain prompt"],
    ["empty", async () => ({ text: "  ", shown: [] }), "⚠️  The briefing came back empty: the call starts with the plain prompt"],
    ["nothing", async () => undefined, "⚠️  The briefing came back empty: the call starts with the plain prompt"],
    ["late", () => new Promise(() => {}), "⚠️  The briefing was not ready 30 ms after the socket opened: the call starts with the plain prompt"],
  ];
  for (const [name, buildInstructions, why] of cases) {
    const { session, ws, logs } = setup({ opts: { buildInstructions, briefingWaitMs: 30, instructions: "PLAIN", clock: AT_TEN } });
    await waitFor(() => ws.sent.length >= 2, 1000);
    assert.equal(ws.sent[0].session.instructions, `${DATE_LINE}\n\nPLAIN`, name);
    assert.equal(ws.sent[1].type, "response.create", `${name}: the greeting still comes`);
    assert.ok(logs.includes(why), `${name}:\n${logs.join("\n")}`);
    session.end("test", { hang: false });
  }
  assert.equal(BRIEFING_WAIT_MS, 1000, "the default wait is the named constant");
});

test("the feed starts before the briefing is asked for, so a row written meanwhile reaches the call one way or the other", async () => {
  const order = [];
  const { session, ws } = setup({
    opts: { greeting: "", feed: () => (order.push("feed"), () => {}), buildInstructions: async () => (order.push("briefing"), "B") },
  });
  await waitFor(() => ws.sent.length >= 1);
  assert.deepEqual(order, ["feed", "briefing"]);
  session.end("test", { hang: false });
});

test("a held live update for a row that the briefing tells is dropped; the others go in after the session.update", async () => {
  let push;
  const built = later();
  const feed = (f) => ((push = f.push), () => {});
  const { session, ws, logs } = setup({ opts: { greeting: "", feed, buildInstructions: () => built.promise } });
  push("[in the briefing too]", "2026-12-02T14:59:00.000Z");
  push("[only in the feed]", "2026-12-02T14:59:30.000Z");
  push("[The user cleared the conversation]");
  await waitFor(() => ws.readyState === 1);
  built.resolve({ text: "BRIEFED", shown: new Set(["2026-12-02T14:59:00.000Z"]) });
  await waitFor(() => ws.sent.length >= 3);
  assert.deepEqual(ws.types(), ["session.update", "conversation.item.create", "conversation.item.create"]);
  assert.deepEqual(systemItems(ws), ["[only in the feed]", "[The user cleared the conversation]"]);
  assert.ok(logs.includes("📞 Dropped 1 live update(s) that the briefing tells already"), logs.join("\n"));
  session.end("test", { hang: false });
});

test("a call that ends while its briefing is built sends nothing", async () => {
  const built = later();
  const { session, ws, ended } = setup({ opts: { buildInstructions: () => built.promise } });
  await waitFor(() => ws.readyState === 1);
  session.end("caller hung up", { hang: false });
  built.resolve("BRIEFED");
  await sleep(20);
  assert.deepEqual(ws.sent, []);
  assert.equal(ended(), 1);
});

test("through a real ledger: a text written while the briefing is built reaches the call once, and the call's own start is no background", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "alfred-brief-"));
  const ledger = makeLedger({ file: path.join(dir, "messages.jsonl"), logsDir: path.join(dir, "logs") });
  const who = { tag: "kuba", id: "1", channel: "c1" };
  await ledger.append(inboundRow({ who, via: "discord", text: "I'm cooking pasta tonight", agentDir: dir }));
  await ledger.append({ dir: "out", via: "discord", kind: "reply", text: "Sounds good.", files: 0 });
  // As bot.js wires it. The builder waits for a text that lands as the call
  // starts, so the row is in the briefing and in the feed's held items both.
  let text;
  const writes = [];
  const { session, ws } = setup({
    opts: {
      greeting: "",
      feed: ({ push }) => liveFeed({ ledger, push }),
      onCallEvent: (ev) => {
        const row = callRow(ev);
        if (row) writes.push(ledger.append(row));
      },
      buildInstructions: async ({ callId, prompt }) => {
        await text;
        return callBriefing({ stateDir: dir, ledger, prompt, callId });
      },
    },
  });
  text = ledger.append(inboundRow({ who, via: "sms", text: "and garlic bread", agentDir: dir }));
  await waitFor(() => ws.sent.length >= 1);
  await Promise.all(writes);
  const { instructions } = ws.sent[0].session;
  assert.match(instructions, /the user said \(by text\): I'm cooking pasta tonight\n.*you said \(by text\): Sounds good\.\n.*the user said \(by SMS\): and garlic bread/);
  assert.equal(instructions.includes("(a phone call started)"), false, "this call is not an earlier call");
  assert.deepEqual(systemItems(ws), [], "the text came once: in the briefing");
  // A text after the briefing reaches the call by the feed.
  await ledger.append(inboundRow({ who, via: "sms", text: "and wine", agentDir: dir }));
  assert.equal(systemItems(ws).length, 1);
  assert.match(systemItems(ws)[0], /by SMS, the user said: "and wine"/);
  session.end("call hung up", { hang: false });
});

test("an answered caller turn is read from then on as its transcript: the text goes in after the audio, then the audio goes", async () => {
  const { session, ws, logs } = setup({ opts: { greeting: "" } });
  await waitFor(() => ws.readyState === 1);
  const sent = (type) => ws.sent.filter((e) => e.type === type);
  ws.server({ type: "input_audio_buffer.committed", item_id: "u1" });
  ws.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "Add milk to the list." });
  assert.equal(sent("conversation.item.create").length, 0, "the newest turn keeps its audio");
  ws.server({ type: "input_audio_buffer.committed", item_id: "u2" });
  ws.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u2", transcript: "And eggs." });
  assert.deepEqual(sent("conversation.item.create"), [
    {
      type: "conversation.item.create",
      previous_item_id: "u1",
      item: { id: "alfred_said_0", type: "message", role: "user", content: [{ type: "input_text", text: "Add milk to the list." }] },
    },
  ]);
  assert.equal(sent("conversation.item.delete").length, 0, "the audio stays until the text is in");
  ws.server({ type: "conversation.item.added", item: { id: "alfred_said_0" } });
  assert.deepEqual(sent("conversation.item.delete"), [{ type: "conversation.item.delete", item_id: "u1" }]);
  ws.server({ type: "conversation.item.added", item: { id: "alfred_said_0" } });
  assert.equal(sent("conversation.item.delete").length, 1, "one delete per turn");
  session.end("test", { hang: false });
  assert.ok(logs.includes("📞 Read back as text: 1 caller turn(s) after their answer"), logs.join("\n"));
});

test("a caller turn with no words, or every turn with textHistory off, keeps its audio", async () => {
  for (const [opts, first] of [[{ textHistory: false }, "Add milk."], [{}, "  "]]) {
    const { session, ws } = setup({ opts: { greeting: "", ...opts } });
    await waitFor(() => ws.readyState === 1);
    ws.server({ type: "input_audio_buffer.committed", item_id: "u1" });
    ws.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: first });
    ws.server({ type: "input_audio_buffer.committed", item_id: "u2" });
    ws.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u2", transcript: "And eggs." });
    assert.equal(ws.sent.filter((e) => e.type === "conversation.item.create").length, 0, JSON.stringify(opts));
    session.end("test", { hang: false });
  }
});

test("the greeting is said once and kept; a later call plays it, with no response to pay for", async () => {
  const kept = new Map();
  const greetingClip = { get: (k) => kept.get(k) ?? null, set: (k, a) => kept.set(k, a) };
  const first = setup({ opts: { greetingClip } });
  await waitFor(() => first.ws.sent.some((e) => e.type === "response.create"));
  first.ws.server({ type: "response.created", response: { id: "g1", metadata: { kind: "greeting" } } });
  first.ws.server({ type: "response.output_audio.delta", response_id: "g1", item_id: "gi", delta: ulaw(300) });
  first.ws.server({ type: "response.output_audio.delta", response_id: "g1", item_id: "gi", delta: ulaw(200) });
  first.ws.server({ type: "response.done", response: { id: "g1", status: "completed", metadata: { kind: "greeting" } } });
  first.session.end("test", { hang: false });
  assert.deepEqual([...kept.keys()], ["cedar|Hey."]);
  assert.equal(kept.get("cedar|Hey.").length, 4000, "the 500 ms the voice said");

  const second = setup({ opts: { greetingClip } });
  await waitFor(() => second.frames.some((f) => f.event === "media"));
  assert.ok(!second.ws.sent.some((e) => e.type === "response.create"), "no response for the greeting");
  const line = second.ws.sent.find((e) => e.type === "conversation.item.create");
  assert.deepEqual(line.item, { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hey." }] });
  assert.ok(second.logs.includes("🗣️  Voice: Hey."), second.logs.join("\n"));
  second.session.end("test", { hang: false });
});

test("a greeting the caller talks over is not kept", async () => {
  const kept = new Map();
  const { session, ws } = setup({ opts: { greetingClip: { get: () => null, set: (k, a) => kept.set(k, a) } } });
  await waitFor(() => ws.sent.some((e) => e.type === "response.create"));
  ws.server({ type: "response.created", response: { id: "g1", metadata: { kind: "greeting" } } });
  ws.server({ type: "response.output_audio.delta", response_id: "g1", item_id: "gi", delta: ulaw(300) });
  ws.server({ type: "input_audio_buffer.speech_started", audio_start_ms: 100 });
  ws.server({ type: "response.done", response: { id: "g1", status: "cancelled", metadata: { kind: "greeting" } } });
  session.end("test", { hang: false });
  assert.equal(kept.size, 0);
});

test("fileClips keeps one greeting per voice and line on disk", () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "alfred-clips-")), "greetings");
  const clips = fileClips(dir);
  assert.equal(clips.get("cedar|Hey."), null);
  clips.set("cedar|Hey.", Buffer.from([1, 2, 3]));
  assert.deepEqual([...clips.get("cedar|Hey.")], [1, 2, 3]);
  assert.equal(clips.get("marin|Hey."), null, "another voice has its own");
});
