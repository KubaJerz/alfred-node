// The client for the local speech sidecar (voice/local-speech.js). The tests
// run a fake sidecar (test/fixtures/fake-sidecar.mjs) as a real child process,
// so the pipes and the line framing are real. No model runs here.
//
// The last test runs the Python unit tests of the turn logic
// (voice/test_local_speech.py) when Python with numpy is there. They load no
// model either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeLineSplitter, sidecarConfig, startLocalSpeech, LOCAL_TTS_RATE } from "../voice/local-speech.js";
import { pythonBin } from "../voice/transcribe.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-sidecar.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await sleep(5);
  }
};

function start({ readyMs = 0, ...opts } = {}) {
  const logs = [];
  process.env.FAKE_READY_MS = String(readyMs);
  const ls = startLocalSpeech({ python: process.execPath, args: [FAKE], log: (l) => logs.push(l), restartMs: 50, ...opts });
  delete process.env.FAKE_READY_MS;
  return { ls, logs, got: (op) => logs.filter((l) => l.includes(`sidecar: got ${op}`)).length };
}

const loud = Buffer.alloc(160, 0x00);
const quiet = Buffer.alloc(160, 0xff);

test("makeLineSplitter joins lines across chunks and drops a line that is too long", () => {
  const lines = [];
  let over = 0;
  const split = makeLineSplitter((l) => lines.push(l), { maxLine: 10, onOverflow: () => over++ });
  split(Buffer.from('{"a":'));
  split(Buffer.from('1}\n{"b":2}\n\n{"c"'));
  split(Buffer.from(":3}\n"));
  split(Buffer.from("0123456789abcdef"));
  split(Buffer.from("more\nok\n"));
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}', "ok"]);
  assert.equal(over, 1);
});

test("sidecarConfig maps the options and leaves out unset ones", () => {
  assert.deepEqual(sidecarConfig({ eotMs: 700, vad: "energy", voice: undefined, speed: NaN, threads: 4 }), {
    eot_ms: 700,
    vad: "energy",
    threads: 4,
  });
  assert.deepEqual(sidecarConfig(), {});
});

test("local speech: a stream opened before ready waits, then gives Flux-shaped turn events", async () => {
  const { ls, logs, got } = start({ readyMs: 150 });
  try {
    assert.equal(ls.ready, false);
    assert.equal(ls.sampleRate, LOCAL_TTS_RATE);
    await assert.rejects(ls.synthesize("too early"), /not ready/);
    const events = [];
    const stt = ls.openStt({ onEvent: (e) => events.push(e) });
    assert.equal(stt.open, false);
    stt.send(loud); // kept until the sidecar is ready
    await waitFor(() => ls.ready);
    await waitFor(() => events.length === 1);
    assert.deepEqual(events[0], { event: "StartOfTurn", transcript: "" });
    assert.equal(stt.open, true);
    assert.ok(logs.some((l) => /Local speech ready .*VAD energy/.test(l)));
    assert.ok(logs.some((l) => /not JSON/.test(l)));

    const before = Date.now();
    stt.send(quiet);
    await waitFor(() => events.length === 2);
    const eot = events[1];
    assert.equal(eot.event, "EndOfTurn");
    assert.equal(eot.transcript, "heard 320 bytes");
    // The speech ended 650 ms (the silence) before the sidecar decided.
    assert.ok(eot.endOfSpeechAt <= before - 600 && eot.endOfSpeechAt >= before - 800, `${before - eot.endOfSpeechAt}`);
    assert.ok(eot.sttMs >= 650);
    assert.equal(eot.asrMs, 12);
    assert.ok(logs.some((l) => /Parakeet: 900 ms of audio in 12 ms/.test(l)));

    stt.setPlaying(true);
    stt.setPlaying(true); // no change, no message
    stt.setPlaying(false);
    stt.close();
    stt.send(loud); // after close: nothing
    await waitFor(() => got("close") === 1);
    assert.equal(logs.filter((l) => /got playing/.test(l)).join("|"), "🎙️  sidecar: got playing true|🎙️  sidecar: got playing false");
    assert.equal(got("audio"), 2);
  } finally {
    ls.stop();
  }
});

test("local speech: synthesize streams PCM chunks, an abort cancels, and an error throws", async () => {
  const { ls, logs, got } = start();
  try {
    await waitFor(() => ls.ready);
    const chunks = [];
    for await (const c of await ls.synthesize("Good evening.")) chunks.push(c);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, 480);
    assert.equal(chunks[1][0], 2);
    assert.ok(logs.some((l) => /Kokoro: 13 chars, 10 ms of audio in 5 ms \(RTF 0\.50/.test(l)));

    const ac = new AbortController();
    const it = await ls.synthesize("slow", ac.signal);
    setTimeout(() => ac.abort(), 50);
    const got2 = [];
    for await (const c of it) got2.push(c);
    assert.equal(got2.length, 0);
    await waitFor(() => got("cancel") === 1);

    // A signal that is already aborted asks for nothing.
    const n = got("tts");
    const done = new AbortController();
    done.abort();
    for await (const c of await ls.synthesize("never", done.signal)) assert.fail(`got ${c.length}`);
    await sleep(50);
    assert.equal(got("tts"), n);

    await assert.rejects(async () => {
      for await (const c of await ls.synthesize("fail")) void c;
    }, /Local text-to-speech failed: ValueError: bad text/);

    // A consumer that stops early cancels the rest.
    const it3 = await ls.synthesize("slow");
    for await (const c of it3) {
      void c;
      break;
    }
    await waitFor(() => got("cancel") === 2);
  } finally {
    ls.stop();
  }
});

test("local speech: a sidecar crash closes the streams, fails the speech, and starts it again", async () => {
  const { ls, logs } = start();
  try {
    await waitFor(() => ls.ready);
    const closes = [];
    ls.openStt({ onClose: (code, reason) => closes.push({ code, reason }) });
    const slow = await ls.synthesize("slow");
    const failed = (async () => {
      for await (const c of slow) void c;
    })();
    await ls.synthesize("crash").catch(() => {});
    await assert.rejects(failed, /sidecar stopped \(exit 3\)/);
    await waitFor(() => closes.length === 1);
    assert.equal(closes[0].code, 1011);
    assert.match(closes[0].reason, /exit 3/);
    assert.ok(logs.some((l) => /starting it again in 50 ms/.test(l)));
    // It comes back, and a new stream works.
    await waitFor(() => logs.filter((l) => /Local speech ready/.test(l)).length === 2);
    const events = [];
    const stt = ls.openStt({ onEvent: (e) => events.push(e) });
    stt.send(loud);
    await waitFor(() => events.length === 1);
  } finally {
    ls.stop();
  }
});

test("local speech: a missing interpreter is logged and retried, never thrown", async () => {
  const logs = [];
  const ls = startLocalSpeech({ python: "/nonexistent/python", args: [], log: (l) => logs.push(l), restartMs: 20, maxRestartMs: 40 });
  try {
    await waitFor(() => logs.filter((l) => /stopped .*ENOENT/.test(l)).length >= 2);
    assert.ok(logs.some((l) => /in 40 ms/.test(l)), logs.join("\n")); // the back-off doubles to the cap
    assert.equal(ls.ready, false);
    const closes = [];
    ls.openStt({ onClose: (c) => closes.push(c) });
    await waitFor(() => closes.length === 1); // a stream waits for one start only
  } finally {
    ls.stop();
  }
});

test("local speech: the Python turn logic tests pass (skipped without numpy)", (t) => {
  const py = pythonBin();
  if (spawnSync(py, ["-c", "import numpy"], { stdio: "ignore" }).status !== 0) return t.skip("no Python with numpy");
  const dir = fileURLToPath(new URL("../voice/", import.meta.url));
  const r = spawnSync(py, ["-B", "-m", "unittest", "-q", "test_local_speech"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
});
