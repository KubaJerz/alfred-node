#!/usr/bin/env node
// Create the Telnyx side of the v2 call pipeline, once: a Call Control
// application whose webhook is the signed events route of bot.js
// (telnyx/pipeline.js). It is separate from the v1 AI Assistant.
//
//   node scripts/telnyx-voice-pipeline-setup.mjs https://<machine>.<tailnet>.ts.net \
//     [--name <application name>] [--dry-run]
//
// Reads TELNYX_API_KEY from .env. With --dry-run it prints the request and
// sends nothing. It does NOT move the phone number. The number stays on v1
// until you move it by hand. The script prints the steps for both directions.

import "dotenv/config";
import { callControlAppBody } from "../telnyx/pipeline.js";

const API = "https://api.telnyx.com/v2";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args.splice(i, 2)[1] : dflt;
};
const NAME = flag("--name", "Alfred (phone pipeline)");
const dryRun = args.includes("--dry-run");
const publicUrl = args.find((a) => !a.startsWith("--"))?.replace(/\/+$/, "");

if (!publicUrl || args.includes("--help") || args.includes("-h")) {
  console.log("usage: node scripts/telnyx-voice-pipeline-setup.mjs https://<machine>.<tailnet>.ts.net [--name <name>] [--dry-run]");
  process.exit(publicUrl ? 0 : 1);
}
if (!/^https:\/\//.test(publicUrl)) {
  console.error("The public URL must start with https:// (Telnyx opens the media socket as wss://).");
  process.exit(1);
}
const { TELNYX_API_KEY } = process.env;
if (!dryRun && !TELNYX_API_KEY) {
  console.error("Set TELNYX_API_KEY in .env first.");
  process.exit(1);
}

const body = callControlAppBody(publicUrl, { name: NAME });
let id = "<application id>";
if (dryRun) {
  console.log(`POST ${API}/call_control_applications\n${JSON.stringify(body, null, 2)}\n`);
} else {
  const res = await fetch(`${API}/call_control_applications`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json?.errors?.map((e) => e.detail || e.title).join("; ") || JSON.stringify(json);
    console.error(`POST /call_control_applications → HTTP ${res.status}: ${detail}`);
    process.exit(1);
  }
  id = json?.data?.id || id;
  console.log(`📞 Call Control application "${NAME}" created: ${id}`);
}

console.log(`
The phone number did not move. Calls still go to v1 (the AI Assistant).

Before you switch to v2:
  1. In .env, set VOICE_PIPELINE_TOKEN (openssl rand -hex 32) and
     VOICE_PUBLIC_URL=${publicUrl}
  2. Restart the bot. The log must show "Call pipeline v2 is on".

Switch the number to v2 (portal, by hand):
  Numbers > My Numbers > the number > Voice settings >
  Connection or App = "${NAME}" (${id}). Save.

Switch the number back to v1 (portal, by hand):
  AI Assistants > "Alfred (phone)" > Calling > assign the number again.
  Or: Numbers > the number > Voice settings > Connection or App = the
  assistant's TeXML application. Save.

Each switch takes effect on the next call. The bot can run both paths at once.`);
if (dryRun) console.log("\nDry run: nothing was sent.");
