#!/usr/bin/env python3
"""Render the strength rolling-load figure.

Two stacked panels — last 30 days (top) and last 90 days (bottom) — each showing
the 7-day acute load for every muscle group. Reads the `v_rolling` view straight
from the strength SQLite DB, i.e. the same numbers `bin/strength.js load` reports,
so the figure and the CLI never disagree on the math.

    load = each set's reps x weight, added up  (assisting muscles count half)

Usage: python plot.py <db_path> <out_png>
"""
import sys
import sqlite3

import matplotlib
matplotlib.use("Agg")  # headless — no display needed
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from matplotlib.lines import Line2D
import pandas as pd

DB, OUT = sys.argv[1], sys.argv[2]

# Fixed muscle order + colours — categorical, chosen for separation (and to stay
# distinguishable for common colour-vision deficiencies).
MUSCLES = ["legs", "back", "chest", "shoulders", "biceps", "triceps"]
COLORS = {
    "legs": "#5ac38b", "back": "#4c9be8", "chest": "#ef6a3d",
    "shoulders": "#e2b13c", "biceps": "#b681e6", "triceps": "#e86aa0",
}
LABELS = {m: m.capitalize() for m in MUSCLES}

BG, PANEL, INK, MUTED, GRID = "#12151a", "#181c22", "#ece9df", "#8b929c", "#252b33"

con = sqlite3.connect(DB)
df = pd.read_sql_query(
    "SELECT date, muscle, acute_7 FROM v_rolling WHERE muscle != '_total'",
    con, parse_dates=["date"],
)
con.close()

plt.rcParams.update({
    "figure.facecolor": BG, "axes.facecolor": PANEL, "savefig.facecolor": BG,
    "text.color": INK, "axes.labelcolor": MUTED, "xtick.color": MUTED,
    "ytick.color": MUTED, "axes.edgecolor": GRID,
    "font.size": 11, "font.family": "sans-serif",
})

fig, axes = plt.subplots(2, 1, figsize=(9.5, 8.6))
fig.suptitle("Strength load · 7-day acute, by muscle",
             fontsize=16, fontweight="bold", x=0.085, ha="left", y=0.98)

if df.empty:
    for ax in axes:
        ax.text(0.5, 0.5, "No strength data yet — run a digest",
                ha="center", va="center", color=MUTED, fontsize=14, transform=ax.transAxes)
        ax.set_xticks([]); ax.set_yticks([])
else:
    latest = df["date"].max()
    for ax, days, title in [(axes[0], 30, "Last 30 days"), (axes[1], 90, "Last 90 days")]:
        start = latest - pd.Timedelta(days=days)
        win = df[df["date"] >= start]
        for m in MUSCLES:
            s = win[win["muscle"] == m].sort_values("date")
            if not s.empty:
                ax.plot(s["date"], s["acute_7"], color=COLORS[m], lw=2.2, solid_capstyle="round")
        ax.set_title(title, loc="left", color=INK, fontsize=12.5, fontweight="bold", pad=8)
        ax.grid(True, color=GRID, lw=0.8)
        ax.set_axisbelow(True)
        ax.margins(x=0.01)
        ax.set_ylim(bottom=0)
        for sp in ("top", "right"):
            ax.spines[sp].set_visible(False)
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %-d"))
        ax.set_ylabel("acute load (lb)")

# One shared legend for all six muscles, stable whether or not each has data.
handles = [Line2D([0], [0], color=COLORS[m], lw=2.6, label=LABELS[m]) for m in MUSCLES]
fig.legend(handles=handles, loc="upper center", ncol=6, frameon=False,
           bbox_to_anchor=(0.5, 0.935), handlelength=1.4, columnspacing=1.6)

fig.text(0.085, 0.02,
         "load = each set's reps × weight, added up  ·  assisting muscles count half",
         color=MUTED, fontsize=10, ha="left")

fig.tight_layout(rect=(0, 0.035, 1, 0.9))
fig.savefig(OUT, dpi=150)
