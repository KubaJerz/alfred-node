---
name: strength
description: Kuba's lifting — his strength workouts from Garmin, and the rolling per-muscle load that tracks progressive overload. Use whenever a message touches lifting or training load — did you see my workout, can you check my lift, did my workout sync, log my lifting, what did I lift, my sets today, how much did I lift; and the trend — how's my volume, my chest volume, back volume this week, how are my legs, my biceps, am I progressing, progressive overload, my training load, my strength load, ACWR, am I overtraining or undertraining, am I recovered enough to push, plot my load, show me my strength chart, how's my lifting going this week. Use it before answering whether a lift logged at all, since the database is the only way to know.
---

# Strength

    digest [--from DATE] [--to DATE]   pull + interpret new lifting workouts
    load [--muscle M]                  current 7-day / 28-day load + ACWR
    sets <activityId>                  one workout's interpreted sets
    plot                               render the strength dashboard (PNG)

`node ../bin/strength.js <command> --help` for one command in full. The rest of
this file is what `--help` can't tell you.

## What this is, in one line

Garmin logs Kuba's sets (reps + weight) into the FIT file; a nightly pass pulls
them, a model names the exercises, and the load is rolled into 7-/28-day windows
per muscle. You read that; you don't compute it.

## `digest` is the slow one — background it

`load`, `sets` and `plot` are instant database reads. **`digest` runs a model to
interpret each new workout (~2 minutes each)**, so it can outlast a turn. It runs
automatically overnight, so most of the time the data is already there — try
`load` first.

When Kuba asks you to *see a new workout* right now ("did my lift sync?", "check
my workout"), and `load`/`sets` don't show it yet, run digest **detached** and say
you'll confirm once it's processed — don't block the whole turn on it:

    node ../bin/strength.js digest > ../var/logs/strength-digest.log 2>&1 &

Then check `load`/`sets` a bit later (or next turn) and report what landed.

## Everything is in pounds

Garmin stores weight in kilograms; the system converts to the whole pounds Kuba
lifts. Always talk pounds. Never surface kilograms unless he asks why a number
looks odd.

## Reading the numbers

- **Load** is `Σ factor × reps × lb`, **assist-scaled**: a pulldown gives back
  full credit and biceps half, a press gives chest full and triceps/shoulders
  half. So per-muscle load already blends the compound work in.
- **ACWR** is the 7-day acute load over the 28-day chronic base. **~0.8–1.3** is
  the maintain/build band; below is detraining, above **~1.5** is a spike worth a
  mention. Report the number and the band; don't hand down a training verdict.
- Muscle keys: `biceps` `triceps` `shoulders` `chest` `back` `legs`, plus
  `_total` for whole body.

## Sending the plot

`plot` renders a PNG and prints its path. To actually send it to Kuba, put
`{img:<path>}` in your reply — bot.js attaches the file and strips the token. Reach
for it when he wants to *see* the trend ("show me", "chart", "plot"); otherwise a
sentence from `load` is enough.

## Unmapped exercises

A set the interpreter couldn't place shows as `unknown` in `sets` — it kept the
reps and weight but earns no muscle credit. If Kuba mentions a new exercise, it
likely needs adding to the exercise map; say so rather than pretending it counted.
