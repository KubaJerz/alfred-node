#!/usr/bin/env node
// Test calls without a phone: run the scenarios in voice-eval/scenarios.js
// against the 2B voice, score them, and save what happened.
//
//   node --env-file=.env scripts/voice-eval.mjs                     every scenario, the .env settings
//   node --env-file=.env scripts/voice-eval.mjs --only add-two,time --repeat 3
//   node --env-file=.env scripts/voice-eval.mjs --model gpt-realtime-2.1 --label full
//   node scripts/voice-eval.mjs --compare <run dir> <run dir> ...   side by side
//
// Options: --model --reasoning --eagerness --voice --noise --silent-chains 0|1
//          --only <ids> --repeat <n> --concurrency <n> --no-judge --label <name>
//          --alfred-ms <n> (how long the stand-in Alfred takes; default 4000)
//          --no-briefing  a control run: each call starts with the prompt
//                         alone (as VOICE_OPENAI_BRIEFING=0), so the brief-*
//                         scenarios show what the briefing adds
//          --no-feed      a control run: nothing reaches a call mid-call (as
//                         VOICE_OPENAI_LIVE=0), for the live-* scenarios
//
// Each run writes agent/var/voice-eval/runs/<time>-<label>/: per call a .txt
// transcript, a .json record and a .wav recording (caller left, Alfred right),
// plus summary.md and summary.json. It costs real OpenAI money: roughly
// $0.02–0.05 a call on the mini model, several times that on the full one.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL } from "../telnyx/realtime.js";
import { runOpenAICall } from "../voice-eval/openai-call.js";
import { SCENARIOS } from "../voice-eval/scenarios.js";
import { judge, scoreChecks, transcript } from "../voice-eval/score.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE = process.env.STATE_DIR || join(REPO, "agent", "var");
const HOME = join(STATE, "voice-eval");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "–");
const num = (x, unit = "") => (x == null ? "–" : `${x}${unit}`);
const mean = (xs) => {
  const v = xs.filter((x) => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
// The parts of the bill, as costLines in telnyx/realtime.js logs them.
const COST_PARTS = [
  ["voice", "her voice"],
  ["talkedOver", "of it talked over"],
  ["audioIn", "audio in, full price"],
  ["audioCached", "audio in, cached"],
  ["textIn", "text in, full price"],
  ["textCached", "text in, cached"],
  ["textOut", "text out"],
];

if (flag("compare")) {
  compare(argv.slice(argv.indexOf("--compare") + 1).filter((a) => !a.startsWith("--")));
  process.exit(0);
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("OPENAI_API_KEY is not set. Run with: node --env-file=.env scripts/voice-eval.mjs");
  process.exit(1);
}

const settings = {
  model: opt("model", process.env.VOICE_OPENAI_MODEL || DEFAULT_MODEL),
  reasoning: opt("reasoning", process.env.VOICE_OPENAI_REASONING || undefined),
  eagerness: opt("eagerness", process.env.VOICE_OPENAI_EAGERNESS || undefined),
  voice: opt("voice", process.env.VOICE_OPENAI_VOICE || undefined),
  noise: opt("noise", process.env.VOICE_OPENAI_NOISE || undefined),
  quietChains: opt("silent-chains", process.env.VOICE_OPENAI_SILENT_CHAINS ?? "1") !== "0",
  briefing: !flag("no-briefing"),
  feed: !flag("no-feed"),
};
// What a control run leaves out, for the header and the summary.
const off = [!settings.briefing && "briefing off", !settings.feed && "live feed off"].filter(Boolean).map((s) => `, ${s}`).join("");
const only = opt("only", "").split(",").filter(Boolean);
const scenarios = only.length ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;
if (only.length && scenarios.length !== only.length) {
  console.error(`Unknown scenario. Known: ${SCENARIOS.map((s) => s.id).join(", ")}`);
  process.exit(1);
}
const repeat = Number(opt("repeat", 1));
const concurrency = Number(opt("concurrency", 4));
const useJudge = !flag("no-judge");
const label = opt("label", settings.model);
const instructions = readFileSync(join(REPO, "agent", "phone-voice.md"), "utf8").trim();
const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
const outDir = join(HOME, "runs", `${stamp}-${label}`);
mkdirSync(outDir, { recursive: true });

const jobs = scenarios.flatMap((s) => Array.from({ length: repeat }, (_, n) => ({ s, n: n + 1 })));
console.log(
  `▶ ${jobs.length} test call(s): ${settings.model}, reasoning ${settings.reasoning || "default"}, ` +
    `silent chains ${settings.quietChains ? "on" : "off"}${off}, ${concurrency} at a time → ${outDir}`
);

const results = [];
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const { s, n } = jobs[next++];
    const name = repeat > 1 ? `${s.id}-${n}` : s.id;
    try {
      const record = await runOpenAICall(s, {
        apiKey,
        instructions,
        ...settings,
        ttsCache: join(HOME, "tts"),
        alfredDelayMs: Number(opt("alfred-ms", 4000)),
      });
      const score = scoreChecks(record, s);
      const grade = useJudge ? await judge(record, s) : null;
      const text = transcript(record);
      const { notion, wav, ...saved } = record;
      // The background the call started with, when it had one, before the call.
      const briefing = record.briefing ? `${record.briefing}\n\n` : "";
      writeFileSync(join(outDir, `${name}.txt`), `${s.goal}\n\n${briefing}${text}\n\n${score.checks.map((c) => `${c.pass ? "✓" : "✗"} ${c.name}`).join("\n")}\n${grade ? `\ngrader: ${JSON.stringify(grade)}\n` : ""}`);
      writeFileSync(join(outDir, `${name}.json`), JSON.stringify({ ...saved, score, grade }, null, 2));
      writeFileSync(join(outDir, `${name}.wav`), wav);
      results.push({ id: s.id, name, ms: record.ms, score, grade });
      const failed = score.checks.filter((c) => !c.pass).map((c) => c.name);
      console.log(
        `${failed.length ? "✗" : "✓"} ${name.padEnd(22)} ${score.passed}/${score.total} checks` +
          `${grade?.total != null ? `, grader ${grade.total}/8` : ""}, ${score.metrics.words} words, ` +
          `first audio ${num(score.metrics.firstAudioMs, " ms")}${failed.length ? `  — failed: ${failed.join("; ")}` : ""}`
      );
    } catch (err) {
      console.log(`⚠️  ${name}: ${err.message}`);
      results.push({ id: s.id, name, error: err.message });
      if (err.fatal) {
        console.log("⛔ Stopping the run: every call after this would fail the same way.");
        next = jobs.length;
      }
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

// ── Summary ──────────────────────────────────────────────────────────────────
const ok = results.filter((r) => r.score);
const byScenario = scenarios.map((s) => {
  const rs = ok.filter((r) => r.id === s.id);
  return {
    id: s.id,
    runs: rs.length,
    checksPassed: rs.reduce((n, r) => n + r.score.passed, 0),
    checksTotal: rs.reduce((n, r) => n + r.score.total, 0),
    allPassed: rs.filter((r) => r.score.passed === r.score.total).length,
    grader: mean(rs.map((r) => r.grade?.total)),
    words: mean(rs.map((r) => r.score.metrics.words)),
    firstAudioMs: mean(rs.map((r) => r.score.metrics.firstAudioMs)),
    usd: rs.reduce((n, r) => n + (r.score.metrics.usd || 0), 0),
    worst: rs.map((r) => r.grade?.worst).filter(Boolean),
  };
});
const totals = {
  calls: ok.length,
  errors: results.length - ok.length,
  callsAllPassed: ok.filter((r) => r.score.passed === r.score.total).length,
  checksPassed: ok.reduce((n, r) => n + r.score.passed, 0),
  checksTotal: ok.reduce((n, r) => n + r.score.total, 0),
  grader: mean(ok.map((r) => r.grade?.total)),
  words: mean(ok.map((r) => r.score.metrics.words)),
  firstAudioMs: mean(ok.map((r) => r.score.metrics.firstAudioMs)),
  usd: ok.reduce((n, r) => n + (r.score.metrics.usd || 0), 0),
  cost: costMix(ok),
};
const summary = { label, settings, stamp, totals, byScenario };
writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));

const f1 = (x) => (x == null ? "–" : x.toFixed(1));
const md = [
  `# Voice eval: ${label}`,
  "",
  `${settings.model}, reasoning ${settings.reasoning || "default"}, silent chains ${settings.quietChains ? "on" : "off"}${off}, ${stamp}`,
  "",
  `**${totals.callsAllPassed}/${totals.calls} calls passed every check** · checks ${pct(totals.checksPassed, totals.checksTotal)} · grader ${f1(totals.grader)}/8 · ${f1(totals.words)} words a call · first audio ${num(totals.firstAudioMs && Math.round(totals.firstAudioMs), " ms")} · $${totals.usd.toFixed(2)}`,
  ...(totals.cost ? ["", costText(totals.cost)] : []),
  "",
  "| scenario | all checks | checks | grader /8 | words | first audio | worst moment |",
  "|---|---|---|---|---|---|---|",
  ...byScenario.map(
    (r) =>
      `| ${r.id} | ${r.allPassed}/${r.runs} | ${pct(r.checksPassed, r.checksTotal)} | ${f1(r.grader)} | ${f1(r.words)} | ${num(r.firstAudioMs && Math.round(r.firstAudioMs), " ms")} | ${(r.worst[0] || "").replace(/\|/g, "/")} |`
  ),
].join("\n");
writeFileSync(join(outDir, "summary.md"), `${md}\n`);
console.log(`\n${md}\n\nSaved in ${outDir}`);

// Where a run's money went: each call's ¢ a minute by part and by kind of
// answer, weighted by the call's length. null when no call logged its cost.
function costMix(rs) {
  const parts = {};
  const kinds = {};
  let mins = 0;
  for (const r of rs) {
    const { costParts, costKinds } = r.score.metrics;
    if (!costParts || !r.ms) continue;
    const m = r.ms / 60000;
    mins += m;
    for (const [k, v] of Object.entries(costParts)) parts[k] = (parts[k] || 0) + v * m;
    for (const [k, v] of Object.entries(costKinds || {})) kinds[k] = (kinds[k] || 0) + v * m;
  }
  if (!mins) return null;
  const per = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v / mins]));
  return { mins, parts: per(parts), kinds: per(kinds) };
}

function costText({ mins, parts, kinds }) {
  const f = (x) => x.toFixed(2);
  const byKind = Object.entries(kinds)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${f(v)}`)
    .join(" · ");
  return (
    `Where the money went, ¢ a minute over ${mins.toFixed(1)} min of calls: her voice ${f(parts.voice)} ` +
    `(talked over ${f(parts.talkedOver)}) · audio in ${f(parts.audioIn)} full, ${f(parts.audioCached)} cached · ` +
    `text in ${f(parts.textIn)} full, ${f(parts.textCached)} cached · text out ${f(parts.textOut)}. By answer: ${byKind}`
  );
}

function compare(dirs) {
  const runs = dirs
    .map((d) => join(d, "summary.json"))
    .filter((p) => existsSync(p) || (console.error(`no summary in ${dirname(p)}`), false))
    .map((p) => JSON.parse(readFileSync(p, "utf8")));
  if (!runs.length) return;
  const ids = [...new Set(runs.flatMap((r) => r.byScenario.map((s) => s.id)))];
  const cell = (s) => (s ? `${s.allPassed}/${s.runs} · ${s.grader == null ? "–" : s.grader.toFixed(1)}` : "");
  const lines = [
    `| scenario | ${runs.map((r) => r.label).join(" | ")} |`,
    `|---|${runs.map(() => "---").join("|")}|`,
    ...ids.map((id) => `| ${id} | ${runs.map((r) => cell(r.byScenario.find((s) => s.id === id))).join(" | ")} |`),
    `| **calls passed** | ${runs.map((r) => `${r.totals.callsAllPassed}/${r.totals.calls}`).join(" | ")} |`,
    `| **checks** | ${runs.map((r) => pct(r.totals.checksPassed, r.totals.checksTotal)).join(" | ")} |`,
    `| **grader /8** | ${runs.map((r) => (r.totals.grader == null ? "–" : r.totals.grader.toFixed(1))).join(" | ")} |`,
    `| **words a call** | ${runs.map((r) => (r.totals.words == null ? "–" : r.totals.words.toFixed(0))).join(" | ")} |`,
    `| **first audio** | ${runs.map((r) => num(r.totals.firstAudioMs && Math.round(r.totals.firstAudioMs), " ms")).join(" | ")} |`,
    `| **cost** | ${runs.map((r) => `$${r.totals.usd.toFixed(2)}`).join(" | ")} |`,
    ...(runs.some((r) => r.totals.cost)
      ? COST_PARTS.map(([key, name]) => `| ${name}, ¢/min | ${runs.map((r) => (r.totals.cost ? r.totals.cost.parts[key].toFixed(2) : "–")).join(" | ")} |`)
      : []),
  ];
  console.log("Each cell: calls that passed every check / runs · grader score out of 8\n");
  console.log(lines.join("\n"));
}
