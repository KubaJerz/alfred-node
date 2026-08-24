// The figure Alfred sends. Renders a muscle's rolling-load series to a PNG: the
// 7-day acute load as a filled ember line, the 28-day chronic base as a steel
// reference, and the current ACWR as a badge. Hand-built SVG (so it reads the way
// the Iron Log does) rasterized with resvg — no browser, no canvas native build
// beyond resvg's prebuilt binary.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { rollingSeries } from "./views.js";
import { defaultDbPath } from "./db.js";

const W = 960, H = 460;
const PAD = { t: 64, r: 28, b: 46, l: 64 };
const PLOT_W = W - PAD.l - PAD.r;
const PLOT_H = H - PAD.t - PAD.b;

// Dark figure — reads well in Discord's default dark theme.
const C = {
  bg: "#12151a", panel: "#181c22", ink: "#eceadf", muted: "#7c828b",
  grid: "#242932", acute: "#ff5a33", chronic: "#6ea9ce", good: "#59c28a", warn: "#e2b93b", high: "#e0603f",
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const muscleLabel = (m) =>
  m === "_total" ? "Whole body" : m === "back" ? "Whole back" : m === "legs" ? "Whole legs" : m[0].toUpperCase() + m.slice(1);

// ACWR read: the sweet-spot band is ~0.8–1.3; below is detraining, above ~1.5 a spike.
function acwrTone(a) {
  if (a == null) return { c: C.muted, label: "—" };
  if (a < 0.8) return { c: C.chronic, label: a.toFixed(2) + " · undertrained" };
  if (a <= 1.3) return { c: C.good, label: a.toFixed(2) + " · in range" };
  if (a <= 1.5) return { c: C.warn, label: a.toFixed(2) + " · pushing" };
  return { c: C.high, label: a.toFixed(2) + " · spike" };
}

function buildSvg(series, muscle) {
  const label = muscleLabel(muscle);
  if (!series.length) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${C.bg}"/><text x="${W / 2}" y="${H / 2}" fill="${C.muted}" font-family="sans-serif" font-size="20" text-anchor="middle">No ${esc(label)} data yet</text></svg>`;
  }
  const maxY = Math.max(1, ...series.map((d) => Math.max(d.acute_7 || 0, d.chronic_28 || 0)));
  const n = series.length;
  const x = (i) => PAD.l + (n === 1 ? PLOT_W / 2 : (i / (n - 1)) * PLOT_W);
  const y = (v) => PAD.t + PLOT_H - (Math.max(0, v || 0) / maxY) * PLOT_H;

  const pts = (key) => series.map((d, i) => `${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(" ");
  const areaPts = `${PAD.l},${PAD.t + PLOT_H} ${pts("acute_7")} ${PAD.l + PLOT_W},${PAD.t + PLOT_H}`;

  // y gridlines + labels (0, mid, max)
  const grid = [0, maxY / 2, maxY].map((v) => {
    const yy = y(v).toFixed(1);
    return `<line x1="${PAD.l}" y1="${yy}" x2="${PAD.l + PLOT_W}" y2="${yy}" stroke="${C.grid}" stroke-width="1"/>` +
      `<text x="${PAD.l - 10}" y="${(+yy + 4).toFixed(1)}" fill="${C.muted}" font-family="monospace" font-size="12" text-anchor="end">${Math.round(v).toLocaleString()}</text>`;
  }).join("");

  // x date ticks (first, middle, last)
  const ticks = [0, Math.floor((n - 1) / 2), n - 1].map((i) => {
    const d = series[i].date.slice(5); // MM-DD
    return `<text x="${x(i).toFixed(1)}" y="${H - 16}" fill="${C.muted}" font-family="monospace" font-size="12" text-anchor="middle">${d}</text>`;
  }).join("");

  const cur = series[series.length - 1];
  const tone = acwrTone(cur.acwr);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${C.bg}"/>
  <text x="${PAD.l}" y="34" fill="${C.ink}" font-family="sans-serif" font-size="22" font-weight="700">${esc(label)} · rolling load</text>
  <text x="${PAD.l}" y="52" fill="${C.muted}" font-family="sans-serif" font-size="12.5">7-day acute vs 28-day chronic · load = Σ factor × reps × lb</text>
  <rect x="${W - PAD.r - 168}" y="20" width="168" height="30" rx="15" fill="${C.panel}" stroke="${tone.c}" stroke-width="1.5"/>
  <text x="${W - PAD.r - 84}" y="39" fill="${tone.c}" font-family="monospace" font-size="12.5" font-weight="700" text-anchor="middle">ACWR ${esc(tone.label)}</text>
  ${grid}
  <polygon points="${areaPts}" fill="${C.acute}" fill-opacity="0.14"/>
  <polyline points="${pts("chronic_28")}" fill="none" stroke="${C.chronic}" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round"/>
  <polyline points="${pts("acute_7")}" fill="none" stroke="${C.acute}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
  <circle cx="${x(n - 1).toFixed(1)}" cy="${y(cur.acute_7).toFixed(1)}" r="4" fill="${C.acute}"/>
  ${ticks}
  <g font-family="sans-serif" font-size="12.5">
    <rect x="${PAD.l}" y="${H - 40}" width="14" height="3" fill="${C.acute}"/>
    <text x="${PAD.l + 20}" y="${H - 34}" fill="${C.muted}">acute · 7-day</text>
    <rect x="${PAD.l + 118}" y="${H - 40}" width="14" height="3" fill="${C.chronic}"/>
    <text x="${PAD.l + 138}" y="${H - 34}" fill="${C.muted}">chronic · 28-day</text>
  </g>
</svg>`;
}

/**
 * Render a muscle's rolling-load plot to a PNG file. Returns the path (for Alfred
 * to emit as {img:path}).
 */
export function renderLoadPlot(db, { muscle = "_total", days = 90, outPath } = {}) {
  let series = rollingSeries(db, muscle);
  if (days && series.length > days) series = series.slice(-days);
  const svg = buildSvg(series, muscle);
  const png = new Resvg(svg, { background: C.bg, fitTo: { mode: "width", value: W * 2 } }).render().asPng();
  const out = outPath || path.join(path.dirname(defaultDbPath()), `strength-${muscle}.png`);
  writeFileSync(out, png);
  return out;
}

export { buildSvg, muscleLabel, acwrTone };
