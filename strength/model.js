// The headless Haiku call, shared by the two model-using steps of the strength
// pipeline: interpret (digest.js) and note routing (notes.js). Kept in its own
// module so neither imports the other just to reach the spawner.
//
// runModel is injected into both callers so their DB/validation logic is tested
// without spawning a model; the default is this — `claude -p` the way bot.js does.

import { spawn } from "node:child_process";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

// One call is a whole-session reasoning pass; observed runs land at 100-170s, so
// the old 120s cap was inside the noise. Overridable per-run.
const HAIKU_TIMEOUT_MS = parseInt(process.env.STRENGTH_INTERPRET_TIMEOUT_MS || "240000");

// Spawn a headless Haiku and return the model's text. Mirrors bot.js's runClaude
// envelope handling: --output-format json wraps the reply as {result: "..."}.
//
// We own the timer rather than using spawn's `timeout` option, for one reason:
// when that option fires, `claude` catches the SIGTERM and exits 143 with a NULL
// signal, indistinguishable from an ordinary non-zero exit. Worse, if the model
// had already flushed part of its JSON, the old code took the partial text as a
// success — a timeout could silently produce a half-labelled workout. A timeout
// is now always an error, loudly, whatever made it to stdout.
export function spawnHaiku(prompt, { timeoutMs = HAIKU_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      ["-p", prompt, "--model", HAIKU_MODEL, "--output-format", "json"],
      // Prompt rides in on `-p`; the child never reads stdin. Point it at
      // /dev/null so the CLI doesn't stall 3s waiting for piped input and then
      // emit "no stdin data received in 3s" into stderr. See bot.js runClaude.
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "", err = "", timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      // Backstop: if it ignores SIGTERM, take it out hard a moment later.
      setTimeout(() => proc.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(new Error(
          `model call TIMED OUT after ${Math.round(timeoutMs / 1000)}s — ` +
          `${out.length} bytes of partial output discarded rather than trusted. ` +
          `Raise STRENGTH_INTERPRET_TIMEOUT_MS if this repeats.`
        ));
      }
      if (code !== 0 && !out.trim()) {
        return reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
      }
      // The last valid JSON line is the result envelope; unwrap it to the text.
      let text = out;
      for (const line of out.trim().split("\n").reverse()) {
        try { text = JSON.parse(line).result ?? text; break; } catch { /* keep looking */ }
      }
      resolve(text);
    });
  });
}

// Pull the JSON object out of the model's text, tolerant of ```json fences and
// surrounding prose. Shared by both callers.
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model output");
  return JSON.parse(body.slice(start, end + 1));
}
