import "dotenv/config";
import { Client, GatewayIntentBits, Partials, AttachmentBuilder } from "discord.js";
import { spawn } from "child_process";
import { readFile, writeFile, mkdir, appendFile } from "fs/promises";
import { existsSync, openSync, statSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { startBroker } from "./google/broker.js";
import { NOTION_ROUTES } from "./notion/broker.js";

// ── Config ──────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "").split(",").filter(Boolean);
const TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || "120000"); // 2 min default

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
// logs/<firstTs>_to_<lastTs>.jsonl (UTC, filename-safe), excluding the /clear
// command itself, then reset the live transcript so the next conversation
// starts clean. Returns the archive path, or null if there was nothing to save.
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
    .filter(Boolean)
    // drop the /clear command line — we want the messages *before* it
    .filter((e) => !(e.dir === "in" && /^\/(clear|c)$/i.test((e.text || "").trim())));

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
  const today = new Date().toISOString().split("T")[0];
  const dailyAbs = path.join(MEMORIES_DIR, "dailies", `${today}.md`);
  const dailyRel = agentRel(dailyAbs);
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
      timeout: TIMEOUT_MS,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code, signal) => {
      if (code !== 0) {
        console.error(`⚠️  Claude exited ${code}${signal ? ` (${signal})` : ""}: ${stderr}`);
      }

      // spawn's `timeout` kills the child rather than returning an error, so a
      // timeout otherwise arrived as an empty/garbled reply. Report it plainly.
      if (signal && !stdout.trim()) {
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
let downSince = null;

function restartProcess(reason) {
  console.error(`🔄 Restarting bot: ${reason}`);
  process.exit(1); // start-alfred.sh's `while true` loop relaunches us
}

// discord.js has given up on the session and won't reconnect on its own.
client.on("invalidated", () => restartProcess("Discord session invalidated"));
client.on("error", (err) => console.error(`⚠️  Client error: ${err?.message || err}`));
client.on("shardDisconnect", (e, id) => console.warn(`⚠️  Shard ${id} disconnected (code ${e?.code}); awaiting reconnect…`));
client.on("shardReconnecting", (id) => console.warn(`… shard ${id} reconnecting`));
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

  // Strip mention and trim whitespace from the message
  const userMessage = msg.content.replace(/<@!?\d+>/g, "").trim();

  if (!userMessage) return;

  // Log the inbound turn (user → bot) before anything else, so the transcript
  // reflects arrival order even if the turn then waits its place in the queue.
  await logTurn({
    dir: "in",
    user: msg.author.tag,
    userId: msg.author.id,
    channel: msg.channelId,
    text: userMessage,
  });

  if (pendingTurns > 0) {
    console.log(`⏳ ${pendingTurns} turn(s) already in flight — queuing this one`);
    msg.react("⏳").catch(() => {}); // best-effort; needs the Add Reactions permission
  }
  await enqueueTurn(() => handleTurn(msg, userMessage));
});

// One turn at a time, in arrival order. Everything below reads and writes the
// single global state.json, so overlapping turns would resume the same session
// twice and race to write the new session id back.
async function handleTurn(msg, userMessage) {
  // Handle /clear or /c command
  const lowerMsg = userMessage.toLowerCase();
  if (lowerMsg === "/clear" || lowerMsg === "/c") {
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
    const note = archivePath ? " (archived + consolidating memory)" : "";
    await msg.reply(`🧹 Session cleared.${note} The next message will start a fresh session with full context.`);
    return;
  }

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

    let finalMessage = userMessage;
    if (shouldResume) {
      console.log(`🔄 Resuming session ${sessionId}`);
    } else {
      if (dreamed) console.log("🌙 A dream pass ran since the last turn — starting fresh to load new memory");
      console.log(`🆕 Starting new session - loading context...`);
      const context = await loadContext();
      finalMessage = context + userMessage;
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

    // Pull out any {img:}/{pdf:}/{file:} attachments, then send (Discord has a
    // 2000-char limit per message; files batch to 10 per message).
    const { text: cleaned, files } = extractAttachments(replyText);
    const reply = cleaned.trim() || (files.length ? "" : "(empty response)");
    await sendReply(msg, reply, files);

    console.log(`✅ Replied (${reply.length} chars${files.length ? `, ${files.length} file(s)` : ""})`);
    await logTurn({ dir: "out", kind: "reply", text: reply, files: files.length, sessionId: response.session_id || null });
  } catch (err) {
    console.error("❌ Error:", err);
    const errReply = `Something went wrong:\n\`\`\`\n${err.message}\n\`\`\``;
    await msg.reply(errReply);
    await logTurn({ dir: "out", kind: "error", text: errReply, error: err.message });
  } finally {
    clearInterval(typingInterval);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
async function loadContext() {
  const today = new Date().toISOString().split("T")[0];

  // SOUL lives with the agent's tracked config; the rest is personal state.
  // Paths are labelled relative to AGENT_DIR so Alfred can reopen any of these
  // files itself — the labels double as working paths from its cwd.
  const files = [
    { path: path.join(AGENT_DIR, "SOUL.md"), label: "SOUL" },
    { path: path.join(STATE_DIR, "USER.md"), label: "USER" },
    { path: path.join(MEMORIES_DIR, "MEMORY.md"), label: "LONG_TERM_MEMORY" },
    { path: path.join(MEMORIES_DIR, "dailies", `${today}.md`), label: "DAILY_NOTES" },
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
  context += "\n=== SYSTEM CONTEXT END ===\n\nUser Message: ";
  return context;
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
// routes mount alongside Google's on the one loopback server, reached with the
// same token.
const broker = await startBroker({ extraRoutes: NOTION_ROUTES });

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
