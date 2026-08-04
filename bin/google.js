#!/usr/bin/env node
// Split into bin/gmail.js and bin/gcal.js. This file remains only because a
// resumed session can still carry `node ../bin/google.js …` in its context, and
// a bare MODULE_NOT_FOUND doesn't read as "wrong file name" — it reads as a
// broken tool, which is exactly the situation that invites looking for another
// route to the mailbox. Failing with the new name costs a turn; failing with a
// stack trace costs the premise that there is one path to Google.
//
// Deliberately holds no credentials and doesn't import bin/lib/broker-client.js:
// that module checks the environment at import and exits, which would preempt
// this message with an unrelated one whenever the shim runs outside a turn.
//
// Deliberately forwards no arguments either: re-joining argv loses the quoting
// on things like --text "two words", and a pasted, mis-quoted `draft` saves a
// wrong email. The command word alone is enough to rebuild from.
//
// Transitional. Delete once no live session predates the split (see TODO.md).

const group = process.argv[2];

if (group === "mail" || group === "cal") {
  const file = group === "mail" ? "gmail.js" : "gcal.js";
  console.error(
    `bin/google.js has been split. This is now: node ../bin/${file}\n` +
      `Same commands, without the leading \`${group}\` — run it with no arguments for usage.`
  );
} else {
  console.error(
    "bin/google.js has been split into node ../bin/gmail.js and node ../bin/gcal.js.\n" +
      "Run either with no arguments for usage."
  );
}
process.exit(1);
