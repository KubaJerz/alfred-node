---
name: notion
description: Kuba's Notion workspace — his notes, tasks, lists and databases, and how to read and write them. Use whenever a message touches Notion — add this to Notion, put it on my task list, add a task, note this down, add to my reading list, log it, what's on my to-do, what's in my notes, look it up in Notion, find that page, what did I write about X, mark that done, set the status, tick it off, check off that task, update the row, append to that page, add a note to it. Use it before answering whether something is in Notion at all, since searching is the only way to know.
---

# Notion

    search <query>   find pages and databases by title; metadata only
    read <id>        one page: its properties and its body as markdown
    query <dbId>     rows of a database; --where NAME=VALUE for one equals match
    create           a page: --db <id> for a row or --page <id> for a subpage
    append <id>      add markdown to the end of a page; nothing existing is touched
    set <id>         change a row's columns: NAME=VALUE, reports the old value

`node ../bin/notion.js <command> --help` for one command in full, or `--help` on
its own for the list. The rest of this file is what `--help` can't tell you.

## Only shared pages exist

The integration sees a page only after Kuba has connected it in Notion (a page's
••• → Connections). Nothing else is reachable — not hidden, *absent*. So
`search` coming back empty means "not shared yet", not "doesn't exist". Say that
rather than concluding he never wrote it, and don't offer another route to it —
there isn't one.

## Read narrowly

`search` and `query` return metadata and rows; a full page body comes from
`read`, one at a time. Decide from the titles which page matters, read that one,
and say which you read. Don't loop `read` over every search hit.

## `set` can't be taken back

A property overwrite is in place, and Notion keeps no history reachable through
the API — so `set` prints the previous value of every column it changed. That
printed `from → to` is the only undo that exists. Always relay it, so a wrong
change is visible and correctable the same turn. If you're unsure a change is
wanted, read the row first and confirm, rather than overwriting and hoping.

This is the opposite of the calendar habit: there, deleting is fine because Trash
holds it for 30 days. Here the innocuous-sounding `set` is the sharp edge and
there's no Trash behind it.

## Capture is additive

`create` and `append` only add. Prefer them for "note this down", "add a task",
"log it". `append` never disturbs what's already on the page, so it's safe to add
to a running note without reading it first.

## No delete, no archive, no comment

None exist as commands. Removing pages and editing existing page bodies aren't
wired up yet; if Kuba asks, say it's not something you can do here and offer to
capture or update instead. Comments are left out on purpose — they notify people
and can't be unsent, the same reason you can't send mail.

## Databases have typed columns

A column is a status, a date, a checkbox, a select — not free text. `create` and
`set` read the database's own types, so `Status=Done`, `Due=2026-08-20` and
`Done=true` each land in the right shape. Multi-value columns take a
comma-separated value. If a column rejects a value, the error names it — relay
that; don't retype the same value a different way.
