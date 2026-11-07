import { test } from "node:test";
import assert from "node:assert/strict";
import {
  linearToMulaw,
  mulawToLinear,
  encodeMulaw,
  decodeMulaw,
  lowPassTaps,
  makeDecimator,
  parseWavHeader,
  makePcmToMulaw,
  frameMulaw,
  splitSentences,
  MULAW_SILENCE,
} from "../telnyx/audio.js";

// A sine wave as 16-bit samples.
const sine = (hz, rate, n, amp = 8000) =>
  Int16Array.from({ length: n }, (_, i) => Math.round(amp * Math.sin((2 * Math.PI * hz * i) / rate)));
const rms = (s) => Math.sqrt(s.reduce((a, x) => a + x * x, 0) / s.length);
const pcmLE = (samples) => {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
};
const wavHeader = (rate, dataBytes) => {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataBytes, 40);
  return h;
};

test("mu-law: known G.711 values", () => {
  assert.equal(linearToMulaw(0), 0xff);
  assert.equal(MULAW_SILENCE, 0xff);
  assert.equal(linearToMulaw(-1), 0x7f);
  assert.equal(linearToMulaw(32767), 0x80);
  assert.equal(linearToMulaw(-32768), 0x00);
  assert.equal(mulawToLinear(0xff), 0);
  assert.equal(mulawToLinear(0x80), 32124);
  assert.equal(mulawToLinear(0x00), -32124);
});

test("mu-law: a round trip keeps each sample within the step size", () => {
  for (let s = -32000; s <= 32000; s += 37) {
    const back = mulawToLinear(linearToMulaw(s));
    // The G.711 step grows with the level. Allow 1/16 of the level plus a floor.
    assert.ok(Math.abs(back - s) <= Math.abs(s) / 16 + 8, `${s} -> ${back}`);
  }
  // Every byte decodes and encodes back to itself (0x7f and 0xff both mean 0).
  for (let b = 0; b < 256; b++) {
    const again = linearToMulaw(mulawToLinear(b));
    assert.ok(again === b || (b === 0x7f && again === 0xff), `byte ${b} -> ${again}`);
  }
  const buf = encodeMulaw(Int16Array.from([0, 1000, -1000]));
  assert.equal(buf.length, 3);
  assert.equal(decodeMulaw(buf).length, 3);
});

test("lowPassTaps sum to 1 and are symmetric", () => {
  const t = lowPassTaps(3);
  assert.equal(t.length, 47);
  assert.ok(Math.abs(t.reduce((a, x) => a + x, 0) - 1) < 1e-9);
  for (let i = 0; i < t.length; i++) assert.ok(Math.abs(t[i] - t[t.length - 1 - i]) < 1e-12);
});

test("makeDecimator keeps speech, removes the band that would alias, and gives 1/3 of the samples", () => {
  const d = makeDecimator(24000, 8000);
  const voice = d.push(sine(500, 24000, 24000));
  assert.equal(voice.length, 8000);
  // After the filter delay, a 500 Hz tone keeps its level (8000 / sqrt 2).
  assert.ok(Math.abs(rms(voice.slice(100)) - 5657) < 150, `rms ${rms(voice.slice(100))}`);
  // 7 kHz would fold to 1 kHz at 8 kHz. The filter must remove it.
  const high = makeDecimator(24000, 8000).push(sine(7000, 24000, 24000));
  assert.ok(rms(high.slice(100)) < 150, `rms ${rms(high.slice(100))}`);
});

test("makeDecimator gives the same output for any chunk size", () => {
  const input = sine(440, 24000, 3001);
  const whole = makeDecimator(24000).push(input);
  const d = makeDecimator(24000);
  const parts = [];
  for (let i = 0; i < input.length; i += 77) parts.push(...d.push(input.slice(i, i + 77)));
  assert.deepEqual(Int16Array.from(parts), whole);
});

test("makeDecimator refuses a rate that is not a whole multiple, and passes 8 kHz through", () => {
  assert.throws(() => makeDecimator(22050, 8000), /whole multiple/);
  const same = makeDecimator(8000, 8000);
  assert.deepEqual(same.push(Int16Array.from([1, 2, 3])), Int16Array.from([1, 2, 3]));
});

test("parseWavHeader finds the data and the rate, and refuses other formats", () => {
  const h = wavHeader(16000, 100);
  assert.deepEqual(parseWavHeader(h), { dataOffset: 44, rate: 16000 });
  assert.equal(parseWavHeader(h.subarray(0, 30)), null);
  assert.throws(() => parseWavHeader(Buffer.from("ID3\x03xxxxxxxxxxxx")), /not a WAV/);
  const stereo = Buffer.from(h);
  stereo.writeUInt16LE(2, 22);
  assert.throws(() => parseWavHeader(stereo), /16-bit mono/);
});

test("makePcmToMulaw converts raw 24 kHz PCM in odd-sized chunks", () => {
  const pcm = pcmLE(sine(400, 24000, 2400));
  const c = makePcmToMulaw({ inRate: 24000 });
  const out = [];
  for (let i = 0; i < pcm.length; i += 333) out.push(c.push(pcm.subarray(i, i + 333)));
  const mulaw = Buffer.concat(out);
  assert.equal(mulaw.length, 800);
  assert.equal(c.rate, 24000);
  const back = decodeMulaw(mulaw);
  assert.ok(rms(back.slice(50)) > 5000);
});

test("makePcmToMulaw reads a WAV header and uses its rate", () => {
  const samples = sine(400, 16000, 1600);
  const wav = Buffer.concat([wavHeader(16000, samples.length * 2), pcmLE(samples)]);
  const c = makePcmToMulaw({ inRate: 24000 });
  const a = c.push(wav.subarray(0, 10)); // not enough for the header yet
  const b = c.push(wav.subarray(10));
  assert.equal(a.length, 0);
  assert.equal(c.rate, 16000);
  assert.equal(b.length, 800);
});

test("frameMulaw pads the last frame with silence", () => {
  const frames = frameMulaw(Buffer.alloc(400, 1), 160);
  assert.equal(frames.length, 3);
  assert.equal(frames[2][79], 1);
  assert.equal(frames[2][80], MULAW_SILENCE);
});

test("splitSentences splits, merges short pieces, and cuts long ones", () => {
  assert.deepEqual(splitSentences("Hi. Your day is clear. Want me to book it?"), ["Hi. Your day is clear.", "Want me to book it?"]);
  assert.deepEqual(splitSentences(""), []);
  const long = `${"word ".repeat(100)}end.`;
  const parts = splitSentences(long, { maxChars: 100 });
  assert.ok(parts.length >= 5);
  assert.ok(parts.every((p) => p.length <= 100));
  assert.equal(parts.join(" "), long.trim());
});
