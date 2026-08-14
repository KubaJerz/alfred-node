---
name: notion
description: Kuba's Notion workspace — his notes, tasks, lists and databases, and how to read and write them. Use whenever a message touches Notion — add this to Notion, put it on my task list, add a task, note this down, add to my reading list, log it, what's on my to-do, what's in my notes, look it up in Notion, find that page, what did I write about X, mark that done, set the status, tick it off, check off that task, cross it off, update the row, append to that page, add a note to it, fix that line, edit that note, change what it says, reword it, delete that line, remove that item, take that off the list, get rid of that line. Use it before answering whether something is in Notion at all, since searching is the only way to know.
---

# Notion

    search <query>   find pages and databases by title; metadata only
    read <id>        one page: its properties and its body as markdown
    read <id> --ids  same, but each line prefixed with its block id (for editing)
    query <dbId>     rows of a database; --where NAME=VALUE for one equals match
    create           a page: --db <id> for a row or --page <id> for a subpage
    append <id>      add markdown to the end of a page; nothing existing is touched
    set <id>         change a row's columns: NAME=VALUE, reports the old value
    check <blockId>  tick a to-do line off (uncheck clears it); reports before→after
    edit <blockId>   replace one body line's text with --body markdown; reports old→new
    remove <blockId> delete one body line; reversible via Trash, reports what it removed

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

## Capture is additive; editing a line is by block id

`create` and `append` only add. Prefer them for "note this down", "add a task",
"log it". `append` never disturbs what's already on the page, so it's safe to add
to a running note without reading it first.

`check`, `edit` and `remove` change one *existing* line, and each takes a **block
id**, not a page id. Those ids don't show in a normal `read` — run `read <page>
--ids` first, which prefixes every line with its `[block-id]`, find the line Kuba
means, then act on that id. So "tick off the milk one", "fix that typo", "drop
that line" is two steps: `read --ids` to see the ids, then `check`/`edit`/`remove`.

A few things worth holding onto:

- **`check` is for a to-do in a page body.** A task that's a database row with a
  checkbox or status column is `set Done=true` — a column, not a line. If you're
  unsure which a "task list" is, `read`/`query` it and look: rows with columns →
  `set`; `- [ ]` lines in a body → `check`.
- **`edit` keeps a line's kind.** Notion can't turn a bullet into a heading in
  place, so give the same markdown the line already is (`- text`, `# text`,
  `- [x] text`); a line that reads as a different kind is refused, not forced.
  Changing kind means `remove` then `append`/re-add.
- **`edit` overwrites like `set`** — it prints the old line → the new one, and
  that echo is the only undo. Relay it. `remove`, by contrast, is recoverable.

## `remove` is reversible; a page and a comment aren't touchable

`remove` deletes a body line, but it lands in Notion's **Trash** and can be
restored there — so it's the safe kind of delete, the same footing as a calendar
delete, not the sharp edge `set`/`edit` are. Still relay the line it printed, so
a wrong removal is caught the same turn. A line with lines nested under it takes
them along.

What's still absent: removing or archiving a whole **page** (only body lines go,
not the page itself — say so and offer to clear or edit its lines instead), and
**comments** (left out on purpose — they notify people and can't be unsent, the
same reason you can't send mail).

## Databases have typed columns

A column is a status, a date, a checkbox, a select — not free text. `create` and
`set` read the database's own types, so `Status=Done`, `Due=2026-08-20` and
`Done=true` each land in the right shape. Multi-value columns take a
comma-separated value. If a column rejects a value, the error names it — relay
that; don't retype the same value a different way.
