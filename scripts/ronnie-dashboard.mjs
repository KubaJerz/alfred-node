// Ronnie's usage dashboard — a self-contained HTML view of Haiku cost + tokens.
//
// Reads the meter's log (agent/var/ronnie-usage.jsonl, one {ts,in,out,model,cost}
// per Haiku call) and renders a weekly + monthly breakdown in Kuba's editorial
// design system (imported from a Claude Design project): Cormorant Garamond
// display numerals, Lora body, a warm-paper ground, hairline rules, wide-tracked
// uppercase labels, and dashed-grid area charts. No build step, no runtime deps,
// no external fetches — both serif families are inlined as data URIs, so the same
// file renders as a Discord attachment, offline, or a published artifact.
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
const DAY = 86400000;

const estCost = (inTok, outTok) => (inTok / 1e6) * IN_RATE + (outTok / 1e6) * OUT_RATE;

function fmtUsd(n) {
  if (!n) return "$0.00";
  if (n >= 1) return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return "$" + n.toFixed(4); // tiny per-day sums need the precision
}
function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
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

function bucket(rows, from, to) {
  let inTok = 0,
    outTok = 0,
    calls = 0;
  for (const r of rows) {
    if (r.ts >= from && r.ts < to) {
      calls++;
      inTok += r.in || 0;
      outTok += r.out || 0;
    }
  }
  return { calls, inTok, outTok, tokens: inTok + outTok, cost: estCost(inTok, outTok) };
}

const d1 = (ts) => new Date(ts).toLocaleDateString("en-GB", { day: "numeric" });
const dMon = (ts) => new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
function rangeLabel(fromTs, toTs) {
  const a = new Date(fromTs),
    b = new Date(toTs);
  return a.getMonth() === b.getMonth() ? `${d1(fromTs)}–${dMon(toTs)}` : `${dMon(fromTs)}–${dMon(toTs)}`;
}

// Build a period: equal-width buckets oldest → newest, plus totals + chart geometry.
function buildPeriod({ label, sub, unit, dayCount, buckets, gridId }) {
  const costs = buckets.map((b) => b.data.cost);
  const max = Math.max(0, ...costs);
  const totalCost = buckets.reduce((s, b) => s + b.data.cost, 0);
  const totalTokens = buckets.reduce((s, b) => s + b.data.tokens, 0);
  const peakIdx = costs.reduce((best, c, i) => (c > costs[best] ? i : best), 0);

  const n = buckets.length;
  const pts = buckets.map((b, i) => {
    const x = n === 1 ? 500 : Math.round((i / (n - 1)) * 1000);
    const y = max > 0 ? Math.round(200 - (b.data.cost / max) * 200) : 200;
    return { x, y, label: b.label, cost: b.data.cost, isPeak: i === peakIdx && max > 0 };
  });
  const linePoints = pts.map((p) => `${p.x},${p.y}`).join(" ");
  const areaPoints = `${linePoints} 1000,200 0,200`;

  return {
    label,
    sub,
    unit,
    dayCount,
    gridId,
    totalCostLabel: fmtUsd(totalCost),
    avgDayLabel: fmtUsd(totalCost / dayCount),
    tokensLabel: fmtTokens(totalTokens),
    tokensPerDayLabel: fmtTokens(Math.round(totalTokens / dayCount)) + " a day",
    peakLabel: fmtUsd(max),
    peakName: buckets[peakIdx]?.label || "—",
    axisTop: fmtUsd(max),
    axisMid: fmtUsd(max / 2),
    bars: pts,
    linePoints,
    areaPoints,
    totalCost,
    totalTokens,
  };
}

function computeAll(rows, now) {
  const today = startOfDay(now);

  const weekBuckets = [];
  for (let i = 6; i >= 0; i--) {
    const from = today - i * DAY;
    weekBuckets.push({ label: new Date(from).toLocaleDateString("en-US", { weekday: "short" }), data: bucket(rows, from, from + DAY) });
  }
  const weekly = buildPeriod({
    label: "Weekly",
    sub: `Last 7 days · ${rangeLabel(today - 6 * DAY, today)}`,
    unit: "day",
    dayCount: 7,
    buckets: weekBuckets,
    gridId: "gridDay",
  });

  const monthBuckets = [];
  for (let k = 3; k >= 0; k--) {
    const to = today - k * 7 * DAY + DAY;
    const from = to - 7 * DAY;
    monthBuckets.push({ label: `Week ${4 - k}`, data: bucket(rows, from, to) });
  }
  const monthly = buildPeriod({
    label: "Monthly",
    sub: `Last 4 weeks · ${rangeLabel(today - 27 * DAY, today)}`,
    unit: "week",
    dayCount: 28,
    buckets: monthBuckets,
    gridId: "gridWeek",
  });

  const totalCost = monthly.totalCost;
  const totalTokens = monthly.totalTokens;
  const hero = {
    totalCostLabel: fmtUsd(totalCost),
    totalTokensLabel: fmtTokens(totalTokens) + " tokens",
    avgDayLabel: fmtUsd(totalCost / 28),
    tokensPerDayLabel: fmtTokens(Math.round(totalTokens / 28)),
    costPer1MLabel: totalTokens > 0 ? fmtUsd(totalCost / (totalTokens / 1e6)) : "—",
  };

  return { weekly, monthly, hero, totalCost, totalTokens };
}

// ── rendering ────────────────────────────────────────────────────────────────

const L = (t) => `<span class="lbl">${esc(t)}</span>`; // wide-tracked uppercase label

function statTriplet(p) {
  const col = (label, big, sub, i) =>
    `<div class="statcol${i === 0 ? " first" : ""}${i === 2 ? " last" : ""}">${L(label)}<div class="statbig">${big}</div><div class="statsub">${esc(sub)}</div></div>`;
  return `<div class="stat3">
    ${col("Total cost", p.totalCostLabel, p.dayCount === 7 ? "seven days" : "four weeks", 0)}
    ${col("Average day", p.avgDayLabel, p.dayCount === 7 ? "across seven days" : "across twenty-eight days", 1)}
    ${col("Tokens used", p.tokensLabel, p.tokensPerDayLabel, 2)}
  </div>`;
}

function chart(p) {
  const cols = p.bars.length;
  const colClass = cols === 7 ? "cols7" : "cols4";
  const daycols = p.bars
    .map((b) => `<div class="dc"><div class="dcv${b.isPeak ? " pk" : ""}">${fmtUsd(b.cost)}</div><div class="dcl${b.isPeak ? " pk" : ""}">${esc(b.label)}</div></div>`)
    .join("");
  return `
  <div class="chartcap">${L(`Cost by ${p.unit}`)}${L(`Peak ${p.peakLabel} · ${p.peakName}`)}</div>
  <div class="chartgrid">
    <div class="yax"><span class="yt">${p.axisTop}</span><span class="ym">${p.axisMid}</span><span class="yb">$0</span></div>
    <div class="plot">
      <svg viewBox="0 0 1000 200" preserveAspectRatio="none">
        <rect x="0" y="0" width="1000" height="200" fill="url(#${p.gridId})"></rect>
        <line x1="0" y1="0" x2="1000" y2="0" class="hair" vector-effect="non-scaling-stroke"></line>
        <line x1="0" y1="100" x2="1000" y2="100" class="hair" vector-effect="non-scaling-stroke"></line>
        <polygon points="${p.areaPoints}" class="area"></polygon>
        <polyline points="${p.linePoints}" class="line" vector-effect="non-scaling-stroke"></polyline>
        <line x1="0" y1="200" x2="1000" y2="200" class="hair" vector-effect="non-scaling-stroke"></line>
      </svg>
    </div>
  </div>
  <div class="chartgrid"><div></div><div class="${colClass}">${daycols}</div></div>`;
}

function section(p) {
  return `<section class="sec">
    <div class="sechead"><h2>${esc(p.label)}</h2>${L(p.sub)}</div>
    ${statTriplet(p)}
    ${chart(p)}
  </section>`;
}

function reading(all) {
  const { weekly, monthly, hero, totalCost } = all;
  if (totalCost <= 0) {
    return {
      read: "No Haiku spend has been recorded in this window yet — the view fills in as Ronnie triages inbound mail.",
      next: "Once a few days of triage accumulate, the weekly shape and cost-per-million settle here.",
    };
  }
  const wCosts = weekly.bars.map((b) => b.cost);
  const mCosts = monthly.bars.map((b) => b.cost);
  const low = fmtUsd(Math.min(...mCosts));
  const high = fmtUsd(Math.max(...mCosts));
  return {
    read: `Spend is ${high === low ? "flat" : "uneven"} across the four weeks — ${low} at the low, ${high} at the high, a ${hero.avgDayLabel} daily average. Within the last week the weight sits on ${weekly.peakName}, which carries ${weekly.peakLabel} of the ${weekly.totalCostLabel}.`,
    next: `Cost per million tokens is ${hero.costPer1MLabel}. Watch whether the ${weekly.peakName} peak repeats next week before changing anything.`,
  };
}

function render(all, { fonts, dateLabel, callsLabel }) {
  const { hero } = all;
  const prose = reading(all);
  const style = `<style>
${fonts}
:root{
  --ink:#111; --paper:#e8e6e2; --card:#f9f6f3; --muted:#5a5852; --body:#3d3b37;
  --hair:rgba(0,0,0,.16); --label:#8a8781;
  --font-display:"Cormorant Garamond",Georgia,serif;
  --font-body:"Lora",Georgia,serif;
}
.rd-root{background:var(--card);color:var(--body);font-family:var(--font-body);
  padding:30px 56px 96px;box-sizing:border-box;min-height:100vh;-webkit-font-smoothing:antialiased}
.rd-root *{box-sizing:border-box}
.rd-wrap{max-width:1180px;margin:0 auto}
.lbl{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:var(--label)}
.rd-head{display:flex;align-items:baseline;justify-content:space-between;gap:24px;padding-bottom:14px}
.rd-eyebrow{font-size:15px;letter-spacing:.22em;text-transform:uppercase;color:var(--ink)}
.hero{display:grid;grid-template-columns:minmax(0,1fr) 300px;align-items:end;
  border-top:1px solid var(--hair);padding-top:44px}
.hero-num{font-family:var(--font-display);font-weight:300;font-size:clamp(64px,9vw,124px);
  line-height:.9;letter-spacing:-.01em;color:var(--ink)}
.hero-row{display:flex;align-items:baseline;gap:26px;margin-top:6px;flex-wrap:wrap}
.hero-p{max-width:30ch;font-size:16px;line-height:1.65;color:var(--muted);margin:18px 0 0}
.side{display:grid;border-left:1px solid var(--hair);padding-left:28px}
.side-row{display:flex;justify-content:space-between;align-items:baseline;padding:10px 0;border-bottom:1px solid var(--hair)}
.side-row.last{border-bottom:0}
.side-v{font-family:var(--font-display);font-weight:400;font-size:30px;color:var(--ink)}
.sec{margin-top:96px}
.sechead{display:flex;align-items:baseline;justify-content:space-between;border-bottom:1px solid var(--hair);padding-bottom:12px;gap:16px}
.sechead h2{font-family:var(--font-display);font-weight:300;font-size:clamp(34px,4vw,52px);line-height:1;letter-spacing:-.01em;color:var(--ink);margin:0}
.stat3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin-top:36px}
.statcol{padding:0 28px;border-right:1px solid var(--hair)}
.statcol.first{padding-left:0}
.statcol.last{padding-right:0;border-right:0}
.statbig{font-family:var(--font-display);font-weight:300;font-size:clamp(40px,5vw,56px);line-height:1.1;color:var(--ink);margin-top:2px}
.statsub{font-size:15px;color:var(--label);margin-top:4px}
.chartcap{display:flex;align-items:baseline;justify-content:space-between;margin-top:56px;gap:16px}
.chartgrid{display:grid;grid-template-columns:56px minmax(0,1fr)}
.yax{position:relative;height:230px}
.yax span{position:absolute;right:14px;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--label)}
.yt{top:-6px}.ym{top:50%;margin-top:-6px}.yb{bottom:-6px}
.plot{position:relative;height:230px;border-left:1px solid var(--hair)}
.plot svg{width:100%;height:100%;display:block;overflow:visible}
.hair{stroke:var(--hair);stroke-width:1}
.area{fill:var(--ink);opacity:.07}
.line{fill:none;stroke:var(--ink);stroke-width:1.5}
.cols7{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));padding-top:14px}
.cols4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));padding-top:14px}
.dc{text-align:center}
.dcv{font-family:var(--font-display);font-weight:400;font-size:clamp(20px,2.4vw,26px);color:var(--ink)}
.dcv.pk{font-weight:500}
.dcl{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--label);margin-top:2px}
.dcl.pk{color:var(--ink)}
.reading{margin-top:96px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:56px;border-top:1px solid var(--hair);padding-top:44px}
.reading p{font-size:17.5px;line-height:1.75;color:var(--body);max-width:62ch;margin:14px 0 0;text-wrap:pretty}
.rd-foot{margin-top:96px;border-top:1px solid var(--hair);padding-top:22px;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--label)}
@media (max-width:820px){.rd-root{padding:24px 22px 64px}.hero{grid-template-columns:1fr;gap:32px}.side{border-left:0;padding-left:0}.reading{grid-template-columns:1fr;gap:28px}}
</style>`;

  const body = `<div class="rd-root">
  <svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
    <pattern id="gridDay" width="142.857" height="200" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0" y2="200" class="hair" stroke-dasharray="3 5"></line></pattern>
    <pattern id="gridWeek" width="250" height="200" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0" y2="200" class="hair" stroke-dasharray="3 5"></line></pattern>
  </defs></svg>
  <div class="rd-wrap">
    <header class="rd-head"><span class="rd-eyebrow">Costs &amp; tokens</span>${L(`Live data · ${dateLabel}${callsLabel ? " · " + callsLabel : ""}`)}</header>

    <section class="hero">
      <div>
        ${L("Spend, last twenty-eight days")}
        <div class="hero-row"><span class="hero-num">${hero.totalCostLabel}</span>${L(hero.totalTokensLabel)}</div>
        <p class="hero-p">Estimated spend and token usage for inbound-mail triage. Four weeks of daily totals, read weekly and monthly.</p>
      </div>
      <div class="side">
        <div class="side-row">${L("Daily average")}<span class="side-v">${hero.avgDayLabel}</span></div>
        <div class="side-row">${L("Tokens / day")}<span class="side-v">${hero.tokensPerDayLabel}</span></div>
        <div class="side-row last">${L("Cost / 1M tokens")}<span class="side-v">${hero.costPer1MLabel}</span></div>
      </div>
    </section>

    ${section(all.weekly)}
    ${section(all.monthly)}

    <section class="reading">
      <div>${L("Reading")}<p>${esc(prose.read)}</p></div>
      <div>${L("Next")}<p>${esc(prose.next)}</p></div>
    </section>

    <footer class="rd-foot">Costs &amp; tokens · estimated at $${IN_RATE}/$${OUT_RATE} per 1M (API-equivalent; a subscription has no per-call bill) · ${esc(dateLabel)}</footer>
  </div>
</div>`;

  return { style, body };
}

function fontFace(name, b64, weights) {
  return `@font-face{font-family:"${name}";font-style:normal;font-weight:${weights};font-display:swap;src:url(data:font/woff2;base64,${b64}) format("woff2")}`;
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
  const all = computeAll(rows, now);

  const cg = (await readFile(path.join(HERE, "assets", "cormorant.woff2"))).toString("base64");
  const lora = (await readFile(path.join(HERE, "assets", "lora.woff2"))).toString("base64");
  const fonts = [
    fontFace("Cormorant Garamond", cg, "300 700"),
    fontFace("Lora", lora, "400 700"),
  ].join("\n");

  const dateLabel = new Date(now).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const callsLabel = `${rows.length} call${rows.length === 1 ? "" : "s"}`;

  const { style, body } = render(all, { fonts, dateLabel, callsLabel });

  const html = fragment
    ? `${style}\n${body}\n`
    : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ronnie · costs &amp; tokens</title>${style}</head><body style="margin:0">${body}</body></html>\n`;

  await writeFile(outHtml, html);

  console.log(
    `${rows.length} Haiku call(s) · 28-day ${all.hero.totalCostLabel} est / ${fmtTokens(all.totalTokens)} tokens · this week ${all.weekly.totalCostLabel} · dashboard → ${path.basename(outHtml)}`
  );
  return 0;
}

process.exit(await main());
