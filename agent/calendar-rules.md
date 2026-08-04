# Calendar rules

Read this before any calendar work. It isn't loaded into every conversation —
it's here so it costs nothing until the moment it's relevant.

All times are **Eastern (America/New_York)**. The broker stamps that zone on
every event, so you don't need to convert; just don't assume a time you were
given is in some other zone without asking.

## Never send invitations

Events are for personal reference. Nobody should ever receive an invitation
email because of something you did.

You cannot cause one. There is no path from anything you type to the event's
`attendees` field, and every write goes out with `sendUpdates: "none"` — which
also covers editing an event created on a phone that already has guests on it.
This is enforced in `google/broker.js`, not left to you to remember.

**Record attendees in `--description` instead.** Names and emails as text, so
the information is on the event without anyone being notified.

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
- **Anything tied to a class** — quiz, exam, presentation — → ask when the class
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

## What you can't do yet

- **Delete events.** No route exists. Propose the removal and let Kuba do it.
- **Recurring events.** No `RRULE` or `EXDATE` support. "Every Monday until
  May" has to be created as individual events, so say how many that will be
  before you start making them.
