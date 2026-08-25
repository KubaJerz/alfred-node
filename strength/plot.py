#!/usr/bin/env python3
"""Render the strength "Strength Load" figure Alfred sends to Discord.

A faithful reproduction of the editorial "Strength Load" design: a light,
print-style broadsheet on warm paper (#f9f6f3) set in Cormorant Garamond (the
big numerals + headings) and Lora (body), with hairline rules and a rust/green
zone palette. Sections: a whole-body acute:chronic hero with the 7-/28-day
averages and rest days, the ACWR zone band, a per-muscle table (30-day acute
sparkline · 7d load · plain-language change · ratio band), the 90-day total-load
chart with trend tiles, and a two-column Reading / Next writeup.

All numbers come from the `v_rolling` view — the same source `bin/strength.js
load` reports from — so the figure and the CLI never disagree.

The whole page is drawn in *design-pixel* coordinates on one inverted-y axes
(1 unit = 1px = 1pt). Layout runs twice: a measure pass sizes the tall canvas
exactly (paragraphs wrap to real widths), then a draw pass paints it.

    load = each set's reps x weight, added up  (assisting muscles count half)

Usage: python plot.py <db_path> <out_png>
"""
import os
import sys
import sqlite3
from datetime import date as _date, timedelta

import matplotlib
matplotlib.use("Agg")  # headless
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle
from matplotlib.font_manager import FontProperties

DB, OUT = sys.argv[1], sys.argv[2]

# ── palette ──────────────────────────────────────────────────────────────────
PAPER = "#f9f6f3"   # warm ground
INK   = "#111111"   # headings + numerals
BODY  = "#3d3b37"   # body text
MUTED = "#8a8781"   # labels / secondary
SUB   = "#5a5852"   # hero description
RULE  = "#d1cfcc"   # hairline = rgba(0,0,0,.16) over paper
BARBG = "#e8e6e2"   # zone-band ground
OVER  = "#9c3a26"   # rust — over / detrain / spike
SAFE  = "#4a6b47"   # green — build band

MUSCLES = ["legs", "triceps", "biceps", "shoulders", "back", "chest"]
NAME = {m: m.capitalize() for m in MUSCLES}

def zone(v):
    if v < 0.8:  return "Detrain"
    if v < 1.3:  return "Build"
    if v < 1.5:  return "Caution"
    return "Spike"

def ratio_color(v):        # green only inside the build band
    return SAFE if 0.8 <= v <= 1.3 else OVER

def mk(v):                 # marker position on the 0–2.6 zone band
    return min(max(v, 0.0), 2.6) / 2.6 * 100.0

def fmt(v):
    v = float(v)
    if v >= 10000: return f"{v/1000:.1f}k"
    if v >= 1000:  return f"{v/1000:.2f}k"
    return str(round(v))

def roll(a, i, w):
    s = n = 0
    for k in range(i - w + 1, i + 1):
        if 0 <= k < len(a):
            s += a[k]; n += 1
    return s / n if n else 0.0

def join_names(xs):
    xs = list(xs)
    if not xs:      return ""
    if len(xs) == 1: return xs[0]
    if len(xs) == 2: return f"{xs[0]} and {xs[1]}"
    return ", ".join(xs[:-1]) + " and " + xs[-1]

# ── data ─────────────────────────────────────────────────────────────────────
con = sqlite3.connect(DB)
rows = con.execute(
    "SELECT date, muscle, load, acute_7, chronic_28, trend_14 FROM v_rolling ORDER BY date"
).fetchall()
con.close()

dates = sorted({r[0] for r in rows})
di = {d: i for i, d in enumerate(dates)}
N = len(dates)
def blank(): return [0.0] * N
load    = {m: blank() for m in MUSCLES}; load["_total"] = blank()
acute   = {m: blank() for m in MUSCLES}; acute["_total"] = blank()
chronic = {m: blank() for m in MUSCLES}; chronic["_total"] = blank()
trend   = {m: blank() for m in MUSCLES}; trend["_total"] = blank()
for d, m, lo, ac, ch, tr in rows:
    if m not in load: continue
    i = di[d]
    load[m][i] = lo or 0.0; acute[m][i] = ac or 0.0
    chronic[m][i] = ch or 0.0; trend[m][i] = tr or 0.0

HAVE = N > 0
t = N - 1

def _pd(s):
    y, m, d = (int(x) for x in s.split("-")); return _date(y, m, d)
def dmy(dt):  return f"{dt.day} {dt.strftime('%b')}"           # "27 Jul"
def longdate(dt): return f"{dt.day} {dt.strftime('%B %Y')}"     # "25 August 2026"
today = _pd(dates[t]) if HAVE else _date(2026, 1, 1)

# per-muscle rollup (ranked by 7-day acute, like the design)
def delta14(m):
    p = trend[m][t - 14] if t - 14 >= 0 else 0.0
    return (trend[m][t] / p - 1) if p > 0 else 0.0

M = []
for m in MUSCLES:
    ac = acute[m][t]; ch = chronic[m][t]
    M.append(dict(key=m, name=NAME[m], acute=ac, chronic=ch,
                  acwr=(ac / ch if ch > 0 else 0.0), delta=delta14(m)))
M.sort(key=lambda r: r["acute"], reverse=True)

def change_text(r):
    if r["acute"] == 0:            return "untrained 14d"
    d = r["delta"]
    if abs(d) < 0.03:              return "held flat"
    return (f"up {round(d*100)}% in 14d" if d > 0 else f"down {round(abs(d)*100)}% in 14d")

tot = acute["_total"][t] / chronic["_total"][t] if chronic["_total"][t] > 0 else 0.0
tzone = zone(tot)
sessions = sum(1 for i in range(max(0, t - 29), t + 1) if load["_total"][i] > 0)
rest = 30 - sessions
d30 = (roll(load["_total"], t, 30) / roll(load["_total"], t - 30, 30) - 1) if roll(load["_total"], t - 30, 30) > 0 else 0.0
d90 = (roll(load["_total"], t, 30) / roll(load["_total"], t - 60, 30) - 1) if roll(load["_total"], t - 60, 30) > 0 else 0.0
def trend_word(d): return "Rising" if d > 0.05 else ("Falling" if d < -0.05 else "Flat")

overs     = [r["name"] for r in M if r["acwr"] > 1.3]
builds    = [r["name"] for r in M if 0.8 <= r["acwr"] <= 1.3]
unders    = [r["name"] for r in M if r["acute"] > 0 and r["acwr"] < 0.8]
untrained = [r["name"] for r in M if r["acute"] == 0]
n_over_word = {0: "No", 1: "One", 2: "Two", 3: "Three", 4: "Four", 5: "Five", 6: "Six"}.get(len(overs), str(len(overs)))

hero_desc = (f"The last seven days carry {tot:.1f}× the load of the last twenty‐eight. "
             f"{n_over_word} muscle group{'' if len(overs)==1 else 's'} "
             f"{'is' if len(overs)==1 else 'are'} above the build band.") if HAVE else \
            "No strength data yet. Log a lifting workout, then run a digest."

_desc = {"Spike": "well past the spike line", "Caution": "into the caution band",
         "Build": "inside the build band", "Detrain": "below the build band"}[tzone]
reading = (f"The whole‐body ratio sits at {tot:.2f}, {_desc}. "
           + (f"{join_names(overs)} {'is' if len(overs)==1 else 'are'} carrying the acute week "
              f"ahead of the base." if overs else
              "The acute week is in step with the base.")) if HAVE else \
          "Once a few workouts are logged, this reads the acute‐to‐chronic balance back in plain language."

nxt = ""
if HAVE:
    if overs:     nxt += f"Back off {join_names(overs)} this week. "
    if builds:    nxt += f"{join_names(builds)} {'is' if len(builds)==1 else 'are'} inside the build band. "
    if unders:    nxt += f"{join_names(unders)} {'has' if len(unders)==1 else 'have'} slipped low — add a set. "
    if untrained: nxt += (f"{join_names(untrained)} {'has' if len(untrained)==1 else 'have'} gone without "
                          f"recent work — bring {'it' if len(untrained)==1 else 'them'} back at half the old volume.")
    nxt = nxt.strip() or "Everything sits inside the build band — hold the line."
else:
    nxt = "—"

# ── fonts ────────────────────────────────────────────────────────────────────
FONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")
_FILES = {
    ("cg", 300): "CormorantGaramond-Light.ttf",
    ("cg", 400): "CormorantGaramond-Regular.ttf",
    ("cg", 500): "CormorantGaramond-Medium.ttf",
    ("lora", 400): "Lora-Regular.ttf",
    ("lora", 500): "Lora-Medium.ttf",
}
_CACHE = {}
def fp(fam, size, weight=400):
    fn = _FILES.get((fam, weight), _FILES[("lora", 400)])
    base = _CACHE.get(fn)
    if base is None:
        p = os.path.join(FONT_DIR, fn)
        base = FontProperties(fname=p) if os.path.exists(p) else FontProperties(family="serif")
        _CACHE[fn] = base
    o = base.copy(); o.set_size(size); return o

# ── canvas geometry ──────────────────────────────────────────────────────────
DPI = 150
PADX = 56
W = 1180 + 2 * PADX          # 1292
CL = PADX                    # content left
CR = W - PADX                # content right
CW = CR - CL                 # 1180

# muscle-table columns (gap 24), spark flexes
GAP = 24
NAME_W, LOAD_W, CHG_W, RATIO_W = 170, 92, 124, 150
SPARK_W = CW - (NAME_W + LOAD_W + CHG_W + RATIO_W) - 4 * GAP
SPARK_X = CL + NAME_W + GAP
LOAD_R  = SPARK_X + SPARK_W + GAP + LOAD_W
CHG_R   = LOAD_R + GAP + CHG_W
RG_X    = CHG_R + GAP                     # ratio group left
MBAND_W = RATIO_W - 52 - 16               # mini band width
RATIO_R = RG_X + RATIO_W                  # =CR

# ── measure/draw plumbing ────────────────────────────────────────────────────
_probe = plt.figure(figsize=(W / 72, 1)); _probe.set_dpi(DPI)
_R = _probe.canvas.get_renderer()
_K = (W / 72 * DPI) / W
R = _R
ax = None
DRAW = False
Y = 0.0

def meas(s, prop):
    w, _h, _d = R.get_text_width_height_descent(s, prop, ismath=False)
    return w / _K

def wrap(s, prop, max_w):
    out, cur = [], ""
    for word in s.split():
        trial = (cur + " " + word).strip()
        if meas(trial, prop) <= max_w or not cur: cur = trial
        else: out.append(cur); cur = word
    if cur: out.append(cur)
    return out

def rect(x, y, w, h, color, alpha=1.0):
    if DRAW and w > 0 and h > 0:
        ax.add_patch(Rectangle((x, y), w, h, facecolor=color, edgecolor="none", alpha=alpha, zorder=1))

def hline(x1, x2, y, color=RULE, lw=1.0, dash=None):
    if DRAW:
        kw = {"dashes": dash} if dash else {}
        ax.plot([x1, x2], [y, y], color=color, lw=lw, zorder=2, **kw)

def vline(x, y1, y2, color=RULE, lw=1.0, dash=None):
    if DRAW:
        kw = {"dashes": dash} if dash else {}
        ax.plot([x, x], [y1, y2], color=color, lw=lw, zorder=2, **kw)

def text(x, y, s, fam, size, weight=400, color=INK, ha="left", va="baseline"):
    if DRAW:
        ax.text(x, y, s, fontproperties=fp(fam, size, weight), color=color, ha=ha, va=va, zorder=3)

def ltext(x, y, s, size, color=MUTED, ha="left", track=0.16, weight=400):
    """Uppercase tracked label in Lora, letter-spacing = track em."""
    prop = fp("lora", size, weight)
    extra = size * track
    ws = [meas(c, prop) for c in s]
    total = sum(ws) + extra * (len(s) - 1 if s else 0)
    cx = x if ha == "left" else (x - total if ha == "right" else x - total / 2)
    if DRAW:
        for c, w in zip(s, ws):
            ax.text(cx, y, c, fontproperties=prop, color=color, ha="left", va="baseline", zorder=3)
            cx += w + extra
    return total

def zoneband(x, y, w, h, marker_pct, mkover=8):
    """The 0–2.6 ACWR band: detrain·build·caution·spike + a black marker."""
    rect(x, y, w, h, BARBG)
    segs = [(0.0, 0.308, OVER, 0.42), (0.308, 0.192, SAFE, 1.0),
            (0.50, 0.077, SAFE, 0.38), (0.577, 0.423, OVER, 1.0)]
    for off, frac, col, a in segs:
        rect(x + w * off, y, w * frac, h, col, alpha=a)
    mxp = x + w * marker_pct / 100.0
    rect(mxp - 1, y - mkover, 2, h + 2 * mkover, INK)

def sparkline(x, y, w, h, series, mx, color):
    # dashed vertical grid (every ~3 days over the 30-day window) + polyline
    n = len(series)
    for gi in range(0, n, 3):
        gx = x + (gi / (n - 1)) * w if n > 1 else x
        vline(gx, y, y + h, color="#00000033", lw=0.8, dash=(2, 3))
    if DRAW and n > 1:
        pts = [(x + (i / (n - 1)) * w, y + h - (v / mx) * h) for i, v in enumerate(series)]
        ax.plot([p[0] for p in pts], [p[1] for p in pts], color=color, lw=1.2,
                solid_capstyle="round", solid_joinstyle="round", zorder=3)

# ── the page ─────────────────────────────────────────────────────────────────
def page():
    global Y
    Y = 30

    # header
    Y += 15
    ltext(CL, Y, "STRENGTH LOAD", 15, color=INK, track=0.22)
    ltext(CR, Y, longdate(today).upper(), 12, color=MUTED, ha="right", track=0.16)
    Y += 14

    # ── hero: whole-body ratio + right-hand stats ──
    Y += 20
    hline(CL, CR, Y); Y += 44
    top = Y
    RXC = CR - 300                        # right column left edge
    # left column
    ltext(CL, top + 12, "WHOLE BODY ACUTE : CHRONIC", 12, color=MUTED, track=0.18)
    big = f"{tot:.2f}" if HAVE else "—"
    bignum_size = 116
    text(CL, top + 12 + 6 + bignum_size * 0.74, big, "cg", bignum_size, 300,
         color=ratio_color(tot) if HAVE else MUTED)
    bw = meas(big, fp("cg", bignum_size, 300))
    if HAVE:
        ltext(CL + bw + 26, top + 12 + 6 + bignum_size * 0.30, tzone.upper(), 12,
              color=ratio_color(tot), track=0.18)
    dy = top + 12 + 6 + bignum_size * 0.9 + 30
    desc_lines = wrap(hero_desc, fp("lora", 16, 400), 300)
    for ln in desc_lines:
        text(CL, dy, ln, "lora", 16, 400, color=SUB)
        dy += 26
    left_h = dy - top
    # right column: three stat rows with hairlines
    vline(RXC, top, top + 120)
    rx0 = RXC + 28
    stats = [("7-day average", fmt(acute["_total"][t]) if HAVE else "—"),
             ("28-day average", fmt(chronic["_total"][t]) if HAVE else "—"),
             ("Rest days / 30", str(rest) if HAVE else "—")]
    ry = top
    for i, (lab, val) in enumerate(stats):
        rowh = 50
        ltext(rx0, ry + 30, lab.upper(), 12, color=MUTED, track=0.18)
        text(CR, ry + 30, val, "cg", 30, 400, color=INK, ha="right")
        ry += rowh
        if i < 2: hline(rx0, CR, ry)
    Y = top + max(left_h, 150)

    # ── ACWR zone band ──
    Y += 52
    zoneband(CL, Y, CW, 8, mk(tot))
    Y += 8 + 14 + 12
    labels = [("Detrain — below 0.8", MUTED, "left"),
              ("Build 0.8–1.3", MUTED, "center-l"),
              ("Caution 1.3–1.5", MUTED, "center-r"),
              ("Spike 1.5 and above", OVER, "right")]
    ltext(CL, Y, labels[0][0].upper(), 12, color=MUTED, track=0.16)
    ltext(CL + CW * 0.34, Y, labels[1][0].upper(), 12, color=MUTED, track=0.16)
    ltext(CL + CW * 0.66, Y, labels[2][0].upper(), 12, color=MUTED, track=0.16, ha="center")
    ltext(CR, Y, labels[3][0].upper(), 12, color=OVER, ha="right", track=0.16)

    # ── by muscle ──
    Y += 112
    text(CL, Y + 40, "By muscle", "cg", 48, 300, color=INK)
    ltext(CR, Y + 34, "THIRTY-DAY WINDOW · 7D LOAD · CHANGE · RATIO", 12, color=MUTED, ha="right", track=0.16)
    Y += 52
    hline(CL, CR, Y)
    # shared sparkline scale
    D = 30
    spk = {}
    smax = 0.0
    for r in M:
        seg = [acute[r["key"]][i] for i in range(max(0, t - D + 1), t + 1)]
        seg = [0.0] * (D - len(seg)) + seg
        spk[r["key"]] = seg
        smax = max(smax, max(seg) if seg else 0.0)
    smax = smax or 1.0
    for r in M:
        rh = 82
        cy = Y + rh / 2
        gone = r["acute"] == 0
        nink = MUTED if gone else INK
        text(CL, cy + 11, r["name"], "cg", 32, 400, color=nink, va="baseline")
        if HAVE:
            sparkline(SPARK_X, cy - 19, SPARK_W, 38, spk[r["key"]], smax,
                      MUTED if gone else BODY)
            text(LOAD_R, cy + 11, fmt(r["acute"]), "cg", 32, 400, color=nink, ha="right")
            text(CHG_R, cy + 6, change_text(r), "lora", 15, 400,
                 color=MUTED if gone else BODY, ha="right")
            # mini ratio band + number
            zoneband(RG_X, cy - 3, MBAND_W, 6, mk(r["acwr"]), mkover=5)
            text(RATIO_R, cy + 9, f"{r['acwr']:.2f}", "cg", 26, 500,
                 color=ratio_color(r["acwr"]), ha="right")
        Y += rh
        hline(CL, CR, Y)
    # date axis under the sparklines
    Y += 12 + 12
    if HAVE:
        ltext(SPARK_X, Y, dmy(today - timedelta(days=D - 1)).upper(), 12, color=MUTED, track=0.16)
        ltext(SPARK_X + SPARK_W / 2, Y, dmy(today - timedelta(days=(D - 1) // 2)).upper(), 12, color=MUTED, track=0.16, ha="center")
        ltext(SPARK_X + SPARK_W, Y, dmy(today).upper(), 12, color=MUTED, track=0.16, ha="right")
    ltext(RATIO_R, Y, "RATIO", 12, color=MUTED, ha="right", track=0.16)

    # ── total load, ninety days ──
    Y += 112
    text(CL, Y + 40, "Total load, ninety days", "cg", 48, 300, color=INK)
    ltext(CR, Y + 34, "7-DAY SOLID · 28-DAY DASHED · GRID EVERY 3 DAYS", 12, color=MUTED, ha="right", track=0.16)
    Y += 52
    hline(CL, CR, Y)
    Y += 36
    chh = 240
    K = 90
    cx0, cw = CL, CW
    # grid every 3 days
    for gi in range(0, K, 3):
        gx = cx0 + (gi / (K - 1)) * cw
        vline(gx, Y, Y + chh, color="#00000022", lw=0.8, dash=(3, 5))
    div_x = cx0 + ((K - 30) / (K - 1)) * cw    # last-30 divider
    if HAVE:
        idx = range(max(0, t - K + 1), t + 1)
        ac = [acute["_total"][i] for i in idx]; ch = [chronic["_total"][i] for i in idx]
        ac = [0.0] * (K - len(ac)) + ac; ch = [0.0] * (K - len(ch)) + ch
        mx = (max(max(ac), max(ch)) or 1.0) * 1.10
        def yv(v): return Y + chh - (v / mx) * chh
        xs = [cx0 + (i / (K - 1)) * cw for i in range(K)]
        vline(div_x, Y, Y + chh, color="#00000073", lw=1.0)
        if DRAW:
            ax.plot(xs, [yv(v) for v in ch], color=MUTED, lw=1.0, dashes=(5, 5), zorder=3)
            ax.plot(xs, [yv(v) for v in ac], color=INK, lw=1.5, zorder=3)
    hline(cx0, cx0 + cw, Y + chh, color=RULE)
    ltext(div_x + 12, Y + 12, "LAST THIRTY", 12, color=MUTED, track=0.18)
    Y += chh
    # date axis
    Y += 14 + 12
    if HAVE:
        ticks = [(0, "left"), (30, "left"), (60, "left"), (K - 1, "right")]
        for ti, ha in ticks:
            tx = cx0 + (ti / (K - 1)) * cw
            dt = today - timedelta(days=(K - 1 - ti))
            ltext(tx, Y, dmy(dt).upper(), 12, color=MUTED, track=0.16, ha=ha)
    # trend tiles
    Y += 44
    hline(CL, CR, Y); Y += 22
    tiles = [("Thirty-day trend", trend_word(d30) if HAVE else "—"),
             ("Ninety-day trend", trend_word(d90) if HAVE else "—"),
             ("Sessions logged / 30", str(sessions) if HAVE else "—")]
    colw = CW / 3
    for i, (lab, val) in enumerate(tiles):
        tx = CL + i * colw
        pad = 0 if i == 0 else 28
        ltext(tx + pad, Y + 12, lab.upper(), 12, color=MUTED, track=0.18)
        text(tx + pad, Y + 12 + 56, val, "cg", 56, 300, color=INK)
        if i < 2: vline(CL + (i + 1) * colw, Y, Y + 80)
    Y += 12 + 56 + 16

    # ── reading / next ──
    Y += 112
    hline(CL, CR, Y); Y += 44
    top = Y
    colw = (CW - 56) / 2
    for ci, (lab, para) in enumerate((("Reading", reading), ("Next", nxt))):
        cx = CL + ci * (colw + 56)
        ltext(cx, top + 12, lab.upper(), 12, color=MUTED, track=0.18)
        yy = top + 12 + 26
        for ln in wrap(para, fp("lora", 17, 400), colw):
            text(cx, yy, ln, "lora", 17, 400, color=BODY)
            yy += 30
        Y = max(Y, yy)

    # ── footer ──
    Y += 96
    hline(CL, CR, Y); Y += 22
    ltext(CL, Y, "STRENGTH LOAD · THIRTY-DAY WINDOW · RATIO OF 7-DAY TO 28-DAY AVERAGE",
          12, color=MUTED, track=0.16)
    Y += 96
    return Y

# measure pass → exact height
H = page()
plt.close(_probe)

# draw pass
fig = plt.figure(figsize=(W / 72, H / 72)); fig.set_dpi(DPI)
ax = fig.add_axes([0, 0, 1, 1]); ax.set_xlim(0, W); ax.set_ylim(H, 0); ax.axis("off")
fig.patch.set_facecolor(PAPER)
rect(0, 0, W, H, PAPER)
R = fig.canvas.get_renderer()
DRAW = True
page()

fig.savefig(OUT, dpi=DPI, facecolor=PAPER)
