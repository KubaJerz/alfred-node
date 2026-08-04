---
name: gmail
description: Kuba's email, through bin/gmail.js. Use whenever a message touches mail — check my email, anything new in the inbox, what came in today, did Sarah reply, what did she say, any unread, read that one, is there a receipt or confirmation or tracking number, archive it, mark it read, put a label on it, draft a reply, write back to him, a morning or daily mail digest. Use it before answering whether any mail has arrived at all, since searching is the only way to know. Covers Gmail search syntax, reading one message, drafting for Kuba to send, archiving and labels, and messages that come back withheld because they are verification codes.
---

# Gmail

Kuba's mailbox, through `bin/gmail.js`. Run it from your working directory:

    node ../bin/gmail.js search "from:sarah is:unread" [--limit 10]
    node ../bin/gmail.js read <id>
    node ../bin/gmail.js draft --to <addr> --subject <s> --text <body> [--thread <id>]
    node ../bin/gmail.js archive <id>            # also marks read
    node ../bin/gmail.js mark-read <id>
    node ../bin/gmail.js label <id> [--add L] [--remove L]
    node ../bin/gmail.js labels                  # list label ids

`search` takes Gmail's own syntax — `from:`, `is:unread`, `newer_than:2d`,
`has:attachment`, `subject:`. Quote the whole query. Ids can be given
positionally or as `--id`; positional reads better.

## Read narrowly

`search` returns metadata only: id, date, sender, subject, snippet. Bodies come
back only from `read`, one message at a time. That split is deliberate, so don't
undo it by looping `read` over a search result to "check" everything — decide
from the subject line, read the few that actually matter, and say which ones you
read.

## Withheld messages

A line like `[abc123] — withheld (sensitive (verification/credential) — content
not retained)` is a verification code, one-time password, password reset or
sign-in alert. It is stripped at the broker before anything reaches you — on
search, on read, and on anything else that is ever wired into the same broker.
The filter sits where the mail arrives, not where it's displayed, so there is
no path around it rather than a list of paths that were remembered.

Say that something came and was withheld. Then stop. Don't reach for the content
another way and don't offer to — there is no route, and offering implies there
is.

## Triage

Archive what you've already summarized, or you'll hand Kuba the same mail again
tomorrow morning. `archive` marks read as well, which is usually what you want;
`mark-read` is for the ones that should stay in the inbox.

Label ids aren't label names. Get them from `labels` rather than guessing at
one.

**When Kuba asks you to delete mail, label it `to delete` instead.** You have no
delete route and won't be getting one — Gmail's delete scope is the one that
empties Trash permanently, and it was never requested. The label is the honest
version of the request: it gathers everything in one place for him to clear in a
single pass, and nothing is lost if you got the wrong message. Say that's what
you did rather than saying it's deleted.

## Drafting, never sending

`draft` saves to Kuba's Drafts folder and gives you back the draft id. Then tell
him it's ready. Never say a message was sent.

That isn't a rule you're being asked to keep — there is no send command, and no
send route in the broker behind it, so it isn't a permission that can be granted
mid-conversation. `node ../bin/gmail.js send` prints that and exits 1.

(`--thread <id>` keeps a reply in its thread. Nothing currently prints thread
ids, so in practice a draft goes out as a fresh message.)

## When a command fails

Report what it said. You hold no Google credentials — the bot does, and this CLI
is the whole of what it hands you. A failure is something to relay, not
something to work around with another client, another file, or another token.
