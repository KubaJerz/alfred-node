import { Client, GatewayIntentBits, Partials } from "discord.js";
import { spawn } from "child_process";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

// ── Config ──────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "").split(",").filter(Boolean);
const AGENT_DIR = process.env.AGENT_DIR || path.resolve(".");
const TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || "120000"); // 2 min default

if (!DISCORD_TOKEN) {
  console.error("❌ Set DISCORD_TOKEN env var");
  process.exit(1);
}

// ── State management ────────────────────────────────────────────────────────
const STATE_FILE = path.join(AGENT_DIR, "state.json");

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
        // Fallback: treat raw stdout as the reply
        resolve({
          result: stdout.trim() || "(no response)",
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

client.on("messageCreate", async (msg) => {
  // Ignore own messages and other bots
  if (msg.author.bot) return;

  // Check if this is a DM or a mention in a server
  const isDM = !msg.guild;
  const isMention = msg.mentions.has(client.user);

  if (!isDM && !isMention) return;

  // Auth check
  if (ALLOWED_USER_IDS.length && !ALLOWED_USER_IDS.includes(msg.author.id)) {
    console.log(`🚫 Ignored message from unauthorized user: ${msg.author.tag} (${msg.author.id})`);
    return;
  }

  // Strip mention and trim whitespace from the message
  const userMessage = msg.content.replace(/<@!?\d+>/g, "").trim();

  if (!userMessage) return;

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
    await msg.reply("🧹 Session cleared. The next message will start a fresh session with full context.");
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

    // Update state
    await writeState({
      last_session_id: response.session_id || state.last_session_id,
      status: "open", // stays open; claude can mark resolved via daily notes
      topic: userMessage.slice(0, 100),
      timestamp: new Date().toISOString(),
    });

    // Send reply (Discord has a 2000 char limit)
    const reply = response.result || "(empty response)";
    const chunks = splitMessage(reply, 1900);
    for (const chunk of chunks) {
      await msg.reply(chunk);
    }

    console.log(`✅ Replied (${reply.length} chars)`);
  } catch (err) {
    console.error("❌ Error:", err);
    await msg.reply("Something went wrong — check the bot logs.");
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
    { path: "memories/OLD_MEMORY.md", label: "ARCHIVED_MEMORY" },
  ];

  const today = new Date().toISOString().split("T")[0];
  files.push({ path: `memories/dailies/${today}.md`, label: "DAILY_NOTES" });

  let context = "--- SYSTEM CONTEXT START ---\n";
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
  context += "\n--- SYSTEM CONTEXT END ---\n\nUser Message: ";
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
