---
name: gcal
description: Kuba's Google Calendar, through bin/gcal.js, plus the rules that govern it. Use whenever a message touches the schedule — what's on my calendar, what do I have today or tomorrow or this week, am I free Thursday, when is that meeting, is anything on this weekend, put that on the calendar, add the quiz, schedule it, block out time, move it to Friday, reschedule, push it back an hour, change where it is, cancel that meeting, delete the event, take it off my calendar, clear Friday. Covers listing events, creating, updating and deleting them, and the rules that apply before any write: Eastern time, checking the date, never inventing a time, the colour categories, no invitations, and which deletions are refused. Read this before creating, changing or removing any event.
---

# Google Calendar

Kuba's calendar, through `bin/gcal.js`. Run it from your working directory:

    node ../bin/gcal.js events [--from ISO] [--to ISO] [--limit N]
    node ../bin/gcal.js create --summary <s> --start <ISO> --end <ISO> \
        [--location <l>] [--description <d>] [--color <name>]
    node ../bin/gcal.js update <id> [--summary] [--start] [--end] \
        [--location] [--description] [--color]

`update` takes the id positionally or as `--id`, and only the fields you pass;
everything you leave out stays as it was.

All times are **Eastern (America/New_York)**. The broker stamps that zone on
every event and reads back in it, so you never convert — just don't assume a
time you were given is in some other zone without asking.

## Verify the date before you write it

Never infer a day of the week from a date, and never infer a date from a day.
Check:

```sh
date -d 2026-01-21 "+%A, %B %d, %Y"     # → Wednesday, January 21, 2026
```

When someone says "the quiz is Wednesday the 21st," those two facts can
disagree. Check before writing, and if they conflict, ask rather than picking
one.

## Never invent a time

If a time wasn't given, ask for it.

- **Deadlines, holidays, anything genuinely untimed** → all-day event. Pass a
  date-only `--start`/`--end` (`2026-01-21`) and it's created as all-day.
- **Anything tied to a class** — quiz, exam, presentation → ask when the class
  actually meets. "What time does DRL meet?" is one question and prevents an
  event on the wrong side of the day.
- **Placeholder times like 9 AM or 11:59 PM** → only if Kuba explicitly approves
  that specific placeholder. Don't offer one as a default and treat silence as
  agreement.

## Colours

Pass `--color <name>`. Categories, not moods:

| colour | for |
|---|---|
| `banana` | school work — quizzes, exams, projects, homework |
| `tomato` | important personal — taxes, medical, job interviews |
| `peacock` | general life — games, car maintenance, alumni events, weekends |
| `grape` | AI Institute work — Dr. Valafar, Kasey Cook/Education, other AII initiatives, **excluding** Leo's group |
| `basil` | Leo's group — Leo, Nick, Ansley, Eleanor, Aphasia, ABC, C-STAR lab, Brain Health |
| `tangerine` | Valafar lab — weekly meetings, HRV project, Dr. Huhns's project, Minna, Madeline |

`grape` and `basil` are the pair worth slowing down for: both are AI Institute,
and the distinction is whether it's Leo's group. When a name on the `basil` list
appears, it's `basil`.

An unrecognised colour is rejected rather than guessed at, so a typo fails
loudly instead of quietly mis-filing an event.

## Never send invitations

Events are for personal reference. Nobody should ever receive an invitation
email because of something you did.

You cannot cause one. There is no path from anything you type to the event's
`attendees` field, and every write goes out with `sendUpdates: "none"` — which
also covers editing an event created on a phone that already has guests on it.
This is enforced in `google/broker.js`, not left to you to remember.

**Record attendees in `--description` instead.** Names and emails as text, so
the information is on the event without anyone being notified.

## Deleting

`delete <id>` works, and you don't need to be precious about it. The event goes
to Google Calendar's Trash and stays restorable for thirty days with its guests,
location and description intact, so a deletion Kuba asked for is an ordinary
request — do it and say you did, rather than proposing it back to him.

Two things still hold. Say which event you're removing before you remove
several, since undoing a batch means thirty days of clicking. And deleting an
event that has guests on it is refused — cancellation email to real people isn't
something this can reliably suppress, so those stay Kuba's. You'll get an error
naming the event and its guest count; relay that.

Mail is the opposite case, and don't carry this habit over: mail cannot be
deleted at all. Label it `to delete` instead.

## Repeating events

Never create a series one event at a time. `--repeat` makes it a single event
that Google expands, which is also a single `delete` to undo — sixteen separate
events are sixteen mistakes to clean up.

    --repeat daily|weekly|biweekly|monthly|yearly
    --until 2026-11-24     inclusive of that day
    --count 16             alternative to --until; pass one, not both

The weekday comes from `--start`, so a Tuesday start gives a Tuesday series —
you never state the day separately and the two can't disagree. Leaving out both
`--until` and `--count` makes it open-ended, which is right for a standing
meeting and wrong for anything with a last week; ask if you weren't told.

`events` lists each occurrence separately with its own id, and updating or
deleting one of those ids affects only that occurrence. Use the id from the
series' first line to change the whole thing.

## What you can't do yet

- **Recurrence more complicated than an interval.** No `BYDAY=MO,WE,FR` for a
  class meeting three times a week, no "third Thursday", and no `EXDATE` for
  skipped weeks. For a Monday/Wednesday/Friday class, say so rather than
  creating three weekly series — that's a decision for Kuba, not a workaround
  for you to pick.

## When a command fails

Report what it said. You hold no Google credentials — the bot does, and this CLI
is the whole of what it hands you. A refusal here is the design, not an obstacle
to route around.
