---
name: reminders
description: The user's reminders and scheduled jobs — one list, and the bot sends each reminder at its time by Discord and SMS. Use whenever a message wants something to happen at a time — remind me, remind me at 5, remind me tomorrow, remind me in 20 minutes, set a reminder, set an alarm, don't let me forget, make sure I remember, ping me at, text me at 6, every Monday remind me, every morning at 7, every month on the 1st, remind mom to, remind her, send my sister a reminder; and to manage them — what are my reminders, what's coming up, did my reminder go out, cancel that reminder, stop reminding me, delete the reminder, snooze it, remind me again in an hour, push the reminder to Friday, move it to 6, skip it this week; and jobs — every night run, run this every morning, schedule a job, what jobs are scheduled. Read this before you add, change or cancel a reminder.
---

# Reminders

    list [--all] [--jobs]   what is set; --all adds the finished ones
    show <id>               one entry, with each delivery of its last time
    add                     --text, then --at <time>, --in 30m, or --repeat … --time
    add --job <name>        a job from agent/jobs, with the same time flags
    edit <id>               change the text, the time, the people or the channels
    snooze <id>             --for 30m or --until <time>: moves the next time only
    skip <id>               skips the next time of a repeating one
    cancel <id>             stops it, and the sends that are still pending
    contacts                who can get a reminder, by name
    jobs                    the jobs that exist

`node ../bin/remind.js <command> --help` for one command in full, or `--help`
on its own for the list. The rest of this file is what `--help` cannot tell
you.

## Check the date first

Run `date` before you write a time. "Remind me Friday at 5" needs the date of
that Friday: `date -d friday +%F`. When a day and a date disagree ("Thursday
the 27th" on a Wednesday), ask. Do not pick one.

## Never invent a time

"Remind me tomorrow" and "remind me about the dentist" have no time. Ask for
one. Do not offer 9 AM as a default and read silence as a yes. A wait needs
no question: "in 20 minutes" is `--in 20m`.

## Times are Eastern

`--at 2026-11-25T17:00` is 5 PM Eastern. Ask when a time can be in another
zone. A repeat's `--time` is a clock time, so 07:00 stays 07:00 across a
daylight saving change.

## People are contact names

`--to me,mom`. `contacts` lists the names and the channels each one has. No
flag takes a phone number or a Discord id, on purpose: the owner adds a
contact in `REMINDER_CONTACTS` (.env), and a turn cannot. If a person is not a
contact, say so. Do not look for another way to reach them.

SMS goes to the user only, for now. The phone number may text another person
only after an opt-in step that does not exist yet. So another person gets a
reminder by Discord only, and a contact with no Discord cannot get one yet.
Tell the user that plainly when it happens.

A reminder to someone else reads "⏰ Reminder from Alfred: <text>". Write only
what that person needs. Keep the user's private detail out of it: nothing
about health or money, nothing about other people, and nothing from memory.

## How it goes out

bot.js sends it at its time, not you. By default it goes to the user by
Discord and SMS (`--via discord` or `--via sms` for one). A failed send goes
again, and the user hears about a send that fails for good. A reminder that
came due while the machine was off arrives in one summary.

When a reminder went out, your next message starts with a line that names it,
with its id. So "snooze it 30 minutes" after a reminder is
`snooze <id> --for 30m`. That works on a reminder that already went out.

After a change, tell the user the line the tool printed: the id, the time,
and who gets it by which channel. If it says "Skipped", say that too.

## Google Calendar gets a copy

Each reminder (not a job) gets an event in Google Calendar, made for you. Do
not make one with gcal.js too. The copy goes one way: a change in Google
Calendar does not come back to the list. To change a reminder, use this
tool. Snooze and skip do not move the event.

## Jobs come only from agent/jobs

A job runs a file from agent/jobs: `<name>.sh` (a script) or `<name>.md` (a
prompt for a separate agent, whose answer goes to the job's `--to`). `jobs`
lists them. The list runs nothing else, so a job cannot be text in the list.

A job file runs only when git has committed it, with no change since. So you
cannot make a new job yourself: a file that you write in agent/jobs does not
run, and an edit stops a job until someone commits the edit. When the user
wants a new job:

1. Write the text that the file must hold, in your reply.
2. Tell the user that the file must go into the repo through a pull request.
3. After the merge, schedule it with `add --job <name>`.

When an agent job's answer went out, your next message starts with a line
that holds the answer. `show <id>` shows the last answer too.
