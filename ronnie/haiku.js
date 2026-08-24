// The paid, smart stage: one Haiku call that decides label + a one-sentence why.
//
// Runs only on mail the deterministic stages left `undecided` (prefilter.js), so
// tokens are spent on judgement, not on newsletters a header already flagged.
// Haiku reads only sender, subject, and a short snippet — never the full body —
// because a subject and a first line are enough to judge "worth interrupting?"
// and the less content that leaves the machine for the API, the better. The code
// screen (OTP withholding) runs upstream, so credential mail never reaches here.
//
// The blast radius is why a model is acceptable at all: its only outputs are a
// label and a sentence. A prompt-injected email can, at worst, talk Haiku into
// one wrong label — a stray ping or a wrongly-filed message. It cannot reach the
// calendar (that path is DKIM-gated and deterministic) or anything that sends.
//
// Needs its own ANTHROPIC_API_KEY — a dedicated key means the Anthropic Console
// attributes every cent of triage spend to it, which is how "what is this
// costing" gets a real answer.

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.RONNIE_HAIKU_MODEL || "claude-haiku-4-5-20251001";

const RUBRIC = [
  "You triage ONE inbound email for a personal assistant. Decide if it is worth",
  "interrupting the owner right now.",
  '- "personal": a human wrote to the owner, OR an automated message that needs',
  "  the owner's attention or action soon — a real security alert, a bill or",
  "  payment due, a delivery/shipping update, a reply in a thread they are in, an",
  "  appointment or invitation, a package, a bank action that needs a decision.",
  '- "bulk": promotional or marketing mail, newsletters, digests, "you might',
  '  like", social/app notifications, and routine confirmations that need no',
  "  action (a receipt, a statement-is-ready, a transfer-completed notice).",
  "When unsure, prefer \"bulk\" — a missed newsletter costs nothing, an extra ping",
  "costs attention.",
  "",
  'Return ONLY compact JSON, no prose: {"label":"personal"|"bulk","summary":"..."}',
  'summary is ONE plain sentence for a "personal" label — what it is and why it',
  'matters. For "bulk", summary is "".',
].join("\n");

function buildContent({ from, subject, snippet }) {
  return `${RUBRIC}\n\nEmail:\nFrom: ${from || "(unknown)"}\nSubject: ${subject || "(none)"}\nSnippet: ${(snippet || "").slice(0, 500)}`;
}

// Pull the JSON object out of the model's reply, tolerating a stray code fence.
function parseVerdict(text) {
  const m = /\{[\s\S]*\}/.exec(text || "");
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const label = o.label === "personal" ? "personal" : o.label === "bulk" ? "bulk" : null;
    if (!label) return null;
    return { label, summary: label === "personal" ? String(o.summary || "").trim() : "" };
  } catch {
    return null;
  }
}

/**
 * Classify one message with Haiku. Returns { label, summary, usage } — usage is
 * {input_tokens, output_tokens} for the meter. Fails *open* to a plain "personal"
 * (surfaced, no summary) so an API blip never silently buries a real message; the
 * error is flagged for the caller to log.
 *
 * @param {{from?: string, subject?: string, snippet?: string}} msg
 */
export async function classifyWithHaiku(
  msg = {},
  { apiKey = process.env.ANTHROPIC_API_KEY, model = MODEL, fetchImpl = fetch, meter = null } = {}
) {
  if (!apiKey) return { label: "personal", summary: "", error: "no ANTHROPIC_API_KEY" };
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 120,
        temperature: 0,
        messages: [{ role: "user", content: buildContent(msg) }],
      }),
    });
    if (!res.ok) throw new Error(`Haiku ${res.status}`);
    const data = await res.json();
    if (meter && data.usage) meter.record({ ...data.usage, model });

    const text = (data.content || []).map((c) => c.text || "").join("");
    const verdict = parseVerdict(text);
    if (!verdict) throw new Error("unparseable verdict");
    return { ...verdict, usage: data.usage };
  } catch (err) {
    // Fail open: surface it (personal), no summary, flag the error.
    return { label: "personal", summary: "", error: err.message };
  }
}

export { MODEL };
