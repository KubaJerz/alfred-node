#!/usr/bin/env python3
"""Render Ronnie's Haiku cost/usage figure from the meter's log.

Reads agent/var/ronnie-usage.jsonl — one line per Haiku call,
{ts, in, out, model, cost} — and writes a PNG summarising what email triage
is costing: calls per day, estimated $ per day, and tokens in/out per day.

The estimate uses the official Haiku API token rates (there is no real bill on a
subscription), matching ronnie/meter.js: RONNIE_HAIKU_IN_RATE / _OUT_RATE, USD
per million tokens, default $1 in / $5 out. A one-line summary is printed to
stdout for the caller (bot.js posts it and drops it in the daily note).

Usage:  ronnie-metrics.py <usage.jsonl> <out.png>
Exits 0 with a message and no PNG when the log is empty.
"""
import json
import os
import sys
from collections import defaultdict
from datetime import datetime

IN_RATE = float(os.environ.get("RONNIE_HAIKU_IN_RATE") or 1.0)   # USD / 1M tokens
OUT_RATE = float(os.environ.get("RONNIE_HAIKU_OUT_RATE") or 5.0)


def est_cost(in_tok, out_tok):
    return in_tok / 1e6 * IN_RATE + out_tok / 1e6 * OUT_RATE


def load(path):
    rows = []
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if "ts" not in r:
                    continue
                rows.append(r)
    except FileNotFoundError:
        pass
    return rows


def main():
    if len(sys.argv) < 3:
        print("usage: ronnie-metrics.py <usage.jsonl> <out.png>", file=sys.stderr)
        return 2
    usage_file, out_png = sys.argv[1], sys.argv[2]

    rows = load(usage_file)
    if not rows:
        print("No Ronnie Haiku usage recorded yet — nothing to plot.")
        return 0

    # Bucket by local calendar day.
    per_day = defaultdict(lambda: {"calls": 0, "in": 0, "out": 0})
    for r in rows:
        day = datetime.fromtimestamp(r["ts"] / 1000).date()
        d = per_day[day]
        d["calls"] += 1
        d["in"] += r.get("in", 0) or 0
        d["out"] += r.get("out", 0) or 0

    days = sorted(per_day)
    labels = [d.isoformat()[5:] for d in days]  # MM-DD
    calls = [per_day[d]["calls"] for d in days]
    ins = [per_day[d]["in"] for d in days]
    outs = [per_day[d]["out"] for d in days]
    costs = [est_cost(per_day[d]["in"], per_day[d]["out"]) for d in days]

    total_calls = sum(calls)
    total_cost = est_cost(sum(ins), sum(outs))
    today = datetime.now().date()
    today_d = per_day.get(today)
    today_str = (
        f"today: {today_d['calls']} calls, ~${est_cost(today_d['in'], today_d['out']):.4f}"
        if today_d
        else "today: 0 calls"
    )

    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.style.use("seaborn-v0_8-darkgrid") if "seaborn-v0_8-darkgrid" in plt.style.available else None
    fig, (ax1, ax2, ax3) = plt.subplots(3, 1, figsize=(9, 9), sharex=True)
    accent, warm = "#1b6b52", "#b07a2a"

    ax1.bar(labels, calls, color=accent)
    ax1.set_ylabel("Haiku calls")
    ax1.set_title(
        f"Ronnie · Haiku usage — {total_calls} calls over {len(days)} day(s) · "
        f"~${total_cost:.4f} est · {today_str}",
        fontsize=12,
    )

    ax2.bar(labels, costs, color=warm)
    ax2.set_ylabel("est. USD / day")

    ax3.bar(labels, ins, label="input", color="#4c78a8")
    ax3.bar(labels, outs, bottom=ins, label="output", color="#e45756")
    ax3.set_ylabel("tokens / day")
    ax3.legend(loc="upper left", fontsize=9)

    for ax in (ax1, ax2, ax3):
        ax.tick_params(axis="x", labelrotation=45)
    fig.tight_layout()
    fig.savefig(out_png, dpi=120)

    print(
        f"{total_calls} Haiku calls over {len(days)} day(s) · "
        f"~${total_cost:.4f} est (@ ${IN_RATE:g}/${OUT_RATE:g} per 1M) · {today_str}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
