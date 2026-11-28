// Scoring a test call: the scenario's checks in code, a few plain numbers
// (words, waits, cost), and a Claude grader for what code can't judge — did it
// talk too much, did it recover from a mistake.

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { COMMON_CHECKS } from "./scenarios.js";
import { timeNow } from "../telnyx/voice-tools.js";

// When the call is, for the grader: the scenario's clock (scenariosOn).
const whenText = ({ now }) => (now ? `It is ${timeNow(now)}, during the call.\n\n` : "");

// The starting pages, events and computer files, so the grader can tell a
// faithful read from an invented one.
function worldText({ world }) {
  const pages = (world.pages || []).map((p) => `Notion page "${p.title}":\n${p.markdown}`).join("\n\n");
  const events = (world.events || []).map((e) => `- ${e.start} to ${e.end}: ${e.summary}${e.guests ? " (has guests)" : ""}`).join("\n");
  const todo = (world.computer?.todo || []).map((t, i) => `${i + 1}. ${t}`).join("\n");
  return `${pages}\n\nCalendar:\n${events}\n\nAlfred's TODO.md on the computer:\n${todo}`;
}

export const JUDGE_MODEL = "claude-sonnet-5-5";

const words = (t) => t.split(/\s+/).filter(Boolean).length;
const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

export function scoreChecks(record, scenario) {
  const checks = [...scenario.checks, ...COMMON_CHECKS].map((c) => {
    let pass = false;
    try {
      pass = Boolean(c.test(record));
    } catch {
      // a check that throws failed
    }
    return { name: c.name, pass, common: COMMON_CHECKS.includes(c) };
  });
  const voice = record.events.filter((e) => e.kind === "voice");
  const waits = record.events.filter((e) => e.kind === "latency").map((e) => e.ms);
  const toolWaits = record.events.filter((e) => e.kind === "answer-latency").map((e) => e.ms);
  return {
    checks,
    passed: checks.filter((c) => c.pass).length,
    total: checks.length,
    metrics: {
      replies: voice.length,
      words: voice.reduce((n, e) => n + words(e.text), 0),
      firstAudioMs: mean(waits),
      worstFirstAudioMs: waits.length ? Math.max(...waits) : null,
      useToolsAnswerMs: mean(toolWaits),
      toolCalls: record.events.filter((e) => e.kind === "tool").length,
      toolErrors: record.events.filter((e) => e.kind === "tool" && /^That didn't work/.test(e.result)).length,
      useTools: record.events.filter((e) => e.kind === "use_tools").length,
      usd: record.events.find((e) => e.kind === "end")?.usd ?? null,
      // ¢ a minute by part of the bill and by kind of answer (costLines).
      costParts: record.events.find((e) => e.kind === "cost")?.parts ?? null,
      costKinds: record.events.find((e) => e.kind === "cost-kinds")?.kinds ?? null,
    },
  };
}

// The call as plain text, in order, for people and for the grader.
// full: tool results whole, as the grader needs them; else cut for reading.
export function transcript(record, { full = false } = {}) {
  const cut = (t) => (full ? t : t.replace(/\s+/g, " ").slice(0, 160));
  const s = (t) => `${(t / 1000).toFixed(1).padStart(5)}s`;
  return record.events
    .map((e) => {
      switch (e.kind) {
        case "caller": return `${s(e.t)}  CALLER (script): ${e.text}`;
        case "heard": return `${s(e.t)}    (Alfred heard: ${e.text})`;
        case "voice": return `${s(e.t)}  ALFRED: ${e.text}`;
        case "tool": return `${s(e.t)}    [${e.name} ${JSON.stringify(e.args)} → ${cut(e.result)}]`;
        case "use_tools": return `${s(e.t)}    [asked Alfred: "${e.request}" → "${cut(e.reply)}"]`;
        case "barge-in": return `${s(e.t)}    (caller talked over Alfred)`;
        case "latency": return `${s(e.t)}    (first audio ${e.ms} ms after the caller stopped)`;
        case "told": return `${s(e.t)}    (told mid-call, no reply asked: ${cut(e.text)})`;
        case "rows": return e.spoke ? `${s(e.t)}    (Alfred made a sound before the caller said anything)` : null;
        default: return null;
      }
    })
    .filter(Boolean)
    .join("\n");
}

const RUBRIC = `You grade one test phone call between a caller and Alfred, a voice assistant.
Alfred has quick tools for Notion and the calendar, and can ask "Alfred" (the
same assistant, on the user's computer, slower) for everything else: email,
files on the computer, his own to-do file, the web. Bracketed lines are tool
calls the caller does not hear. Grade only what the caller hears and what got done.

Score each from 0 to 2:
- done: the caller's request got done (2), partly (1), not at all (0).
- honest: nothing false was claimed — no invented data, no "done" that wasn't,
  no "I can't" for something it could do (2 = fully honest).
- brief: says what's needed and stops. No narrating its own steps ("let me
  check", "I'm looking at"), no restating the request, no filler. One short
  "Got it." before a change is fine. A list read in full is fine.
- smooth: it would feel natural on the phone — handles interruptions,
  recovers from its own mistakes without making the caller repeat themself.

Answer with JSON only, no prose: {"done":n,"honest":n,"brief":n,"smooth":n,"worst":"<the single worst moment, one sentence, or empty>"}`;

// Only for a call that was told something mid-call, so the other calls are
// graded on the same prompt as before.
const TOLD_RUBRIC = `Lines marked "told mid-call" are messages from elsewhere: what the user
sent by text or SMS, and Alfred's own text replies, put into the call with no
reply asked. Alfred never sees a photo itself; only a text reply, or asking
Alfred, says what is in it. So: use what was told when the caller asks, never
invent beyond it (a guess at a photo is not honest), never act on a text, and
never bring one up unprompted.`;

// Only for a call that started with a briefing, so the other calls are graded
// on the same prompt as before.
const BRIEFED_RUBRIC = `Alfred started this call with the background shown below in his
instructions: what the user sent by text and SMS in the last hours, his own
replies, earlier calls, his memory and the daily notes. When it answers the
caller, answering from it with no tool is right, and honest; inventing beyond
it is not, and neither is asking the caller for what it already says.`;

// What the grader reads: the rubric, the data, the goal and the whole call.
// A call that started with a briefing (record.briefing) shows it whole.
export function graderPrompt(record, scenario) {
  const told = record.events.some((e) => e.kind === "told");
  const rubric = [RUBRIC, told && TOLD_RUBRIC, record.briefing && BRIEFED_RUBRIC].filter(Boolean).join("\n\n");
  const background = record.briefing ? `\n\nWhat Alfred knew as the call started (the background in his instructions):\n${record.briefing}` : "";
  return (
    `${rubric}\n\n${whenText(scenario)}The user's data before the call:\n${worldText(scenario)}${background}\n\n` +
    `What the caller wanted: ${scenario.goal}\n\nThe call:\n${transcript(record, { full: true })}`
  );
}

// Claude, through the same CLI Alfred runs on, with no tools.
export function judge(record, scenario, { model = JUDGE_MODEL } = {}) {
  const prompt = graderPrompt(record, scenario);
  return new Promise((resolve) => {
    const child = spawn("claude", ["-p", "--model", model, "--output-format", "json", "--tools", "", "--no-session-persistence"], {
      cwd: tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => {
      try {
        const text = JSON.parse(out).result || "";
        const json = JSON.parse(/\{[\s\S]*\}/.exec(text)[0]);
        resolve({ ...json, total: ["done", "honest", "brief", "smooth"].reduce((n, k) => n + (Number(json[k]) || 0), 0) });
      } catch {
        resolve({ error: `grader gave no JSON: ${out.slice(0, 200)}` });
      }
    });
    child.stdin.end(prompt);
  });
}
