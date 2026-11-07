// A fake local speech sidecar for test/voice-local-speech.test.js. It speaks
// the same JSON-lines protocol as voice/local_speech.py, with no models.
//
//   - "ready" after FAKE_READY_MS (default 0).
//   - Caller audio: a frame of loud mu-law (bytes 0x00) is speech. The first
//     one gives "speech_start". A silent frame (0xff) after speech gives "eot"
//     and then "turn" with text "heard <n> bytes".
//   - tts: two PCM chunks and "tts_done". Text "fail" gives "tts_error".
//     Text "slow" waits 300 ms between chunks. Text "crash" stops the process.
//   - Each request op goes to stderr as "got <op>", so the test can read it.
import readline from "node:readline";

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const calls = new Map();
const cancelled = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

setTimeout(() => {
  // A line that is not JSON: the client must log it and go on.
  process.stdout.write("this is not json\n");
  out({ ev: "ready", pid: process.pid, vad: "energy", voice: "bm_george", rate: 24000, load_ms: 1, rss_mb: 1 });
}, Number(process.env.FAKE_READY_MS || 0));

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  process.stderr.write(`got ${m.op}${m.op === "playing" ? ` ${m.on}` : ""}\n`);
  if (m.op === "open") calls.set(m.call, { speaking: false, bytes: 0 });
  if (m.op === "close") calls.delete(m.call);
  if (m.op === "audio") {
    const c = calls.get(m.call);
    if (!c) return;
    const b = Buffer.from(m.mulaw, "base64");
    c.bytes += b.length;
    if (b[0] === 0x00 && !c.speaking) {
      c.speaking = true;
      out({ ev: "speech_start", call: m.call });
    } else if (b[0] === 0xff && c.speaking) {
      c.speaking = false;
      out({ ev: "eot", call: m.call, silence_ms: 650, speech_ms: 400, forced: false });
      out({ ev: "turn", call: m.call, text: ` heard ${c.bytes} bytes `, asr_ms: 12, audio_ms: 900 });
    }
  }
  if (m.op === "cancel") cancelled.add(m.id);
  if (m.op === "tts") {
    if (m.text === "crash") process.exit(3);
    if (m.text === "fail") return out({ ev: "tts_error", id: m.id, error: "ValueError: bad text" });
    for (let i = 0; i < 2; i++) {
      if (m.text === "slow") await sleep(300);
      if (cancelled.has(m.id)) return;
      out({ ev: "tts_chunk", id: m.id, pcm: Buffer.alloc(480, i + 1).toString("base64") });
    }
    out({ ev: "tts_done", id: m.id, synth_ms: 5, audio_ms: 10, chars: m.text.length });
  }
});
