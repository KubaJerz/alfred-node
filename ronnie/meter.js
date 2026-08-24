// The Haiku cost meter — "what is email triage costing us?" answered locally.
//
// Every Haiku call returns usage {input_tokens, output_tokens}; record() appends
// one line per call to agent/var/ronnie-usage.jsonl, and summarize() totals it
// into calls, tokens, and an estimated dollar cost. This is the local, immediate
// view; a dedicated ANTHROPIC_API_KEY gives the authoritative one in the Console.
//
// The rates are configurable and DEFAULT TO A BALLPARK — confirm the current
// Haiku list price and set RONNIE_HAIKU_IN_RATE / RONNIE_HAIKU_OUT_RATE (USD per
// million tokens) so the estimate matches your bill. spentTodayUSD() backs a
// daily cap the caller can enforce to fall back to grep before a runaway.

import { appendFile, readFile, mkdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const REPO_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const AGENT_DIR = process.env.AGENT_DIR || path.join(REPO_DIR, "agent");
const STATE_DIR = process.env.STATE_DIR || path.join(AGENT_DIR, "var");
const USAGE_FILE = path.join(STATE_DIR, "ronnie-usage.jsonl");

// USD per million tokens. Ballpark defaults — set the env vars from current
// pricing. Kept as separate in/out rates because output is the pricier half.
const IN_RATE = Number(process.env.RONNIE_HAIKU_IN_RATE) || 1.0;
const OUT_RATE = Number(process.env.RONNIE_HAIKU_OUT_RATE) || 5.0;

const cost = (inTok, outTok, inRate, outRate) =>
  (inTok / 1e6) * inRate + (outTok / 1e6) * outRate;

/**
 * A meter bound to a file and a pair of rates. `now` is injectable so tests
 * aren't clock-dependent.
 */
export function makeMeter({
  file = USAGE_FILE,
  inRate = IN_RATE,
  outRate = OUT_RATE,
  now = () => Date.now(),
} = {}) {
  return {
    // Fire-and-forget: a metering failure must never break triage. Awaitable if
    // the caller wants, but callers don't have to.
    async record({ input_tokens = 0, output_tokens = 0, model = "" } = {}) {
      try {
        await mkdir(path.dirname(file), { recursive: true });
        const line = JSON.stringify({ ts: now(), in: input_tokens, out: output_tokens, model });
        await appendFile(file, line + "\n");
      } catch {
        /* metering is best-effort */
      }
    },

    /** Totals over the whole log: { calls, inTokens, outTokens, estUSD }. */
    async summarize() {
      const rows = await readRows(file);
      const inTokens = rows.reduce((s, r) => s + (r.in || 0), 0);
      const outTokens = rows.reduce((s, r) => s + (r.out || 0), 0);
      return {
        calls: rows.length,
        inTokens,
        outTokens,
        estUSD: Number(cost(inTokens, outTokens, inRate, outRate).toFixed(4)),
      };
    },

    /** Estimated USD spent since local midnight — for a daily cap. */
    async spentTodayUSD() {
      const rows = await readRows(file);
      const midnight = new Date(now()).setHours(0, 0, 0, 0);
      const today = rows.filter((r) => r.ts >= midnight);
      const inTok = today.reduce((s, r) => s + (r.in || 0), 0);
      const outTok = today.reduce((s, r) => s + (r.out || 0), 0);
      return Number(cost(inTok, outTok, inRate, outRate).toFixed(4));
    },
  };
}

async function readRows(file) {
  try {
    return (await readFile(file, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export { USAGE_FILE };
