// Ronnie's usage dashboard — a self-contained HTML view of Haiku cost + tokens.
//
// Replaces the old matplotlib PNG. Reads the meter's log (agent/var/
// ronnie-usage.jsonl, one {ts,in,out,model,cost} per Haiku call) and renders a
// weekly + monthly breakdown in the "modernist" design system (imported from a
// Claude Design project): Archivo, zero-radius, uppercase headings, a blue
// accent, stat cards + an area/line chart + a summary table. No build step, no
// runtime deps, no external fetches — the font is inlined as a data URI, so the
// same file renders as a Discord attachment, offline, or a published artifact.
//
// Cost is the official-rate ESTIMATE (a subscription has no per-call bill), the
// same basis the meter uses: RONNIE_HAIKU_IN_RATE / _OUT_RATE, USD per 1M.
//
// Usage:  ronnie-dashboard.mjs <usage.jsonl> <out.html> [--fragment]
//   --fragment emits style+markup only (for embedding / publishing as an
//   artifact); the default emits a full standalone HTML document.
// Prints a one-line summary to stdout for the caller's daily-note breadcrumb.

import { readFile, writeFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const IN_RATE = Number(process.env.RONNIE_HAIKU_IN_RATE) || 1.0;
const OUT_RATE = Number(process.env.RONNIE_HAIKU_OUT_RATE) || 5.0;
const HERE = path.dirname(fileURLToPath(import.meta.url));

const estCost = (inTok, outTok) => (inTok / 1e6) * IN_RATE + (outTok / 1e6) * OUT_RATE;

function fmtUsd(n) {
  if (!n) return "$0.00";
  if (n >= 1) return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return "$" + n.toFixed(4); // tiny per-day sums need the precision
}
function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function loadRows(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((r) => r && typeof r.ts === "number");
}

const startOfDay = (ts) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const DAY = 86400000;

// Sum the rows whose ts falls in [from, to).
function bucket(rows, from, to) {
  let calls = 0,
    inTok = 0,
    outTok = 0;
  for (const r of rows) {
    if (r.ts >= from && r.ts < to) {
      calls++;
      inTok += r.in || 0;
      outTok += r.out || 0;
    }
  }
  return { calls, inTok, outTok, cost: estCost(inTok, outTok) };
}

// Build one period (a set of equal-width buckets, oldest → newest).
function buildPeriod({ label, rangeLabel, chartUnitLabel, dayCount, buckets }) {
  const costs = buckets.map((b) => b.data.cost);
  const max = Math.max(0, ...costs);
  const totalCost = buckets.reduce((s, b) => s + b.data.cost, 0);
  const totalIn = buckets.reduce((s, b) => s + b.data.inTok, 0);
  const totalOut = buckets.reduce((s, b) => s + b.data.outTok, 0);
  const totalTokens = totalIn + totalOut;

  const n = buckets.length;
  const pts = buckets.map((b, i) => {
    const x = n === 1 ? 50 : (i / (n - 1)) * 100;
    const y = max > 0 ? 100 - (b.data.cost / max) * 96 : 100;
    return { x, y, label: b.label, valueLabel: fmtUsd(b.data.cost) };
  });
  const linePoints = pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  const areaPoints = `0,100 ${linePoints} 100,100`;

  return {
    label,
    rangeLabel,
    chartUnitLabel,
    dayCount,
    totalCostLabel: fmtUsd(totalCost),
    avgDailyCostLabel: fmtUsd(totalCost / dayCount),
    totalTokensLabel: fmtTokens(totalTokens),
    tokenBreakdownLabel: `~${fmtTokens(Math.round(totalTokens / dayCount))} / day`,
    peakLabel: fmtUsd(max),
    axisTopLabel: fmtUsd(max),
    axisMidLabel: fmtUsd(max / 2),
    bars: pts,
    linePoints,
    areaPoints,
  };
}

function computePeriods(rows, now) {
  const today = startOfDay(now);

  // Weekly: the last 7 calendar days, oldest → newest.
  const weekBuckets = [];
  for (let i = 6; i >= 0; i--) {
    const from = today - i * DAY;
    weekBuckets.push({
      label: new Date(from).toLocaleDateString("en-US", { weekday: "short" }),
      data: bucket(rows, from, from + DAY),
    });
  }
  const weekly = buildPeriod({
    label: "Weekly",
    rangeLabel: "Last 7 days",
    chartUnitLabel: "by day",
    dayCount: 7,
    buckets: weekBuckets,
  });

  // Monthly: the last 4 seven-day windows, oldest → newest.
  const monthBuckets = [];
  for (let k = 3; k >= 0; k--) {
    const to = today - k * 7 * DAY + DAY; // inclusive of that window's last day
    const from = to - 7 * DAY;
    monthBuckets.push({
      label: new Date(from).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      data: bucket(rows, from, to),
    });
  }
  const monthly = buildPeriod({
    label: "Monthly",
    rangeLabel: "Last 4 weeks",
    chartUnitLabel: "by week",
    dayCount: 28,
    buckets: monthBuckets,
  });

  return [weekly, monthly];
}

function periodSection(p) {
  const cards = `
    <div class="stat-grid">
      <div class="card stat"><div class="card-kicker">Total cost (est.)</div><div class="stat-num">${p.totalCostLabel}</div><div class="card-meta">${esc(p.rangeLabel)}</div></div>
      <div class="card stat"><div class="card-kicker">Avg. daily cost</div><div class="stat-num">${p.avgDailyCostLabel}</div><div class="card-meta">across ${p.dayCount} days</div></div>
      <div class="card stat"><div class="card-kicker">Total tokens</div><div class="stat-num">${p.totalTokensLabel}</div><div class="card-meta">${esc(p.tokenBreakdownLabel)}</div></div>
    </div>`;

  const dots = p.bars
    .map((b) => `<div class="dot" style="left:${b.x}%; top:${b.y}%;"></div>`)
    .join("");
  const axis = p.bars
    .map(
      (b) =>
        `<div class="axcol"><div class="axval">${b.valueLabel}</div><div class="axlab">${esc(b.label)}</div></div>`
    )
    .join("");

  return `
  <section class="period">
    <div class="period-head">
      <h2>${esc(p.label)}</h2>
      <span class="period-range">${esc(p.rangeLabel)}</span>
    </div>
    ${cards}
    <div class="card chart-card">
      <div class="chart-head">
        <div class="card-kicker">Cost ${esc(p.chartUnitLabel)}</div>
        <div class="chart-peak">peak ${p.peakLabel}</div>
      </div>
      <div class="chart-row">
        <div class="yaxis"><span>${p.axisTopLabel}</span><span>${p.axisMidLabel}</span><span>$0</span></div>
        <div class="plot-wrap">
          <div class="plot">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none">
              <line x1="0" y1="4" x2="100" y2="4" class="grid"></line>
              <line x1="0" y1="52" x2="100" y2="52" class="grid"></line>
              <line x1="0" y1="100" x2="100" y2="100" class="baseline"></line>
              <polygon points="${p.areaPoints}" class="area"></polygon>
              <polyline points="${p.linePoints}" class="line"></polyline>
            </svg>
            ${dots}
          </div>
          <div class="xaxis">${axis}</div>
        </div>
      </div>
    </div>
  </section>`;
}

function render(periods, { fontDataUri, generatedLabel, totalCallsLabel }) {
  const table = periods
    .map(
      (p) =>
        `<tr><td>${esc(p.label)}</td><td>${p.totalCostLabel}</td><td>${p.avgDailyCostLabel}</td><td>${p.totalTokensLabel}</td></tr>`
    )
    .join("");

  const style = `<style>
@font-face { font-family: "Archivo"; font-style: normal; font-weight: 100 900; font-display: swap; src: url(${fontDataUri}) format("woff2"); }
:root {
  --bg:#f3f2f2; --surface:#eae9e9; --text:#201e1d;
  --divider: color-mix(in srgb, #201e1d 40%, transparent);
  --n300:#d7d3d3; --n600:#7d7979; --n700:#605d5d;
  --accent:#1f4fd8; --accent-100:#e9eefc; --accent-800:#112a75;
  --fh:"Archivo", system-ui, sans-serif;
  --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:20px; --s6:24px; --s8:32px; --s10:48px;
}
* { box-sizing: border-box; }
.rd-root { background: var(--bg); color: var(--text); font-family: var(--fh); min-height: 100%; margin: 0;
  -webkit-font-smoothing: antialiased; }
.rd-root h1, .rd-root h2 { font-family: var(--fh); font-weight: 800; margin: 0; line-height: 1.05; letter-spacing: -0.02em; text-transform: uppercase; }
.nav { display:flex; align-items:center; justify-content:space-between; gap:var(--s4);
  padding: var(--s3) var(--s6); border-bottom: 2px solid var(--divider); }
.nav-brand { font-weight: 800; font-size: 18px; }
.nav-sub { font-family: var(--fh); text-transform: uppercase; letter-spacing: .06em; font-size: 13px; }
.wrap { max-width: 1120px; margin: 0 auto; padding: var(--s8) var(--s6) var(--s10); }
.head { display:flex; align-items:flex-end; justify-content:space-between; gap:var(--s6);
  border-bottom: 2px solid var(--text); padding-bottom: var(--s4); margin-bottom: var(--s8); }
.head h1 { font-size: 44px; margin-bottom: var(--s2); }
.head p { margin: 0; max-width: 520px; color: var(--n700); }
.tag { display:inline-flex; align-items:center; font-size:11px; letter-spacing:.02em; padding:3px 10px; flex:none;
  background: var(--accent-100); color: var(--accent-800); }
.period { margin-bottom: var(--s10); }
.period-head { display:flex; align-items:baseline; justify-content:space-between;
  border-bottom: 2px solid var(--divider); padding-bottom: var(--s3); margin-bottom: var(--s6); }
.period-head h2 { font-size: 22px; }
.period-range { color: var(--n600); font-size: 14px; }
.stat-grid { display:grid; grid-template-columns: repeat(3, 1fr); gap: var(--s4); margin-bottom: var(--s4); }
.card { background: var(--surface); padding: var(--s3); }
.stat { border-top: 2px solid var(--accent); padding: var(--s4); }
.card-kicker { font-size:10px; letter-spacing:.1em; text-transform:uppercase; color: var(--accent); }
.stat-num { font-family: var(--fh); font-weight: 800; font-size: 36px; line-height: 1.05; margin-top: var(--s2); }
.card-meta { font-size: 11px; color: var(--n600); margin-top: var(--s1); }
.chart-card { padding: var(--s6); }
.chart-head { display:flex; align-items:baseline; justify-content:space-between; margin-bottom: var(--s5); }
.chart-peak { font-size:12px; color: var(--n600); }
.chart-row { display:flex; gap: var(--s4); }
.yaxis { display:flex; flex-direction:column; justify-content:space-between; height:170px; font-size:11px;
  color: var(--n600); text-align:right; flex:none; }
.plot-wrap { flex:1; min-width:0; }
.plot { position:relative; height:170px; }
.plot svg { width:100%; height:170px; display:block; overflow:visible; }
.grid { stroke: var(--n300); stroke-width:1; vector-effect:non-scaling-stroke; }
.baseline { stroke: var(--text); stroke-width:2; vector-effect:non-scaling-stroke; }
.area { fill: var(--accent-100); }
.line { fill:none; stroke: var(--accent); stroke-width:2; vector-effect:non-scaling-stroke; }
.dot { position:absolute; width:8px; height:8px; background: var(--accent); transform: translate(-50%,-50%); }
.xaxis { display:flex; margin-top: var(--s3); border-top: 1px solid var(--divider); padding-top: var(--s2); }
.axcol { flex:1; text-align:center; }
.axval { font-family: var(--fh); font-weight: 600; font-size: 13px; }
.axlab { font-size:11px; color: var(--n600); text-transform:uppercase; letter-spacing:.06em; margin-top:2px; }
.hr { height:2px; border:0; background: var(--divider); margin: var(--s8) 0; }
.table { width:100%; border-collapse:collapse; font-size:14px; }
.table th { text-align:left; font-size:11px; letter-spacing:.08em; text-transform:uppercase; color: var(--n600);
  padding: var(--s2); border-bottom: 2px solid var(--divider); }
.table td { padding: var(--s2); border-bottom: 1px solid var(--divider); }
.foot { margin-top: var(--s6); color: var(--n600); font-size: 12px; }
.table-num { font-variant-numeric: tabular-nums; }
@media (max-width: 640px) { .stat-grid { grid-template-columns: 1fr; } .head h1 { font-size: 32px; } }
</style>`;

  const body = `<div class="rd-root">
  <div class="nav"><div class="nav-brand">Alfred · Ronnie</div><div class="nav-sub">Haiku Usage &amp; Cost</div></div>
  <div class="wrap">
    <div class="head">
      <div><h1>Costs &amp; Tokens</h1><p>Estimated spend and token usage for inbound-mail triage, weekly and monthly.</p></div>
      <span class="tag">Live data${totalCallsLabel ? " · " + esc(totalCallsLabel) : ""}</span>
    </div>
    ${periods.map(periodSection).join("")}
    <hr class="hr">
    <table class="table"><thead><tr><th>Period</th><th>Total cost (est.)</th><th>Avg. daily cost</th><th>Total tokens</th></tr></thead>
    <tbody class="table-num">${table}</tbody></table>
    <p class="foot">${esc(generatedLabel)} · estimated at $${IN_RATE}/$${OUT_RATE} per 1M tokens (API-equivalent; a subscription has no per-call bill).</p>
  </div>
</div>`;

  return { style, body };
}

async function main() {
  const args = process.argv.slice(2);
  const fragment = args.includes("--fragment");
  const [usageFile, outHtml] = args.filter((a) => !a.startsWith("--"));
  if (!usageFile || !outHtml) {
    console.error("usage: ronnie-dashboard.mjs <usage.jsonl> <out.html> [--fragment]");
    return 2;
  }

  const rows = await loadRows(usageFile);
  const now = Date.now();
  const periods = computePeriods(rows, now);

  const fontB64 = (await readFile(path.join(HERE, "assets", "archivo-variable.woff2"))).toString("base64");
  const fontDataUri = `data:font/woff2;base64,${fontB64}`;
  const generatedLabel = `Generated ${new Date(now).toLocaleString("en-US")}`;
  const totalCalls = rows.length;
  const totalCallsLabel = `${totalCalls} call${totalCalls === 1 ? "" : "s"} logged`;

  const { style, body } = render(periods, { fontDataUri, generatedLabel, totalCallsLabel });

  const html = fragment
    ? `${style}\n${body}\n`
    : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ronnie · Haiku usage</title>${style}</head><body style="margin:0">${body}</body></html>\n`;

  await writeFile(outHtml, html);

  const wk = periods[0];
  console.log(
    `${totalCalls} Haiku call(s) · this week ${wk.totalCostLabel} est / ${wk.totalTokensLabel} tokens · dashboard → ${path.basename(outHtml)}`
  );
  return 0;
}

process.exit(await main());
