// The CLIs are the only part of the Google path that was never tested, and they
// are where the write commands live — draft, archive, label, calendar create and
// update all reach a real mailbox or a real calendar when they work. So they are
// tested against a stub broker on loopback: a plain http server that records what
// arrived and answers with canned JSON. Nothing here can reach Google, and the
// stub is what makes the interesting assertion possible — not "did the command
// print something plausible" but "what exactly went on the wire".
//
// Two properties matter more than the rest, and both are assertions about
// *absence*: `gmail.js send` and `gcal.js delete` must issue no HTTP request at
// all, and neither CLI may carry credential material of any kind. A refusal that
// still made a request would mean the capability exists and is merely declined.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Same reason as broker.test.js: auth.js resolves credential paths at import
// time, so point it at an empty directory before importing anything that pulls
// it in. OPERATIONS is imported for one purpose — to check the CLIs' requests
// against the broker's real route table, so renaming a route there fails here
// instead of failing in front of Kuba.
process.env.STATE_DIR = mkdtempSync(path.join(tmpdir(), "alfred-cli-test-"));
const { OPERATIONS } = await import("../google/broker.js");

const BIN = fileURLToPath(new URL("../bin/", import.meta.url));
const brokerSource = readFileSync(new URL("../google/broker.js", import.meta.url), "utf8");

const TOKEN = "stub-broker-token-not-a-real-secret";

// What the stub answers with, keyed the way the broker keys its own routes. An
// unrecognised key is answered the way the broker answers one, so a CLI that
// drifts onto a path the broker doesn't serve fails loudly here.
const CANNED = {
  "GET /mail/search": {
    messages: [
      {
        id: "m1",
        ts: 1769000000000,
        from: "Sarah <sarah@example.com>",
        subject: "Lunch?",
        snippet: "x".repeat(400),
      },
      { id: "b2", withheld: true, note: "sensitive (verification code)" },
    ],
  },
  "GET /mail/message": {
    message: { id: "m1", from: "Sarah <sarah@example.com>", subject: "Lunch?", body: "Thursday?" },
  },
  "POST /mail/draft": { draftId: "d9", note: "Draft saved. Sending is not available here." },
  "POST /mail/modify": { id: "m1", added: ["Label_9"], removed: ["INBOX", "UNREAD"] },
  "GET /mail/labels": { labels: [{ id: "Label_9", name: "receipts" }] },
  "GET /calendar/events": {
    events: [
      {
        id: "e1",
        summary: "Quiz",
        start: "2026-01-21T14:00:00-05:00",
        end: "2026-01-21T15:00:00-05:00",
        location: "Swearingen",
      },
    ],
  },
  "POST /calendar/events": { id: "e1", htmlLink: "https://calendar.example/e1" },
  "PATCH /calendar/events": { id: "e1", htmlLink: "https://calendar.example/e1" },
  "DELETE /calendar/events": {
    id: "e1",
    summary: "Quiz",
    note: "Deleted. Recoverable from Google Calendar's Trash for 30 days.",
  },
  "POST /mail/reply": {
    draftId: "r1",
    to: "sarah@example.com",
    subject: "Re: lab meeting",
    note: "Reply saved as a draft, in-thread. Sending is not available here.",
  },
};

let server;
let stubUrl;
let requests = [];
// Set by a test that needs a different answer than the canned one — { status,
// body } — and cleared afterwards.
let override = null;

async function startStub() {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: req.method,
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      raw,
      body: raw ? JSON.parse(raw) : null,
    });

    const key = `${req.method} ${url.pathname}`;
    const canned = CANNED[key];
    const status = override?.status ?? (canned ? 200 : 404);
    const payload = JSON.stringify(
      override?.body ??
        canned ?? { error: `no such operation: ${key}`, available: Object.keys(CANNED) }
    );
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  stubUrl = `http://127.0.0.1:${server.address().port}`;
}

after(async () => {
  await new Promise((r) => server.close(r));
});

// The environment the CLIs see, with any real broker vars from the surrounding
// shell stripped — a developer running the suite inside a live turn must not
// have the tests talk to their own bot.
const cleanEnv = () => {
  const env = { ...process.env };
  delete env.ALFRED_BROKER;
  delete env.ALFRED_BROKER_TOKEN;
  return env;
};

// spawn, not spawnSync: the stub runs on this process's event loop, and a
// synchronous child would block the very server it is waiting on.
function run(file, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(BIN, file), ...args], {
      env: env ?? { ...cleanEnv(), ALFRED_BROKER: stubUrl, ALFRED_BROKER_TOKEN: TOKEN },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// One invocation of every command that is supposed to reach the broker. Run once
// in `before`; several tests read the resulting request records.
const SURFACE = [
  ["gmail.js", ["search", "from:sarah", "is:unread", "--limit", "5"]],
  ["gmail.js", ["read", "m1"]],
  ["gmail.js", ["draft", "--to", "a@b.com", "--subject", "Re: x", "--text", "two words"]],
  ["gmail.js", ["reply", "m1", "--text", "sounds good"]],
  ["gmail.js", ["archive", "m1"]],
  ["gmail.js", ["mark-read", "m1"]],
  ["gmail.js", ["label", "m1", "--add", "Label_9", "--remove", "INBOX"]],
  ["gmail.js", ["labels"]],
  ["gcal.js", ["events", "--from", "2026-01-21T00:00:00", "--to", "2026-01-22T00:00:00", "--limit", "5"]],
  ["gcal.js", ["create", "--summary", "Quiz", "--start", "2026-01-21", "--end", "2026-01-21", "--color", "banana"]],
  ["gcal.js", ["update", "e1", "--start", "2026-01-21T14:00:00", "--color", "basil"]],
  ["gcal.js", ["delete", "e1"]],
];

const calls = new Map(); // "gmail.js draft" -> { result, request }

// One hook, not two: the stub has to be listening before the surface is run
// through it, and separate root-level hooks don't guarantee that order.
before(async () => {
  await startStub();
  for (const [file, args] of SURFACE) {
    requests = [];
    const result = await run(file, args);
    assert.equal(
      requests.length,
      1,
      `${file} ${args[0]} made ${requests.length} requests: ${result.stderr}`
    );
    calls.set(`${file} ${args[0]}`, { result, request: requests[0] });
  }
});

test("every command authenticates with the broker token, in the header", () => {
  for (const [name, { request }] of calls) {
    assert.equal(
      request.headers["x-alfred-broker"],
      TOKEN,
      `${name} did not present the broker token`
    );
    // The header is the only place it may appear. A token in a query string
    // lands in logs and shell history, which is why broker.js chose a header.
    assert.ok(!request.raw.includes(TOKEN), `${name} put the token in the body`);
    assert.ok(
      !JSON.stringify(request.query).includes(TOKEN),
      `${name} put the token in the query string`
    );
  }
});

test("nothing that looks like a Google credential is transmitted", () => {
  const CREDENTIALISH = /client_secret|GOCSPX-|refresh_token|access_token|private_key|token\.json|ya29\./i;
  for (const [name, { request }] of calls) {
    const sent = JSON.stringify({
      ...request,
      headers: { ...request.headers, "x-alfred-broker": "<token>" },
    });
    assert.ok(!CREDENTIALISH.test(sent), `${name} transmitted credential-shaped material`);
    for (const header of ["authorization", "cookie", "x-goog-api-key"]) {
      assert.ok(!(header in request.headers), `${name} sent a ${header} header`);
    }
  }
});

test("no file under bin/ contains credential material", () => {
  // The CLIs hold no secrets by construction — they read the broker address out
  // of the environment bot.js sets. This is that claim checked by inspection
  // rather than left as an intention, and it covers a bin/notion.js added later.
  const CREDENTIALISH = /client_secret|GOCSPX-|refresh_token|private_key|BEGIN [A-Z ]*PRIVATE KEY/;
  const walk = (dir) =>
    readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  const files = walk(BIN);
  assert.ok(files.length >= 3, "expected at least the two CLIs and the shared client");
  for (const file of files) {
    assert.ok(
      !CREDENTIALISH.test(readFileSync(file, "utf8")),
      `${path.relative(BIN, file)} contains credential material`
    );
  }
});

test("every request names a route the broker actually serves", () => {
  // The CLIs and the broker agree on method and path by convention alone. This
  // is what turns that convention into something a rename in broker.js breaks
  // here, loudly, instead of at 2am in a live turn.
  for (const [name, { request }] of calls) {
    const key = `${request.method} ${request.pathname}`;
    assert.ok(OPERATIONS.includes(key), `${name} called ${key}, which the broker does not serve`);
  }
});

// The keys each write route destructures out of its body, read from broker.js
// itself. A field the CLI sends that the route never unpacks is silently
// discarded — the shape of bug where a draft saves without its subject.
function bodyKeysOf(routeKey) {
  const starts = [...brokerSource.matchAll(/"((?:GET|POST|PATCH|PUT|DELETE) \/[^"]*)":/g)];
  const i = starts.findIndex((m) => m[1] === routeKey);
  assert.ok(i >= 0, `broker.js no longer defines a route named ${routeKey}`);
  const block = brokerSource.slice(starts[i].index, starts[i + 1]?.index ?? brokerSource.length);
  const destructure = /const \{([^}]*)\} = body \|\| \{\};/.exec(block);
  assert.ok(destructure, `${routeKey} no longer destructures its body`);
  return destructure[1].split(",").map((s) => s.trim()).filter(Boolean);
}

test("write commands send exactly the body the broker route unpacks", () => {
  const expected = {
    "gmail.js draft": {
      route: "POST /mail/draft",
      body: { to: "a@b.com", subject: "Re: x", text: "two words" },
    },
    // A reply sends only the original's id and the new text. Everything that
    // makes it thread — In-Reply-To, References, the Re: subject, the recipient
    // — is derived by the broker from the original, because the CLI cannot see
    // any of it and a reply assembled from guesses starts a new conversation.
    "gmail.js reply": {
      route: "POST /mail/reply",
      body: { id: "m1", text: "sounds good" },
    },
    "gmail.js archive": {
      route: "POST /mail/modify",
      // Archiving marks read as well; mail out of the inbox but still bold is a
      // state nobody asked for.
      body: { id: "m1", archive: true, markRead: true },
    },
    "gmail.js mark-read": {
      route: "POST /mail/modify",
      body: { id: "m1", archive: false, markRead: true },
    },
    "gmail.js label": {
      route: "POST /mail/modify",
      body: { id: "m1", addLabels: ["Label_9"], removeLabels: ["INBOX"] },
    },
    "gcal.js create": {
      route: "POST /calendar/events",
      // Flags that were not given are absent, not empty strings: the broker
      // treats an undefined field as "leave it alone".
      body: { summary: "Quiz", start: "2026-01-21", end: "2026-01-21", color: "banana" },
    },
    "gcal.js update": {
      route: "PATCH /calendar/events",
      body: { start: "2026-01-21T14:00:00", color: "basil" },
    },
  };

  for (const [name, want] of Object.entries(expected)) {
    const { request } = calls.get(name);
    assert.equal(`${request.method} ${request.pathname}`, want.route, `${name} called the wrong route`);
    assert.deepEqual(request.body, want.body, `${name} sent an unexpected body`);
    const unpacked = bodyKeysOf(want.route);
    for (const key of Object.keys(want.body)) {
      assert.ok(
        unpacked.includes(key),
        `${name} sends ${key}, which ${want.route} no longer reads out of the body`
      );
    }
  }

  // The id for an update travels in the query string, which is where the route
  // looks for it; nothing else does.
  assert.deepEqual(calls.get("gcal.js update").request.query, { id: "e1" });
});

test("read commands ask on the query string and print what came back", () => {
  assert.deepEqual(calls.get("gmail.js search").request.query, {
    q: "from:sarah is:unread",
    limit: "5",
  });
  assert.deepEqual(calls.get("gmail.js read").request.query, { id: "m1" });
  assert.deepEqual(calls.get("gcal.js events").request.query, {
    from: "2026-01-21T00:00:00",
    to: "2026-01-22T00:00:00",
    limit: "5",
  });

  assert.match(calls.get("gcal.js events").result.stdout, /\[e1\].*Quiz.*@ Swearingen/);
  assert.match(calls.get("gcal.js create").result.stdout, /Created e1/);
  assert.match(calls.get("gcal.js update").result.stdout, /Updated e1/);
  assert.match(calls.get("gmail.js draft").result.stdout, /Draft d9 saved/);
  assert.match(calls.get("gmail.js labels").result.stdout, /^Label_9\treceipts$/m);
  for (const [name, { result }] of calls) {
    assert.equal(result.code, 0, `${name} exited ${result.code}: ${result.stderr}`);
  }
});

test("a withheld message shows up as a marker rather than vanishing", async () => {
  // Search: the withheld entry must still be visible, next to the one that
  // wasn't. Something arrived and can't be read is the useful fact; a silently
  // shorter list reads as "no mail", which is false.
  const search = calls.get("gmail.js search").result.stdout;
  assert.match(search, /\[b2\] — withheld \(sensitive \(verification code\)\)/);
  assert.match(search, /\[m1\]/, "the unwithheld message was dropped along with it");
  assert.ok(!search.includes("(nothing matched)"));

  // Read: the note and nothing else. No body, no snippet, no headers.
  requests = [];
  override = { body: { message: { id: "b2", withheld: true, note: "sensitive (verification code)" } } };
  const read = await run("gmail.js", ["read", "b2"]);
  override = null;
  assert.equal(read.code, 0);
  assert.equal(read.stdout.trim(), "Withheld: sensitive (verification code)");
  assert.ok(!/From:|Subject:/.test(read.stdout), "a withheld read printed message headers");
});

test("gmail.js send makes no request at all — the capability does not exist", async () => {
  requests = [];
  const out = await run("gmail.js", ["send", "--to", "a@b.com", "--text", "hi"]);
  assert.equal(
    requests.length,
    0,
    `send reached the broker: ${JSON.stringify(requests)}`
  );
  assert.notEqual(out.code, 0, "send exited 0, which reads as sent");
  assert.equal(out.stdout, "", "a refusal printed to stdout looks like a result");
  assert.match(out.stderr, /drafts are reviewed by Kuba/);
  assert.match(out.stderr, /draft/, "the refusal should name what to do instead");
});

// Calendar delete is allowed and mail delete is not, and the reason is
// reversibility rather than the verb: a deleted event sits in Google's Trash
// for 30 days, a deleted message needs a scope that empties Trash for good.
// This asserts the id travels where the route reads it, and that the caller is
// told the deletion is recoverable — an agent that thinks removal is permanent
// hedges on requests it should just carry out.
test("gcal.js delete sends the id on the query string and reports the trash window", () => {
  const { request, result } = calls.get("gcal.js delete");
  assert.equal(`${request.method} ${request.pathname}`, "DELETE /calendar/events");
  assert.deepEqual(request.query, { id: "e1" });
  assert.equal(request.raw, "", "delete should carry no body");
  assert.equal(result.code, 0);
  assert.match(result.stdout, /30 days/);
});

test("a delete with no id never reaches the broker", async () => {
  requests = [];
  const out = await run("gcal.js", ["delete"]);
  assert.notEqual(out.code, 0);
  assert.equal(requests.length, 0, "an id-less delete was forwarded");
});

test("the send refusal isn't reachable by another spelling of the same word", async () => {
  // The point is that no argv reaches a send, not that one specific word is
  // caught. Anything unrecognised must fall through to usage, which also makes
  // no request.
  for (const [file, args] of [
    ["gmail.js", ["send"]],
    ["gmail.js", ["mail", "send", "--to", "a@b.com"]],
    ["gmail.js", ["Send"]],
    ["gmail.js", ["reply"]],
    ["gcal.js", ["remove", "e1"]],
  ]) {
    requests = [];
    const out = await run(file, args);
    assert.notEqual(out.code, 0, `${file} ${args.join(" ")} exited 0`);
    assert.equal(requests.length, 0, `${file} ${args.join(" ")} reached the broker`);
  }
});

// Asking what a tool does is not an error; getting the command wrong is. The
// skills point at --help instead of restating the flags, so help has to behave
// like every other tool — stdout, exit 0 — or a piped read turns reading the
// manual into a failed command.
test("--help prints usage on stdout and exits 0, with no broker needed", async () => {
  for (const file of ["gmail.js", "gcal.js"]) {
    for (const args of [["--help"], ["-h"], ["help"], []]) {
      requests = [];
      const out = await run(file, args, cleanEnv()); // no ALFRED_BROKER at all
      assert.equal(out.code, 0, `${file} ${args.join(" ")} exited ${out.code}`);
      assert.match(out.stdout, new RegExp(`usage: node \\.\\./bin/${file.replace(".", "\\.")}`));
      assert.equal(out.stderr, "", `${file} ${args.join(" ")} wrote to stderr`);
      assert.equal(requests.length, 0);
    }
  }
  // Usage is also where the absences are stated, so a confused turn reads them
  // without having to attempt the command first.
  assert.match((await run("gmail.js", ["--help"])).stdout, /No `send`/);
  assert.match((await run("gcal.js", ["--help"])).stdout, /guests, where deleting is refused/);
});

// Both conventional spellings, because both are what someone reaches for. The
// important half is that `delete --help` explains delete rather than running it.
test("per-command help works and never performs the command", async () => {
  for (const [file, command, marker] of [
    ["gcal.js", "delete", /Trash/],
    ["gcal.js", "create", /--rrule/],
    ["gmail.js", "reply", /brand-new thread/],
    ["gmail.js", "label", /to delete/],
  ]) {
    for (const args of [[command, "--help"], ["help", command]]) {
      requests = [];
      const out = await run(file, args, cleanEnv());
      assert.equal(out.code, 0, `${file} ${args.join(" ")} exited ${out.code}`);
      assert.match(out.stdout, new RegExp(`usage: node \\.\\./bin/${file.replace(".", "\\.")} ${command}`));
      assert.match(out.stdout, marker);
      assert.equal(requests.length, 0, `${file} ${args.join(" ")} called the broker`);
      // The overview's other commands must not be in a single command's help.
      assert.ok(!/Any one of them in detail/.test(out.stdout), "printed the overview instead");
    }
  }
});

test("help for a command that doesn't exist is an error, not silence", async () => {
  for (const file of ["gmail.js", "gcal.js"]) {
    const out = await run(file, ["help", "frobnicate"], cleanEnv());
    assert.equal(out.code, 1);
    assert.match(out.stderr, /no such command: frobnicate/);
    assert.equal(out.stdout, "");
  }
});

test("an unrecognised command is an error, unlike --help", async () => {
  for (const file of ["gmail.js", "gcal.js"]) {
    requests = [];
    const out = await run(file, ["frobnicate"]);
    assert.equal(out.code, 1, `${file} frobnicate exited 0`);
    assert.match(out.stderr, /usage:/);
    assert.equal(out.stdout, "", "a refusal on stdout reads as a result");
    assert.equal(requests.length, 0);
  }
});

test("the dropped group word is named, not quietly absorbed", async () => {
  // A resumed session can still be carrying `google.js mail search`. Accepting
  // it would make the usage text a lie; failing without explaining it looks like
  // a broken tool, which is what invites looking for another route to the mailbox.
  const mail = await run("gmail.js", ["mail", "search", "from:sarah"]);
  assert.equal(mail.code, 1);
  assert.match(mail.stderr, /no `mail` group word/i);
  assert.match(mail.stderr, /node \.\.\/bin\/gmail\.js search/);

  const cal = await run("gcal.js", ["cal", "events"]);
  assert.equal(cal.code, 1);
  assert.match(cal.stderr, /no `cal` group word/i);
  assert.match(cal.stderr, /node \.\.\/bin\/gcal\.js events/);
});

test("an id may be positional or --id, on every command that takes one", async () => {
  for (const [file, args, wants] of [
    ["gmail.js", ["read", "--id", "m1"], (r) => assert.equal(r.query.id, "m1")],
    ["gmail.js", ["archive", "--id", "m1"], (r) => assert.equal(r.body.id, "m1")],
    ["gmail.js", ["label", "--id", "m1", "--add", "Label_9"], (r) => assert.equal(r.body.id, "m1")],
    ["gcal.js", ["update", "--id", "e1", "--color", "basil"], (r) => assert.equal(r.query.id, "e1")],
  ]) {
    requests = [];
    const out = await run(file, args);
    assert.equal(out.code, 0, `${file} ${args.join(" ")} failed: ${out.stderr}`);
    assert.equal(requests.length, 1);
    wants(requests[0]);
  }

  // And with neither form, it fails before reaching the broker rather than
  // asking about an undefined id.
  for (const [file, args] of [
    ["gmail.js", ["read"]],
    ["gcal.js", ["update", "--color", "basil"]],
  ]) {
    requests = [];
    const out = await run(file, args);
    assert.equal(out.code, 1);
    assert.equal(requests.length, 0, `${file} ${args[0]} called the broker with no id`);
    assert.match(out.stderr, /usage:/);
  }
});

test("a broker error is relayed, not swallowed or reworded", async () => {
  // Alfred is told to report what a failed command said rather than go looking
  // for another route to the same data. That only works if what he sees is the
  // broker's own words, on stderr, with a non-zero exit.
  requests = [];
  override = { status: 400, body: { error: "unknown colour: burgundy" } };
  const bad = await run("gcal.js", ["create", "--summary", "Quiz", "--start", "2026-01-21", "--end", "2026-01-21", "--color", "burgundy"]);
  override = null;
  assert.equal(bad.code, 1);
  assert.equal(bad.stdout, "", "a failure that prints to stdout reads as a result");
  assert.match(bad.stderr, /Error: unknown colour: burgundy/);

  // A 404 carries the broker's operation list, which is the one hint worth
  // passing through — it names the real commands instead of inviting a guess.
  requests = [];
  override = {
    status: 404,
    body: { error: "no such operation: POST /mail/send", available: ["POST /mail/draft"] },
  };
  const missing = await run("gmail.js", ["labels"]);
  override = null;
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Error: no such operation/);
  assert.match(missing.stderr, /Available: POST \/mail\/draft/);
});

test("the old google.js names its replacement instead of exploding", async () => {
  // A resumed session carries the old path in its context. What matters is that
  // the failure reads as "wrong file name" rather than "the tool is broken" —
  // the second is what sends a turn looking for another route to the mailbox.
  // It has to say so with no environment at all, since it is also what gets run
  // outside a turn; and it must reach nothing, since it holds nothing.
  for (const [args, expected] of [
    [["mail", "search", "from:sarah"], /node \.\.\/bin\/gmail\.js/],
    [["cal", "events"], /node \.\.\/bin\/gcal\.js/],
    [["labels"], /gmail\.js/],
  ]) {
    requests = [];
    const out = await run("google.js", args, cleanEnv());
    assert.equal(out.code, 1, `google.js ${args.join(" ")} exited ${out.code}`);
    assert.match(out.stderr, expected);
    assert.match(out.stderr, /split/, "the message should say what happened");
    assert.equal(requests.length, 0, "the shim reached the broker");
  }

  // No arguments at all still names both, because the shim can't know which was
  // meant and a guess would send the turn to the wrong file.
  const bare = (await run("google.js", [], cleanEnv())).stderr;
  assert.match(bare, /gmail\.js/);
  assert.match(bare, /gcal\.js/);

  // And it echoes nothing back: re-joining argv loses the quoting on
  // --text "two words", so a pasted, mis-quoted draft would save a wrong email.
  const draft = await run(
    "google.js",
    ["mail", "draft", "--to", "a@b.com", "--text", "two words"],
    cleanEnv()
  );
  assert.ok(!draft.stderr.includes("a@b.com"), "the shim echoed arguments back");
  assert.ok(!draft.stderr.includes("two words"), "the shim echoed arguments back");
});

test("without the broker env, both CLIs explain themselves and reach nothing", async () => {
  // This is the standalone-invocation case: someone (or Alfred, in a turn where
  // bot.js did not inject the env) running the CLI directly. It has to fail in a
  // way that names the reason, since "command not working" is what prompts
  // looking for another path to the same data.
  for (const [file, args] of [
    ["gmail.js", ["labels"]],
    ["gcal.js", ["events"]],
    ["gmail.js", ["search", "from:sarah"]],
    ["gcal.js", ["create", "--summary", "Quiz", "--start", "2026-01-21", "--end", "2026-01-21"]],
  ]) {
    requests = [];
    const out = await run(file, args, cleanEnv());
    assert.equal(out.code, 1, `${file} ${args[0]} exited ${out.code} with no broker configured`);
    assert.match(out.stderr, /Broker unavailable/);
    assert.match(out.stderr, /ALFRED_BROKER\/ALFRED_BROKER_TOKEN/);
    assert.match(out.stderr, /can't be used standalone/);
    assert.equal(requests.length, 0);
  }

  // Half-configured is still unconfigured — a CLI that fell back to an
  // unauthenticated request would be a request without a token.
  for (const partial of [
    { ALFRED_BROKER: stubUrl },
    { ALFRED_BROKER_TOKEN: TOKEN },
  ]) {
    requests = [];
    const out = await run("gmail.js", ["labels"], { ...cleanEnv(), ...partial });
    assert.equal(out.code, 1);
    assert.match(out.stderr, /Broker unavailable/);
    assert.equal(requests.length, 0);
  }
});
