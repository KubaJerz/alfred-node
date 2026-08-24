---
name: intervals
description: Kuba's training and wellness data from Intervals.icu, where his Garmin activities, sleep and recovery land. Use whenever a message touches a workout or how his body is doing — how far did I run, what was my last ride, how long did I train, my pace, my power, my heart rate on that run, what workouts this week, did I train yesterday, how much have I ridden, my mileage; and recovery — how did I sleep, my sleep last night, my resting heart rate, my RHR, my HRV, am I recovered, my readiness, how's my fitness, my training load, my form, am I overtraining, my weight, my Garmin data. Use it before answering whether an activity or a day's wellness exists at all, since querying is the only way to know.
---

# Intervals.icu

    activities [--from DATE] [--to DATE] [--limit N]   completed workouts in a window
    activity <id>                                       one workout's detail
    wellness [--from DATE] [--to DATE]                  daily sleep, HRV, RHR, readiness

`node ../bin/intervals.js <command> --help` for one command in full, or `--help`
on its own for the list. The rest of this file is what `--help` can't tell you.

## It's read-only, and that's the whole shape

There is no command here that writes. You can read what Kuba did and how he
slept; you can't edit an activity, log one, change a wellness figure, or push a
planned workout to his watch. If he asks for any of that, say it isn't wired up
(the natural next add is planned-workout export) rather than looking for a flag —
there isn't one.

## Where the data comes from

Kuba wears a Garmin. It syncs to Garmin Connect, which syncs to Intervals.icu,
which is what this reads. So "my Garmin data" and "my Intervals data" are the
same thing from here, and everything is a few minutes behind the watch, not live.
A ride he hasn't finished or synced yet simply won't be there — that's a
not-yet-synced, not a missing one; say so rather than concluding it didn't
happen.

## Dates are YYYY-MM-DD, and the window defaults to 30 days

`activities` and `wellness` with no `--from`/`--to` cover the last 30 days up to
today. Give both bounds for a specific stretch — `--from 2026-08-01 --to
2026-08-07` is that week. A bare `activities` is the right reflex for "what have I
been doing lately"; reach for the flags only when he names a period.

Check the date, don't infer it: `date -d '7 days ago' +%F` beats hand-counting
back a week, and "last month" is a range worth stating back before you pull it.

## Read narrowly, then summarize

`activities` and `wellness` already return a summary line per item — distance,
time, HR, power, load for a workout; RHR, HRV, sleep, readiness for a day. That's
usually enough to answer. `activity <id>` adds nothing but focus on one workout;
use it when he asks about a specific ride, not as a loop over every line a list
returned.

Per-second traces (his HR second by second across a whole run) aren't fetched by
design — they'd bury the answer. If he wants the full curve, point him at the
activity on intervals.icu.

## The numbers, briefly

- **CTL / ATL** — fitness (chronic load) and fatigue (acute load). Form is
  roughly CTL minus ATL; positive means fresh, negative means loaded. Report the
  numbers; don't diagnose overtraining from them.
- **Readiness / HRV / RHR** — Garmin's recovery signals. A rising resting HR or a
  dropping HRV is the shape of "not fully recovered", but it's his call, not a
  verdict to hand down.
