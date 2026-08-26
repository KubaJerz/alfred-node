import "dotenv/config";
import { Client, GatewayIntentBits, Partials, AttachmentBuilder } from "discord.js";
import { spawn } from "child_process";
import { readFile, writeFile, mkdir, appendFile } from "fs/promises";
import { existsSync, openSync, statSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { startBroker } from "./google/broker.js";
import { NOTION_ROUTES } from "./notion/broker.js";
import { INTERVALS_ROUTES } from "./intervals/broker.js";
import { openDb as openStrengthDb, insertNote } from "./strength/db.js";
import { startMailListener, migrateBacklogToQueue, enrich } from "./google/gmail-push.js";
import { gmailClient, PUBSUB_KEY_FILE } from "./google/auth.js";
import { drainMailDigest } from "./google/gmail-buffer.js";
import { RONNIE_ROUTES } from "./ronnie/broker-routes.js";
import { makeRonnie } from "./ronnie/runner.js";
import { easternDate, dailyDir, dailyNotePath, attachmentName, buildAttachmentBlock } from "./dailies.js";
import { parseClearCommand } from "./commands.js";

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
const CHAT_LOG = path.join(STATE_DIR, "messages.jsonl");

// On /clear, the live transcript is archived under LOGS_DIR and a headless
// Claude is spawned to fold it into today's daily note using MEMORY_PROMPT_FILE.
// The nightly dream.sh pass later promotes durable facts from dailies → MEMORY.md.
const LOGS_DIR = path.join(STATE_DIR, "logs");
const MEMORIES_DIR = path.join(STATE_DIR, "memories");
const MEMORY_PROMPT_FILE = path.join(AGENT_DIR, "memory-prompt.md");

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

async function logTurn(entry) {
  try {
    await appendFile(CHAT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch (err) {
    console.error(`⚠️  Failed to write ${CHAT_LOG}: ${err.message}`);
  }
}

// On /clear: copy the just-ended conversation from messages.jsonl into
// logs/<firstTs>_to_<lastTs>.jsonl (UTC, filename-safe), then reset the live
// transcript so the next conversation starts clean. The /clear command line
// never appears here — handleTurn archives *before* it logs the inbound turn,
// so the transcript holds only the real messages. Returns the archive path, or
// null if there was nothing to save.
async function archiveConversation() {
  let raw;
  try {
    raw = await readFile(CHAT_LOG, "utf-8");
  } catch {
    return null; // no transcript yet
  }

  const entries = raw
    .split("\n")
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  if (!entries.length) return null;

  const safe = (ts) => String(ts).replace(/:/g, "-"); // ':' is awkward in filenames
  const name = `${safe(entries[0].ts)}_to_${safe(entries[entries.length - 1].ts)}.jsonl`;

  await mkdir(LOGS_DIR, { recursive: true });
  const archivePath = path.join(LOGS_DIR, name);
  await writeFile(archivePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

  await writeFile(CHAT_LOG, ""); // reset live transcript for the next conversation
  return archivePath;
}

// Spawn a headless Claude to fold an archived transcript into today's daily
// note. The prompt lives in memory-prompt.md so it can change without touching
// code: `{{TRANSCRIPT}}` → archive path, `{{DAILY_PATH}}` → today's note path,
// `{{DAILY}}` → its current contents (so the pass merges instead of clobbering).
// Detached + unref'd so it never blocks the bot or dies when the bot restarts.
async function consolidateMemory(archivePath) {
  let template;
  try {
    template = (await readFile(MEMORY_PROMPT_FILE, "utf-8")).trim();
  } catch {
    console.warn(`🧠 No ${MEMORY_PROMPT_FILE} yet — skipping memory consolidation`);
    return;
  }
  if (!template) {
    console.warn(`🧠 ${MEMORY_PROMPT_FILE} is empty — skipping memory consolidation`);
    return;
  }

  // Target today's daily note. Inject its current contents so the pass appends
  // to what's there instead of overwriting. Use {{DAILY}} in the prompt, else
  // it's appended. {{DAILY_PATH}} tells the pass where to write.
  const today = easternDate();
  const dailyAbs = dailyNotePath(MEMORIES_DIR, today);
  const dailyRel = agentRel(dailyAbs);
  // The note lives in a per-day folder; make sure it exists so the pass can write.
  await mkdir(dailyDir(MEMORIES_DIR, today), { recursive: true });
  let daily = "";
  try {
    daily = (await readFile(dailyAbs, "utf-8")).trim();
  } catch {
    /* no note for today yet */
  }

  let prompt = template.includes("{{TRANSCRIPT}}")
    ? template.replaceAll("{{TRANSCRIPT}}", archivePath)
    : `${template}\n\nTranscript file: ${archivePath}`;

  prompt = prompt.replaceAll("{{DAILY_PATH}}", dailyRel);

  prompt = prompt.includes("{{DAILY}}")
    ? prompt.replaceAll("{{DAILY}}", daily || "(empty)")
    : `${prompt}\n\n=== TODAY'S DAILY NOTE (${dailyRel}) ===\n${daily || "(empty)"}\n=== END DAILY NOTE ===`;

  const args = ["-p", prompt, "--allowedTools", "Read,Write,Edit", "--dangerously-skip-permissions"];

  try {
    await mkdir(LOGS_DIR, { recursive: true });
    const logFd = openSync(path.join(LOGS_DIR, "consolidate.log"), "a");
    const proc = spawn("claude", args, {
      cwd: AGENT_DIR,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    proc.unref();
    console.log(`🧠 Spawned headless daily-note consolidation (pid ${proc.pid}) → ${archivePath}`);
  } catch (err) {
    console.error(`🧠 Failed to spawn memory consolidation: ${err.message}`);
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

function runClaude(message, sessionId) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", message,
      "--output-format", "json",
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

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code, signal) => {
      clearTimeout(killer);
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

  // Workout-log channel: a message here is a training note, not a turn for
  // Alfred. Store it immutably (keyed by the local date, so it lines up with the
  // workout's own date) for the strength interpreter, ack it, and stop. Off
  // unless STRENGTH_LOG_CHANNEL is set.
  if (STRENGTH_LOG_CHANNEL && msg.channelId === STRENGTH_LOG_CHANNEL) {
    const note = msg.content.trim();
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

  // Strip mention and trim whitespace from the message
  const userMessage = msg.content.replace(/<@!?\d+>/g, "").trim();

  // Download any files first — a file sent with no caption arrives with empty
  // content and would otherwise be dropped by the guard below before it's seen.
  const attachments = await saveInboundAttachments(msg);

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
  await enqueueTurn(() => handleTurn(msg, userMessage, attachments));
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
// twice and race to write the new session id back.
async function handleTurn(msg, userMessage, attachments = []) {
  // "/clear" / "/c" as a prefix: bare = clear and wait; "/c <text>" = clear,
  // then run <text> as the fresh session's first turn (one message does both).
  const clear = parseClearCommand(userMessage);
  if (clear) {
    console.log(`🧹 Clearing session for ${msg.author.tag}`);

    // Archive the just-ended conversation, then kick off memory consolidation.
    let archivePath = null;
    try {
      archivePath = await archiveConversation();
      if (archivePath) {
        console.log(`📦 Archived conversation → ${archivePath}`);
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
      await msg.reply(`🧹 Session cleared.${note} The next message will start a fresh session with full context.`);
      return;
    }

    // There's a message (and/or files) riding with the command. Signal the
    // clear with a reaction instead of a second message, then fall through and
    // handle the remainder as the fresh session's first turn. State is already
    // reset above, so `shouldResume` below is false and full context loads.
    msg.react("🧹").catch(() => {}); // best-effort; needs the Add Reactions permission
    userMessage = clear.remainder;
  }

  // Log the inbound turn now — after any /clear reset above — so it lands in the
  // fresh transcript rather than the one we just archived.
  await logTurn({
    dir: "in",
    user: msg.author.tag,
    userId: msg.author.id,
    channel: msg.channelId,
    text: userMessage,
    attachments: attachments.length,
  });

  console.log(`📨 ${msg.author.tag}: ${userMessage.slice(0, 100)}`);

  // Show typing indicator
  await msg.channel.sendTyping();
  const typingInterval = setInterval(() => msg.channel.sendTyping(), 8000);

  try {
    // Read current state
    const state = await readState();

    // Decide: new session or resume
    const dreamed = await dreamedSince(state);
    const shouldResume = state.status === "open" && state.last_session_id && !dreamed;
    const sessionId = shouldResume ? state.last_session_id : null;

    // Files the user sent ride with THIS message, not the session context, so
    // they reach the turn on a resumed session too (a photo dropped mid-chat is
    // the common case). Unlike the mail digest below — which is a fresh-session
    // concern and lives in loadContext — the attachment block attaches to the
    // message body. When there's no caption, give the turn a short placeholder
    // so it isn't handed an empty string.
    const attachBlock = buildAttachmentBlock(attachments);
    const messageBody = attachBlock
      ? `${attachBlock}\n\n${userMessage || "(The user sent the file(s) above with no other text.)"}`
      : userMessage;

    let finalMessage = messageBody;
    if (shouldResume) {
      console.log(`🔄 Resuming session ${sessionId}`);
    } else {
      if (dreamed) console.log("🌙 A dream pass ran since the last turn — starting fresh to load new memory");
      console.log(`🆕 Starting new session - loading context...`);
      // Tier-1 mail: drain the buffer (reads + clears it) and fold it into the
      // context of this fresh session. Only new sessions surface it — a resumed
      // conversation re-injects nothing, so buffered mail waits for the next
      // fresh start (a /clear, a dream, or a first message of the day). The
      // digest goes into finalMessage, which runClaude never logs, so it can't
      // reach messages.jsonl or the memory funnel downstream of it.
      const digest = await drainMailDigest();
      const context = await loadContext(digest);
      finalMessage = context + messageBody;
    }

    // Run Claude
    const response = await runClaude(finalMessage, sessionId);

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
      await msg.reply(response.result);
      await logTurn({ dir: "out", kind, text: response.result });
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
      await logTurn({ dir: "out", kind: "silent", text: "", sessionId: response.session_id || null });
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
    await sendReply(msg, reply, files);

    console.log(`✅ Replied (${reply.length} chars${files.length ? `, ${files.length} file(s)` : ""}${deferStrength ? ", deferred digest" : ""})`);
    await logTurn({ dir: "out", kind: "reply", text: reply, files: files.length, sessionId: response.session_id || null });

    if (deferStrength) startStrengthDigestFollowup(msg);
  } catch (err) {
    console.error("❌ Error:", err);
    const errReply = `Something went wrong:\n\`\`\`\n${err.message}\n\`\`\``;
    await msg.reply(errReply);
    await logTurn({ dir: "out", kind: "error", text: errReply, error: err.message });
  } finally {
    clearInterval(typingInterval);
  }
}

// Run the strength digest out-of-band after Alfred deferred it with
// {bg:strength}. bot.js holds the broker, so — unlike a claude-spawned detached
// run — the activity pull works here. When it lands, enqueue a follow-up turn so
// Alfred answers the original question with the freshly interpreted data. The
// digest is idempotent, so a redundant run (e.g. nothing new) is harmless.
function startStrengthDigestFollowup(msg) {
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
    enqueueTurn(() => strengthFollowupTurn(msg, { ok: code === 0, out, err }));
  });
  proc.on("error", (e) => {
    console.error(`🏋️  Deferred digest spawn error: ${e.message}`);
    enqueueTurn(() => strengthFollowupTurn(msg, { ok: false, out: "", err: e.message }));
  });
}

// The follow-up itself: resume the current session (read at run time, so a
// message that arrived meanwhile is respected) and let Alfred report the result
// in his own voice. Runs through the turn queue, so it never races a live turn.
// A concrete fallback covers the cases where there's no session or Alfred stays
// silent, so a deferred pull never ends in silence.
async function strengthFollowupTurn(msg, { ok, out, err }) {
  const fallback = ok
    ? "✅ Pulled your workout — ask me how it looks for the breakdown."
    : "⚠️ I couldn't pull your workout just now — try again in a bit.";
  try {
    const state = await readState();
    const sessionId = state.last_session_id;
    if (!sessionId) { await sendReply(msg, fallback, []); return; }

    const summary = ok
      ? `Digest output:\n${(out || "").trim().slice(0, 1000)}`
      : `It FAILED (${(err || "").trim().slice(0, 300) || "unknown error"}).`;
    const nudge =
      `[SYSTEM — not a user message: the background strength digest you started has finished. ${summary}\n\n` +
      `Answer the user's earlier request now with the freshly interpreted data (read it via the strength skill — ` +
      `load/sets are instant). Reply naturally as a follow-up; do NOT run the digest again. If it failed, say so briefly.]`;

    await msg.channel.sendTyping().catch(() => {});
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
    if (!replyText || canon(replyText) === canon(NO_REPLY)) { await sendReply(msg, fallback, []); return; }

    const { text: cleaned, files } = extractAttachments(replyText);
    const reply = cleaned.trim() || (files.length ? "" : fallback);
    await sendReply(msg, reply, files);
    console.log(`✅ Strength follow-up replied (${reply.length} chars${files.length ? `, ${files.length} file(s)` : ""})`);
    await logTurn({ dir: "out", kind: "reply", text: reply, files: files.length, sessionId: response.session_id || null });
  } catch (e) {
    console.error(`❌ Strength follow-up error: ${e.message}`);
    await sendReply(msg, fallback, []).catch(() => {});
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
async function loadContext(digest = "") {
  const today = easternDate();

  // SOUL lives with the agent's tracked config; the rest is personal state.
  // Paths are labelled relative to AGENT_DIR so Alfred can reopen any of these
  // files itself — the labels double as working paths from its cwd.
  const files = [
    { path: path.join(AGENT_DIR, "SOUL.md"), label: "SOUL" },
    { path: path.join(STATE_DIR, "USER.md"), label: "USER" },
    { path: path.join(MEMORIES_DIR, "MEMORY.md"), label: "LONG_TERM_MEMORY" },
    { path: dailyNotePath(MEMORIES_DIR, today), label: "DAILY_NOTES" },
  ];

  let context = "=== SYSTEM CONTEXT START ===\n";
  context += "The following files contain your core instructions, user preferences, and long-term memory. Use them to guide your response.\n";

  for (const file of files) {
    if (existsSync(file.path)) {
      try {
        const content = await readFile(file.path, "utf-8");
        context += `\n[FILE: ${agentRel(file.path)}]\n${content}\n`;
      } catch (e) {
        console.error(`Error reading ${agentRel(file.path)}:`, e);
      }
    }
  }
  context += "\n=== SYSTEM CONTEXT END ===\n";
  // Buffered mail rides between the system context and the user's message — a
  // delimited block the turn can read but that is clearly not the user talking.
  if (digest) context += `\n${digest}\n`;
  context += "\nUser Message: ";
  return context;
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
  const chunks = text ? splitMessage(text, 1900) : [];
  if (!files.length) {
    for (const chunk of chunks) await msg.reply(chunk);
    return;
  }
  // Leading chunks go out as plain text; the last chunk rides with the first file batch.
  for (const chunk of chunks.slice(0, -1)) await msg.reply(chunk);
  const trailing = chunks.length ? chunks[chunks.length - 1] : "";
  for (let b = 0; b < files.length; b += MAX_FILES_PER_MSG) {
    const payload = { files: files.slice(b, b + MAX_FILES_PER_MSG) };
    if (b === 0 && trailing) payload.content = trailing;
    await msg.reply(payload);
  }
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
  ronnie = makeRonnie({ brokerUrl: ronnieBroker.url, brokerToken: ronnieBroker.token, enrichOne });
  console.log("🧰 Ronnie is on — inbound mail is queued, triaged, labelled, and pinged");

  if (ronnie && sharedGmail) {
    // Load the durable work queue, then migrate anything left in the old digest
    // buffer into it (one-time, dedup-safe). Runs before the listener so it can't
    // race a live drain.
    await ronnie.queue.load();
    await migrateBacklogToQueue({ queue: ronnie.queue }).catch((err) =>
      console.error(`⚠️  Ronnie backlog migration failed: ${err.message}`)
    );

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
// not a reason to take the whole bot down. When Ronnie is on, each drain enqueues
// new ids and kicks the consumer; when off, the drain buffers for the digest.
startMailListener({ gmail: sharedGmail, enqueue: ronnie?.enqueue, onDrained: ronnie?.drain }).catch((err) =>
  console.error(`⚠️  Gmail push listener failed to start: ${err.message}`)
);

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
