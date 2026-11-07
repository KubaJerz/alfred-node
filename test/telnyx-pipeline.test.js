import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import {
  tokenOk,
  streamUrlFor,
  answerBody,
  callControlAppBody,
  makeCallControl,
  capSpoken,
  makeReorder,
  makePlayer,
  makeVoicePipeline,
  EVENTS_PATH,
  MEDIA_PATH,
  OVERFLOW_LINE,
} from "../telnyx/pipeline.js";
import { startTelnyxWebhook, normalizeNumber } from "../telnyx/sms.js";
import { FILLERS, FILLER_MS } from "../telnyx/voice.js";

// A real Ed25519 pair, so the checks run the same code path as production.
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const PUB_B64 = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
const sign = (ts, body) => crypto.sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString("base64");

const TOKEN = "media-s3cret";
const OWNER = "+15551234567";
const OURS = "+18646248580";
const PUBLIC = "https://box.example.ts.net";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await sleep(5);
  }
};

// ── pure parts ──────────────────────────────────────────────────────────────

test("tokenOk accepts only the exact token", () => {
  assert.equal(tokenOk(TOKEN, TOKEN), true);
  assert.equal(tokenOk(`${TOKEN}x`, TOKEN), false);
  assert.equal(tokenOk("", TOKEN), false);
  assert.equal(tokenOk(null, TOKEN), false);
  assert.equal(tokenOk(TOKEN, ""), false);
});

test("streamUrlFor turns the public https URL into the wss media URL", () => {
  assert.equal(streamUrlFor("https://box.example.ts.net/", "a b"), "wss://box.example.ts.net/telnyx/voice/media?token=a%20b");
  assert.equal(streamUrlFor("http://127.0.0.1:9", "t"), "ws://127.0.0.1:9/telnyx/voice/media?token=t");
});

test("answerBody asks for PCMU both ways in rtp mode", () => {
  assert.deepEqual(answerBody("wss://x/y", "v3:abc"), {
    stream_url: "wss://x/y",
    stream_track: "inbound_track",
    stream_codec: "PCMU",
    stream_bidirectional_mode: "rtp",
    stream_bidirectional_codec: "PCMU",
    command_id: "answer-v3:abc",
  });
});

test("callControlAppBody points at the events route with API version 2", () => {
  const b = callControlAppBody("https://box.example.ts.net/");
  assert.equal(b.webhook_event_url, "https://box.example.ts.net/telnyx/voice/events");
  assert.equal(b.webhook_api_version, "2");
  assert.equal(b.application_name, "Alfred (phone pipeline)");
});

test("makeCallControl posts the commands and surfaces API errors", async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization });
    if (url.endsWith("/hangup")) return { ok: false, status: 422, json: async () => ({ errors: [{ detail: "Call has already ended" }] }) };
    return { ok: true, json: async () => ({ data: { result: "ok" } }) };
  };
  const cc = makeCallControl({ apiKey: "KEY", base: "https://api.test/v2", fetchImpl });
  await cc.answer("v3:a/b", { stream_url: "wss://x" });
  await cc.reject("v3:a", "USER_BUSY");
  await assert.rejects(cc.hangup("v3:a"), /Call hangup failed: Call has already ended/);
  assert.equal(seen[0].url, "https://api.test/v2/calls/v3:a%2Fb/actions/answer");
  assert.equal(seen[0].auth, "Bearer KEY");
  assert.deepEqual(seen[1].body, { cause: "USER_BUSY", command_id: "reject-v3:a" });
  assert.deepEqual(seen[2].body, { command_id: "hangup-v3:a" });
});

test("capSpoken keeps a short reply and cuts a long one at a sentence end", () => {
  assert.equal(capSpoken("Short."), "Short.");
  const long = Array.from({ length: 50 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
  const out = capSpoken(long, 200);
  assert.ok(out.length <= 200, `length ${out.length}`);
  assert.ok(out.endsWith(`here. ${OVERFLOW_LINE}`));
});

test("makeReorder puts frames back in order, drops late ones, and skips a gap", () => {
  const out = [];
  const r = makeReorder((p) => out.push(p), { window: 2 });
  r.push("1", "a");
  r.push("3", "c");
  r.push("2", "b");
  r.push("1", "late");
  assert.deepEqual(out, ["a", "b", "c"]);
  r.push("6", "f");
  r.push("7", "g");
  r.push("8", "h"); // 3 held > window 2: skip the gap at 4-5
  assert.deepEqual(out, ["a", "b", "c", "f", "g", "h"]);
  r.push(undefined, "nochunk");
  assert.equal(out.at(-1), "nochunk");
  assert.deepEqual(r.stats, { late: 1, reordered: 4, skipped: 1, resyncs: 0 });
});

test("makeReorder starts again when the chunk count goes back", () => {
  // A restart far back: the first frame of the new count starts again.
  const out = [];
  const r = makeReorder((p) => out.push(p));
  for (let n = 100; n <= 104; n++) r.push(String(n), n);
  for (let n = 1; n <= 19; n++) r.push(String(n), n);
  assert.equal(out.length, 24);
  assert.deepEqual(out.slice(5), Array.from({ length: 19 }, (_, i) => i + 1));
  assert.deepEqual(r.stats, { late: 0, reordered: 0, skipped: 0, resyncs: 1 });

  // A small step back: a few late frames are dropped, then it starts again.
  const out2 = [];
  const r2 = makeReorder((p) => out2.push(p), { window: 4 });
  for (let n = 10; n <= 12; n++) r2.push(String(n), n);
  for (let n = 9; n <= 15; n++) r2.push(String(n), n);
  // 9, 10 and 11 are late and dropped. 12 is the 4th late frame in a row, so
  // the order starts again from it.
  assert.deepEqual(out2, [10, 11, 12, 12, 13, 14, 15]);
  assert.equal(r2.stats.resyncs, 1);
  assert.equal(r2.stats.late, 3);
});

test("makePlayer paces audio, keeps marks in order, pads short chunks, and clears", async () => {
  let t = 0;
  const sent = [];
  const p = makePlayer({ send: (f) => sent.push(f), chunkBytes: 800, leadMs: 200, tickMs: 5, now: () => t });
  let first = 0;
  p.push(Buffer.alloc(2000, 1), () => first++);
  // Lead 200 ms = two 100 ms chunks. The rest waits for the clock.
  assert.equal(sent.length, 2);
  assert.equal(first, 1);
  p.mark("u1:end");
  assert.equal(sent.length, 2);
  t = 150;
  await sleep(20);
  // 400 bytes are left, and a mark follows them, so they go out, then the mark.
  assert.deepEqual(sent.map((f) => f.event), ["media", "media", "media", "mark"]);
  assert.equal(Buffer.from(sent[2].media.payload, "base64").length, 400);
  assert.deepEqual(sent[3].mark, { name: "u1:end" });
  // A tiny tail is padded to 20 ms (160 bytes) of silence.
  t = 10_000;
  p.push(Buffer.alloc(10, 1));
  p.mark("u2:end");
  const tail = Buffer.from(sent[4].media.payload, "base64");
  assert.equal(tail.length, 160);
  assert.equal(tail[9], 1);
  assert.equal(tail[10], 0xff);
  assert.equal(p.busy, true);
  p.push(Buffer.alloc(5000, 1));
  p.clear();
  assert.deepEqual(sent.at(-1), { event: "clear" });
  assert.equal(p.busy, false);
  p.close();
});

// ── the whole pipeline, offline ─────────────────────────────────────────────

// PCM 16-bit at 24 kHz: a quiet tone, 30 ms per character of text.
const fakePcm = (text) => {
  const n = 24 * 30 * text.length;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(3000 * Math.sin(i / 10)), i * 2);
  return b;
};

async function startFakeTts({ delayMs = 0 } = {}) {
  const texts = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const { text } = JSON.parse(body);
    texts.push(text);
    if (delayMs) await sleep(delayMs);
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    const pcm = fakePcm(text);
    // Two pieces, the first an odd length, like a real chunked reply.
    res.write(pcm.subarray(0, 1001));
    setTimeout(() => res.end(pcm.subarray(1001)), 5);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const close = () => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  };
  return { url: `http://127.0.0.1:${server.address().port}/tts`, texts, close };
}

async function startFakeStt() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  const st = { peers: [], bytes: 0, closes: 0, url: `ws://127.0.0.1:${wss.address().port}/stt`, query: null };
  wss.on("connection", (ws, req) => {
    st.query = new URL(req.url, "http://x").searchParams;
    st.auth = req.headers.authorization;
    st.peers.push(ws);
    ws.on("message", (d, bin) => {
      if (bin) st.bytes += d.length;
    });
    ws.on("close", () => st.closes++);
  });
  st.say = (event, transcript = "") => st.peers.at(-1).send(JSON.stringify({ type: "TurnInfo", event, transcript }));
  st.close = () => {
    for (const ws of wss.clients) ws.terminate();
    return new Promise((r) => wss.close(r));
  };
  return st;
}

// The pipeline on a real webhook server, with fake Telnyx parts around it.
async function setup({ onTurn, ttsDelayMs = 0, session = {}, requireSignature = true, pipelineOpts = {} } = {}) {
  const logs = [];
  const commands = [];
  const callControl = {
    answer: async (id, body) => commands.push({ cmd: "answer", id, body }),
    reject: async (id, cause) => commands.push({ cmd: "reject", id, cause }),
    hangup: async (id) => commands.push({ cmd: "hangup", id }),
  };
  const stt = await startFakeStt();
  const tts = await startFakeTts({ delayMs: ttsDelayMs });
  const turns = [];
  const pipeline = makeVoicePipeline({
    publicUrl: PUBLIC,
    token: TOKEN,
    publicKey: PUB_B64,
    apiKey: "KEY",
    allowFrom: [OWNER],
    ourNumber: OURS,
    normalize: normalizeNumber,
    onTurn: async (t) => {
      const missed = t.takeMissed();
      turns.push({ text: t.text, caller: t.caller, missed });
      return onTurn ? onTurn(t, turns.length) : "All clear today.";
    },
    log: (l) => logs.push(l),
    requireSignature,
    callControl,
    sttEndpoint: stt.url.replace(/\?.*$/, ""),
    ttsEndpoint: tts.url,
    fillerMs: 0,
    session: { player: { leadMs: 1e9 }, ...session },
    ...pipelineOpts,
  });
  const hook = await startTelnyxWebhook({ publicKey: PUB_B64, routes: pipeline.routes, log: (l) => logs.push(l) });
  hook.server.on("upgrade", pipeline.handleUpgrade);
  const port = new URL(hook.url).port;

  const postEvent = async (event_type, payload, id = crypto.randomUUID()) => {
    const body = JSON.stringify({ data: { record_type: "event", event_type, id, payload } });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await fetch(`${hook.url}${EVENTS_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "telnyx-signature-ed25519": sign(ts, body), "telnyx-timestamp": ts },
      body,
    });
    return res.status;
  };
  const incoming = (id, from = OWNER) => postEvent("call.initiated", { call_control_id: id, direction: "incoming", state: "parked", from, to: OURS });

  // Telnyx's side of the media socket. It echoes each mark, as if the audio
  // before it was played, unless echo is off.
  const connectMedia = ({ token = TOKEN, signed = true, signUrl = pipeline.streamUrl, echo = true } = {}) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = signed ? { "telnyx-signature-ed25519": sign(ts, signUrl), "telnyx-timestamp": ts } : {};
    const ws = new WebSocket(`ws://127.0.0.1:${port}${MEDIA_PATH}?token=${encodeURIComponent(token)}`, { headers });
    const peer = { ws, frames: [], status: null, closed: null, echo };
    ws.on("error", (err) => {
      const m = /Unexpected server response: (\d+)/.exec(err.message);
      if (m) peer.status = Number(m[1]);
    });
    ws.on("close", (code) => (peer.closed = code));
    ws.on("message", (d) => {
      const f = JSON.parse(String(d));
      peer.frames.push(f);
      if (f.event === "mark" && peer.echo) ws.send(JSON.stringify({ event: "mark", mark: f.mark }));
    });
    peer.open = () => new Promise((r, j) => {
      ws.once("open", r);
      ws.once("close", () => j(new Error(`closed, HTTP ${peer.status}`)));
    });
    peer.start = (id, fmt = { encoding: "PCMU", sample_rate: 8000, channels: 1 }) => {
      ws.send(JSON.stringify({ event: "connected", version: "1.0.0" }));
      ws.send(JSON.stringify({ event: "start", sequence_number: "1", stream_id: "s1", start: { call_control_id: id, media_format: fmt } }));
    };
    let chunk = 1;
    peer.audio = (n = 1) => {
      for (let i = 0; i < n; i++) {
        ws.send(JSON.stringify({ event: "media", media: { track: "inbound", chunk: String(chunk++), timestamp: "0", payload: Buffer.alloc(160, 0xff).toString("base64") } }));
      }
    };
    peer.media = () => peer.frames.filter((f) => f.event === "media");
    peer.marks = () => peer.frames.filter((f) => f.event === "mark").map((f) => f.mark.name);
    return peer;
  };

  const close = async () => {
    pipeline.close();
    await hook.close();
    await stt.close();
    await tts.close();
  };
  return { pipeline, logs, commands, stt, tts, turns, postEvent, incoming, connectMedia, close, hookUrl: hook.url };
}

test("pipeline: an allowed call is answered, greeted, heard, and answered aloud", async () => {
  const s = await setup({ onTurn: async () => "**All** clear today. Nothing on the calendar." });
  try {
    assert.equal(await s.incoming("v3:call1"), 200);
    await waitFor(() => s.commands.length === 1);
    assert.equal(s.commands[0].cmd, "answer");
    assert.equal(s.commands[0].body.stream_url, `wss://box.example.ts.net${MEDIA_PATH}?token=${TOKEN}`);

    const peer = s.connectMedia();
    await peer.open();
    peer.start("v3:call1");
    // The greeting plays, then its end mark.
    await waitFor(() => peer.marks().includes("g1:end"));
    assert.deepEqual(s.tts.texts, ["Hey, it's Alfred."]);
    assert.ok(peer.media().length > 0);
    // Caller audio reaches speech-to-text.
    await waitFor(() => s.stt.peers.length === 1);
    assert.equal(s.stt.auth, "Bearer KEY");
    assert.equal(s.stt.query.get("model"), "flux");
    peer.audio(8);
    await waitFor(() => s.stt.bytes >= 1280);
    // End of turn runs the Alfred turn, and the reply is spoken.
    s.stt.say("StartOfTurn");
    s.stt.say("EndOfTurn", "what's on today");
    await waitFor(() => s.logs.some((l) => /Call reply heard/.test(l)));
    assert.deepEqual(s.turns, [{ text: "what's on today", caller: OWNER, missed: false }]);
    // Markdown is gone. Two sentences, one request each.
    assert.deepEqual(s.tts.texts.slice(1), ["All clear today.", "Nothing on the calendar."]);
    assert.ok(s.logs.some((l) => /Latency \d+ ms: end of speech → first audio sent/.test(l)));
    // Each media frame is 100 ms of mu-law, or a padded tail.
    for (const f of peer.media()) assert.ok(Buffer.from(f.media.payload, "base64").length >= 160);

    // Hangup ends the session, closes speech-to-text, and closes the socket.
    await s.postEvent("call.hangup", { call_control_id: "v3:call1", hangup_cause: "normal_clearing", hangup_source: "caller" });
    await waitFor(() => peer.closed !== null && s.stt.closes === 1);
    assert.equal(s.pipeline.calls.size, 0);
    assert.ok(!s.commands.some((c) => c.cmd === "hangup")); // the call ended on its own
  } finally {
    await s.close();
  }
});

test("pipeline: the greeting comes from the cache on the second call", async () => {
  const s = await setup();
  try {
    for (const id of ["v3:a", "v3:b"]) {
      await s.incoming(id);
      const peer = s.connectMedia();
      await peer.open();
      peer.start(id);
      await waitFor(() => peer.marks().includes("g1:end"));
      await s.postEvent("call.hangup", { call_control_id: id });
      await waitFor(() => peer.closed !== null);
    }
    assert.deepEqual(s.tts.texts, ["Hey, it's Alfred."]);
  } finally {
    await s.close();
  }
});

test("pipeline: unknown callers, other numbers, and a third call are rejected", async () => {
  const s = await setup();
  try {
    await s.incoming("v3:x", "+15550000000");
    await s.postEvent("call.initiated", { call_control_id: "v3:y", direction: "incoming", state: "parked", from: OWNER, to: "+15559999999" });
    await s.postEvent("call.initiated", { call_control_id: "v3:out", direction: "outgoing", state: "bridging", from: OURS, to: OWNER });
    await s.incoming("v3:1");
    await s.incoming("v3:2");
    await s.incoming("v3:3");
    await waitFor(() => s.commands.length === 5);
    assert.deepEqual(
      s.commands.map((c) => [c.cmd, c.id, c.cause]),
      [
        ["reject", "v3:x", "CALL_REJECTED"],
        ["reject", "v3:y", "NOT_FOUND"],
        ["answer", "v3:1", undefined],
        ["answer", "v3:2", undefined],
        ["reject", "v3:3", "USER_BUSY"],
      ]
    );
  } finally {
    await s.close();
  }
});

test("pipeline: an unsigned events request gets a 401 and does nothing", async () => {
  const s = await setup();
  try {
    const body = JSON.stringify({ data: { event_type: "call.initiated", id: "e1", payload: { call_control_id: "v3:z", direction: "incoming", from: OWNER, to: OURS } } });
    const res = await fetch(`${s.hookUrl}${EVENTS_PATH}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    assert.equal(res.status, 401);
    await sleep(20);
    assert.equal(s.commands.length, 0);
  } finally {
    await s.close();
  }
});

test("pipeline: the media socket needs the token, the signature, and an answered call", async () => {
  const s = await setup();
  try {
    // No call is waiting yet.
    let peer = s.connectMedia();
    await assert.rejects(peer.open());
    assert.equal(peer.status, 409);

    await s.incoming("v3:m");
    await waitFor(() => s.commands.length === 1);
    for (const opts of [{ token: "wrong" }, { signed: false }, { signUrl: "wss://evil.example/telnyx/voice/media?token=x" }]) {
      peer = s.connectMedia(opts);
      await assert.rejects(peer.open());
      assert.equal(peer.status, 401, JSON.stringify(opts));
    }
    assert.ok(s.logs.some((l) => /bad token/.test(l)));
    assert.ok(s.logs.some((l) => /no telnyx-signature-ed25519 header/.test(l)));

    // A good socket that names a call we did not answer is closed.
    peer = s.connectMedia();
    await peer.open();
    peer.start("v3:other");
    await waitFor(() => peer.closed !== null);
    assert.equal(peer.closed, 1008);
    assert.equal(s.stt.peers.length, 0);

    // One session per call: a second socket for the same call is refused.
    const a = s.connectMedia();
    await a.open();
    a.start("v3:m");
    await waitFor(() => s.stt.peers.length === 1);
    const b = s.connectMedia();
    await assert.rejects(b.open());
    assert.equal(b.status, 409);
  } finally {
    await s.close();
  }
});

test("pipeline: without requireSignature the token alone opens the socket", async () => {
  const s = await setup({ requireSignature: false });
  try {
    await s.incoming("v3:n");
    await waitFor(() => s.commands.length === 1);
    const peer = s.connectMedia({ signed: false });
    await peer.open();
    const bad = s.connectMedia({ signed: false, token: "nope" });
    await assert.rejects(bad.open());
    assert.equal(bad.status, 401);
  } finally {
    await s.close();
  }
});

test("pipeline: a stream that is not PCMU 8 kHz is refused and the call is hung up", async () => {
  const s = await setup();
  try {
    await s.incoming("v3:f");
    const peer = s.connectMedia();
    await peer.open();
    peer.start("v3:f", { encoding: "L16", sample_rate: 16000, channels: 1 });
    await waitFor(() => peer.closed !== null);
    await waitFor(() => s.commands.some((c) => c.cmd === "hangup" && c.id === "v3:f"));
  } finally {
    await s.close();
  }
});

test("pipeline: a barge-in clears the audio and the next turn hears that the reply was missed", async () => {
  const long = Array.from({ length: 6 }, (_, i) => `This is sentence ${i} of a long reply.`).join(" ");
  const s = await setup({ onTurn: async (t, n) => (n === 1 ? long : "Okay."), ttsDelayMs: 30 });
  try {
    await s.incoming("v3:b");
    const peer = s.connectMedia({ echo: false }); // marks never come back: nothing is "played"
    await peer.open();
    peer.start("v3:b");
    await waitFor(() => s.stt.peers.length === 1);
    peer.echo = true;
    s.stt.say("EndOfTurn", "tell me a story");
    await waitFor(() => s.tts.texts.includes("This is sentence 0 of a long reply."));
    peer.echo = false;
    await waitFor(() => peer.media().length > 0 && s.turns.length === 1);
    const before = s.tts.texts.length;
    s.stt.say("StartOfTurn");
    await waitFor(() => peer.frames.some((f) => f.event === "clear"));
    await waitFor(() => s.logs.some((l) => /Call reply cut/.test(l)));
    assert.ok(s.logs.some((l) => /Barge-in: .*reply not heard/.test(l)));
    // The rest of the reply is never asked for (at most the one in flight).
    await sleep(100);
    assert.ok(s.tts.texts.length <= before + 1, `${s.tts.texts.length} vs ${before}`);
    peer.echo = true;
    s.stt.say("EndOfTurn", "stop, what time is it");
    await waitFor(() => s.turns.length === 2);
    assert.equal(s.turns[1].missed, true);
  } finally {
    await s.close();
  }
});

test("pipeline: a slow turn speaks a filler line, and a newer turn drops the older reply", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const s = await setup({
    // fillerMs at the top level, as bot.js passes VOICE_FILLER_MS.
    pipelineOpts: { fillerMs: 40, fillerRepeatMs: 10_000 },
    onTurn: async (t, n) => {
      if (n === 1) {
        await gate;
        return "First answer.";
      }
      return "Second answer.";
    },
  });
  try {
    await s.incoming("v3:s");
    const peer = s.connectMedia();
    await peer.open();
    peer.start("v3:s");
    await waitFor(() => s.stt.peers.length === 1);
    s.stt.say("EndOfTurn", "first question");
    // Well before the default FILLER_MS, so the top-level fillerMs was used.
    await waitFor(() => s.tts.texts.includes(FILLERS[0]), FILLER_MS - 300);
    await waitFor(() => peer.marks().includes("f2:end"));
    // The caller asks again before the first reply comes.
    s.stt.say("EndOfTurn", "second question");
    await waitFor(() => s.logs.filter((l) => /Call turn from/.test(l)).length === 2);
    release();
    await waitFor(() => s.logs.some((l) => /Call reply heard/.test(l)));
    assert.ok(s.logs.some((l) => /A newer caller turn came first/.test(l)));
    assert.ok(!s.tts.texts.includes("First answer."));
    assert.ok(s.tts.texts.includes("Second answer."));
    assert.equal(s.turns[1].missed, true);
  } finally {
    await s.close();
  }
});

test("pipeline: a lost media socket hangs up the call and closes speech-to-text", async () => {
  const s = await setup();
  try {
    await s.incoming("v3:l");
    const peer = s.connectMedia();
    await peer.open();
    peer.start("v3:l");
    await waitFor(() => s.stt.peers.length === 1);
    peer.ws.terminate();
    await waitFor(() => s.commands.some((c) => c.cmd === "hangup" && c.id === "v3:l"));
    await waitFor(() => s.stt.closes === 1);
    assert.equal(s.pipeline.calls.size, 0); // the call slot is free again
  } finally {
    await s.close();
  }
});

test("pipeline: speech-to-text reconnects, then gives up and hangs up", async () => {
  const s = await setup({ session: { sttRetryMs: 5 } });
  try {
    await s.incoming("v3:r");
    const peer = s.connectMedia();
    await peer.open();
    peer.start("v3:r");
    for (let i = 1; i <= 4; i++) {
      await waitFor(() => s.stt.peers.length === i);
      s.stt.peers.at(-1).close(1011);
    }
    await waitFor(() => s.commands.some((c) => c.cmd === "hangup" && c.id === "v3:r"));
    assert.ok(s.logs.some((l) => /speech-to-text lost/.test(l)));
    await waitFor(() => peer.closed !== null);
  } finally {
    await s.close();
  }
});

test("pipeline: streaming.failed hangs up, and the webhook stays signed", async () => {
  const s = await setup();
  try {
    await s.incoming("v3:sf");
    await waitFor(() => s.commands.length === 1);
    await s.postEvent("streaming.failed", { call_control_id: "v3:sf", failure_reason: "connection_failed" });
    await waitFor(() => s.commands.some((c) => c.cmd === "hangup"));
    assert.equal(s.pipeline.calls.size, 0);
  } finally {
    await s.close();
  }
});

test("pipeline: frames that are not JSON objects are ignored, before and after start", async () => {
  const s = await setup();
  try {
    await s.incoming("v3:n");
    const peer = s.connectMedia();
    await peer.open();
    // JSON null, a number, a string, an array: none may throw in the listener.
    for (const f of ["null", "5", '"x"', "[]"]) peer.ws.send(f);
    peer.start("v3:n");
    await waitFor(() => s.stt.peers.length === 1);
    for (const f of ["null", "5", '"x"', "[]"]) peer.ws.send(f);
    peer.audio(3);
    s.stt.say("EndOfTurn", "still there?");
    await waitFor(() => s.logs.some((l) => /Call reply heard/.test(l)));
    assert.equal(peer.closed, null);
  } finally {
    await s.close();
  }
});

test("pipeline: an answered call whose stream never starts is hung up", async () => {
  const s = await setup({ pipelineOpts: { streamWaitMs: 50 } });
  try {
    await s.incoming("v3:p");
    await waitFor(() => s.commands.some((c) => c.cmd === "hangup" && c.id === "v3:p"));
    assert.equal(s.pipeline.calls.size, 0);
    assert.ok(s.logs.some((l) => /no media stream after 50 ms/.test(l)));
  } finally {
    await s.close();
  }
});

test("pipeline: a stream that starts in time is not hung up by the wait timer", async () => {
  const s = await setup({ pipelineOpts: { streamWaitMs: 150 } });
  try {
    await s.incoming("v3:q");
    const peer = s.connectMedia();
    await peer.open();
    peer.start("v3:q");
    await waitFor(() => s.stt.peers.length === 1);
    await sleep(250);
    assert.ok(!s.commands.some((c) => c.cmd === "hangup"));
    assert.ok(s.pipeline.calls.get("v3:q")?.session);
  } finally {
    await s.close();
  }
});

test("pipeline: speech-to-text drops do not add up when a speech event comes between them", async () => {
  const s = await setup({ session: { sttRetryMs: 5 } });
  try {
    await s.incoming("v3:sr");
    const peer = s.connectMedia();
    await peer.open();
    peer.start("v3:sr");
    // Six drops, more than the 3 tries, but each new link delivers an event.
    for (let i = 1; i <= 6; i++) {
      await waitFor(() => s.stt.peers.length === i);
      s.stt.say("Update");
      await sleep(20);
      s.stt.peers.at(-1).close(1011);
    }
    await waitFor(() => s.stt.peers.length === 7);
    assert.ok(!s.commands.some((c) => c.cmd === "hangup"));
    assert.ok(!s.logs.some((l) => /speech-to-text lost/.test(l)));
  } finally {
    await s.close();
  }
});

test("pipeline: a reply whose end mark never comes back counts as heard after the audio ends", async () => {
  const s = await setup({ onTurn: async () => "Okay.", session: { markGraceMs: 50 } });
  try {
    await s.incoming("v3:m");
    const peer = s.connectMedia({ echo: false });
    await peer.open();
    peer.start("v3:m");
    await waitFor(() => s.stt.peers.length === 1);
    s.stt.say("EndOfTurn", "ping");
    await waitFor(() => s.logs.some((l) => /Call reply heard/.test(l)));
    assert.ok(s.logs.some((l) => /No mark echo for reply/.test(l)));
    // The next StartOfTurn is no barge-in, and the next turn missed nothing.
    s.stt.say("StartOfTurn");
    s.stt.say("EndOfTurn", "and again");
    await waitFor(() => s.turns.length === 2);
    assert.ok(!s.logs.some((l) => /Barge-in/.test(l)));
    assert.equal(s.turns[1].missed, false);
    assert.ok(!peer.frames.some((f) => f.event === "clear"));
  } finally {
    await s.close();
  }
});

test("makeVoicePipeline needs a public URL and a token", () => {
  assert.throws(() => makeVoicePipeline({ publicUrl: "", token: "t", onTurn: () => "" }), /public URL and a token/);
  assert.throws(() => makeVoicePipeline({ publicUrl: PUBLIC, token: "", onTurn: () => "" }), /public URL and a token/);
  assert.throws(() => makeVoicePipeline({ publicUrl: PUBLIC, token: "t", ttsRate: 22050, onTurn: () => "" }), /whole multiple of 8000/);
});

test("the setup script dry run prints the app request and the manual number steps", async () => {
  const { execFile } = await import("child_process");
  const os = await import("os");
  const path = await import("path");
  const script = path.join(import.meta.dirname, "..", "scripts", "telnyx-voice-pipeline-setup.mjs");
  const env = { PATH: process.env.PATH }; // no API key, no .env in the cwd
  const run = (args) =>
    new Promise((resolve) =>
      execFile(process.execPath, [script, ...args], { cwd: os.tmpdir(), env }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }))
    );
  const ok = await run(["https://box.example.ts.net/", "--dry-run"]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /POST https:\/\/api\.telnyx\.com\/v2\/call_control_applications/);
  assert.match(ok.stdout, /"webhook_event_url": "https:\/\/box\.example\.ts\.net\/telnyx\/voice\/events"/);
  assert.match(ok.stdout, /"webhook_api_version": "2"/);
  assert.match(ok.stdout, /did not move/);
  assert.match(ok.stdout, /back to v1/);
  assert.match(ok.stdout, /Dry run: nothing was sent/);
  const noKey = await run(["https://box.example.ts.net"]);
  assert.equal(noKey.code, 1);
  assert.match(noKey.stderr, /TELNYX_API_KEY/);
  const http = await run(["http://box.example.ts.net", "--dry-run"]);
  assert.equal(http.code, 1);
});

// ── the local speech engine (v3) ────────────────────────────────────────────

// An in-process stand-in for voice/local-speech.js: the same two interfaces,
// and a record of what the session did with them.
function fakeLocalSpeech() {
  const st = { streams: [], texts: [], playing: [] };
  return {
    st,
    sampleRate: 24000,
    say(event, transcript = "", extra = {}) {
      st.streams.at(-1).onEvent({ event, transcript, ...extra });
    },
    openStt({ onEvent, onClose }) {
      const s = { onEvent, onClose, bytes: 0, closed: false };
      st.streams.push(s);
      return {
        send: (b) => (s.bytes += b.length),
        close: () => (s.closed = true),
        setPlaying: (on) => st.playing.push(on),
        get open() {
          return !s.closed;
        },
      };
    },
    async synthesize(text) {
      st.texts.push(text);
      const pcm = fakePcm(text);
      return (async function* () {
        yield pcm.subarray(0, 1001);
        yield pcm.subarray(1001);
      })();
    },
  };
}

test("makeVoicePipeline checks the engine name and needs the sidecar for local", () => {
  const base = { publicUrl: PUBLIC, token: TOKEN, apiKey: "K", onTurn: async () => "" };
  assert.throws(() => makeVoicePipeline({ ...base, engine: "cloud" }), /Unknown speech engine "cloud"/);
  assert.throws(() => makeVoicePipeline({ ...base, engine: "local" }), /needs the local speech sidecar/);
  const p = makeVoicePipeline({ ...base, engine: "local", localSpeech: fakeLocalSpeech(), ttsRate: 7 });
  assert.equal(p.engine, "local"); // the sidecar rate replaces a bad ttsRate
  p.close();
  const t = makeVoicePipeline(base);
  assert.equal(t.engine, "telnyx");
  t.close();
});

test("pipeline (local): speech goes through the sidecar, not Telnyx, and the echo guard is told", async () => {
  const local = fakeLocalSpeech();
  const s = await setup({ onTurn: async () => "All clear today.", pipelineOpts: { engine: "local", localSpeech: local } });
  try {
    await s.incoming("v3:loc");
    await waitFor(() => s.commands.length === 1);
    assert.ok(s.logs.some((l) => /answering \(pipeline v3, local speech\)/.test(l)));
    const peer = s.connectMedia();
    await peer.open();
    peer.start("v3:loc");
    await waitFor(() => peer.marks().includes("g1:end"));
    assert.deepEqual(local.st.texts, ["Hey, it's Alfred."]);
    // The greeting played, then ended: playing on, then off.
    await waitFor(() => local.st.playing.length === 2);
    assert.deepEqual(local.st.playing, [true, false]);
    peer.audio(4);
    await waitFor(() => local.st.streams[0].bytes === 640);
    local.say("StartOfTurn");
    local.say("EndOfTurn", "what's on today", { endOfSpeechAt: Date.now() - 900, sttMs: 900 });
    await waitFor(() => s.logs.some((l) => /Call reply heard/.test(l)));
    assert.deepEqual(local.st.texts.slice(1), ["All clear today."]);
    assert.ok(s.logs.some((l) => /Latency \d+ ms: end of speech → first audio sent \(transcript 900 ms, Alfred \d+ ms, speech \d+ ms\)/.test(l)));
    // No Telnyx speech service was used.
    assert.equal(s.stt.peers.length, 0);
    assert.deepEqual(s.tts.texts, []);
    await s.postEvent("call.hangup", { call_control_id: "v3:loc" });
    await waitFor(() => local.st.streams[0].closed);
  } finally {
    await s.close();
  }
});

test("pipeline: the caller talks again within the drop window — the turn is cancelled and its text goes with the next", async () => {
  const local = fakeLocalSpeech();
  const signals = [];
  const s = await setup({
    pipelineOpts: { engine: "local", localSpeech: local },
    onTurn: async (t, n) => {
      signals.push(t.signal);
      if (n === 1) {
        await new Promise((r) => t.signal.addEventListener("abort", r));
        return "";
      }
      return "Booked.";
    },
  });
  try {
    await s.incoming("v3:d");
    const peer = s.connectMedia();
    await peer.open();
    peer.start("v3:d");
    await waitFor(() => peer.marks().includes("g1:end"));
    local.say("EndOfTurn", "book a table for");
    await waitFor(() => signals.length === 1);
    local.say("StartOfTurn"); // inside 1.5 s
    assert.equal(signals[0].aborted, true);
    assert.ok(s.logs.some((l) => /kept talking \d+ ms after a turn — turn cancelled/.test(l)));
    local.say("EndOfTurn", "two at eight");
    await waitFor(() => s.logs.some((l) => /Call reply heard/.test(l)));
    assert.equal(s.turns[1].text, "book a table for two at eight");
    assert.equal(s.turns[1].missed, false); // a cancelled turn is not a missed reply
    assert.ok(!s.logs.some((l) => /A newer caller turn came first/.test(l)));
    assert.equal(signals[1].aborted, false);
  } finally {
    await s.close();
  }
});

test("pipeline: a cancelled turn is sent again when the next speech has no words", async () => {
  const local = fakeLocalSpeech();
  const s = await setup({
    pipelineOpts: { engine: "local", localSpeech: local },
    onTurn: async (t, n) => {
      if (n === 1) await new Promise((r) => t.signal.addEventListener("abort", r));
      return "Okay.";
    },
  });
  try {
    await s.incoming("v3:e");
    const peer = s.connectMedia();
    await peer.open();
    peer.start("v3:e");
    await waitFor(() => peer.marks().includes("g1:end"));
    local.say("EndOfTurn", "call mum");
    await waitFor(() => s.turns.length === 1);
    local.say("StartOfTurn");
    local.say("EndOfTurn", ""); // a cough: no words
    await waitFor(() => s.turns.length === 2);
    assert.equal(s.turns[1].text, "call mum");
  } finally {
    await s.close();
  }
});

test("pipeline: speech after the drop window does not cancel the running turn", async () => {
  const local = fakeLocalSpeech();
  let release;
  const signals = [];
  const s = await setup({
    pipelineOpts: { engine: "local", localSpeech: local },
    session: { dropWindowMs: 30 },
    onTurn: async (t, n) => {
      signals.push(t.signal);
      if (n === 1) await new Promise((r) => (release = r));
      return n === 1 ? "First." : "Second.";
    },
  });
  try {
    await s.incoming("v3:w");
    const peer = s.connectMedia();
    await peer.open();
    peer.start("v3:w");
    await waitFor(() => peer.marks().includes("g1:end"));
    local.say("EndOfTurn", "first question");
    await waitFor(() => signals.length === 1);
    await sleep(60);
    local.say("StartOfTurn");
    assert.equal(signals[0].aborted, false);
    local.say("EndOfTurn", "second question");
    await waitFor(() => s.turns.length === 2);
    assert.equal(s.turns[1].text, "second question");
    release();
    await waitFor(() => s.logs.some((l) => /A newer caller turn came first/.test(l)));
  } finally {
    await s.close();
  }
});
