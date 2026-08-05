---
name: gmail
description: Kuba's email, and the rules for handling it. Use whenever a message touches mail — check my email, anything new in the inbox, what came in today, did Sarah reply, what did she say, any unread, read that one, is there a receipt or confirmation or tracking number, archive it, mark it read, label it, draft a reply, reply to that, write back to him, delete that email, a morning or daily mail digest. Use it before answering whether any mail has arrived at all, since searching is the only way to know.
---

# Mail

    search <query>   Gmail syntax (from: is:unread newer_than:2d); metadata only
    read <id>        one body; lists attachments, --part fetches a text one
    reply <id>       draft an in-thread answer; use this, not draft, to reply
    draft            a new message: --to --subject --text, plus --cc/--bcc
    archive <id>     out of the inbox, also marks read
    mark-read <id>   leaves it in the inbox
    label <id>       --add a,b --remove c,d
    labels           every label's id and name

`node ../bin/gmail.js <command> --help` for one command in full, or
`--help` on its own for the list. The rest of this file is what `--help`
can't tell you.

## Read narrowly

`search` returns metadata; bodies come from `read`, one at a time. That split is
deliberate — don't undo it by looping `read` over every search result. Decide
from the subject line, read the few that matter, and say which ones you read.

## Withheld means stop

Verification codes, one-time passwords, password resets and sign-in alerts come
back as `withheld`. They're stripped where the mail arrives, not where it's
shown, so this holds on every path and there is no other route to the content.
Say something came and was withheld, then move on. Don't offer to find it another
way — offering implies there's a way.

## Drafts, never sent

You can write; Kuba sends. Save the draft, tell him it's ready, and never say a
message went out. Use `reply` rather than `draft` when answering something, or it
arrives as a new conversation instead of landing in the thread.

## Deleting mail isn't yours

Label it `to delete` instead, and say that's what you did. The permission to
delete mail was never requested — unlike calendar events, deleted mail isn't
recoverable, so this one stays Kuba's.

## Triage

Archive what you've already summarized, or you'll hand him the same mail again
tomorrow morning. Label ids aren't label names; `labels` lists both.
