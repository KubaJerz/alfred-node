#!/usr/bin/env python3
"""Render the strength dashboard PNG Alfred sends to Discord.

This is a faithful reproduction of the "Strength Dashboard" design (a dark,
single-column mobile card): a whole-body ACWR hero with a detrain -> build ->
spike band, six per-muscle rows (each a 30-day acute sparkline + an ACWR
mini-band), a 90-day acute/chronic total chart, three trend tiles, and a plain
verdict line. The numbers come straight from the `v_rolling` view, the same
source `bin/strength.js load` reports from, so the figure and the CLI never
disagree.

The whole card is drawn in *design-pixel* coordinates on one inverted-y axes
(1 data unit = 1 px = 1 pt), so the design's box model maps directly onto
matplotlib patches and text. Archivo (the design's typeface) is bundled under
strength/fonts/ as static weight instances; we fall back to the default sans if
they are missing.

    load = each set's reps x weight, added up  (assisting muscles count half)

Usage: python plot.py <db_path> <out_png>
"""
import os
import sys
import sqlite3

import matplotlib
matplotlib.use("Agg")  # headless — no display needed
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle, Polygon
from matplotlib.font_manager import FontProperties

DB, OUT = sys.argv[1], sys.argv[2]

# ── palette (from the design) ────────────────────────────────────────────────
CARD   = "#18191b"   # card ground
INK    = "#e8e6e3"   # primary text
MUTED  = "#85817c"   # secondary label
FAINT  = "#6f6b67"   # tertiary / verdict
DIM    = "#a5a19c"   # per-muscle acute value
ACCENT = "#ec3013"   # red — accent rules
PLOT   = "#131416"   # inset chart ground
RULE   = "#33363a"   # section rule
HAIR   = "#2b2e31"   # row hairline
TILE   = "#202225"   # stat tile ground

# ACWR band segments: detrain · build · caution · spike (dim, so the white
# marker and the muscle hues read on top of them).
BAND = [("#7a3b35", 25.0), ("#3f7a56", 31.25), ("#b8863f", 12.5), ("#ec3013", 31.25)]

# Fixed muscle order + colours (Okabe-Ito-ish, chosen to stay distinguishable
# for common colour-vision deficiencies). code = the 2-letter chip label.
MUSCLES = [
    ("legs",      "LG", "#E69F00"),
    ("back",      "BK", "#56B4E9"),
    ("chest",     "CH", "#009E73"),
    ("shoulders", "SH", "#F0E442"),
    ("triceps",   "TR", "#B08CD9"),
    ("biceps",    "BI", "#7FA9E8"),
]
NAME  = {m: m.capitalize() for m, _, _ in MUSCLES}
CODE  = {m: c for m, c, _ in MUSCLES}
COLOR = {m: h for m, _, h in MUSCLES}

# status(acwr) -> (label, colour)
def status(v):
    if v < 0.8:  return ("DETRAIN", "#e08a80")
    if v < 1.3:  return ("BUILD",   "#6fcf9c")
    if v < 1.5:  return ("CAUTION", "#d9974e")
    return ("SPIKE", "#ec3013")

def band_pct(v):
    """Marker position 0..100 across the 0.4–2.0 ACWR band."""
    return (min(max(v, 0.4), 2.0) - 0.4) / 1.6 * 100.0

def fmt(v):
    v = float(v)
    if v >= 10000: return f"{v/1000:.1f}k"
    if v >= 1000:  return f"{v/1000:.2f}k"
    return str(round(v))

def pct(v):
    sign = "+" if v >= 0 else "−"
    return f"{sign}{round(abs(v)*100)}%"

def roll(a, i, w):
    """Mean of the w values of `a` ending at index i (clamped at the start)."""
    s = n = 0
    for k in range(i - w + 1, i + 1):
        if 0 <= k < len(a):
            s += a[k]; n += 1
    return s / n if n else 0.0

# ── data ─────────────────────────────────────────────────────────────────────
con = sqlite3.connect(DB)
rows = con.execute(
    "SELECT date, muscle, load, acute_7, chronic_28, trend_14 "
    "FROM v_rolling ORDER BY date"
).fetchall()
con.close()

# group into per-muscle daily series (already densified daily by the view)
dates = sorted({r[0] for r in rows})
di = {d: i for i, d in enumerate(dates)}
N = len(dates)
def blank(): return [0.0] * N
load    = {m: blank() for m, _, _ in MUSCLES}; load["_total"] = blank()
acute   = {m: blank() for m, _, _ in MUSCLES}; acute["_total"] = blank()
chronic = {m: blank() for m, _, _ in MUSCLES}; chronic["_total"] = blank()
trend   = {m: blank() for m, _, _ in MUSCLES}; trend["_total"] = blank()
for d, m, lo, ac, ch, tr in rows:
    if m not in load:
        continue
    i = di[d]
    load[m][i]    = lo or 0.0
    acute[m][i]   = ac or 0.0
    chronic[m][i] = ch or 0.0
    trend[m][i]   = tr or 0.0

HAVE_DATA = N > 0
t = N - 1  # "today" index

# ── fonts ────────────────────────────────────────────────────────────────────
FONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")
_FILES = {400: "Archivo-Regular.ttf", 600: "Archivo-SemiBold.ttf",
          700: "Archivo-Bold.ttf"}
_CACHE = {}
def fp(size, weight=400):
    path = os.path.join(FONT_DIR, _FILES.get(weight, _FILES[400]))
    key = _FILES.get(weight, _FILES[400])
    base = _CACHE.get(key)
    if base is None:
        base = FontProperties(fname=path) if os.path.exists(path) else FontProperties(family="sans-serif", weight=weight)
        _CACHE[key] = base
    out = base.copy(); out.set_size(size); return out

# ── canvas ───────────────────────────────────────────────────────────────────
# 1 design px = 1 pt = 1 data unit. figsize in inches = px/72; the axes fills the
# figure; y is inverted so we lay the card out top-to-bottom like the HTML.
W = 420
PAD = 16                      # card side padding
CX = PAD                      # content left
CW = W - 2 * PAD              # content width = 388

# Row heights are fixed, so the total height is deterministic given the verdict
# line count; compute the layout math first, then size the figure.
ROW_H = 79
N_ROWS = len(MUSCLES)

def wrap(text, prop, max_w, renderer):
    """Greedy word-wrap to fit max_w design-px (used for the verdict)."""
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if meas(trial, prop, renderer) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur); cur = w
    if cur: lines.append(cur)
    return lines

# We need a renderer to measure text (letter-spacing + wrapping). Build a probe
# figure to get one, then build the real figure once the height is known.
_probe = plt.figure(figsize=(W / 72, 1)); _probe.set_dpi(200)
_R = _probe.canvas.get_renderer()
_K = (W / 72 * 200) / W       # display px per design px

def meas(s, prop, renderer=None):
    r = renderer or _R
    w, _h, _d = r.get_text_width_height_descent(s, prop, ismath=False)
    return w / _K              # -> design px

# verdict text + height
if HAVE_DATA:
    rank = sorted(MUSCLES, key=lambda mc: acute[mc[0]][t], reverse=True)
    stt = {m: status(acute[m][t] / chronic[m][t] if chronic[m][t] > 0 else 0.0) for m, _, _ in MUSCLES}
    tot_acwr = acute["_total"][t] / chronic["_total"][t] if chronic["_total"][t] > 0 else 0.0
    tS = status(tot_acwr)[0]
    hot  = [NAME[m] for m, _, _ in MUSCLES if stt[m][0] in ("SPIKE", "CAUTION")]
    cold = [NAME[m] for m, _, _ in MUSCLES if stt[m][0] == "DETRAIN"]
    verdict = f"Overall {tS.lower()} at {tot_acwr:.2f}. "
    if hot:  verdict += "Back off: " + ", ".join(hot) + ". "
    if cold: verdict += "Neglected: " + ", ".join(cold) + "."
else:
    verdict = "No strength data yet — log a workout, then run a digest."
vlines = wrap(verdict.upper(), fp(9, 400), CW, _R)
VERDICT_H = 10 + max(1, len(vlines)) * 15 + 14

H = (44 + 2 + 153 + 2 + 33 + N_ROWS * ROW_H + 2 + 214 + 2 + VERDICT_H)
plt.close(_probe)

fig = plt.figure(figsize=(W / 72, H / 72)); fig.set_dpi(200)
ax = fig.add_axes([0, 0, 1, 1]); ax.set_xlim(0, W); ax.set_ylim(H, 0); ax.axis("off")
fig.patch.set_facecolor("#0d0e0f")
R = fig.canvas.get_renderer()

# ── drawing helpers ──────────────────────────────────────────────────────────
def rect(x, y, w, h, color, alpha=1.0):
    ax.add_patch(Rectangle((x, y), w, h, facecolor=color, edgecolor="none", alpha=alpha, zorder=1))

def text(x, y, s, size, weight=400, color=INK, ha="left", va="center"):
    ax.text(x, y, s, fontproperties=fp(size, weight), color=color, ha=ha, va=va, zorder=3)

def ltext(x, y, s, size, weight=400, color=INK, ha="left", va="center", track=0.0):
    """Text with CSS-style letter-spacing (`track` em). Places each glyph so the
    tracked micro-labels read like the design instead of default kerning."""
    prop = fp(size, weight)
    extra = size * track
    widths = [meas(ch, prop, R) for ch in s]
    total = sum(widths) + extra * (len(s) - 1 if s else 0)
    start = x if ha == "left" else (x - total if ha == "right" else x - total / 2)
    cx = start
    for ch, w in zip(s, widths):
        ax.text(cx, y, ch, fontproperties=prop, color=color, ha="left", va=va, zorder=3)
        cx += w + extra

def band(x, y, w, h, marker_pct, gap, over):
    """The 4-segment ACWR band + white marker. `over` = px the marker over/undershoots."""
    n = len(BAND)
    inner = w - gap * (n - 1)
    cx = x
    for col, frac in BAND:
        seg = inner * frac / 100.0
        rect(cx, y, seg, h, col); cx += seg + gap
    mx = x + (w * marker_pct / 100.0)
    rect(mx - 1.5, y - over, 3, h + 2 * over, "#ffffff")

def arrow(x_right, cy, delta, color):
    """A small delta triangle (up / down) or neutral dash, right-edge at x_right."""
    w, h = 9, 8
    l, r = x_right - w, x_right
    if delta > 0.03:
        tri = [(l, cy + h / 2), (r, cy + h / 2), ((l + r) / 2, cy - h / 2)]
    elif delta < -0.03:
        tri = [(l, cy - h / 2), (r, cy - h / 2), ((l + r) / 2, cy + h / 2)]
    else:
        rect(l, cy - 1, w, 2, color); return
    ax.add_patch(Polygon(tri, closed=True, facecolor=color, edgecolor="none", zorder=3))

def polyline(pts, color, lw, dash=None):
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    kw = {"dashes": dash} if dash else {}
    ax.plot(xs, ys, color=color, lw=lw, solid_capstyle="round",
            solid_joinstyle="round", zorder=3, **kw)

# ═════════════════════════════════════════════════════════════════════════════
Y = 0

# ── header ──
rect(0, 0, W, 44, CARD)
ltext(PAD, 24, "STRENGTH LOAD", 13, 700, INK, track=0.16)
today = dates[-1] if HAVE_DATA else ""
ltext(W - PAD, 24, today.upper(), 11, 400, MUTED, ha="right", track=0.10)
Y = 44
rect(0, Y, W, 2, ACCENT); Y += 2

# ── whole-body ACWR hero ──
top = Y
rect(0, top, W, 153, CARD)
ky = top + 16 + 5
ltext(CX, ky, "WHOLE BODY ACWR", 10, 600, MUTED, track=0.16)
if HAVE_DATA:
    ts, tcol = status(tot_acwr)
    text(CX, ky + 34, f"{tot_acwr:.2f}", 46, 700, INK, va="center")
    numw = meas(f"{tot_acwr:.2f}", fp(46, 700), R)
    ltext(CX + numw + 12, ky + 40, ts, 13, 700, tcol, track=0.14)
    # right column
    ry = top + 16 + 8
    for i, (lab, val) in enumerate((("7d avg", fmt(acute["_total"][t])),
                                    ("28d avg", fmt(chronic["_total"][t])))):
        yy = ry + i * 17
        vw = meas(val, fp(11, 700), R)
        text(W - PAD, yy, val, 11, 700, INK, ha="right")
        text(W - PAD - vw - 5, yy, lab, 11, 400, MUTED, ha="right")
    bp = band_pct(tot_acwr)
else:
    text(CX, ky + 34, "—", 46, 700, MUTED)
    bp = 0
# band + labels
by = top + 16 + 62 + 12
band(CX, by, CW, 26, bp, gap=2, over=5)
ly = by + 26 + 5 + 6
ltext(CX, ly, "DETRAIN", 9, 400, MUTED, track=0.10)
ltext(CX + CW * 0.25, ly, "BUILD 0.8–1.3", 9, 400, MUTED, track=0.10)
ltext(W - PAD, ly, "SPIKE 1.5+", 9, 400, ACCENT, ha="right", track=0.10)
Y = top + 153
rect(0, Y, W, 2, RULE); Y += 2

# ── "by muscle" header ──
rect(0, Y, W, 33, CARD)
ltext(CX, Y + 14 + 6, "BY MUSCLE", 11, 700, INK, track=0.16)
ltext(W - PAD, Y + 14 + 6, "7D LOAD · Δ14D · ACWR", 9, 400, MUTED, ha="right", track=0.10)
Y += 33

# ── per-muscle rows ──
order = [mc[0] for mc in rank] if HAVE_DATA else [mc[0] for mc in MUSCLES]
# shared sparkline scale = max 30-day acute across muscles
D = 30
spark = {}
max_ac = 0.0
for m in order:
    seg = [acute[m][i] for i in range(max(0, t - D + 1), t + 1)]
    seg = [0.0] * (D - len(seg)) + seg
    spark[m] = seg
    max_ac = max(max_ac, max(seg) if seg else 0.0)
max_ac = max_ac or 1.0

SPARK_W = 220
MINI_X = CX + SPARK_W + 10
MINI_W = CW - SPARK_W - 10 - 34 - 10   # remaining after acwr(34) + gaps
for m in order:
    rect(0, Y, W, ROW_H, CARD)
    rect(0, Y, W, 1, HAIR)          # top hairline
    ry1 = Y + 10 + 8
    # chip
    rect(CX, ry1 - 8, 26, 16, COLOR[m])
    ltext(CX + 13, ry1, CODE[m], 9, 700, "#101112", ha="center", track=0.06)
    ltext(CX + 34, ry1, NAME[m].upper(), 13, 700, INK, track=0.10)
    if HAVE_DATA:
        ac = acute[m][t]; ch = chronic[m][t]
        acwr = ac / ch if ch > 0 else 0.0
        l14, p14 = trend[m][t], trend[m][t - 14] if t - 14 >= 0 else 0.0
        delta = (l14 / p14 - 1) if p14 > 0 else 0.0
        st, col = status(acwr)
        # acute value (right of name, before delta group of width 88)
        gx = W - PAD - 88
        text(gx - 8, ry1, fmt(ac), 13, 700, DIM, ha="right")
        # delta group, right-aligned within 88px
        dcol = "#ffffff" if delta > 0.03 else ("#e0714f" if delta < -0.03 else MUTED)
        text(W - PAD, ry1, "14D", 9, 400, "#6f6b67", ha="right")
        dw = meas(pct(delta), fp(19, 700), R)
        text(W - PAD - 22, ry1, pct(delta), 19, 700, dcol, ha="right")
        arrow(W - PAD - 22 - dw - 4, ry1, delta, dcol)
    # row 2: sparkline + mini band + acwr
    ry2 = Y + 10 + 19 + 7
    sh = 30
    rect(CX, ry2, SPARK_W, sh, PLOT)
    seg = spark[m]
    pts = [(CX + 2 + i * (SPARK_W - 4) / (D - 1), ry2 + sh - 2 - (v / max_ac) * (sh - 5))
           for i, v in enumerate(seg)]
    ax.fill([p[0] for p in pts] + [pts[-1][0], pts[0][0]],
            [p[1] for p in pts] + [ry2 + sh, ry2 + sh],
            color=COLOR[m], alpha=0.30, edgecolor="none", zorder=2)
    polyline(pts, COLOR[m], 1.6)
    mby = ry2 + (sh - 14) / 2
    if HAVE_DATA:
        band(MINI_X, mby, MINI_W, 14, band_pct(acwr), gap=1, over=3)
        text(W - PAD, ry2 + sh / 2, f"{acwr:.2f}", 12, 700, col, ha="right")
    else:
        band(MINI_X, mby, MINI_W, 14, 0, gap=1, over=3)
    Y += ROW_H

rect(0, Y, W, 2, RULE); Y += 2

# ── 90-day total load ──
top = Y
rect(0, top, W, 214, CARD)
hy = top + 14 + 6
ltext(CX, hy, "TOTAL LOAD · 90 DAYS", 11, 700, INK, track=0.16)
ltext(W - PAD, hy, "7D — · 28D ---", 9, 400, MUTED, ha="right", track=0.10)
# chart
cw, chh = CW, 104
cy = top + 14 + 11 + 10
rect(CX, cy, cw, chh, PLOT)
if HAVE_DATA:
    K = 90
    idx = range(max(0, t - K + 1), t + 1)
    ac = [acute["_total"][i] for i in idx]
    ch = [chronic["_total"][i] for i in idx]
    ac = [0.0] * (K - len(ac)) + ac
    ch = [0.0] * (K - len(ch)) + ch
    mx = (max(max(ac), max(ch)) or 1.0) * 1.12
    def cpath(arr):
        return [(CX + 4 + i * (cw - 8) / (K - 1), cy + chh - 6 - (v / mx) * (chh - 18))
                for i, v in enumerate(arr)]
    shade_x = CX + 4 + (K - 30) * (cw - 8) / (K - 1)
    rect(shade_x, cy, CX + cw - 4 - shade_x, chh, "#ffffff", alpha=0.05)
    ax.plot([shade_x, shade_x], [cy, cy + chh], color="#5c6066", lw=1, dashes=(3, 3), zorder=2)
    polyline(cpath(ch), "#7f858c", 1.6, dash=(4, 3))
    polyline(cpath(ac), INK, 2.0)
    ltext(shade_x + 6, cy + 13, "LAST 30", 9, 400, MUTED, track=0.11)
    # tiles
    d30 = (roll(load["_total"], t, 30) / roll(load["_total"], t - 30, 30) - 1) if roll(load["_total"], t - 30, 30) > 0 else 0.0
    d90 = (roll(load["_total"], t, 30) / roll(load["_total"], t - 60, 30) - 1) if roll(load["_total"], t - 60, 30) > 0 else 0.0
    rest = sum(1 for i in range(max(0, t - 29), t + 1) if load["_total"][i] == 0)
    tiles = [("30-DAY TREND", pct(d30)), ("90-DAY TREND", pct(d90)), ("REST DAYS /30", str(rest))]
else:
    text(CX + cw / 2, cy + chh / 2, "awaiting data", 12, 400, MUTED, ha="center")
    tiles = [("30-DAY TREND", "—"), ("90-DAY TREND", "—"), ("REST DAYS /30", "—")]
ty = cy + chh + 12
tw = (cw - 2 * 2) / 3
for i, (lab, val) in enumerate(tiles):
    tx = CX + i * (tw + 2)
    rect(tx, ty, tw, 47, TILE)
    ltext(tx + 10, ty + 9 + 5, lab, 9, 400, MUTED, track=0.12)
    text(tx + 10, ty + 9 + 5 + 3 + 12, val, 17, 700, INK, va="center")
Y = top + 214
rect(0, Y, W, 2, ACCENT); Y += 2

# ── verdict ──
rect(0, Y, W, VERDICT_H, CARD)
for i, line in enumerate(vlines):
    ltext(CX, Y + 10 + 6 + i * 15, line, 9, 400, FAINT, track=0.08)

fig.savefig(OUT, dpi=200, facecolor="#0d0e0f")
