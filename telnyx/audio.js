// Audio helpers for the v2 call pipeline (telnyx/pipeline.js). All of them are
// pure functions or small state machines with no I/O, so tests can feed them
// bytes and read bytes back.
//
// The phone side speaks G.711 mu-law at 8 kHz (PCMU). Caller audio arrives in
// that format and goes to speech-to-text as it is. Text-to-speech gives 16-bit
// little-endian PCM at a higher rate (24 kHz by default). We low-pass filter
// it, take every Nth sample, and encode each sample as one mu-law byte.

export const PHONE_RATE = 8000;
export const MULAW_SILENCE = 0xff; // the mu-law byte for a zero sample
const BIAS = 0x84;
const CLIP = 32635;

// One 16-bit sample to one mu-law byte (ITU-T G.711).
export function linearToMulaw(sample) {
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// One mu-law byte to one 16-bit sample.
export function mulawToLinear(byte) {
  const u = ~byte & 0xff;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const s = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return u & 0x80 ? -s : s;
}

export function encodeMulaw(samples) {
  const out = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = linearToMulaw(samples[i]);
  return out;
}

export function decodeMulaw(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = mulawToLinear(buf[i]);
  return out;
}

// Low-pass FIR taps for a decimation by `factor`: a windowed sinc with a
// Hamming window. The cut-off is 90% of the new Nyquist frequency, so speech
// up to about 3.6 kHz stays and the band that would alias goes. The taps sum
// to 1, so the gain at 0 Hz is 1.
export function lowPassTaps(factor, count = 47) {
  const fc = 0.9 / (2 * factor); // cycles per input sample
  const mid = (count - 1) / 2;
  const taps = new Float64Array(count);
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (count - 1));
    taps[i] = sinc * w;
    sum += taps[i];
  }
  for (let i = 0; i < count; i++) taps[i] /= sum;
  return taps;
}

// A stream resampler from inRate down to outRate. inRate must be a whole
// multiple of outRate (24000, 16000 and 48000 all are for 8000). push() takes
// an Int16Array and returns the Int16Array of new output samples. The filter
// keeps its history across calls, so chunk edges make no clicks.
export function makeDecimator(inRate, outRate = PHONE_RATE) {
  const factor = inRate / outRate;
  if (!Number.isInteger(factor) || factor < 1) {
    throw new Error(`Cannot resample ${inRate} Hz to ${outRate} Hz: the rate must be a whole multiple`);
  }
  if (factor === 1) return { factor, push: (s) => Int16Array.from(s) };
  const taps = lowPassTaps(factor);
  const keep = taps.length - 1;
  let hist = new Float64Array(keep);
  let next = keep; // index in (hist + new samples) of the next output sample
  return {
    factor,
    push(samples) {
      const buf = new Float64Array(keep + samples.length);
      buf.set(hist);
      buf.set(samples, keep);
      const out = [];
      let i = next;
      for (; i < buf.length; i += factor) {
        let acc = 0;
        for (let k = 0; k < taps.length; k++) acc += taps[k] * buf[i - k];
        out.push(Math.max(-32768, Math.min(32767, Math.round(acc))));
      }
      hist = buf.slice(buf.length - keep);
      next = i - (buf.length - keep);
      return Int16Array.from(out);
    },
  };
}

// The PCM data offset and the sample rate in a WAV header, or null when the
// buffer holds no complete header yet. Throws when the bytes are not a WAV
// file or are not 16-bit mono PCM.
export function parseWavHeader(buf) {
  if (buf.length < 12) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV file");
  }
  let off = 12;
  let rate = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      if (off + 8 + 16 > buf.length) return null;
      const format = buf.readUInt16LE(off + 8);
      const channels = buf.readUInt16LE(off + 10);
      rate = buf.readUInt32LE(off + 12);
      const bits = buf.readUInt16LE(off + 22);
      if (format !== 1 || channels !== 1 || bits !== 16) {
        throw new Error(`WAV is not 16-bit mono PCM (format ${format}, ${channels} channels, ${bits} bits)`);
      }
    }
    if (id === "data") return { dataOffset: off + 8, rate };
    off += 8 + size + (size % 2);
  }
  return null;
}

// A stream converter from text-to-speech output to phone audio. Input: raw
// 16-bit little-endian PCM at inRate, or the same with a WAV header in front
// (then the header's rate wins). Output: mu-law bytes at 8 kHz. push() takes a
// Buffer of any size, also an odd size, and returns a Buffer.
export function makePcmToMulaw({ inRate, outRate = PHONE_RATE } = {}) {
  let head = Buffer.alloc(0); // bytes kept until we know if a WAV header is there
  let decided = false;
  let carry = null; // one odd byte between chunks
  let dec = null;

  const convert = (bytes) => {
    if (!bytes.length) return Buffer.alloc(0);
    if (carry) {
      bytes = Buffer.concat([carry, bytes]);
      carry = null;
    }
    if (bytes.length % 2) {
      carry = bytes.subarray(bytes.length - 1);
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    const n = bytes.length / 2;
    const samples = new Int16Array(n);
    for (let i = 0; i < n; i++) samples[i] = bytes.readInt16LE(i * 2);
    return encodeMulaw(dec.push(samples));
  };

  return {
    push(chunk) {
      if (decided) return convert(chunk);
      head = Buffer.concat([head, chunk]);
      if (head.length < 4) return Buffer.alloc(0);
      let rate = inRate;
      let start = 0;
      if (head.toString("ascii", 0, 4) === "RIFF") {
        const wav = parseWavHeader(head);
        if (!wav) return Buffer.alloc(0);
        start = wav.dataOffset;
        rate = wav.rate || inRate;
      }
      decided = true;
      dec = makeDecimator(rate, outRate);
      const rest = head.subarray(start);
      head = null;
      return convert(rest);
    },
    get rate() {
      return dec ? dec.factor * outRate : null;
    },
  };
}

// Split mu-law bytes into frames of frameBytes. The last frame is padded with
// silence. At 8 kHz, 160 bytes are 20 ms, the shortest frame Telnyx accepts.
export function frameMulaw(buf, frameBytes = 160) {
  const out = [];
  for (let i = 0; i < buf.length; i += frameBytes) {
    const f = Buffer.alloc(frameBytes, MULAW_SILENCE);
    buf.copy(f, 0, i, Math.min(buf.length, i + frameBytes));
    out.push(f);
  }
  return out;
}

// Split a reply into sentences for one text-to-speech request each. The first
// sentence is short, so the caller hears audio sooner. A very short piece goes
// with the next one. A very long sentence is cut at a comma or a space.
export function splitSentences(text, { maxChars = 300, minChars = 12 } = {}) {
  const parts = String(text || "")
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const merged = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.length < minChars) merged[merged.length - 1] = `${last} ${p}`;
    else merged.push(p);
  }
  const out = [];
  for (let s of merged) {
    while (s.length > maxChars) {
      let cut = s.lastIndexOf(", ", maxChars);
      if (cut < maxChars / 3) cut = s.lastIndexOf(" ", maxChars);
      if (cut < maxChars / 3) cut = maxChars;
      out.push(s.slice(0, cut + (s[cut] === "," ? 1 : 0)).trim());
      s = s.slice(cut + 1).trim();
    }
    if (s) out.push(s);
  }
  return out;
}
