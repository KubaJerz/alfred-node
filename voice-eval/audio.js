// Caller audio for test calls, and the call's recording.
//
// A scripted line is spoken by OpenAI's text-to-speech once, converted to the
// phone's 8 kHz mu-law, and cached on disk by its text and voice, so a rerun of
// the suite costs nothing for the caller side.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makePcmToMulaw, mulawToLinear, PHONE_RATE } from "../telnyx/audio.js";

export const TTS_MODEL = "gpt-4o-mini-tts";
const TTS_URL = "https://api.openai.com/v1/audio/speech";
const TTS_RATE = 24000; // OpenAI's "pcm" format: 24 kHz, 16-bit, mono

// How the scripted caller sounds: a person on a phone, a bit hurried.
const TTS_STYLE = "A man talking casually on the phone to his assistant, natural pace, not performing.";

export async function callerAudio(text, { apiKey, voice = "ash", cacheDir }) {
  const key = createHash("sha1").update(`${TTS_MODEL}|${voice}|${TTS_STYLE}|${text}`).digest("hex").slice(0, 16);
  const file = cacheDir && join(cacheDir, `${key}.ulaw`);
  if (file && existsSync(file)) return readFileSync(file);
  const res = await fetch(TTS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: TTS_MODEL, voice, input: text, instructions: TTS_STYLE, response_format: "pcm" }),
  });
  if (!res.ok) throw new Error(`text-to-speech failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const pcm = Buffer.from(await res.arrayBuffer());
  const ulaw = makePcmToMulaw({ inRate: TTS_RATE }).push(pcm);
  if (file) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(file, ulaw);
  }
  return ulaw;
}

// Two tracks on one clock (ms since the call started): the caller and Alfred.
// Written as a stereo WAV, caller left and Alfred right, to listen back to.
export function makeRecording() {
  const tracks = [[], []]; // per track: { at (ms), bytes (mu-law) }
  return {
    add(track, at, bytes) {
      tracks[track].push({ at, bytes });
    },
    wav() {
      const end = Math.max(0, ...tracks.flat().map((c) => c.at + (c.bytes.length * 1000) / PHONE_RATE));
      const n = Math.ceil((end * PHONE_RATE) / 1000) + 1;
      const out = Buffer.alloc(44 + n * 4);
      out.write("RIFF", 0);
      out.writeUInt32LE(36 + n * 4, 4);
      out.write("WAVEfmt ", 8);
      out.writeUInt32LE(16, 16);
      out.writeUInt16LE(1, 20); // PCM
      out.writeUInt16LE(2, 22); // stereo
      out.writeUInt32LE(PHONE_RATE, 24);
      out.writeUInt32LE(PHONE_RATE * 4, 28);
      out.writeUInt16LE(4, 32);
      out.writeUInt16LE(16, 34);
      out.write("data", 36);
      out.writeUInt32LE(n * 4, 40);
      tracks.forEach((chunks, ch) => {
        for (const { at, bytes } of chunks) {
          const start = Math.round((at * PHONE_RATE) / 1000);
          for (let i = 0; i < bytes.length && start + i < n; i++) {
            out.writeInt16LE(mulawToLinear(bytes[i]), 44 + (start + i) * 4 + ch * 2);
          }
        }
      });
      return out;
    },
  };
}
