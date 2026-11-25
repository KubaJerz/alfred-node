import "dotenv/config";
import { Client, GatewayIntentBits, Partials, AttachmentBuilder, MessageFlags } from "discord.js";
import { spawn } from "child_process";
import { readFile, writeFile, mkdir, appendFile } from "fs/promises";
import { existsSync, openSync, readFileSync, statSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { startBroker, GOOGLE_ROUTES } from "./google/broker.js";
import { NOTION_ROUTES } from "./notion/broker.js";
import { fetchBlockChildren } from "./notion/client.js";
import { makeVoiceTools } from "./telnyx/voice-tools.js";
import { INTERVALS_ROUTES } from "./intervals/broker.js";
import { openDb as openStrengthDb, insertNote } from "./strength/db.js";
import { startMailListener, enrich } from "./google/gmail-push.js";
import { gmailClient, PUBSUB_KEY_FILE } from "./google/auth.js";
import { RONNIE_ROUTES } from "./ronnie/broker-routes.js";
import { makeRonnie } from "./ronnie/runner.js";
import { resolveRonnieLabels } from "./ronnie/labels.js";
import { ensureLabels } from "./google/gmail-labels.js";
import { dailyDir, dailyNotePath, attachmentName, buildAttachmentBlock } from "./dailies.js";
import { makeLedger, inboundRow, callRow, toolRow } from "./ledger.js";
import { makeCatchUp, sessionContext, liveFeed, callBriefing } from "./context.js";
import { ensureWatermark } from "./fold.js";
import { parseClearCommand } from "./commands.js";
import { transcribe, transcriptionAvailable } from "./voice/transcribe.js";
import { isVoiceInput } from "./voice/detect.js";
import { browserEnv } from "./browser.js";
import { startTelnyxWebhook, makeMessagingRoute, sendSms, smsText, parseNumberList, normalizeNumber, makeSmsAck, SMS_ACK_TEXT } from "./telnyx/sms.js";
import { downloadMedia, pickMmsFiles, makeMediaHost, MEDIA_ROUTE } from "./telnyx/mms.js";
import { makeVoiceLlmRoutes } from "./telnyx/voice.js";
import { makeVoicePipeline, EVENTS_PATH as VOICE_EVENTS_PATH } from "./telnyx/pipeline.js";
import { startLocalSpeech, sidecarConfig } from "./voice/local-speech.js";
import { makeStreamParser } from "./claude-stream.js";

// ── Config ──────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "").split(",").filter(Boolean);
const TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || "120000"); // 2 min default
// A Discord channel whose messages are workout notes, not turns. Off unless set.
const STRENGTH_LOG_CHANNEL = process.env.STRENGTH_LOG_CHANNEL || "";

// Deferred strength pull. Interpreting a just-finished workout is a ~2-min model
// job — too slow to block a turn on. Alfred ends a reply with this sentinel to
// send an immediate ack; bot.js then runs the digest out-of-band (it holds the
// broker, so the detached-process credential loss doesn't apply) and, when the
// data lands, enqueues a follow-up turn so Alfred reports back on his own.
const BG_STRENGTH_RE = /\{bg:strength\}/i;
const BG_DIGEST_TIMEOUT_MS = parseInt(process.env.BG_DIGEST_TIMEOUT_MS || "600000"); // 10 min

// SMS over Telnyx (telnyx/sms.js). Off unless all four of the first group are
// set. SMS_MIRROR_CHANNEL is optional: with it, each text and each reply also
// shows in that Discord channel. See env.example for the setup steps.
const TELNYX_API_KEY = process.env.TELNYX_API_KEY || "";
const TELNYX_PUBLIC_KEY = process.env.TELNYX_PUBLIC_KEY || "";
const TELNYX_PHONE_NUMBER = process.env.TELNYX_PHONE_NUMBER || "";
const SMS_ALLOWED_NUMBERS = parseNumberList(process.env.SMS_ALLOWED_NUMBERS);
const TELNYX_MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID || "";
const SMS_MIRROR_CHANNEL = process.env.SMS_MIRROR_CHANNEL || "";
const SMS_WEBHOOK_PORT = parseInt(process.env.SMS_WEBHOOK_PORT || "8788");
const smsConfigured = !!(TELNYX_API_KEY && TELNYX_PUBLIC_KEY && TELNYX_PHONE_NUMBER && SMS_ALLOWED_NUMBERS.length);
// Files in a reply go out as MMS. Telnyx fetches each one from this public URL
// (the tunnel in front of the webhook server; see telnyx/mms.js). Unset, reply
// files stay Discord-only, as before. It defaults to VOICE_PUBLIC_URL, the same
// tunnel.
const SMS_PUBLIC_URL = process.env.SMS_PUBLIC_URL || process.env.VOICE_PUBLIC_URL || "";
const mediaHost = smsConfigured && SMS_PUBLIC_URL ? makeMediaHost({ publicUrl: SMS_PUBLIC_URL }) : null;
// Alfred reads this tag at the top of an SMS turn (see agent/SOUL.md).
const SMS_TAG = "[via SMS]";
// A turn from a text that runs this long with no reply sends one "👀 On it…"
// text, since SMS has no typing indicator. 0 turns it off.
const SMS_ACK_MS = parseInt(process.env.SMS_ACK_MS || "10000");

// Phone calls over a Telnyx AI Assistant (telnyx/voice.js). Telnyx does the
// audio. bot.js is the assistant's model: each caller turn is an Alfred turn.
// Off unless VOICE_LLM_TOKEN is set. The allow list falls back to the SMS one,
// and the mirror channel falls back to the SMS mirror.
const VOICE_LLM_TOKEN = process.env.VOICE_LLM_TOKEN || "";
const VOICE_ALLOWED_NUMBERS = parseNumberList(process.env.VOICE_ALLOWED_NUMBERS || process.env.SMS_ALLOWED_NUMBERS);
const VOICE_MIRROR_CHANNEL = process.env.VOICE_MIRROR_CHANNEL || SMS_MIRROR_CHANNEL;
const voiceConfigured = !!(VOICE_LLM_TOKEN && VOICE_ALLOWED_NUMBERS.length);
// When a slow call turn speaks its first filler line, and how often it repeats.
// Unset keeps the defaults in telnyx/voice.js (1 s, then every 5 s).
const VOICE_FILLER_MS = process.env.VOICE_FILLER_MS ? parseInt(process.env.VOICE_FILLER_MS) : undefined;
const VOICE_FILLER_REPEAT_MS = process.env.VOICE_FILLER_REPEAT_MS ? parseInt(process.env.VOICE_FILLER_REPEAT_MS) : undefined;
// Phone calls over our own pipeline (telnyx/pipeline.js), the opt-in "v2".
// Telnyx Call Control streams the call audio to us, and we run Telnyx
// speech-to-text and text-to-speech. Each caller turn is the same onCallTurn
// as v1. Off unless VOICE_PIPELINE_TOKEN and VOICE_PUBLIC_URL are set. It also
// needs the API key, the public key, and an allow list. Which path answers a
// call is the phone number's setting in the Telnyx portal, not this flag.
const VOICE_PIPELINE_TOKEN = process.env.VOICE_PIPELINE_TOKEN || "";
const VOICE_PUBLIC_URL = process.env.VOICE_PUBLIC_URL || "";
const VOICE_PIPELINE_VOICE = process.env.VOICE_PIPELINE_VOICE || undefined;
const VOICE_PIPELINE_TTS_RATE = parseInt(process.env.VOICE_PIPELINE_TTS_RATE || "0") || undefined;
const VOICE_PIPELINE_SIGNED_MEDIA = process.env.VOICE_PIPELINE_SIGNED_MEDIA !== "0";
const voicePipelineConfigured = !!(VOICE_PIPELINE_TOKEN && VOICE_PUBLIC_URL && TELNYX_API_KEY && TELNYX_PUBLIC_KEY && VOICE_ALLOWED_NUMBERS.length);
// The speech engine of the pipeline. "local" (v3, the default) runs the voice
// activity detector, Parakeet and Kokoro in a sidecar on this machine
// (voice/local_speech.py). "telnyx" (v2) uses the Telnyx STT and TTS.
const VOICE_PIPELINE_ENGINE = (process.env.VOICE_PIPELINE_ENGINE || "local").trim().toLowerCase();
// Engine "openai" (option 2B): OpenAI Realtime talks to the caller and calls
// Alfred as a tool (telnyx/realtime.js). Its prompt is agent/phone-voice.md.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const VOICE_OPENAI = {
  model: process.env.VOICE_OPENAI_MODEL || undefined,
  voice: process.env.VOICE_OPENAI_VOICE || undefined,
  eagerness: process.env.VOICE_OPENAI_EAGERNESS || undefined,
  reasoning: process.env.VOICE_OPENAI_REASONING || undefined,
  silenceMs: Number(process.env.VOICE_OPENAI_SILENCE_MS) || undefined,
  noise: process.env.VOICE_OPENAI_NOISE || undefined,
  // "0": the reply after a quick tool is audio, not silent text (to compare).
  quietChains: process.env.VOICE_OPENAI_SILENT_CHAINS !== "0",
  // The voice's own notion, calendar and get_time tools. "0" sends everything
  // through Alfred (use_tools) again. Made once per call, for that call.
  directTools: process.env.VOICE_OPENAI_DIRECT_TOOLS === "0" ? null : ({ caller, callId } = {}) =>
    makeVoiceTools({
      notionRoutes: NOTION_ROUTES,
      calendarRoutes: GOOGLE_ROUTES,
      fetchBlockChildren,
      note: (text) => notePhoneAction(text, { caller, callId }),
      // Where "make a new page" puts it when no page is named (a shared page).
      homePage: process.env.VOICE_NOTION_HOME || undefined,
    }),
  // "0" turns off the caller transcript (it costs a little): in the log, and
  // the caller's lines in messages.jsonl, so the call keeps only the voice's.
  ...(process.env.VOICE_OPENAI_TRANSCRIBE === "0" ? { transcribeModel: "" } : {}),
  // A message sent by text or SMS while a call is live, and Alfred's reply to
  // it, go into the call as they are written, with no reply asked (liveFeed in
  // context.js). "0" keeps the call to what is said on it.
  feed: process.env.VOICE_OPENAI_LIVE === "0" ? null : ({ push }) => liveFeed({ ledger, push }),
  // Each call's prompt is phone-voice.md plus a briefing of what the voice
  // should know already: USER.md, MEMORY.md, yesterday's and today's daily
  // notes, and the last 6 hours of messages on every channel (callBriefing in
  // context.js). It is built while the OpenAI socket opens. "0" starts every
  // call with the prompt alone, as before.
  buildInstructions: process.env.VOICE_OPENAI_BRIEFING === "0" ? null : ({ callId, prompt }) =>
    callBriefing({ stateDir: STATE_DIR, ledger, prompt, callId }),
};
// The pipeline speaks Alfred's reply sentence by sentence while he writes it.
// "0" makes it wait for the whole reply, as before.
const VOICE_STREAM_REPLY = process.env.VOICE_STREAM_REPLY !== "0";
const envInt = (name) => (process.env[name] ? parseInt(process.env[name]) : undefined);
const VOICE_LOCAL_CONFIG = sidecarConfig({
  eotMs: envInt("VOICE_LOCAL_EOT_MS"),
  minSpeechMs: envInt("VOICE_LOCAL_MIN_SPEECH_MS"),
  echoGuardMs: envInt("VOICE_LOCAL_ECHO_GUARD_MS"),
  vad: process.env.VOICE_LOCAL_VAD || undefined,
  voice: process.env.VOICE_LOCAL_VOICE || undefined,
  lang: process.env.VOICE_LOCAL_LANG || undefined,
  speed: process.env.VOICE_LOCAL_SPEED ? parseFloat(process.env.VOICE_LOCAL_SPEED) : undefined,
  threads: envInt("VOICE_LOCAL_THREADS"),
});
// Alfred reads this tag at the top of a phone-call turn (see agent/SOUL.md).
const CALL_TAG = "[via phone call]";
const VIA_TAGS = { sms: SMS_TAG, call: CALL_TAG };

// ── Layout ──────────────────────────────────────────────────────────────────
// Three kinds of files live here and they don't mix:
//
//   REPO_DIR   the app and its dev process (bot.js, CLAUDE.md, CONTRIBUTING).
//              Alfred never reads these.
//   AGENT_DIR  Alfred's config — SOUL.md, memory-prompt.md, and its own
//              CLAUDE.md. Tracked in git, and the cwd we spawn `claude` in,
//              so Claude Code auto-loads agent/CLAUDE.md rather than the
//              repo's dev-facing one.
//   STATE_DIR  Alfred's memory and transcripts. Personal, machine-local,
//              gitignored wholesale.
//
// Resolved from this file rather than cwd so launching from cron, tmux, or any
// other directory behaves identically.
const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = process.env.AGENT_DIR || path.join(REPO_DIR, "agent");
const STATE_DIR = process.env.STATE_DIR || path.join(AGENT_DIR, "var");

// Sentinel Alfred emits (and nothing else) when it judges a message isn't
// directed at it. The bot detects it and stays silent instead of replying.
const NO_REPLY = "<no_reply>";

// Alfred can attach files by writing {img:path}, {pdf:path}, or {file:path}
// inline in its reply. All three behave the same — Discord auto-detects type;
// the prefix is just an author hint. Any readable path works (absolute, or
// relative to AGENT_DIR), matching the fact that the agent works across all dirs.
const ATTACH_RE = /\{(?:img|pdf|file):\s*([^}]+?)\s*\}/gi;
const MAX_FILES_PER_MSG = 10; // Discord's hard cap per message
const MAX_ATTACHMENTS = parseInt(process.env.MAX_ATTACHMENTS || "30"); // total per reply
const MAX_FILE_BYTES = parseInt(process.env.MAX_FILE_BYTES || String(8 * 1024 * 1024)); // 8 MB

if (!DISCORD_TOKEN) {
  console.error("❌ Set DISCORD_TOKEN env var");
  process.exit(1);
}

// ── State management ────────────────────────────────────────────────────────
const STATE_FILE = path.join(STATE_DIR, "state.json");

// Written by dream.sh after each nightly pass — an ISO timestamp, nothing else.
// It exists so the dream pass never has to touch state.json.
const LAST_DREAM_FILE = path.join(STATE_DIR, "last-dream");

// Append-only JSONL transcript of every turn through the bot — one JSON object
// per line, both inbound (user → bot) and outbound (bot → user). This is the
// bot's OWN log, separate from Claude Code's per-session .jsonl files.
// ledger.js owns the file: it writes the rows, archives them, and reads them.
// It also tells a live 2B call each new row as it is written (VOICE_OPENAI.feed).
const CHAT_LOG = path.join(STATE_DIR, "messages.jsonl");

// On /clear, the live transcript is archived under LOGS_DIR, and FOLD_SCRIPT
// folds the rows not folded yet into the daily note of each one's own day
// (fold.js, with the prompt in agent/memory-prompt.md). The nightly dream.sh
// runs the same fold for yesterday first, then promotes durable facts from the
// dailies into MEMORY.md.
const LOGS_DIR = path.join(STATE_DIR, "logs");
const MEMORIES_DIR = path.join(STATE_DIR, "memories");
const FOLD_SCRIPT = path.join(REPO_DIR, "scripts", "fold-day.mjs");
const ledger = makeLedger({ file: CHAT_LOG, logsDir: LOGS_DIR });
// What the phone wrote to the ledger since Alfred's last turn (context.js).
// Its cursor is a file in STATE_DIR, so a restart loses nothing.
const catchUp = makeCatchUp({ ledger, stateDir: STATE_DIR });

// Paths handed to a spawned `claude` must be relative to AGENT_DIR, since that
// is its cwd — absolute paths would leak this machine's layout into prompts.
const agentRel = (abs) => path.relative(AGENT_DIR, abs);

// For log output only: short path when it's inside the repo, absolute when a
// custom AGENT_DIR/STATE_DIR puts it elsewhere (beats printing ../../../..).
const prettyPath = (abs) => {
  const rel = path.relative(REPO_DIR, abs);
  return rel.startsWith("..") ? abs : rel;
};

// Build Alfred's state tree on first run so a fresh clone needs no manual
// setup: `npm install && npm start` is enough. Everything created here is
// gitignored; USER.md is seeded from the tracked USER.md.example template.
async function bootstrap() {
  // A stale AGENT_DIR (e.g. an old .env pointing at the repo root) leaves the
  // bot running but loading no context — it answers with no persona and no
  // memory, which is easy to miss. Fail loudly instead of degrading silently.
  const soul = path.join(AGENT_DIR, "SOUL.md");
  if (!existsSync(soul)) {
    console.error(`❌ No SOUL.md at ${soul}`);
    console.error(`   AGENT_DIR is "${AGENT_DIR}" — is it stale in .env? Unset it to use the default.`);
    process.exit(1);
  }

  await mkdir(path.join(MEMORIES_DIR, "dailies"), { recursive: true });
  await mkdir(LOGS_DIR, { recursive: true });

  const seeds = [
    { file: path.join(STATE_DIR, "USER.md"), from: path.join(AGENT_DIR, "USER.md.example") },
    {
      file: path.join(MEMORIES_DIR, "MEMORY.md"),
      content:
        "# Long-Term Memory\n\n" +
        "_Curated facts promoted from daily notes during nightly dreaming passes._\n" +
        "_Injected into every new session — keep it short and high-signal._\n\n---\n\n" +
        "(Nothing here yet.)\n",
    },
    { file: path.join(MEMORIES_DIR, "changelog.json"), content: "[]\n" },
  ];

  for (const seed of seeds) {
    if (existsSync(seed.file)) continue;
    let content = seed.content;
    if (seed.from) {
      try {
        content = await readFile(seed.from, "utf-8");
      } catch {
        continue; // no template to seed from — skip rather than write junk
      }
    }
    await writeFile(seed.file, content);
    console.log(`🌱 Created ${prettyPath(seed.file)}`);
  }
}

// One row in messages.jsonl. ledger.js stamps the time, and logs a failed
// write instead of throwing it. Resolves to the row as written, or null.
async function logTurn(entry) {
  return ledger.append(entry);
}

// After a /clear archive: fold the rows of the archive that no nightly pass
// folded yet, each into the daily note of its own day. FOLD_SCRIPT (fold.js)
// runs one headless Claude per day with agent/memory-prompt.md, and records
// how far it got only after a run worked. Detached + unref'd so it never
// blocks the bot or dies when the bot restarts. Its output goes to
// logs/consolidate.log, as the old one-shot pass did.
async function consolidateMemory(archivePath) {
  try {
    await mkdir(LOGS_DIR, { recursive: true });
    const logFd = openSync(path.join(LOGS_DIR, "consolidate.log"), "a");
    // process.execPath is this bot's own node, so nvm/tmux PATHs don't matter.
    const proc = spawn(process.execPath, [FOLD_SCRIPT, "--archive", archivePath], {
      cwd: AGENT_DIR,
      env: { ...process.env, AGENT_DIR, STATE_DIR },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    proc.unref();
    console.log(`🧠 Spawned the daily-note fold (pid ${proc.pid}) → ${archivePath}`);
  } catch (err) {
    console.error(`🧠 Failed to spawn the daily-note fold: ${err.message}`);
  }
}

// state.json has exactly one writer: this process. The nightly dream pass used
// to overwrite it directly, which silently reset a conversation if it landed
// mid-session. It now only stamps LAST_DREAM_FILE, and the bot decides what
// that means for session continuity (see shouldStartFresh).
async function readState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf-8"));
  } catch {
    return { status: "resolved", last_session_id: null, topic: null, timestamp: null };
  }
}

async function writeState(state) {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// A dreaming pass rewrites long-term memory, so any session started before it
// is holding a stale copy — the next message should start fresh to pick the new
// memory up. Resuming across a dream is the one case worth forcing a reset.
async function dreamedSince(state) {
  if (!state.timestamp) return false;
  try {
    const dreamedAt = (await readFile(LAST_DREAM_FILE, "utf-8")).trim();
    return Date.parse(dreamedAt) > Date.parse(state.timestamp);
  } catch {
    return false; // no dream has run yet
  }
}

// ── Claude Code invocation ──────────────────────────────────────────────────
// A lapsed login doesn't look like an error from out here: `claude -p` prints a
// short human message and Alfred happily forwards it as a reply. Match the
// shapes it uses so the bot can name the real problem instead. Deliberately
// narrow — a false positive would mask a genuine reply about logging in.
const AUTH_FAILURE_PATTERNS = [
  /not logged in/i,
  /please run\s+\/login/i,
  /run `?\/login/i,
  /invalid api key/i,
  /authentication_error/i,
  /oauth token (has )?expired/i,
];

function isAuthFailure(stdout, stderr) {
  // Only inspect the first part: a long genuine reply that happens to discuss
  // logging in shouldn't trip this, but a bare auth notice is short and early.
  const head = `${stdout}\n${stderr}`.slice(0, 600);
  return AUTH_FAILURE_PATTERNS.some((re) => re.test(head));
}

// signal (optional) stops the child early: a phone turn that Telnyx dropped.
// The promise then resolves with is_aborted and no result.
//
// onText (optional) gets the reply text while Alfred writes it. Then the child
// runs with --output-format stream-json, and claude-stream.js reads its lines.
// The "result" line is the same object as json mode prints, so the timeout,
// login check and result parse below do not change. Without onText, the
// command and the parse are the same as before.
function runClaude(message, sessionId, { signal, onText } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve({ result: "", session_id: null, is_aborted: true });
    const parser = typeof onText === "function"
      ? makeStreamParser({ onText, onError: (err) => console.error(`⚠️  Streamed reply text failed: ${err.message}`) })
      : null;
    const args = [
      "-p", message,
      ...(parser
        ? ["--output-format", "stream-json", "--include-partial-messages", "--verbose"]
        : ["--output-format", "json"]),
      "--allowedTools", "Bash,Read,Edit,Write",
      "--dangerously-skip-permissions",
    ];

    if (sessionId) {
      args.push("--resume", sessionId);
    }

    console.log(`🤖 Running: claude ${args.map(a => a.length > 80 ? a.slice(0, 80) + "…" : a).join(" ")}`);

    const proc = spawn("claude", args, {
      cwd: AGENT_DIR,
      // The broker address and its one-time secret reach the agent through the
      // environment and never touch disk, so there's no credential file for a
      // stray `cat` to turn up. The Google tokens themselves stay in this
      // process — the CLIs in bin/ only ever get a handle to the broker.
      env: {
        ...process.env,
        HOME: process.env.HOME,
        ALFRED_BROKER: broker.url,
        ALFRED_BROKER_TOKEN: broker.token,
        ...BROWSER_ENV,
      },
      // The prompt rides in on `-p`, so the child never reads stdin. Leaving it
      // an open, unwritten pipe makes the CLI wait 3s for piped input and then
      // reply with "no stdin data received in 3s" — which surfaces as Alfred's
      // answer. Point stdin at /dev/null (instant EOF) so it proceeds at once.
      stdio: ["ignore", "pipe", "pipe"],
    });

    // We time out the child ourselves rather than via spawn's `timeout` option.
    // When that option fires, `claude` catches the SIGTERM and exits 143 with a
    // NULL signal — so a `signal`-based check below never recognised the timeout
    // and the user got a bare "(no response)". An explicit flag is unambiguous.
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      // Backstop: if it ignores SIGTERM, take it out hard a moment later.
      setTimeout(() => proc.kill("SIGKILL"), 2000).unref();
    }, TIMEOUT_MS);

    let aborted = false;
    signal?.addEventListener("abort", () => {
      aborted = true;
      parser?.stop();
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 2000).unref();
    }, { once: true });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => {
      if (parser) parser.push(d);
      else stdout += d.toString();
    });
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code, signal) => {
      clearTimeout(killer);
      // Stream mode: from here on, stdout is what json mode would print.
      if (parser) {
        parser.end();
        stdout = parser.body();
      }
      if (aborted) {
        resolve({ result: "", session_id: null, is_aborted: true });
        return;
      }
      if (code !== 0) {
        console.error(`⚠️  Claude exited ${code}${signal ? ` (${signal})` : ""}${timedOut ? " [timed out]" : ""}: ${stderr}`);
      }

      // A timeout kill leaves partial or no stdout; report it plainly instead of
      // letting the empty result fall through to "(no response)".
      if (timedOut) {
        const secs = Math.round(TIMEOUT_MS / 1000);
        resolve({
          result: `⏱️ That took longer than ${secs}s, so I stopped it. Ask again, or break it into smaller steps — raise \`CLAUDE_TIMEOUT_MS\` if it genuinely needs longer.`,
          session_id: null,
          is_error: true,
          is_timeout: true,
        });
        return;
      }

      // An expired headless login comes back as an ordinary-looking message,
      // so Alfred would relay "Not logged in · Please run /login" as if it were
      // a considered reply. Catch it and say what actually needs doing.
      if (isAuthFailure(stdout, stderr)) {
        console.error("🔑 Claude Code is not authenticated — run `claude` on the host and /login");
        resolve({
          result: "🔑 My Claude session isn't authenticated anymore. Run `claude` on the host and sign in with `/login`, then try me again.",
          session_id: null,
          is_error: true,
          is_auth_error: true,
        });
        return;
      }

      // claude -p --output-format json may return multiple JSON lines
      // or a single JSON object. Try to parse the last valid JSON.
      let parsed = null;
      const lines = stdout.trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          parsed = JSON.parse(lines[i]);
          break;
        } catch { /* keep looking */ }
      }

      if (!parsed) {
        // Fallback: treat raw stdout as the reply. 
        // If stdout is empty but there's stderr, show that to help debugging.
        let result = stdout.trim();
        if (!result && stderr.trim()) {
          result = `⚠️ Claude Error:\n\`\`\`\n${stderr.trim().slice(0, 1800)}\n\`\`\``;
        }

        resolve({
          result: result || "(no response)",
          session_id: null,
          is_error: code !== 0,
        });
        return;
      }

      resolve({
        result: parsed.result || parsed.text || JSON.stringify(parsed),
        session_id: parsed.session_id || null,
        is_error: code !== 0,
      });
    });

    proc.on("error", (err) => reject(err));
  });
}

// ── Discord bot ─────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel], // Needed for DMs
});

client.once("ready", () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  if (ALLOWED_USER_IDS.length) {
    console.log(`🔒 Only responding to user IDs: ${ALLOWED_USER_IDS.join(", ")}`);
  } else {
    console.log(`⚠️  No ALLOWED_USER_IDS set — responding to ALL users. Set this for safety!`);
  }
  // One-time probe so the operator knows voice notes will work before the first
  // one arrives. It's advisory only — the message handler still catches a failed
  // transcribe — so a false negative here never blocks a turn.
  console.log(
    transcriptionAvailable()
      ? "🎙️  Voice transcription ready (Parakeet int8 via onnx-asr)."
      : "🎙️  Voice transcription unavailable — run scripts/setup-voice.sh to enable it."
  );
});

// ── Connection watchdog ──────────────────────────────────────────────────────
// After a long suspend (laptop slept for hours), discord.js can end up silently
// disconnected: the process stays alive — so start-alfred.sh's restart loop
// never fires — but the gateway socket is dead, so Alfred stops receiving
// messages. We watch the connection and, if it stays down past a grace period,
// exit non-zero so the wrapper relaunches us with a fresh login.
const WATCHDOG_GRACE_MS = parseInt(process.env.WATCHDOG_GRACE_MS || "90000"); // 90s
// Flap detection: a wedged gateway can keep *resuming* every few seconds, so it
// reads as "ready" on any given health tick and the grace-period check below
// never fires — yet real-time events fall through the cracks the whole time
// (this is exactly how Alfred once went silent for hours). So we also count
// reconnects in a rolling window and restart once they cross a threshold.
const FLAP_WINDOW_MS = parseInt(process.env.FLAP_WINDOW_MS || "180000"); // 3 min
const FLAP_MAX = parseInt(process.env.FLAP_MAX || "5");                  // >5 in window
let downSince = null;
let reconnectAt = [];
let restarting = false;

// Post a one-line alert to a webhook (ALFRED_ALERT_WEBHOOK, else Ronnie's) so a
// restart is visible in Discord within seconds instead of discovered hours later.
// Never lets a slow or failed POST hold up the exit.
async function notifyRestart(reason) {
  const url = process.env.ALFRED_ALERT_WEBHOOK || process.env.RONNIE_DISCORD_WEBHOOK;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Alfred", content: `⚠️ Alfred restarting — ${reason}` }),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* a missed alert must never block the restart */ }
}

function restartProcess(reason) {
  if (restarting) return; // one restart, even amid a reconnect storm
  restarting = true;
  console.error(`🔄 Restarting bot: ${reason}`);
  // Fire the alert, then exit no matter what — with a hard backstop in case the
  // POST never settles. start-alfred.sh's `while true` loop relaunches us.
  notifyRestart(reason).finally(() => process.exit(1));
  setTimeout(() => process.exit(1), 3500).unref();
}

// discord.js has given up on the session and won't reconnect on its own.
client.on("invalidated", () => restartProcess("Discord session invalidated"));
client.on("error", (err) => console.error(`⚠️  Client error: ${err?.message || err}`));
client.on("shardDisconnect", (e, id) => console.warn(`⚠️  Shard ${id} disconnected (code ${e?.code}); awaiting reconnect…`));
client.on("shardReconnecting", (id) => {
  console.warn(`… shard ${id} reconnecting`);
  const now = Date.now();
  reconnectAt = reconnectAt.filter((t) => now - t < FLAP_WINDOW_MS);
  reconnectAt.push(now);
  if (reconnectAt.length > FLAP_MAX) {
    restartProcess(`gateway flapping — ${reconnectAt.length} reconnects in ${Math.round(FLAP_WINDOW_MS / 1000)}s`);
  }
});
client.on("shardResume", (id) => console.log(`✅ Shard ${id} resumed`));

setInterval(() => {
  if (client.isReady()) {
    if (downSince) console.log("✅ Gateway healthy again");
    downSince = null;
    return;
  }
  if (!downSince) {
    downSince = Date.now();
    console.warn("⚠️  Gateway not ready; watching for recovery…");
  } else if (Date.now() - downSince > WATCHDOG_GRACE_MS) {
    restartProcess(`gateway down for ${Math.round((Date.now() - downSince) / 1000)}s`);
  }
}, 30000);

// ── Turn queue ──────────────────────────────────────────────────────────────
// Discord delivers messages concurrently, but a turn is not reentrant: it reads
// state.json, spawns `claude --resume <id>`, and writes the new id back. Two in
// flight would both resume the same session and clobber each other's state, so
// turns are chained and run strictly one at a time.
let turnQueue = Promise.resolve();
let pendingTurns = 0;

function enqueueTurn(fn) {
  pendingTurns++;
  // .then(fn, fn) so one failed turn doesn't stall every turn behind it.
  const run = turnQueue.then(fn, fn).finally(() => pendingTurns--);
  turnQueue = run.catch(() => {});
  return run;
}

// Append a workout note to the strength DB. Immutable and keyed by the Eastern
// local date so it matches the workout's own date (Intervals dates are local),
// even when the note is written late at night. Opened per note — cheap, and it
// keeps no handle around when the feature is idle.
function recordWorkoutNote(text) {
  const db = openStrengthDb();
  try {
    const noteDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    insertNote(db, { received_at: new Date().toISOString(), note_date: noteDate, text });
  } finally {
    db.close();
  }
}

// A Discord voice note carries the IsVoiceMessage flag; its lone attachment is
// the Opus audio. This is one of the two voice shapes isVoiceInput() accepts —
// the other is a plain audio file dropped in with no caption (voice/detect.js).
function isVoiceNote(msg) {
  return Boolean(msg.flags?.has?.(MessageFlags.IsVoiceMessage));
}

// The attachments as the plain shape voice/detect.js reads — content-type and
// name only, so the decision stays testable without a discord.js object.
function attachmentMeta(msg) {
  if (!msg.attachments) return [];
  return [...msg.attachments.values()].map((a) => ({ contentType: a.contentType, name: a.name }));
}

client.on("messageCreate", async (msg) => {
  // Ignore own messages and other bots
  if (msg.author.bot) return;

  // Respond to every message from an authorized user — no @mention required,
  // in DMs and any channel Alfred can see. Access is enforced by the auth
  // check below, so Alfred only ever acts on messages from ALLOWED_USER_IDS.

  // Auth check
  if (ALLOWED_USER_IDS.length && !ALLOWED_USER_IDS.includes(msg.author.id)) {
    console.log(`🚫 Ignored message from unauthorized user: ${msg.author.tag} (${msg.author.id})`);
    return;
  }

  // Resolve the message text before any channel routing. Strip a mention, then
  // download attachments, then — for a voice note — transcribe it so the
  // transcript BECOMES the message. This runs first so a voicemail works on
  // every channel: whatever a channel does next (a turn, a workout-log record,
  // a Ronnie undo) then operates on words, never an Opus blob.
  let userMessage = msg.content.replace(/<@!?\d+>/g, "").trim();

  // Download any files first — a file sent with no caption arrives with empty
  // content and would otherwise be dropped by the guard below before it's seen.
  let attachments = await saveInboundAttachments(msg);

  // Voice input: a native Discord voice note, OR a lone audio file dropped in
  // with no caption (a voice memo recorded elsewhere). Either way the message IS
  // the audio, so transcribe it locally (voice/transcribe.js) and let the
  // transcript BE the user message — the same downstream path as typed text.
  // Alfred never learns it was spoken. The audio is not handed on as an
  // attachment: Alfred can't read it, and the point is the text. Echo what was
  // heard first, so a mishear ("cancel Thursday's meeting") is visible before
  // the turn acts on it.
  if (isVoiceInput({ atts: attachmentMeta(msg), isVoiceNote: isVoiceNote(msg), caption: userMessage }) && attachments.length) {
    const audioPath = attachments[0]; // voice input carries exactly one file
    await msg.channel.sendTyping().catch(() => {});
    let transcript;
    try {
      transcript = await transcribe(audioPath);
    } catch (err) {
      console.error(`🎙️  Transcription failed: ${err.message}`);
      await msg.reply("🎙️ Sorry — I couldn't transcribe that voice message.").catch(() => {});
      return;
    }
    if (!transcript) {
      await msg.reply("🎙️ I didn't catch any speech in that voice message.").catch(() => {});
      return;
    }
    console.log(`🎙️  Voice message → "${transcript.slice(0, 100)}"`);
    await msg.reply(`🎙️ heard: "${transcript}"`).catch(() => {});
    userMessage = transcript;
    attachments = []; // the transcript replaces the audio; don't inject the file
  }

  // Workout-log channel: a message here is a training note, not a turn for
  // Alfred. Store it immutably (keyed by the local date, so it lines up with the
  // workout's own date) for the strength interpreter, ack it, and stop. Off
  // unless STRENGTH_LOG_CHANNEL is set. A voicemail reaches here as its
  // transcript, so a spoken note is logged the same as a typed one.
  if (STRENGTH_LOG_CHANNEL && msg.channelId === STRENGTH_LOG_CHANNEL) {
    const note = userMessage.trim();
    if (note) {
      try {
        recordWorkoutNote(note);
        msg.react("💪").catch(() => {}); // best-effort ack
      } catch (err) {
        console.error(`🏋️  Failed to log workout note: ${err.message}`);
        msg.react("⚠️").catch(() => {});
      }
    }
    return;
  }

  if (!userMessage && attachments.length === 0) return;

  // Ronnie's undo, handled here and NOT as a turn — it's a direct broker action
  // and must not spawn claude -p. Only the exact affordance form fires (a cal: or
  // mail: token from a Ronnie embed footer), so a plain "undo …" to Alfred still
  // reaches a turn untouched.
  const undoMatch = /^undo\s+((?:cal|mail):\S+)/i.exec(userMessage);
  if (undoMatch && ronnie?.undo) {
    const token = undoMatch[1];
    try {
      const r = await ronnie.undo(token);
      await msg.react("↩️").catch(() => {});
      console.log(`↩️  Ronnie undo ${token} → ${r.kind}`);
    } catch (err) {
      await msg.reply(`Couldn't undo \`${token}\`: ${err.message}`).catch(() => {});
    }
    return;
  }

  // Ronnie metrics: "/ronnie-metrics" renders the Haiku cost figure into today's
  // daily folder and posts it back. Handled here, not as a turn — it just runs a
  // script and attaches a PNG.
  if (/^\/?ronnie-metrics\b/i.test(userMessage)) {
    await runRonnieMetrics(msg).catch((err) =>
      msg.reply(`Couldn't build Ronnie metrics: ${err.message}`).catch(() => {})
    );
    return;
  }

  // The inbound turn is logged inside handleTurn, not here: a "/c <text>"
  // command clears (and archives) the transcript first, so logging on arrival
  // would file the new message into the conversation it just ended. The queue
  // is FIFO, so logging when the turn runs still preserves arrival order.
  if (pendingTurns > 0) {
    console.log(`⏳ ${pendingTurns} turn(s) already in flight — queuing this one`);
    msg.react("⏳").catch(() => {}); // best-effort; needs the Add Reactions permission
  }
  // The SMS mirror channel is the phone thread. A message typed there gets its
  // reply in Discord AND by SMS to the owner's phone. Every other channel is
  // Discord only.
  const target = smsConfigured && SMS_MIRROR_CHANNEL && msg.channelId === SMS_MIRROR_CHANNEL
    ? smsTarget({ to: SMS_ALLOWED_NUMBERS[0], discord: discordTarget(msg) })
    : discordTarget(msg);
  await enqueueTurn(() => handleTurn(target, userMessage, attachments));
});

// Build Ronnie's Haiku usage dashboard and post it. Writes a self-contained
// HTML view (editorial serif design, fonts inlined, no external fetches) into today's
// daily folder so Alfred can surface it, drops a one-line breadcrumb in the daily
// note, and attaches the file. Pure Node — scripts/ronnie-dashboard.mjs has no
// runtime deps, so there's nothing to provision.
async function runRonnieMetrics(msg) {
  const today = new Date().toISOString().split("T")[0];
  const usageFile = path.join(STATE_DIR, "ronnie-usage.jsonl");
  const dailyDir = path.join(MEMORIES_DIR, "dailies");
  const outHtml = path.join(dailyDir, `ronnie-usage-${today}.html`);
  const script = path.join(REPO_DIR, "scripts", "ronnie-dashboard.mjs");
  await mkdir(dailyDir, { recursive: true });

  const summary = await new Promise((resolve, reject) => {
    // process.execPath is this bot's own node — robust under nvm/tmux where
    // `node` may not be on a bare PATH.
    const child = spawn(process.execPath, [script, usageFile, outHtml], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(err.trim().slice(0, 300) || `exited ${code}`))
    );
  });

  if (existsSync(outHtml)) {
    // A breadcrumb in the daily note so Alfred can mention it; best-effort.
    await appendFile(path.join(dailyDir, `${today}.md`), `\n- 📊 Ronnie Haiku usage: ${summary}\n`).catch(() => {});
    await msg.reply({ content: `📊 ${summary}\nOpen the attached dashboard in a browser.`, files: [new AttachmentBuilder(outHtml)] });
  } else {
    await msg.reply(summary || "No Ronnie usage recorded yet.");
  }
}

// One turn at a time, in arrival order. Everything below reads and writes the
// single global state.json, so overlapping turns would resume the same session
// twice and race to write the new session id back. `target` is where the turn
// answers — Discord, SMS, or both (see "Reply targets" below).
async function handleTurn(target, userMessage, attachments = [], { signal, onText } = {}) {
  // "/clear" / "/c" as a prefix: bare = clear and wait; "/c <text>" = clear,
  // then run <text> as the fresh session's first turn (one message does both).
  const clear = parseClearCommand(userMessage);
  if (clear) {
    console.log(`🧹 Clearing session for ${target.who.tag}`);

    // Archive the just-ended conversation, then kick off memory consolidation.
    // The fold watermark must exist before the archive does, so the archive
    // counts as not folded until its fold works (fold.js). Its first value
    // marks the older archives as folded.
    await ensureWatermark({ stateDir: STATE_DIR, logsDir: LOGS_DIR })
      .catch((err) => console.error(`⚠️  Fold watermark: ${err.message}`));
    let archivePath = null;
    try {
      // ledger.archive() copies messages.jsonl to logs/<firstTs>_to_<lastTs>.jsonl
      // and empties it. The /clear command is not in the archive: the inbound
      // turn is logged below, after the archive, without the command.
      archivePath = await ledger.archive();
      if (archivePath) {
        console.log(`📦 Archived conversation → ${archivePath}`);
        // The ledger starts again at 0, so Alfred's place in it does too.
        await catchUp.reset();
        await consolidateMemory(archivePath);
      }
    } catch (err) {
      console.error(`⚠️  Archive/consolidate failed: ${err.message}`);
    }

    await writeState({
      status: "resolved",
      last_session_id: null,
      topic: "session cleared",
      timestamp: new Date().toISOString(),
    });

    // Nothing after the command → the old behaviour: confirm and wait.
    if (!clear.remainder && attachments.length === 0) {
      const note = archivePath ? " (archived + consolidating memory)" : "";
      await target.send(`🧹 Session cleared.${note} The next message will start a fresh session with full context.`);
      return;
    }

    // There's a message (and/or files) riding with the command. Signal the
    // clear with a reaction instead of a second message, then fall through and
    // handle the remainder as the fresh session's first turn. State is already
    // reset above, so `shouldResume` below is false and full context loads.
    target.react("🧹"); // best-effort; needs the Add Reactions permission
    userMessage = clear.remainder;
  }

  // Log the inbound turn now — after any /clear reset above — so it lands in the
  // fresh transcript rather than the one we just archived. The row names the
  // saved files (Discord and SMS alike), so a fold can open a photo later.
  const inbound = await logTurn(inboundRow({ who: target.who, via: target.via, text: userMessage, attachments, agentDir: AGENT_DIR, callId: target.callId }));
  // An out row of this turn names its channel and call too, so no reader has to
  // take them from the row before it: a call's own lines can come between.
  const logOut = (row) => logTurn({ dir: "out", via: target.via, ...row, callId: target.callId });

  console.log(`📨 ${target.who.tag}: ${userMessage.slice(0, 100)}`);

  // Show typing indicator
  await target.typing();
  const typingInterval = setInterval(() => target.typing(), 8000);

  try {
    // Read current state
    const state = await readState();

    // Decide: new session or resume
    const dreamed = await dreamedSince(state);
    const shouldResume = state.status === "open" && state.last_session_id && !dreamed;
    const sessionId = shouldResume ? state.last_session_id : null;

    // What was said and done on the phone since Alfred's last turn: the call
    // lines and the voice's tool changes (context.js). A use_tools turn is a
    // turn too, so it carries the call so far, with the caller's own words.
    const phone = await catchUp.read();

    // Files the user sent ride with THIS message, not the session context, so
    // they reach the turn on a resumed session too (a photo dropped mid-chat is
    // the common case). The attachment block attaches to the message body. When
    // there's no caption, give the turn a short placeholder so it isn't handed
    // an empty string.
    const attachBlock = buildAttachmentBlock(attachments);
    let messageBody = attachBlock
      ? `${attachBlock}\n\n${userMessage || "(The user sent the file(s) above with no other text.)"}`
      : userMessage;

    let context = "";
    let shown = null;
    if (shouldResume) {
      console.log(`🔄 Resuming session ${sessionId}`);
    } else {
      if (dreamed) console.log("🌙 A dream pass ran since the last turn — starting fresh to load new memory");
      console.log(`🆕 Starting new session - loading context...`);
      // until: this turn's own row. The message carries it, so the recent
      // messages leave it out.
      ({ text: context, shown } = await loadContext({ until: inbound?.ts }));
    }

    // The phone block and the tag ride on this message only, like the
    // attachment block, so a resumed session still sees them. A new session's
    // recent messages show the newest calls already, so the block leaves those
    // rows out. A /clear above already took its prefix off.
    messageBody = catchUp.block(phone, { skip: shown }) + messageBody;
    if (VIA_TAGS[target.via]) messageBody = `${VIA_TAGS[target.via]} ${messageBody}`;
    const finalMessage = context + messageBody;

    // Run Claude
    // onText: a phone call that speaks the reply while Alfred writes it.
    const response = await runClaude(finalMessage, sessionId, { signal, onText });
    // Alfred read the phone's rows up to phone.end: the cursor moves there now.
    // A dropped turn, a login lapse or a timeout leaves it, so the next turn
    // shows those rows again.
    await catchUp.advance(phone, response);

    // A dropped phone turn: Telnyx sent a longer version of the same words.
    // Keep no state and send nothing. The next turn carries the words.
    if (response.is_aborted) {
      console.log("✂️  Turn cancelled (Telnyx dropped an early guess)");
      await logOut({ kind: "cancelled", text: "" });
      return;
    }

    // An auth lapse or timeout produced no session and did no work — recording
    // it as the session's latest turn would just push the real one out of view.
    const infraFailed = response.is_auth_error || response.is_timeout;

    if (!infraFailed) {
      // Persist session continuity whether or not we end up replying.
      await writeState({
        last_session_id: response.session_id || state.last_session_id,
        status: "open", // reset by /clear, or implicitly by the next dream pass
        topic: userMessage.slice(0, 100),
        timestamp: new Date().toISOString(),
      });
    }

    // These are bot-level failures, not things Alfred said. Send them straight
    // out, skipping the <no_reply> and attachment handling below.
    if (infraFailed) {
      const kind = response.is_auth_error ? "auth_error" : "timeout";
      await target.send(response.result);
      await logOut({ kind, text: response.result });
      return;
    }

    // Alfred can opt out of replying by emitting ONLY the sentinel — used when
    // a message clearly isn't directed at it. Tolerate stray markdown/quotes.
    const replyText = (response.result || "").trim();
    // Normalize away markdown/quoting/brackets, keep letters + underscore, so
    // `<no_reply>`, `> <no_reply>`, **<no_reply>** etc. all match. Requiring the
    // underscore avoids silencing a genuine reply like "no reply" (-> noreply).
    const canon = (s) => s.toLowerCase().replace(/[^a-z_]/g, "");
    const isSilent = canon(replyText) === canon(NO_REPLY);
    if (isSilent) {
      console.log("🤫 Stayed silent (no_reply sentinel)");
      await logOut({ kind: "silent", text: "", sessionId: response.session_id || null });
      return;
    }

    // Deferred strength pull: Alfred ended the reply with {bg:strength} to ack
    // now and let the slow digest run out-of-band. Strip the sentinel, send the
    // ack (a default if he wrote only the token), then kick the job off.
    const deferStrength = BG_STRENGTH_RE.test(replyText);
    const visibleText = deferStrength ? replyText.replace(BG_STRENGTH_RE, "").trim() : replyText;

    // Pull out any {img:}/{pdf:}/{file:} attachments, then send (Discord has a
    // 2000-char limit per message; files batch to 10 per message).
    const { text: cleaned, files } = extractAttachments(visibleText);
    const reply = cleaned.trim() ||
      (files.length ? "" : deferStrength ? "On it — pulling your workout, back in ~2 min ⏳" : "(empty response)");
    // streamed: the caller already heard this text as it came. A default line
    // (no text from Alfred) did not stream, so the call must still speak it.
    await target.send(reply, files, { streamed: !!onText && !!cleaned.trim() });

    console.log(`✅ Replied (${reply.length} chars${files.length ? `, ${files.length} file(s)` : ""}${deferStrength ? ", deferred digest" : ""})`);
    await logOut({ kind: "reply", text: reply, files: files.length, sessionId: response.session_id || null });

    if (deferStrength) startStrengthDigestFollowup(target);
  } catch (err) {
    console.error("❌ Error:", err);
    const errReply = `Something went wrong:\n\`\`\`\n${err.message}\n\`\`\``;
    await target.send(errReply).catch((e) => console.error(`⚠️  Couldn't send the error reply: ${e.message}`));
    await logOut({ kind: "error", text: errReply, error: err.message });
  } finally {
    clearInterval(typingInterval);
    target.done?.();
  }
}

// Run the strength digest out-of-band after Alfred deferred it with
// {bg:strength}. bot.js holds the broker, so — unlike a claude-spawned detached
// run — the activity pull works here. When it lands, enqueue a follow-up turn so
// Alfred answers the original question with the freshly interpreted data. The
// digest is idempotent, so a redundant run (e.g. nothing new) is harmless.
function startStrengthDigestFollowup(target) {
  console.log("🏋️  Deferred strength digest started (background)");
  const proc = spawn("node", ["../bin/strength.js", "digest"], {
    cwd: AGENT_DIR,
    env: { ...process.env, ALFRED_BROKER: broker.url, ALFRED_BROKER_TOKEN: broker.token },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: BG_DIGEST_TIMEOUT_MS,
  });
  let out = "", err = "";
  proc.stdout.on("data", (d) => (out += d.toString()));
  proc.stderr.on("data", (d) => (err += d.toString()));
  proc.on("close", (code) => {
    console.log(`🏋️  Deferred digest ${code === 0 ? "done" : `failed (exit ${code})`}`);
    enqueueTurn(() => strengthFollowupTurn(target, { ok: code === 0, out, err }));
  });
  proc.on("error", (e) => {
    console.error(`🏋️  Deferred digest spawn error: ${e.message}`);
    enqueueTurn(() => strengthFollowupTurn(target, { ok: false, out: "", err: e.message }));
  });
}

// The follow-up itself: resume the current session (read at run time, so a
// message that arrived meanwhile is respected) and let Alfred report the result
// in his own voice. Runs through the turn queue, so it never races a live turn.
// A concrete fallback covers the cases where there's no session or Alfred stays
// silent, so a deferred pull never ends in silence.
async function strengthFollowupTurn(target, { ok, out, err }) {
  const fallback = ok
    ? "✅ Pulled your workout — ask me how it looks for the breakdown."
    : "⚠️ I couldn't pull your workout just now — try again in a bit.";
  try {
    const state = await readState();
    const sessionId = state.last_session_id;
    if (!sessionId) { await target.send(fallback); return; }

    const summary = ok
      ? `Digest output:\n${(out || "").trim().slice(0, 1000)}`
      : `It FAILED (${(err || "").trim().slice(0, 300) || "unknown error"}).`;
    const nudge =
      `[SYSTEM — not a user message: the background strength digest you started has finished. ${summary}\n\n` +
      `Answer the user's earlier request now with the freshly interpreted data (read it via the strength skill — ` +
      `load/sets are instant). Reply naturally as a follow-up; do NOT run the digest again. If it failed, say so briefly.]`;

    await target.typing();
    const response = await runClaude(nudge, sessionId);
    if (!response.is_auth_error && !response.is_timeout) {
      await writeState({
        last_session_id: response.session_id || sessionId,
        status: "open",
        topic: "strength digest follow-up",
        timestamp: new Date().toISOString(),
      });
    }

    const replyText = (response.result || "").trim();
    const canon = (s) => s.toLowerCase().replace(/[^a-z_]/g, "");
    if (!replyText || canon(replyText) === canon(NO_REPLY)) { await target.send(fallback); return; }

    const { text: cleaned, files } = extractAttachments(replyText);
    const reply = cleaned.trim() || (files.length ? "" : fallback);
    await target.send(reply, files);
    console.log(`✅ Strength follow-up replied (${reply.length} chars${files.length ? `, ${files.length} file(s)` : ""})`);
    await logTurn({ dir: "out", via: target.via, kind: "reply", text: reply, files: files.length, sessionId: response.session_id || null });
  } catch (e) {
    console.error(`❌ Strength follow-up error: ${e.message}`);
    await target.send(fallback).catch(() => {});
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
// A new session's context (context.js): SOUL, USER, MEMORY, the daily notes of
// yesterday and today, and the last hours of messages on every channel, word
// for word. Resolves to { text, shown }: shown is the rows the messages show.
// until: the row of this turn's message, which the message itself carries.
function loadContext({ until } = {}) {
  return sessionContext({ agentDir: AGENT_DIR, stateDir: STATE_DIR, ledger, until });
}

// Download every file attached to an inbound message into that day's folder and
// return the saved absolute paths, in order. The counterpart to
// extractAttachments (which sends files out); this is the missing inbound
// direction. Any type is accepted — this is a single-user, high-trust channel,
// gated by the ALLOWED_USER_IDS check in messageCreate, so there's no whitelist.
// A failed download is logged and skipped, never fatal to the turn.
async function saveInboundAttachments(msg) {
  if (!msg.attachments || msg.attachments.size === 0) return [];

  const dir = dailyDir(MEMORIES_DIR);
  await mkdir(dir, { recursive: true });

  const saved = [];
  let i = 0;
  for (const att of msg.attachments.values()) {
    const dest = path.join(dir, attachmentName(msg.id, i, att.name));
    try {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(dest, buf);
      saved.push(dest);
      console.log(`📎 Saved inbound attachment → ${agentRel(dest)} (${buf.length} bytes)`);
    } catch (err) {
      console.error(`⚠️  Couldn't download attachment ${att.name}: ${err.message}`);
    }
    i++;
  }
  return saved;
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  while (text.length > 0) {
    // Try to split at a newline
    let splitAt = text.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(text.slice(0, splitAt));
    text = text.slice(splitAt).trimStart();
  }
  return chunks;
}

// Pull {img:}/{pdf:}/{file:} tokens out of a reply, turn the valid ones into
// Discord attachments, and strip the tokens from the visible text. Each file is
// renamed attachment_<i>.<ext> — index-based names avoid collisions between
// files that share a basename. Invalid tokens (missing / too big / over the
// count cap) are replaced with a short inline note instead of crashing.
function extractAttachments(text) {
  const files = [];
  let i = 0;
  const cleaned = text.replace(ATTACH_RE, (_match, rawPath) => {
    const p = rawPath.trim();
    const label = path.basename(p) || p;
    if (i >= MAX_ATTACHMENTS) return `⚠️ (skipped ${label} — over ${MAX_ATTACHMENTS}-file limit)`;

    const abs = path.isAbsolute(p) ? p : path.join(AGENT_DIR, p);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      return `⚠️ (couldn't attach ${label} — not found)`;
    }
    if (!stat.isFile()) return `⚠️ (couldn't attach ${label} — not a file)`;
    if (stat.size > MAX_FILE_BYTES) {
      return `⚠️ (couldn't attach ${label} — ${(stat.size / 1048576).toFixed(1)}MB over ` +
        `${(MAX_FILE_BYTES / 1048576).toFixed(0)}MB limit)`;
    }

    files.push(new AttachmentBuilder(abs, { name: `attachment_${i}${path.extname(p)}` }));
    i++;
    return ""; // strip the token from the visible reply
  });
  return { text: cleaned, files };
}

// Send a reply that may carry attachments. Text is chunked to Discord's char
// limit; files ride on the final message, batched to MAX_FILES_PER_MSG.
async function sendReply(msg, text, files) {
  return postChunks((payload) => msg.reply(payload), text, files);
}

// post(payload) sends one Discord message: msg.reply, or channel.send.
async function postChunks(post, text, files) {
  const chunks = text ? splitMessage(text, 1900) : [];
  if (!files.length) {
    for (const chunk of chunks) await post(chunk);
    return;
  }
  // Leading chunks go out as plain text; the last chunk rides with the first file batch.
  for (const chunk of chunks.slice(0, -1)) await post(chunk);
  const trailing = chunks.length ? chunks[chunks.length - 1] : "";
  for (let b = 0; b < files.length; b += MAX_FILES_PER_MSG) {
    const payload = { files: files.slice(b, b + MAX_FILES_PER_MSG) };
    if (b === 0 && trailing) payload.content = trailing;
    await post(payload);
  }
}

// ── Reply targets ───────────────────────────────────────────────────────────
// A turn writes to a target, not to a discord.js message. So one turn can
// answer in Discord, by SMS, or in both. A target has:
//
//   who             { tag, id, channel } for the transcript and the console
//   via             "discord", "sms" or "call": where the turn came from, for
//                   the tag on the message and the ledger rows
//   callId          a 2B call's id (call targets only): the turn's rows carry it
//   typing()        show that Alfred is working. It never throws.
//   react(emoji)    react to the inbound message. It never throws.
//   send(text, files)  deliver a reply. It throws only if no copy arrived.
function discordTarget(msg) {
  return {
    who: { tag: msg.author.tag, id: msg.author.id, channel: msg.channelId },
    via: "discord",
    typing: () => msg.channel.sendTyping().catch(() => {}),
    react: (emoji) => msg.react(emoji).catch(() => {}),
    send: (text, files = []) => sendReply(msg, text, files),
  };
}

// SMS to `to`, plus a Discord copy when `discord` is a target (the mirror).
// The two sends are independent: a failed SMS still leaves the Discord copy,
// and the mirror says that the SMS did not go. Typing and reactions exist only
// on the Discord side.
//
// Reply files go in the text as MMS when the media host is on and they fit
// (telnyx/mms.js). The rest are named in the text. If the MMS is refused, the
// words go again as a plain SMS, so a bad file never loses the reply.
//
// ackMs: a turn from a text sends one "👀 On it…" text when it runs this long
// with no reply (makeSmsAck). typing() starts the timer. send() and done() (the
// end of the turn) stop it. Without ackMs, nothing extra goes.
function smsTarget({ to, discord = null, who = discord?.who, ackMs = 0 }) {
  const sendText = (text, mediaUrls = []) =>
    sendSms({ apiKey: TELNYX_API_KEY, from: TELNYX_PHONE_NUMBER, to, text, mediaUrls, messagingProfileId: TELNYX_MESSAGING_PROFILE_ID });
  const textNote = (text, skipped) => smsText(text, discord ? { files: skipped } : {
    files: skipped,
    filesNote: mediaHost ? "too big to text" : "not sent — SMS cannot carry files",
    overflowNote: "(cut)",
  });
  async function sendSmsCopy(text, files) {
    const local = files.map((f) => ({ path: f.attachment, name: f.name }));
    const { send, skip } = mediaHost ? await pickMmsFiles(local) : { send: [], skip: local };
    const body = textNote(text, skip.length);
    if (!send.length) return body ? sendText(body) : null;
    try {
      return await sendText(body, send.map((f) => mediaHost.publish(f)));
    } catch (err) {
      console.error(`📵 MMS refused (${err.message}); sending the words alone`);
      const words = textNote(text, files.length);
      return words ? sendText(words) : null;
    }
  }
  const ack = makeSmsAck({ delayMs: ackMs, send: () => {
    console.log(`👀 Slow SMS turn — texting "${SMS_ACK_TEXT}" to ${to}`);
    return sendText(SMS_ACK_TEXT);
  } });
  return {
    who,
    via: "sms",
    typing: () => {
      ack.start();
      return discord?.typing() ?? Promise.resolve();
    },
    react: (emoji) => discord?.react(emoji) ?? Promise.resolve(),
    done: () => ack.done(),
    send: async (text, files = []) => {
      ack.done();
      const [sms, mirror] = await Promise.allSettled([
        sendSmsCopy(text, files),
        discord ? discord.send(text, files) : Promise.resolve(),
      ]);
      if (sms.status === "rejected") {
        console.error(`📵 ${sms.reason.message}`);
        if (discord && mirror.status === "fulfilled") {
          await discord.send(`📵 The SMS copy did not go: ${sms.reason.message}`).catch(() => {});
        }
      }
      if (mirror.status === "rejected") console.error(`⚠️  SMS mirror post failed: ${mirror.reason.message}`);
      if (sms.status === "rejected" && (!discord || mirror.status === "rejected")) throw sms.reason;
    },
  };
}

// An inbound text from an allowed number. Post it in the mirror channel (if
// set), then queue it as a normal turn. The mirror post is what Alfred's
// Discord-side reply answers, so the thread reads in order. The text runs the
// same path as a Discord message, so "/c …" clears from a phone too.
//
// An MMS brings files. They are saved at once (Telnyx's links expire) and go to
// the turn like Discord attachments. A voice message — one audio file and no
// words — is transcribed locally, as in Discord: the reply "🎙️ heard: …" goes
// back first, so a mishear shows before the turn acts on it.
async function onSmsText({ id, from, text, media }) {
  const who = { tag: `sms:${from}`, id: from, channel: SMS_MIRROR_CHANNEL || "sms" };
  const reply = (words) => smsTarget({ to: from, who }).send(words).catch(() => {});
  const msgId = `sms-${String(id || Date.now()).replace(/[^\w-]/g, "")}`;
  let files = await downloadMedia({
    media,
    dir: dailyDir(MEMORIES_DIR),
    nameFor: (i, name) => attachmentName(msgId, i, name),
  });
  if (!text && !files.length) {
    if (media.length) await reply("I couldn't open that attachment. Try sending it again.");
    return;
  }

  let heard = "";
  const atts = files.map((f) => ({ contentType: f.contentType, name: f.name }));
  if (isVoiceInput({ atts, isVoiceNote: false, caption: text })) {
    try {
      heard = await transcribe(files[0].path);
    } catch (err) {
      console.error(`🎙️  SMS voice message: transcription failed: ${err.message}`);
      await reply("🎙️ Sorry — I couldn't transcribe that voice message.");
      return;
    }
    if (!heard) {
      await reply("🎙️ I didn't catch any speech in that voice message.");
      return;
    }
    console.log(`🎙️  SMS voice message → "${heard.slice(0, 100)}"`);
    await reply(`🎙️ heard: "${heard}"`);
    text = heard;
  }
  console.log(`📱 SMS from ${from}: ${text.slice(0, 100)}${files.length && !heard ? ` (+${files.length} file${files.length === 1 ? "" : "s"})` : ""}`);

  let discord = null;
  if (SMS_MIRROR_CHANNEL) {
    try {
      const channel = await client.channels.fetch(SMS_MIRROR_CHANNEL);
      const posted = await channel.send({
        content: (heard ? `📱 🎙️ "${heard}"` : `📱 ${text}`).slice(0, 2000),
        files: files.map((f) => new AttachmentBuilder(f.path, { name: f.name })),
        allowedMentions: { parse: [] },
      });
      discord = discordTarget(posted);
    } catch (err) {
      console.error(`⚠️  Couldn't post the SMS in the mirror channel: ${err.message}`);
    }
  }
  const target = smsTarget({ to: from, discord, who, ackMs: SMS_ACK_MS });
  if (heard) files = []; // the transcript replaces the audio, as in Discord
  if (pendingTurns > 0) target.react("⏳");
  await enqueueTurn(() => handleTurn(target, text, files.map((f) => f.path)));
}

// Where a call posts what it cannot speak: files, and answers that came back
// after the caller hung up. The call mirror channel when one is set, else a DM
// to the owner (the first of ALLOWED_USER_IDS). Without either, it is lost.
async function postFromCall(text, files = []) {
  try {
    let channel = null;
    if (VOICE_MIRROR_CHANNEL) channel = await client.channels.fetch(VOICE_MIRROR_CHANNEL);
    else if (ALLOWED_USER_IDS.length) channel = await (await client.users.fetch(ALLOWED_USER_IDS[0])).createDM();
    if (!channel) {
      console.warn("⚠️  Nowhere to post from the call — set VOICE_MIRROR_CHANNEL or ALLOWED_USER_IDS");
      return;
    }
    await postChunks((payload) => channel.send(payload), text, files);
  } catch (err) {
    console.error(`⚠️  Couldn't post from the call: ${err.message}`);
  }
}

// What is said and done on a 2B call, as it happens (telnyx/realtime.js): each
// line, the start and the end, an answer that came after the hangup. Each is a
// ledger row with src "call" (callRow in ledger.js), so a reader can tell the
// call's own lines from its use_tools turns, which are chat rows with the same
// callId. logTurn never throws; a failed write is logged.
function logCallEvent(ev) {
  const row = callRow(ev);
  return row ? logTurn(row) : null;
}

// What the 2B voice did with its own tools, without Alfred. Each action is a
// ledger row (src "tool") and a line in today's daily note. Alfred's next turn,
// on any channel, starts with the row (the catch-up in context.js), so he
// knows the same day. The row is on disk, so a restart does not lose it.
function notePhoneAction(text, { caller, callId } = {}) {
  logTurn(toolRow({ text, caller, callId }));
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" }).format(new Date());
  const file = dailyNotePath(MEMORIES_DIR);
  mkdir(path.dirname(file), { recursive: true })
    .then(() => appendFile(file, `\n## ${time} — By phone\nThe phone voice ${text}.\n`))
    .catch((err) => console.error(`⚠️  Could not note a phone action: ${err.message}`));
}

// A use_tools answer that came back after the call ended (2B). It goes by SMS
// to the caller, and to Discord: a mirror channel already has it, else the
// owner's DM.
async function onLateCallAnswer({ request, reply, caller }) {
  if (!reply.trim()) return;
  const text = `📞 You hung up before I could answer "${request}":\n\n${reply.trim()}`;
  const to = caller || SMS_ALLOWED_NUMBERS[0];
  const sms = smsConfigured && to
    ? sendSms({ apiKey: TELNYX_API_KEY, from: TELNYX_PHONE_NUMBER, to, text: smsText(text), messagingProfileId: TELNYX_MESSAGING_PROFILE_ID })
        .catch((err) => console.error(`📵 Late call answer: ${err.message}`))
    : null;
  await Promise.all([sms, VOICE_MIRROR_CHANNEL ? null : postFromCall(text)]);
}

// A phone call. The reply is spoken, so send() keeps the text for the voice
// route to stream back, and posts a copy in the mirror channel (if set). A late
// send, for example a deferred strength follow-up, reaches the mirror only.
// opts.streamed: the caller heard this text while Alfred wrote it.
function callTarget({ discord = null, who, onReply, callId }) {
  return {
    who,
    via: "call",
    callId,
    typing: () => discord?.typing() ?? Promise.resolve(),
    react: (emoji) => discord?.react(emoji) ?? Promise.resolve(),
    send: async (text, files = [], opts = {}) => {
      onReply(text, opts);
      if (discord) await discord.send(text, files).catch((err) => console.error(`⚠️  Call mirror post failed: ${err.message}`));
      // No mirror: the files still need to reach Discord. The caller hears the text.
      else if (files.length) await postFromCall("📞 From the call:", files);
    },
  };
}

// One caller turn from telnyx/voice.js (v1) or telnyx/pipeline.js (v2). It
// runs the same path as a Discord message, in the same session, and resolves
// to the text to speak.
//
// onText (pipeline only, VOICE_STREAM_REPLY): the pipeline speaks the reply
// text while Alfred writes it. Then this resolves only to text that did not
// stream and must be spoken whole: an error, a timeout, or a default line.
// The mirror post still gets the whole reply.
//
// callId (2B only): the call this use_tools request came from. The turn's rows
// carry it next to the call's own lines (logCallEvent).
async function onCallTurn({ text, caller, takeMissed, signal, onText, callId }) {
  let discord = null;
  if (VOICE_MIRROR_CHANNEL) {
    try {
      const channel = await client.channels.fetch(VOICE_MIRROR_CHANNEL);
      const posted = await channel.send({ content: `📞 ${text}`.slice(0, 2000), allowedMentions: { parse: [] } });
      discord = discordTarget(posted);
    } catch (err) {
      console.error(`⚠️  Couldn't post the call turn in the mirror channel: ${err.message}`);
    }
  }
  let reply = "";
  let streamedAny = false;
  const streamText = typeof onText === "function"
    ? (d) => { streamedAny = true; onText(d); }
    : undefined;
  const target = callTarget({
    discord,
    who: { tag: `call:${caller}`, id: caller, channel: VOICE_MIRROR_CHANNEL || "call" },
    callId,
    onReply: (t, { streamed = false } = {}) => {
      // The pipeline spoke this text from the stream. Do not give it again.
      // If no text came by the stream, give it, so the call is not silent.
      if (streamed && streamedAny) return;
      reply = reply ? `${reply}\n${t}` : t;
    },
  });
  await enqueueTurn(() => {
    // Telnyx dropped this early guess while it waited in the queue.
    if (signal?.aborted) {
      console.log("✂️  Call turn dropped before it started");
      return;
    }
    // Read the flag when the turn starts. A reply that the caller talked over
    // can finish while this turn waits in the queue.
    const note = takeMissed() ? "(The caller talked over your last reply and did not hear it.)\n" : "";
    return handleTurn(target, note + text, [], { signal, onText: streamText });
  });
  return reply;
}

// ── Launch ──────────────────────────────────────────────────────────────────
await bootstrap();

// The broker holds the Google and Notion credentials so the agent doesn't have
// to. It starts even when a service isn't configured yet — the routes then fail
// with a message naming the missing setup step, which is more useful than the
// whole bot refusing to boot over an integration that's still optional. Notion
// and Intervals.icu routes mount alongside Google's on the one loopback server,
// reached with the same token — one gateway, never a server per service.
const broker = await startBroker({ extraRoutes: { ...NOTION_ROUTES, ...INTERVALS_ROUTES } });

// The browser's PATH (browser.js), so Alfred can run agent-browser by name.
const BROWSER_ENV = browserEnv(REPO_DIR);
// agent-browser saves to the path Alfred gives it but never makes the folder.
await mkdir(path.join(AGENT_DIR, "var", "screenshots"), { recursive: true });

// Ronnie: a second, narrow broker (its own port and token, only the label +
// calendar-import/remove routes) plus the queue + consumer that triage inbound
// mail through it. Off unless configured — a webhook, labels, or owner addresses
// present — so a box without Ronnie config drains mail exactly as before. bot.js
// holds the token and runs both brokers; Ronnie is a client of its own one.
const ronnieConfigured = !!(
  process.env.RONNIE_DISCORD_WEBHOOK ||
  process.env.RONNIE_LABEL_BULK ||
  process.env.RONNIE_LABEL_INTERESTING ||
  process.env.RONNIE_FORWARD_SENDERS
);
// The consumer fetches full messages, which needs the OAuth client — and that
// only matters when the push path is actually set up. Build one client and share
// it between the consumer's enrichOne and the listener, so there's one watch.
const pushConfigured = !!(
  process.env.GMAIL_PUBSUB_TOPIC &&
  process.env.GMAIL_PUBSUB_SUBSCRIPTION &&
  existsSync(PUBSUB_KEY_FILE)
);
let ronnie = null;
let sharedGmail = null;
if (ronnieConfigured) {
  const ronnieBroker = await startBroker({ baseRoutes: {}, extraRoutes: RONNIE_ROUTES });
  sharedGmail = pushConfigured ? await gmailClient() : null;
  const enrichOne = sharedGmail ? (id) => enrich(sharedGmail, id) : undefined;
  // Resolve (and create-if-missing) the nested topic labels once at boot, from
  // the two parent ids in env. Best-effort: if the client isn't up or Gmail
  // hiccups, Ronnie runs with attention-only labels rather than not at all.
  let labels;
  if (sharedGmail) {
    try {
      // Interesting and General (the old Bulk label, same id) come from env.
      // Priority, Records and Meetings are newer parents: use the env id when it
      // is set, else create the label by name. Then resolve the nested children.
      const parent = async (envId, name) =>
        envId || (await ensureLabels([name], { gmail: sharedGmail })).ids[name];
      labels = await resolveRonnieLabels({
        gmail: sharedGmail,
        priorityId: await parent(process.env.RONNIE_LABEL_PRIORITY, "Priority"),
        interestingId: process.env.RONNIE_LABEL_INTERESTING,
        recordsId: await parent(process.env.RONNIE_LABEL_RECORDS, "Records"),
        generalId: process.env.RONNIE_LABEL_BULK,
        meetingsId: await parent(process.env.RONNIE_LABEL_MEETINGS, "Meetings"),
        create: true,
      });
      if (labels.created?.length) console.log(`🏷️  created ${labels.created.length} topic label(s): ${labels.created.join(", ")}`);
    } catch (err) {
      console.error(`⚠️  Ronnie label resolution failed (topics disabled): ${err.message}`);
    }
  }
  ronnie = makeRonnie({ brokerUrl: ronnieBroker.url, brokerToken: ronnieBroker.token, enrichOne, labels });
  console.log("🧰 Ronnie is on — inbound mail is queued, triaged, labelled, and pinged");

  if (ronnie && sharedGmail) {
    // Load the durable work queue. Runs before the listener so it can't race a
    // live drain.
    await ronnie.queue.load();

    // A periodic sweep is what re-probes held mail during a Haiku outage — the
    // breaker's cooldown only matters if something calls drain() again. A no-op
    // when the queue is empty. Plus one kick at boot to drain what's queued.
    const sweepMs = Number(process.env.RONNIE_SWEEP_MS) || 60_000;
    const sweep = setInterval(() => ronnie.drain().catch(() => {}), sweepMs);
    sweep.unref?.();
    ronnie.drain().catch((err) => console.error(`⚠️  Ronnie boot drain failed: ${err.message}`));
  }
}

// The inbound-mail listener. Like the broker, it's optional: with no topic /
// subscription / service-account key it logs that it's off and returns null,
// so a box without the cloud setup runs exactly as before. A failure to start
// (bad key, unreachable Pub/Sub) is logged and swallowed — mail is an add-on,
// not a reason to take the whole bot down. Ronnie is the only consumer: with it
// off the listener does not start, so each drain enqueues new ids and kicks the
// consumer.
startMailListener({ gmail: sharedGmail, enqueue: ronnie?.enqueue, onDrained: ronnie?.drain }).catch((err) =>
  console.error(`⚠️  Gmail push listener failed to start: ${err.message}`)
);

// SMS and phone calls over Telnyx. Each is off unless configured. They share
// one webhook server, which binds loopback only. A tunnel forwards the public
// URL to it (see env.example). A failure to start is logged and swallowed —
// both are add-ons, like mail.
//
// The v2 call pipeline adds one signed route (call events) and the media
// WebSocket upgrade to the same server. A bad pipeline config is logged, and
// SMS and v1 calls still start.
let voicePipeline = null;
// The talker prompt for engine "openai". A missing file keeps the default in
// telnyx/realtime.js. Each call adds its briefing to it
// (VOICE_OPENAI.buildInstructions); without one, it is the whole prompt.
function readPhoneVoicePrompt() {
  try {
    return readFileSync(path.join(AGENT_DIR, "phone-voice.md"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
if (voicePipelineConfigured) {
  let localSpeech;
  try {
    // The sidecar loads its models once (a few seconds) and stays up. If it
    // stops, the client starts it again. It never stops the bot.
    if (VOICE_PIPELINE_ENGINE === "local") localSpeech = startLocalSpeech({ config: VOICE_LOCAL_CONFIG });
    voicePipeline = makeVoicePipeline({
      publicUrl: VOICE_PUBLIC_URL,
      token: VOICE_PIPELINE_TOKEN,
      publicKey: TELNYX_PUBLIC_KEY,
      apiKey: TELNYX_API_KEY,
      allowFrom: VOICE_ALLOWED_NUMBERS,
      ourNumber: TELNYX_PHONE_NUMBER,
      normalize: normalizeNumber,
      onTurn: onCallTurn,
      voice: VOICE_PIPELINE_VOICE,
      ttsRate: VOICE_PIPELINE_TTS_RATE,
      requireSignature: VOICE_PIPELINE_SIGNED_MEDIA,
      fillerMs: VOICE_FILLER_MS,
      fillerRepeatMs: VOICE_FILLER_REPEAT_MS,
      engine: VOICE_PIPELINE_ENGINE,
      localSpeech,
      streamReply: VOICE_STREAM_REPLY,
      // 2B only, passed through to telnyx/realtime.js like onLate.
      realtime: VOICE_PIPELINE_ENGINE === "openai" ? {
        apiKey: OPENAI_API_KEY,
        instructions: readPhoneVoicePrompt(),
        onLate: onLateCallAnswer,
        onCallEvent: logCallEvent,
        ...VOICE_OPENAI,
      } : {},
    });
  } catch (err) {
    localSpeech?.stop();
    console.error(`⚠️  Call pipeline v2 is off: ${err.message}`);
  }
} else if (VOICE_PIPELINE_TOKEN) {
  console.warn("⚠️  Call pipeline v2 is off — set VOICE_PUBLIC_URL, TELNYX_API_KEY, TELNYX_PUBLIC_KEY, and VOICE_ALLOWED_NUMBERS");
}
if (smsConfigured || voiceConfigured || voicePipeline) {
  startTelnyxWebhook({
    port: SMS_WEBHOOK_PORT,
    publicKey: TELNYX_PUBLIC_KEY,
    routes: {
      ...(smsConfigured ? {
        "/telnyx/messaging": makeMessagingRoute({
          ourNumber: TELNYX_PHONE_NUMBER,
          allowFrom: SMS_ALLOWED_NUMBERS,
          onText: onSmsText,
        }),
      } : {}),
      ...(voicePipeline ? voicePipeline.routes : {}),
    },
    httpRoutes: {
      ...(mediaHost ? { [MEDIA_ROUTE]: (req, res) => mediaHost.route(req, res) } : {}),
      ...(voiceConfigured ? makeVoiceLlmRoutes({
        token: VOICE_LLM_TOKEN,
        allowFrom: VOICE_ALLOWED_NUMBERS,
        normalize: normalizeNumber,
        onTurn: onCallTurn,
        fillerMs: VOICE_FILLER_MS,
        fillerRepeatMs: VOICE_FILLER_REPEAT_MS,
        backgroundAudio: path.join(REPO_DIR, "telnyx", "assets", "whoosh.mp3"),
      }) : {}),
    },
  })
    .then((hook) => {
      if (smsConfigured) console.log(`📱 SMS is on — Telnyx webhook on ${hook.url}/telnyx/messaging${SMS_MIRROR_CHANNEL ? ", mirrored to Discord" : ""}, ${mediaHost ? `MMS files served for ${SMS_PUBLIC_URL}` : "reply files Discord-only (no SMS_PUBLIC_URL)"}`);
      if (voiceConfigured) console.log(`📞 Calls are on — model endpoint on ${hook.url}/telnyx/voice/v1${VOICE_MIRROR_CHANNEL ? ", mirrored to Discord" : ""}`);
      if (voicePipeline) {
        hook.server.on("upgrade", voicePipeline.handleUpgrade);
        console.log(
          `📞 Call pipeline ${{ local: "v3 (local speech)", openai: "2B (OpenAI Realtime, Alfred as a tool)" }[voicePipeline.engine] || "v2 (Telnyx speech)"} is on — ` +
            `events on ${hook.url}${VOICE_EVENTS_PATH}, media socket for ${VOICE_PUBLIC_URL}` +
            (voicePipeline.engine === "openai" ? "" : VOICE_STREAM_REPLY ? ", streamed replies" : "")
        );
      }
    })
    .catch((err) => console.error(`⚠️  Telnyx webhook failed to start: ${err.message}`));
}
if (!smsConfigured && (TELNYX_API_KEY || TELNYX_PUBLIC_KEY || TELNYX_PHONE_NUMBER)) {
  console.warn("⚠️  SMS is off — set TELNYX_API_KEY, TELNYX_PUBLIC_KEY, TELNYX_PHONE_NUMBER, and SMS_ALLOWED_NUMBERS");
}

// An unreachable network rejects here. Left unhandled it becomes an uncaught
// exception and a full stack dump — which, at one restart every 5s, is how a
// single outage produced 380k restarts and a 186 MB log. Exit quietly with a
// distinct code so the supervisor can tell "no network yet" from "broken" and
// back off accordingly.
const EX_TEMPFAIL = 75;
client.login(DISCORD_TOKEN).catch((err) => {
  const transient = err?.code === "EAI_AGAIN" || err?.code === "ENOTFOUND" || err?.code === "ENETUNREACH";
  if (transient) {
    console.error(`🌐 Can't reach Discord (${err.code}) — exiting for the supervisor to retry`);
    process.exit(EX_TEMPFAIL);
  }
  console.error(`❌ Discord login failed: ${err?.message || err}`);
  process.exit(1);
});
