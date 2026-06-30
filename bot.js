import "dotenv/config";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import { spawn } from "child_process";
import { readFile, writeFile, mkdir, appendFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

// ── Config ──────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "").split(",").filter(Boolean);
const AGENT_DIR = process.env.AGENT_DIR || path.resolve(".");
const TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || "120000"); // 2 min default

// Sentinel Alfred emits (and nothing else) when it judges a message isn't
// directed at it. The bot detects it and stays silent instead of replying.
const NO_REPLY = "<no_reply>";

if (!DISCORD_TOKEN) {
  console.error("❌ Set DISCORD_TOKEN env var");
  process.exit(1);
}

// ── State management ────────────────────────────────────────────────────────
const STATE_FILE = path.join(AGENT_DIR, "state.json");

// Append-only JSONL transcript of every turn through the bot — one JSON object
// per line, both inbound (user → bot) and outbound (bot → user). This is the
// bot's OWN log, separate from Claude Code's per-session .jsonl files.
const CHAT_LOG = path.join(AGENT_DIR, "messages.jsonl");

async function logTurn(entry) {
  try {
    await appendFile(CHAT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch (err) {
    console.error(`⚠️  Failed to write ${CHAT_LOG}: ${err.message}`);
  }
}

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

// ── Claude Code invocation ──────────────────────────────────────────────────
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
      env: { ...process.env, HOME: process.env.HOME },
      timeout: TIMEOUT_MS,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      if (code !== 0) {
        console.error(`⚠️  Claude exited ${code}: ${stderr}`);
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

  // Log the inbound turn (user → bot) before anything else.
  await logTurn({
    dir: "in",
    user: msg.author.tag,
    userId: msg.author.id,
    channel: msg.channelId,
    text: userMessage,
  });

  // Handle /clear or /c command
  const lowerMsg = userMessage.toLowerCase();
  if (lowerMsg === "/clear" || lowerMsg === "/c") {
    console.log(`🧹 Clearing session for ${msg.author.tag}`);
    await writeState({
      status: "resolved",
      last_session_id: null,
      topic: "session cleared",
      timestamp: new Date().toISOString(),
    });
    const clearReply = "🧹 Session cleared. The next message will start a fresh session with full context.";
    await msg.reply(clearReply);
    await logTurn({ dir: "out", kind: "clear", text: clearReply });
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
    const shouldResume = state.status === "open" && state.last_session_id;
    const sessionId = shouldResume ? state.last_session_id : null;

    let finalMessage = userMessage;
    if (shouldResume) {
      console.log(`🔄 Resuming session ${sessionId}`);
    } else {
      console.log(`🆕 Starting new session - loading context...`);
      const context = await loadContext();
      finalMessage = context + userMessage;
    }

    // Run Claude
    const response = await runClaude(finalMessage, sessionId);

    // Persist session continuity whether or not we end up replying.
    await writeState({
      last_session_id: response.session_id || state.last_session_id,
      status: "open", // stays open; claude can mark resolved via daily notes
      topic: userMessage.slice(0, 100),
      timestamp: new Date().toISOString(),
    });

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

    // Send reply (Discord has a 2000 char limit)
    const reply = replyText || "(empty response)";
    const chunks = splitMessage(reply, 1900);
    for (const chunk of chunks) {
      await msg.reply(chunk);
    }

    console.log(`✅ Replied (${reply.length} chars)`);
    await logTurn({ dir: "out", kind: "reply", text: reply, sessionId: response.session_id || null });
  } catch (err) {
    console.error("❌ Error:", err);
    const errReply = `Something went wrong:\n\`\`\`\n${err.message}\n\`\`\``;
    await msg.reply(errReply);
    await logTurn({ dir: "out", kind: "error", text: errReply, error: err.message });
  } finally {
    clearInterval(typingInterval);
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────
async function loadContext() {
  const files = [
    { path: "SOUL.md", label: "SOUL" },
    { path: "USER.md", label: "USER" },
    { path: "memories/MEMORY.md", label: "LONG_TERM_MEMORY" },
  ];

  const today = new Date().toISOString().split("T")[0];
  files.push({ path: `memories/dailies/${today}.md`, label: "DAILY_NOTES" });

  let context = "=== SYSTEM CONTEXT START ===\n";
  context += "The following files contain your core instructions, user preferences, and long-term memory. Use them to guide your response.\n";

  for (const file of files) {
    const filePath = path.join(AGENT_DIR, file.path);
    if (existsSync(filePath)) {
      try {
        const content = await readFile(filePath, "utf-8");
        context += `\n[FILE: ${file.path}]\n${content}\n`;
      } catch (e) {
        console.error(`Error reading ${file.path}:`, e);
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

// ── Launch ──────────────────────────────────────────────────────────────────
client.login(DISCORD_TOKEN);
