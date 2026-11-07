#!/usr/bin/env node
// Create the Telnyx side of phone calls, once: an integration secret that holds
// VOICE_LLM_TOKEN, and an AI Assistant whose model is bot.js (external_llm).
// Telnyx sends the secret as a bearer token on each model request, and
// telnyx/voice.js checks it.
//
//   node scripts/telnyx-voice-setup.mjs https://<machine>.<tailnet>.ts.net \
//     [--secret <id>] [--voice <voice id>] [--dry-run]
//
// Reads TELNYX_API_KEY and VOICE_LLM_TOKEN from .env. --secret names the
// integration secret (lowercase). If it exists, the script keeps it, so its
// token must equal VOICE_LLM_TOKEN. --voice picks the text-to-speech voice.
// With --dry-run it prints the requests and sends nothing. It does not assign the phone number. Do that
// in the portal (AI Assistants > the assistant > Calling > Assign number).

import "dotenv/config";

const API = "https://api.telnyx.com/v2";
// Rupert: a warm, mature British male Telnyx Ultra voice. Change it with
// --voice. List the voices: GET /v2/text-to-speech/voices?provider=telnyx
const DEFAULT_VOICE = "Telnyx.Ultra.0ad65e7f-006c-47cf-bd31-52279d487913";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args.splice(i, 2)[1] : dflt;
};
const SECRET_ID = flag("--secret", "alfred-voice-llm");
const VOICE = flag("--voice", DEFAULT_VOICE);
const dryRun = args.includes("--dry-run");
const publicUrl = args.find((a) => !a.startsWith("--"))?.replace(/\/+$/, "");

if (!publicUrl || args.includes("--help") || args.includes("-h")) {
  console.log("usage: node scripts/telnyx-voice-setup.mjs https://<machine>.<tailnet>.ts.net [--secret <id>] [--voice <voice id>] [--dry-run]");
  process.exit(publicUrl ? 0 : 1);
}
const { TELNYX_API_KEY, VOICE_LLM_TOKEN } = process.env;
if (!dryRun && (!TELNYX_API_KEY || !VOICE_LLM_TOKEN)) {
  console.error("Set TELNYX_API_KEY and VOICE_LLM_TOKEN in .env first.");
  process.exit(1);
}

const secret = { identifier: SECRET_ID, type: "bearer", token: VOICE_LLM_TOKEN || "<VOICE_LLM_TOKEN>" };
const assistant = {
  name: "Alfred (phone)",
  // bot.js ignores these instructions. Alfred's own prompt applies. Telnyx
  // still needs a value.
  instructions: "You are Alfred, a personal assistant on a phone call.",
  greeting: "Hey, it's Alfred.",
  external_llm: {
    model: "alfred",
    base_url: `${publicUrl}/telnyx/voice/v1`,
    llm_api_key_ref: SECRET_ID,
    authentication_method: "token",
    forward_metadata: true,
  },
  voice_settings: {
    voice: VOICE,
    // No background sound. A background loop plays for the whole call, also
    // under quick replies. A slow turn gets a spoken filler from voice.js.
    background_audio: { type: "predefined_media", value: "silence" },
  },
  // Flux decides the end of a turn from the speech, not from a silence timer.
  transcription: { model: "deepgram/flux" },
  enabled_features: ["telephony"],
  // Telnyx turns recording on by default. The transcript goes to Discord.
  telephony_settings: { time_limit_secs: 1800, recording_settings: { enabled: false } },
};

async function call(method, path, body) {
  if (dryRun) {
    const shown = path.includes("integration_secrets") ? { ...body, token: "<hidden>" } : body;
    console.log(`${method} ${API}${path}\n${JSON.stringify(shown, null, 2)}\n`);
    return { data: {} };
  }
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json?.errors?.map((e) => e.detail || e.title).join("; ") || JSON.stringify(json);
    const err = new Error(`${method} ${path} → HTTP ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

try {
  await call("POST", "/integration_secrets", secret);
  console.log(`🔑 Integration secret "${SECRET_ID}" created.`);
} catch (err) {
  // A second run finds the secret. Keep it and go on.
  if (err.status !== 409 && err.status !== 422) throw err;
  console.log(`🔑 Integration secret "${SECRET_ID}" exists — kept. (${err.message})`);
}

const made = await call("POST", "/ai/assistants", assistant);
const id = made?.id || made?.data?.id;
console.log(`📞 Assistant created${id ? `: ${id}` : ""}.`);
console.log("Next: assign the phone number to it in the portal, then call it.");
if (dryRun) console.log("Dry run: nothing was sent.");
