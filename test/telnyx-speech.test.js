import { test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import { WebSocketServer } from "ws";
import { sttUrl, parseSttMessage, openStt, ttsBody, synthesize, DEFAULT_VOICE, STT_URL } from "../telnyx/speech.js";

const once = (emitter, ev) => new Promise((r) => emitter.once(ev, (...a) => r(a)));
const waitFor = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("sttUrl asks for Flux with mu-law at 8 kHz", () => {
  const u = new URL(sttUrl());
  assert.equal(`${u.origin}${u.pathname}`.replace(/^https?/, "wss"), STT_URL);
  assert.equal(u.searchParams.get("transcription_engine"), "Deepgram");
  assert.equal(u.searchParams.get("model"), "flux");
  assert.equal(u.searchParams.get("input_format"), "mulaw");
  assert.equal(u.searchParams.get("sample_rate"), "8000");
  assert.equal(u.searchParams.get("keyterm"), "Alfred");
  assert.equal(u.searchParams.get("eot_threshold"), null);
  const v = new URL(sttUrl({ base: "ws://127.0.0.1:1/x", keyterms: [], eotThreshold: 0.8, eotTimeoutMs: 3000 }));
  assert.equal(v.searchParams.get("keyterm"), null);
  assert.equal(v.searchParams.get("eot_threshold"), "0.8");
  assert.equal(v.searchParams.get("eot_timeout_ms"), "3000");
});

test("parseSttMessage keeps TurnInfo, drops the untyped copy, and reads errors", () => {
  assert.deepEqual(parseSttMessage(JSON.stringify({ type: "TurnInfo", event: "EndOfTurn", transcript: " hi there ", turn_index: 2, end_of_turn_confidence: "0.91" })), {
    event: "EndOfTurn",
    transcript: "hi there",
    turnIndex: 2,
    confidence: 0.91,
  });
  assert.equal(parseSttMessage(JSON.stringify({ transcript: "hi there", is_final: true })), null);
  assert.equal(parseSttMessage("not json"), null);
  assert.deepEqual(parseSttMessage(JSON.stringify({ errors: [{ code: "40006", title: "bad format" }] })), { error: "40006 bad format" });
  assert.deepEqual(parseSttMessage(JSON.stringify({ type: "error", error: "boom" })), { error: "boom" });
});

test("openStt sends the key, batches audio, passes turn events, and closes with CloseStream", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");
  const got = { auth: null, bytes: [], text: [] };
  let peer;
  wss.on("connection", (ws, req) => {
    peer = ws;
    got.auth = req.headers.authorization;
    ws.on("message", (d, bin) => (bin ? got.bytes.push(d.length) : got.text.push(String(d))));
  });
  const events = [];
  let closedByPeer = false;
  const stt = openStt({
    url: `ws://127.0.0.1:${wss.address().port}/stt`,
    apiKey: "KEY",
    onEvent: (e) => events.push(e),
    onClose: () => (closedByPeer = true),
    log: () => {},
    chunkBytes: 640,
  });
  // Audio sent before the socket opens is kept.
  for (let i = 0; i < 5; i++) stt.send(Buffer.alloc(160, 0xff));
  await waitFor(() => got.bytes.length === 1);
  assert.equal(got.auth, "Bearer KEY");
  assert.deepEqual(got.bytes, [640]);
  peer.send(JSON.stringify({ type: "TurnInfo", event: "StartOfTurn", transcript: "" }));
  peer.send(JSON.stringify({ transcript: "dup", is_final: false }));
  peer.send(JSON.stringify({ type: "TurnInfo", event: "EndOfTurn", transcript: "hello" }));
  await waitFor(() => events.length === 2);
  assert.deepEqual(events.map((e) => e.event), ["StartOfTurn", "EndOfTurn"]);
  stt.close();
  await waitFor(() => got.text.length === 1);
  assert.deepEqual(got.bytes, [640, 160]); // the rest goes out before CloseStream
  assert.deepEqual(JSON.parse(got.text[0]), { type: "CloseStream" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(closedByPeer, false); // our own close is not a failure
  await new Promise((r) => wss.close(r));
});

test("openStt reports a refused connection to onClose", async () => {
  const server = http.createServer();
  server.on("upgrade", (req, socket) => {
    socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
    socket.destroy();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const logs = [];
  const [code, reason] = await new Promise((resolve) =>
    openStt({
      url: `ws://127.0.0.1:${server.address().port}/stt`,
      apiKey: "KEY",
      onEvent: () => {},
      onClose: (c, r) => resolve([c, r]),
      log: (l) => logs.push(l),
    })
  );
  assert.equal(typeof code, "number");
  assert.match(reason, /401/);
  assert.ok(logs.some((l) => /HTTP 401/.test(l)));
  await new Promise((r) => server.close(r));
});

test("ttsBody asks the Ultra voice for PCM at 24 kHz", () => {
  assert.deepEqual(ttsBody({ text: "Hi." }), {
    text: "Hi.",
    voice: DEFAULT_VOICE,
    output_type: "binary_output",
    telnyx: { response_format: "pcm", sampling_rate: 24000 },
  });
});

test("synthesize streams the audio and surfaces errors", async () => {
  let seen;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    seen = { auth: req.headers.authorization, body: JSON.parse(body) };
    if (seen.body.text === "fail") {
      res.writeHead(422, { "Content-Type": "application/json" }).end(JSON.stringify({ errors: [{ code: "90103", title: "Failed to produce text to speech" }] }));
    } else if (seen.body.text === "mp3") {
      res.writeHead(200, { "Content-Type": "audio/mpeg" }).end(Buffer.from("ID3xxxx"));
    } else {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.write(Buffer.alloc(100, 1));
      setTimeout(() => res.end(Buffer.alloc(50, 2)), 10);
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/tts`;

  const it = await synthesize({ text: "Hello.", apiKey: "KEY", url });
  const parts = [];
  for await (const b of it) parts.push(b);
  assert.equal(Buffer.concat(parts).length, 150);
  assert.equal(seen.auth, "Bearer KEY");
  assert.equal(seen.body.telnyx.response_format, "pcm");

  await assert.rejects(synthesize({ text: "fail", apiKey: "KEY", url }), /Failed to produce text to speech/);
  await assert.rejects(synthesize({ text: "mp3", apiKey: "KEY", url }), /audio\/mpeg, not PCM/);

  const big = await synthesize({ text: "Hello.", apiKey: "KEY", url, maxBytes: 120 });
  await assert.rejects(async () => {
    for await (const _ of big) {
      // read until it throws
    }
  }, /over 120 bytes/);
  await new Promise((r) => server.close(r));
});
