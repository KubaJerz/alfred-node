// Run with: npm test   (node's built-in runner, no network, no credentials)
//
// The broker routes for reminders. These tests check the promises the routes
// make to whoever calls them: a validation error is a 400 with a plain
// message, a person is a contact name and never a raw number, and a job is a
// name from the allowlist and never a path.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeStore } from "../reminders/store.js";
import { makeReminders } from "../reminders/service.js";
import { parseContacts } from "../reminders/contacts.js";
import { makeJobRunner } from "../reminders/jobs.js";
import { makeReminderRoutes } from "../reminders/routes.js";

// The broker's Google auth reads STATE_DIR at import. Point it at an empty
// temp dir first, as test/broker.test.js does.
process.env.STATE_DIR = mkdtempSync(path.join(tmpdir(), "alfred-reminders-routes-state-"));
const { startBroker } = await import("../google/broker.js");

const START = Date.parse("2026-11-24T17:00:00Z"); // Tue Nov 24, 12:00 PM Eastern
const OWNER_DISCORD = "100000000000000001";
const MOM_SMS = "+15550000002";

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "alfred-reminders-routes-"));
  const jobsDir = path.join(root, "jobs");
  mkdirSync(jobsDir);
  writeFileSync(path.join(jobsDir, "backup.sh"), "echo ok\n");
  writeFileSync(path.join(jobsDir, "brief.md"), "Write the morning brief.\n");
  writeFileSync(path.join(root, "outside.sh"), "echo outside\n");
  symlinkSync(path.join(root, "outside.sh"), path.join(jobsDir, "escape.sh"));
  const sent = [];
  const service = makeReminders({
    store: makeStore({ file: path.join(root, "reminders.json") }),
    contacts: parseContacts({
      spec: `mom=${MOM_SMS};anna=discord:100000000000000003`,
      ownerDiscordId: OWNER_DISCORD,
      ownerSms: "+15550000001",
    }),
    // A temp dir is not a git repo: count every file in it as committed.
    jobs: makeJobRunner({ dir: jobsDir, cwd: root, committed: (dir) => new Set(readdirSync(dir)) }),
    sendDiscord: async (to, text) => sent.push({ to, text }),
    sendSms: async (to, text) => {
      sent.push({ to, text });
      return "msg-1";
    },
    smsEnabled: true,
    now: () => START,
    log: () => {},
  });
  return { service, routes: makeReminderRoutes(service), sent };
}

const call = (routes, key, { params = {}, body } = {}) => routes[key]({ params: new URLSearchParams(params), body });

let app;
before(async () => {
  app = setup();
  await app.service.load();
});

test("the route table: list, one, add, edit, cancel, snooze, skip, contacts, jobs", () => {
  assert.deepEqual(Object.keys(app.routes).sort(), [
    "DELETE /reminders",
    "GET /reminders",
    "GET /reminders/contacts",
    "GET /reminders/jobs",
    "GET /reminders/one",
    "PATCH /reminders",
    "POST /reminders",
    "POST /reminders/skip",
    "POST /reminders/snooze",
  ]);
});

test("no route sends: a reminder goes out only when its time comes", () => {
  const names = Object.keys(app.routes);
  assert.ok(!names.some((op) => /send/i.test(op)), `a send route exists: ${names.filter((o) => /send/i.test(o))}`);
});

test("validation errors are 400s with plain messages", async () => {
  const cases = [
    [{}, /text is missing/],
    [{ text: "x" }, /say when/],
    [{ text: "x", at: "tomorrow" }, /not a time I can read\. Write Eastern time as 2026-11-25T17:00/],
    [{ text: "x", at: "2026-11-01T09:00" }, /is in the past/],
    [{ text: "x", in: "soon" }, /not a duration/],
    [{ text: "x", repeat: "hourly", time: "09:00" }, /repeat must be daily, weekly or monthly/],
    [{ text: "x", repeat: "daily", time: "25:00" }, /24-hour clock/],
    [{ text: "x", repeat: "monthly", time: "09:00", day: 31 }, /"last"/],
    [{ text: "x", in: "1h", via: "carrier-pigeon" }, /via takes discord, sms, or both/],
    [{ text: "x", in: "1h", colour: "red" }, /unknown field: colour/],
  ];
  for (const [body, message] of cases) {
    const r = await call(app.routes, "POST /reminders", { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.error, message, JSON.stringify(body));
    assert.doesNotMatch(r.error, /at Object|node:internal|\n\s+at /, "no stack in the message");
  }
  assert.deepEqual((await call(app.routes, "GET /reminders")).entries, [], "nothing was added");
});

test("a raw number or account id is refused in every form", async () => {
  for (const to of [MOM_SMS, "5550000002", "(555) 000-0002", "discord:100000000000000003", "<@100000000000000003>", [MOM_SMS], ["me", "+15559999999"]]) {
    const r = await call(app.routes, "POST /reminders", { body: { text: "x", in: "1h", to } });
    assert.equal(r.status, 400, JSON.stringify(to));
    assert.match(r.error, /contact names only/, JSON.stringify(to));
  }
  // There is no other field to put a number in.
  const r = await call(app.routes, "POST /reminders", { body: { text: "x", in: "1h", phone: MOM_SMS } });
  assert.equal(r.status, 400);
  assert.match(r.error, /unknown field: phone/);
});

test("an unknown contact is refused, and the known names are listed", async () => {
  const r = await call(app.routes, "POST /reminders", { body: { text: "x", in: "1h", to: "bob" } });
  assert.equal(r.status, 400);
  assert.match(r.error, /"bob" is not a contact\. Contacts: me, mom, anna\./);
});

test("SMS goes to me only: a text to another contact is refused, and the reason is plain", async () => {
  // mom has only a number. The 10DLC campaign allows no text to her yet.
  const r = await call(app.routes, "POST /reminders", { body: { text: "x", in: "1h", to: "mom", via: "sms" } });
  assert.equal(r.status, 400);
  assert.equal(r.error, 'mom cannot get this by SMS: SMS goes to "me" only for now.');
  const all = await call(app.routes, "POST /reminders", { body: { text: "x", in: "1h", to: "me,anna,mom" } });
  assert.equal(all.status, 400, "mom has no channel at all");
  const ok = await call(app.routes, "POST /reminders", { body: { text: "Dinner at 7", in: "1h", to: "me,anna" } });
  assert.match(ok.line, /to me by Discord and SMS, anna by Discord\. Skipped: anna has no SMS\.$/);
  await call(app.routes, "DELETE /reminders", { params: { id: ok.entry.id } });
});

test("an edit cannot slip a number in either", async () => {
  const { entry } = await call(app.routes, "POST /reminders", { body: { text: "edit me", in: "1h" } });
  const r = await call(app.routes, "PATCH /reminders", { params: { id: entry.id }, body: { to: MOM_SMS } });
  assert.equal(r.status, 400);
  assert.match(r.error, /contact names only/);
  assert.deepEqual((await call(app.routes, "GET /reminders/one", { params: { id: entry.id } })).entry.to, ["me"]);
  await call(app.routes, "DELETE /reminders", { params: { id: entry.id } });
});

test("bad job names are refused: a path, a slash, an unknown name, a symlink out", async () => {
  for (const job of ["../x", "x/y", "../../etc/passwd", "Backup", "backup.sh", "-rf"]) {
    const r = await call(app.routes, "POST /reminders", { body: { job, in: "1h" } });
    assert.equal(r.status, 400, job);
    assert.match(r.error, /not a job name/, job);
  }
  const unknown = await call(app.routes, "POST /reminders", { body: { job: "nope", in: "1h" } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.error, /no job "nope"\. Jobs: backup, brief\. A job is a file in agent\/jobs that git has committed/);
  const escape = await call(app.routes, "POST /reminders", { body: { job: "escape", in: "1h" } });
  assert.equal(escape.status, 400, "a symlink that points outside the jobs dir is not a job");
});

test("GET /reminders/jobs lists the allowlist", async () => {
  assert.deepEqual(await call(app.routes, "GET /reminders/jobs"), {
    jobs: [
      { name: "backup", kind: "code" },
      { name: "brief", kind: "agent" },
    ],
  });
});

test("GET /reminders/contacts gives names and channels, and no number or id", async () => {
  const r = await call(app.routes, "GET /reminders/contacts");
  // mom has a number, but SMS goes to "me" only for now.
  assert.deepEqual(r, {
    contacts: [
      { name: "me", channels: ["discord", "sms"] },
      { name: "mom", channels: [] },
      { name: "anna", channels: ["discord"] },
    ],
  });
  assert.doesNotMatch(JSON.stringify(r), /\d{5}/);
});

test("add, list, show, edit, snooze, skip and cancel work through the routes", async () => {
  const { service, routes } = setup();
  await service.load();
  const added = await call(routes, "POST /reminders", { body: { text: "Stand-up", repeat: "weekly", days: "MO,WE", time: "09:00", via: "discord" } });
  assert.equal(added.status, undefined);
  const id = added.entry.id;
  assert.equal(added.line, `${id}: "Stand-up" — every Monday and Wednesday at 9:00 AM, next Wed Nov 25, 9:00 AM, to me by Discord`);

  const job = await call(routes, "POST /reminders", { body: { job: "backup", repeat: "daily", time: "03:00" } });
  assert.match(job.entry.id, /^j/);

  assert.deepEqual((await call(routes, "GET /reminders")).entries.map((e) => e.id), [job.entry.id, id]);
  assert.deepEqual((await call(routes, "GET /reminders", { params: { kind: "reminder" } })).entries.map((e) => e.id), [id]);
  assert.equal((await call(routes, "GET /reminders", { params: { kind: "nope" } })).status, 400);

  const one = await call(routes, "GET /reminders/one", { params: { id: id.toUpperCase() } });
  assert.equal(one.entry.id, id, "ids match without case");

  const edited = await call(routes, "PATCH /reminders", { params: { id }, body: { time: "10:00" } });
  assert.equal(edited.entry.repeatText, "every Monday and Wednesday at 10:00 AM");

  const snoozed = await call(routes, "POST /reminders/snooze", { params: { id }, body: { for: "2h" } });
  assert.match(snoozed.line, /^Snoozed .* \(snoozed\)/);
  const viaQuery = await call(routes, "POST /reminders/snooze", { params: { id, until: "2026-11-25T08:00" }, body: {} });
  assert.equal(viaQuery.entry.dueText, "Wed Nov 25, 8:00 AM");

  const skipped = await call(routes, "POST /reminders/skip", { params: { id } });
  assert.match(skipped.line, /^Skipped Wed Nov 25, 8:00 AM\./);

  const cancelled = await call(routes, "DELETE /reminders", { params: { id } });
  assert.equal(cancelled.line, `Cancelled ${id}: "Stand-up".`);
  assert.deepEqual((await call(routes, "GET /reminders")).entries.map((e) => e.id), [job.entry.id]);
  assert.equal((await call(routes, "GET /reminders", { params: { all: "1" } })).entries.length, 2);
});

test("a missing id is a 400, and an unknown id is a 404", async () => {
  const bodies = { "PATCH /reminders": { text: "x" }, "POST /reminders/snooze": { for: "1h" } };
  for (const key of ["GET /reminders/one", "PATCH /reminders", "DELETE /reminders", "POST /reminders/snooze", "POST /reminders/skip"]) {
    const missing = await call(app.routes, key, { body: bodies[key] });
    assert.deepEqual(missing, { error: "id required", status: 400 }, key);
    const unknown = await call(app.routes, key, { params: { id: "rzzz" }, body: bodies[key] });
    assert.equal(unknown.status, 404, key);
    assert.match(unknown.error, /no reminder or job "rzzz"/, key);
  }
});

// The routes mount on the real broker, as bot.js mounts them. Over loopback,
// with the token, and with nothing from Google in the table.
let broker;
after(async () => broker?.close());

test("mounted on the broker: the status codes and the bodies arrive intact", async () => {
  const { service, routes } = setup();
  await service.load();
  broker = await startBroker({ baseRoutes: {}, extraRoutes: routes, log: () => {} });
  const hit = (p, { method = "GET", body } = {}) =>
    fetch(broker.url + p, {
      method,
      headers: { "x-alfred-broker": broker.token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

  const bad = await hit("/reminders", { method: "POST", body: { text: "x", in: "1h", to: MOM_SMS } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /contact names only/);

  const ok = await hit("/reminders", { method: "POST", body: { text: "Call the bank", in: "1h" } });
  assert.equal(ok.status, 200);
  const { entry } = await ok.json();

  const patched = await hit(`/reminders?id=${entry.id}`, { method: "PATCH", body: { text: "Call the bank about the card" } });
  assert.equal((await patched.json()).entry.text, "Call the bank about the card", "the PATCH body reached the route");

  const gone = await hit(`/reminders?id=${entry.id}`, { method: "DELETE" });
  assert.equal((await gone.json()).entry.status, "cancelled");

  const nope = await hit("/reminders/send", { method: "POST", body: {} });
  assert.equal(nope.status, 404);
});
