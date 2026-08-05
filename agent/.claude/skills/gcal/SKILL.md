---
name: gcal
description: Kuba's Google Calendar, and the rules for how he wants it kept. Use whenever a message touches the schedule — what's on my calendar, what do I have today or tomorrow or this week, am I free Thursday, when is that meeting, put that on the calendar, add the quiz, schedule it, block out time, move it to Friday, reschedule, push it back an hour, cancel that meeting, delete the event, take it off my calendar. Read this before creating, changing or removing anything.
---

# Calendar

    events    a window: --from --to, plus --query to search text
    create    --summary --start --end, plus --location --description --color
              repeating: --repeat weekly --days MO,WE,FR --until 2026-11-24
              or --rrule 'FREQ=MONTHLY;BYDAY=3TH' for anything odder
    update    <id>, then any create flag; what you omit stays as it was
    delete    <id>

`node ../bin/gcal.js <command> --help` for one command in full, or
`--help` on its own for the list. The rest of this file is what `--help`
can't tell you: how Kuba wants his calendar kept.

## Times are Eastern

Everything is `America/New_York`, stamped for you. Don't convert. Do ask if a
time you were given might be in another zone.

## Check the date, don't infer it

`date -d 2026-01-21 "+%A"` before writing anything. "The quiz is Wednesday the
21st" contains two facts that can disagree — when they do, ask rather than
picking one.

## Never invent a time

If you weren't given one, ask. Untimed things — deadlines, holidays — are all-day
events. Anything tied to a class needs the class's actual meeting time, and "what
time does DRL meet?" is one question that prevents an event on the wrong side of
the day. Don't offer 9 AM as a default and read silence as agreement.

## Colours are categories

| | |
|---|---|
| `banana` | school work — quizzes, exams, projects, homework |
| `tomato` | important personal — taxes, medical, job interviews |
| `peacock` | general life — games, car maintenance, alumni events, weekends |
| `grape` | AI Institute, **excluding** Leo's group |
| `basil` | Leo's group — Leo, Nick, Ansley, Eleanor, Aphasia, ABC, C-STAR, Brain Health |
| `tangerine` | Valafar lab — weekly meetings, HRV, Dr. Huhns's project, Minna, Madeline |

`grape` and `basil` are the pair to slow down for: both are AI Institute, and the
question is only whether it's Leo's group. A name on the `basil` list means
`basil`.

## Nobody gets email because of you

Events are for reference. Record attendees in `--description` as text. You
couldn't send an invitation if you tried — there's no path from anything you type
to the guest list — so this is context, not a rule to keep.

The exception surfaces on delete: an event that already has guests is refused,
because cancellation mail can't be reliably suppressed. Relay that and let Kuba
remove it.

## Deleting is fine

Deleted events sit in Google's Trash for 30 days. When Kuba asks you to remove
something, remove it and say so — don't propose it back to him. Name what you're
deleting first if it's several, since undoing a batch means thirty days of
clicking.

Series get one event, never one per occurrence. If the shape doesn't fit
`--repeat`, `--rrule` takes raw iCalendar.
