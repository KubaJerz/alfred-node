// Run with: npm test   (node's built-in runner, no network, no credentials)
//
// The reminder engine with a fake clock and fake senders. The store is real
// and writes to a temp dir, so "a new service loads the same file" is a real
// restart. Nothing here reaches Discord, Telnyx or Google.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeStore } from "../reminders/store.js";
import { makeReminders, reminderConfig, DEFAULTS } from "../reminders/service.js";
import { parseContacts } from "../reminders/contacts.js";
import { makeCalendarMirror } from "../reminders/calendar-mirror.js";
import { parseWhen, toCalendarRecurrence } from "../reminders/schedule.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = Date.parse("2026-11-24T17:00:00Z"); // Tue Nov 24, 2026, 12:00 PM Eastern
const et = (local) => +parseWhen(local); // Eastern wall time to ms

const OWNER_DISCORD = "100000000000000001";
const OWNER_SMS = "+15550000001";
const MOM_SMS = "+15550000002";
const ANNA_DISCORD = "100000000000000003";
const CONTACTS = `mom=${MOM_SMS};anna=discord:${ANNA_DISCORD}`;

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};

// A service with fake senders. h.sent records what went out. h.discordFail and
// h.smsFail return an Error to throw for one send, or null. fs replaces
// fs/promises in the store, to make a save fail.
function harness({ file, clock, contacts = CONTACTS, fs, ...opts } = {}) {
  file = file || path.join(mkdtempSync(path.join(tmpdir(), "alfred-reminders-svc-")), "reminders.json");
  clock = clock || { t: START };
  const h = {
    file,
    clock,
    sent: { discord: [], sms: [] },
    logs: [],
    notes: [],
    ready: true,
    discordFail: null,
    smsFail: null,
    smsSeq: 0,
  };
  h.sendDiscord = async (to, text) => {
    const err = h.discordFail?.(to, text);
    if (err) throw err;
    h.sent.discord.push({ to, text });
  };
  h.sendSms = async (to, text) => {
    const err = h.smsFail?.(to, text);
    if (err) throw err;
    const id = `msg-${++h.smsSeq}`;
    h.sent.sms.push({ to, text, id });
    return id;
  };
  h.svc = makeReminders({
    store: makeStore({ file, ...(fs ? { fs } : {}) }),
    contacts: parseContacts({ spec: contacts, ownerDiscordId: OWNER_DISCORD, ownerSms: OWNER_SMS }),
    sendDiscord: (...a) => h.sendDiscord(...a),
    discordReady: () => h.ready,
    sendSms: (...a) => h.sendSms(...a),
    smsEnabled: true,
    now: () => h.clock.t,
    log: (m) => h.logs.push(m),
    note: (m) => h.notes.push(m),
    silent: (text) => text.trim() === "<no_reply>",
    ...opts,
  });
  h.at = (local) => (h.clock.t = et(local));
  h.advance = (ms) => (h.clock.t += ms);
  h.tickAt = async (local) => {
    h.at(local);
    return h.svc.tick();
  };
  h.disk = () => JSON.parse(readFileSync(file, "utf8"));
  h.deliveries = (id) => h.svc.get(id).last.deliveries.map((d) => `${d.contact}/${d.channel}:${d.state}:${d.attempts}`);
  return h;
}

async function started(opts) {
  const h = harness(opts);
  await h.svc.load();
  return h;
}

// A job runner with no processes. results maps a job name to a function that
// returns what run() resolves (or a promise of it).
function fakeJobs(results = {}) {
  const runs = [];
  const list = [
    { name: "backup", kind: "code" },
    { name: "brief", kind: "agent" },
  ];
  return {
    runs,
    available: () => list,
    has: (name) => list.some((j) => j.name === name),
    run: async (name) => {
      runs.push(name);
      return (results[name] || (() => ({ ok: true, output: "", error: "" })))();
    },
  };
}

// A Google Calendar API in memory that keeps its calls. failInsert: how many
// inserts fail first. events holds the events by id. writes() leaves out the
// reads.
function fakeCalendar({ failInsert = 0, failAlways = false, log } = {}) {
  const calls = [];
  const events = new Map();
  let n = 0;
  let fails = failInsert;
  const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });
  const api = {
    events: {
      insert: async (args) => {
        calls.push(["insert", args]);
        if (failAlways || fails-- > 0) throw Object.assign(new Error("backend error"), { status: 503 });
        const id = `ev${++n}`;
        events.set(id, { id, ...structuredClone(args.requestBody) });
        return { data: { id } };
      },
      get: async (args) => {
        calls.push(["get", args]);
        if (!events.has(args.eventId)) throw notFound();
        return { data: structuredClone(events.get(args.eventId)) };
      },
      patch: async (args) => {
        calls.push(["patch", args]);
        if (!events.has(args.eventId)) throw notFound();
        Object.assign(events.get(args.eventId), structuredClone(args.requestBody));
        return { data: { id: args.eventId } };
      },
      delete: async (args) => {
        calls.push(["delete", args]);
        if (!events.delete(args.eventId)) throw notFound();
        return {};
      },
    },
  };
  const writes = () => calls.filter(([op]) => op !== "get");
  return { calls, writes, events, mirror: makeCalendarMirror({ calendarClient: async () => api, ...(log ? { log } : {}) }) };
}

// ── Firing and Discord ──────────────────────────────────────────────────────

test("one-time reminder by Discord: delivered when the send resolves, then done", async () => {
  const h = await started();
  const { entry, line } = await h.svc.add({ text: "Stretch", at: "2026-11-24T12:30", via: "discord" });
  assert.match(entry.id, /^r[2-9a-z]{3}$/);
  assert.equal(line, `${entry.id}: "Stretch" — Tue Nov 24, 12:30 PM, to me by Discord`);

  await h.tickAt("2026-11-24T12:29");
  assert.equal(h.sent.discord.length, 0, "not before its time");

  await h.tickAt("2026-11-24T12:30");
  assert.deepEqual(h.sent.discord, [{ to: OWNER_DISCORD, text: "⏰ Stretch" }]);
  const after = h.svc.get(entry.id);
  assert.equal(after.status, "done");
  assert.equal(after.due, null);
  assert.deepEqual(h.deliveries(entry.id), ["me/discord:delivered:1"]);
  assert.deepEqual(h.notes, [`Reminder ${entry.id} "Stretch" went to me by Discord.`]);

  h.advance(10 * MIN);
  await h.svc.tick();
  assert.equal(h.sent.discord.length, 1, "a delivered reminder is not sent again");
});

test("a tick fires anything due at or before now, and says when it is late", async () => {
  const h = await started();
  const { entry } = await h.svc.add({ text: "Stretch", at: "2026-11-24T12:30", via: "discord" });
  await h.tickAt("2026-11-24T12:34"); // late by 4 min: no note
  assert.equal(h.sent.discord[0].text, "⏰ Stretch");

  const late = await h.svc.add({ text: "Water", at: "2026-11-24T12:40", via: "discord" });
  await h.tickAt("2026-11-24T12:52");
  assert.equal(h.sent.discord[1].text, "⏰ Water (due Tue Nov 24, 12:40 PM, sent late)");
  assert.match(h.notes.at(-1), new RegExp(`Reminder ${late.entry.id} "Water" went to me by Discord, late`));
  assert.equal(h.svc.get(entry.id).status, "done");
});

test("another contact gets the 'Reminder from Alfred' form", async () => {
  const h = await started();
  await h.svc.add({ text: "Bring the charger", in: "10m", to: "anna", via: "discord" });
  h.advance(10 * MIN);
  await h.svc.tick();
  assert.deepEqual(h.sent.discord, [{ to: ANNA_DISCORD, text: "⏰ Reminder from Alfred: Bring the charger" }]);
});

test("Discord not ready: the delivery waits and no attempt is counted", async () => {
  const h = await started();
  const { entry } = await h.svc.add({ text: "Stretch", in: "5m", via: "discord" });
  h.ready = false;
  for (let i = 0; i < 4; i++) {
    h.advance(5 * MIN);
    await h.svc.tick();
  }
  assert.equal(h.sent.discord.length, 0);
  assert.deepEqual(h.deliveries(entry.id), ["me/discord:pending:0"]);
  h.ready = true;
  h.advance(MIN);
  await h.svc.tick();
  assert.deepEqual(h.deliveries(entry.id), ["me/discord:delivered:1"]);
});

test("Discord: a failed send waits 1, 2, 5, 10 min, then gives up after 5 tries", async () => {
  const h = await started();
  h.discordFail = () => new Error("Missing Access");
  const { entry } = await h.svc.add({ text: "Stretch", in: "5m", via: "discord" });
  h.advance(5 * MIN);
  await h.svc.tick();
  assert.deepEqual(h.deliveries(entry.id), ["me/discord:pending:1"]);
  for (const [wait, attempts] of [[1, 2], [2, 3], [5, 4], [10, 5]]) {
    h.advance(wait * MIN - 1000);
    await h.svc.tick();
    assert.equal(h.svc.get(entry.id).last.deliveries[0].attempts, attempts - 1, `not before ${wait} min`);
    h.advance(1000);
    await h.svc.tick();
    assert.equal(h.svc.get(entry.id).last.deliveries[0].attempts, attempts);
  }
  assert.deepEqual(h.deliveries(entry.id), ["me/discord:failed:5"]);
  // The failed channel is the owner's own Discord, so the alert goes to the log.
  assert.equal(h.disk().alerts.length, 0);
  assert.match(h.logs.join("\n"), /did not reach me by Discord: Discord: Missing Access/);
  h.advance(DAY);
  await h.svc.tick();
  assert.equal(h.svc.get(entry.id).last.deliveries[0].attempts, 5, "no attempt after giving up");
});

test("a send that never settles times out as a failed try and does not stop the tick", async () => {
  const h = await started({ config: { sendTimeoutMs: 20 } });
  h.sendDiscord = () => new Promise(() => {});
  const { entry } = await h.svc.add({ text: "Stretch", in: "1m", via: "discord" });
  h.advance(MIN);
  assert.equal(await h.svc.tick(), true);
  const d = h.svc.get(entry.id).last.deliveries[0];
  assert.equal(d.state, "pending");
  assert.match(d.error, /timed out/);
});

test("tick does not run twice at once", async () => {
  const h = await started();
  const gate = deferred();
  const called = deferred();
  h.sendDiscord = async (to, text) => {
    called.resolve();
    await gate.promise;
    h.sent.discord.push({ to, text });
  };
  await h.svc.add({ text: "Stretch", in: "1m", via: "discord" });
  h.advance(MIN);
  const first = h.svc.tick();
  await called.promise;
  assert.equal(await h.svc.tick(), false, "the second tick returns at once");
  gate.resolve();
  assert.equal(await first, true);
  assert.equal(h.sent.discord.length, 1);
});

test("tick before load does nothing, and add before load is refused", async () => {
  const h = harness();
  assert.equal(await h.svc.tick(), false);
  await assert.rejects(h.svc.add({ text: "x", in: "5m" }), /not loaded/);
});

// ── SMS ─────────────────────────────────────────────────────────────────────

test("SMS: sent, then the delivered report confirms it", async () => {
  const h = await started();
  const { entry } = await h.svc.add({ text: "Call the bank", in: "5m", via: "sms" });
  h.advance(5 * MIN);
  await h.svc.tick();
  assert.deepEqual(h.sent.sms, [{ to: OWNER_SMS, text: "⏰ Call the bank", id: "msg-1" }]);
  assert.deepEqual(h.deliveries(entry.id), ["me/sms:sent:1"]);
  await h.svc.onSmsReport({ id: "msg-1", statuses: ["delivered"] });
  assert.deepEqual(h.deliveries(entry.id), ["me/sms:delivered:1"]);
  h.advance(30 * MIN);
  await h.svc.tick();
  assert.equal(h.sent.sms.length, 1, "a confirmed SMS is not sent again");
});

test("SMS: a failed report sends again", async () => {
  const h = await started();
  const { entry } = await h.svc.add({ text: "Call the bank", in: "5m", via: "sms" });
  h.advance(5 * MIN);
  await h.svc.tick();
  await h.svc.onSmsReport({ id: "msg-1", statuses: ["delivery_failed"] });
  assert.deepEqual(h.deliveries(entry.id), ["me/sms:pending:1"]);
  h.advance(MIN);
  await h.svc.tick();
  assert.equal(h.sent.sms.length, 2);
  await h.svc.onSmsReport({ id: "msg-2", statuses: ["delivered"] });
  assert.deepEqual(h.deliveries(entry.id), ["me/sms:delivered:2"]);
});

test("SMS: no report within the confirm window sends again", async () => {
  const h = await started();
  const { entry } = await h.svc.add({ text: "Call the bank", in: "5m", via: "sms" });
  h.advance(5 * MIN);
  await h.svc.tick();
  h.advance(9 * MIN);
  await h.svc.tick();
  assert.equal(h.sent.sms.length, 1, "inside the window: wait");
  h.advance(MIN);
  await h.svc.tick();
  assert.equal(h.sent.sms.length, 2, "10 min with no report: send again");
  assert.equal(h.sent.sms[1].text, "⏰ Call the bank (due Tue Nov 24, 12:05 PM, sent late)", "the late note is decided at the send");
  assert.deepEqual(h.deliveries(entry.id), ["me/sms:sent:2"]);
});

test("SMS: a late 'delivered' for an older send still confirms it", async () => {
  const h = await started();
  const { entry } = await h.svc.add({ text: "Call the bank", in: "5m", via: "sms" });
  h.advance(5 * MIN);
  await h.svc.tick();
  h.advance(10 * MIN);
  await h.svc.tick(); // no report: msg-2 goes out
  await h.svc.onSmsReport({ id: "msg-1", statuses: ["delivery_failed"] });
  assert.deepEqual(h.deliveries(entry.id), ["me/sms:sent:2"], "the failure of an older send changes nothing");
  await h.svc.onSmsReport({ id: "msg-1", statuses: ["delivered"] });
  assert.deepEqual(h.deliveries(entry.id), ["me/sms:delivered:2"]);
});

test("SMS: after 3 tries it gives up and tells the owner once by Discord", async () => {
  const h = await started();
  const { entry, line } = await h.svc.add({ text: "Bring the pie", in: "5m", via: "sms" });
  assert.match(line, /to me by SMS$/);

  h.advance(5 * MIN);
  await h.svc.tick(); // try 1
  assert.deepEqual(h.sent.sms.map((s) => [s.to, s.text]), [[OWNER_SMS, "⏰ Bring the pie"]]);
  h.advance(10 * MIN);
  await h.svc.tick(); // no report: try 2
  await h.svc.onSmsReport({ id: "msg-2", statuses: ["sending_failed"] });
  h.advance(MIN);
  await h.svc.tick(); // failed report: try 3
  h.advance(10 * MIN);
  await h.svc.tick(); // no report again: give up, and the alert goes out
  assert.equal(h.sent.sms.length, 3);
  assert.deepEqual(h.deliveries(entry.id), ["me/sms:failed:3"]);
  const alerts = h.sent.discord.filter((m) => m.to === OWNER_DISCORD);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, new RegExp(`Reminder ${entry.id} "Bring the pie" did not reach me by SMS: no delivery report`));
  assert.doesNotMatch(alerts[0].text, /\+1555/, "the alert names the contact, not the number");

  h.advance(DAY);
  await h.svc.tick();
  assert.equal(h.sent.sms.length, 3);
  assert.equal(h.sent.discord.length, 1, "the owner hears it once");
});

test("SMS: delivery_unconfirmed is final", async () => {
  const h = await started();
  const { entry } = await h.svc.add({ text: "Call the bank", in: "5m", via: "sms" });
  h.advance(5 * MIN);
  await h.svc.tick();
  await h.svc.onSmsReport({ id: "msg-1", statuses: ["delivery_unconfirmed"] });
  assert.deepEqual(h.deliveries(entry.id), ["me/sms:unconfirmed:1"]);
  h.advance(HOUR);
  await h.svc.tick();
  assert.equal(h.sent.sms.length, 1, "another send cannot help");
  assert.match(h.logs.join("\n"), /delivery_unconfirmed/);
  assert.equal(h.sent.discord.length, 0, "not a failure to alert");
});

test("SMS: an opt-out error is final at once, with no retry", async () => {
  // sendSms (telnyx/sms.js) gives the code, the title and the detail. The old
  // form gave the detail only, which names a "block rule" and not STOP.
  for (const error of [
    "Telnyx send failed: 40300 Blocked due to STOP message: Messages cannot be sent from '+18005550100' to '+15550000001' due to an existing block rule.",
    "Telnyx send failed: Messages cannot be sent from '+18005550100' to '+15550000001' due to an existing block rule.",
  ]) {
    const h = await started();
    h.smsFail = () => new Error(error);
    const { entry } = await h.svc.add({ text: "Bring the pie", in: "5m", via: "sms" });
    h.advance(5 * MIN);
    await h.svc.tick();
    assert.deepEqual(h.deliveries(entry.id), ["me/sms:failed:1"], error);
    const d = h.svc.get(entry.id).last.deliveries[0];
    assert.doesNotMatch(d.error, /\d{10}/, "no number in the stored error");
    assert.match(h.sent.discord[0].text, /did not reach me by SMS: the number does not take texts/);
    h.advance(HOUR);
    await h.svc.tick();
    assert.equal(h.svc.get(entry.id).last.deliveries[0].attempts, 1);
    assert.equal(h.sent.sms.length, 0);
  }
});

test("SMS: a failed report with the STOP code is final at once", async () => {
  const h = await started();
  const { entry } = await h.svc.add({ text: "Call the bank", in: "5m", via: "sms" });
  h.advance(5 * MIN);
  await h.svc.tick();
  await h.svc.onSmsReport({ id: "msg-1", statuses: ["sending_failed"], errors: ["40300"] });
  assert.deepEqual(h.deliveries(entry.id), ["me/sms:failed:1"]);
  assert.match(h.svc.get(entry.id).last.deliveries[0].error, /does not take texts \(Telnyx error 40300\)/);
  h.advance(HOUR);
  await h.svc.tick();
  assert.equal(h.sent.sms.length, 1, "no send after a STOP");
});

test("SMS: an ordinary send error waits and tries again", async () => {
  const h = await started();
  let fail = true;
  h.smsFail = () => (fail ? new Error("Telnyx send failed: HTTP 503") : null);
  const { entry } = await h.svc.add({ text: "Call the bank", in: "5m", via: "sms" });
  h.advance(5 * MIN);
  await h.svc.tick();
  assert.deepEqual(h.deliveries(entry.id), ["me/sms:pending:1"]);
  fail = false;
  h.advance(MIN);
  await h.svc.tick();
  assert.deepEqual(h.deliveries(entry.id), ["me/sms:sent:2"]);
});

test("SMS: a report that comes before the send returns is matched later", async () => {
  const h = await started();
  h.sendSms = async (to, text) => {
    // Telnyx reports before the HTTP answer reaches us.
    await h.svc.onSmsReport({ id: "early-1", statuses: ["delivered"] });
    h.sent.sms.push({ to, text });
    return "early-1";
  };
  const { entry } = await h.svc.add({ text: "Call the bank", in: "5m", via: "sms" });
  h.advance(5 * MIN);
  await h.svc.tick();
  assert.deepEqual(h.deliveries(entry.id), ["me/sms:delivered:1"]);
});

test("an unknown report is kept for 30 min, then dropped", async () => {
  const h = await started();
  await h.svc.onSmsReport({ id: "ghost", statuses: ["delivered"] });
  h.advance(31 * MIN);
  await h.svc.tick(); // prune
  h.sendSms = async () => "ghost";
  const { entry } = await h.svc.add({ text: "x", in: "1m", via: "sms" });
  h.advance(MIN);
  await h.svc.tick();
  assert.deepEqual(h.deliveries(entry.id), ["me/sms:sent:1"], "the old report did not match");
});

test("SMS: a report that comes while the list loads is matched after the load", async () => {
  for (const [status, after] of [["delivered", "me/sms:delivered:1"], ["delivery_unconfirmed", "me/sms:unconfirmed:1"]]) {
    const a = await started();
    const { entry } = await a.svc.add({ text: "Call the bank", in: "5m", via: "sms" });
    a.advance(5 * MIN);
    await a.svc.tick();
    // The bot restarts. Telnyx sends the report again while the list loads.
    const b = harness({ file: a.file, clock: a.clock });
    const loading = b.svc.load();
    await b.svc.onSmsReport({ id: "msg-1", statuses: [status] });
    await loading;
    assert.deepEqual(b.deliveries(entry.id), [after], status);
    b.advance(30 * MIN);
    await b.svc.tick();
    assert.equal(b.sent.sms.length + b.sent.discord.length, 0, `${status}: no second send, and no alert`);
  }
});

test("SMS: a report kept while the list does not load is dropped after 30 min", async () => {
  const a = await started();
  const { entry } = await a.svc.add({ text: "Call the bank", in: "5m", via: "sms" });
  a.advance(5 * MIN);
  await a.svc.tick();
  const b = harness({ file: a.file, clock: a.clock });
  await b.svc.onSmsReport({ id: "msg-1", statuses: ["delivered"] }); // no load yet
  b.advance(31 * MIN);
  await b.svc.onSmsReport({ id: "msg-other", statuses: ["delivered"] });
  await b.svc.load();
  assert.deepEqual(b.deliveries(entry.id), ["me/sms:sent:1"], "a report older than 30 min is not used");
});

// ── Crashes and restarts ────────────────────────────────────────────────────

test("a crash after an SMS went out, before its report: the next service sends again", async () => {
  const a = await started();
  const { entry } = await a.svc.add({ text: "Call the bank", in: "5m", via: "sms" });
  a.advance(5 * MIN);
  await a.svc.tick();
  assert.equal(a.sent.sms.length, 1);

  // The bot restarts. The report for msg-1 never comes.
  const b = await started({ file: a.file, clock: a.clock });
  b.smsSeq = 1;
  a.advance(10 * MIN);
  await b.svc.tick();
  assert.equal(b.sent.sms.length, 1, "the new service sent it again");
  assert.deepEqual(b.deliveries(entry.id), ["me/sms:sent:2"]);
});

test("a crash during a send: the attempt was saved first, and the next service sends again", async () => {
  const a = await started();
  const called = deferred();
  a.sendDiscord = () => {
    called.resolve();
    return new Promise(() => {}); // the process dies here
  };
  const { entry } = await a.svc.add({ text: "Stretch", in: "5m", via: "discord" });
  a.advance(5 * MIN);
  a.svc.tick();
  await called.promise;
  const saved = a.disk().entries[0].occurrence.deliveries[0];
  assert.equal(saved.attempts, 1, "the attempt is on disk before the send");
  assert.equal(saved.state, "pending");

  const b = await started({ file: a.file, clock: { t: a.clock.t + MIN } });
  await b.svc.tick();
  assert.deepEqual(b.sent.discord, [{ to: OWNER_DISCORD, text: "⏰ Stretch" }]);
  assert.deepEqual(b.deliveries(entry.id), ["me/discord:delivered:2"]);
});

test("a reminder that came due while the bot was down fires at the first tick after load", async () => {
  const a = await started();
  const { entry } = await a.svc.add({ text: "Stretch", at: "2026-11-24T13:00", via: "discord" });
  const b = await started({ file: a.file, clock: { t: et("2026-11-24T15:00") } });
  await b.svc.tick();
  assert.deepEqual(b.sent.discord, [{ to: OWNER_DISCORD, text: "⏰ Stretch (due Tue Nov 24, 1:00 PM, sent late)" }]);
  assert.equal(b.svc.get(entry.id).status, "done");
});

// ── Catch-up ────────────────────────────────────────────────────────────────

test("catch-up: misses older than the window go in one summary per contact", async () => {
  const h = await started();
  const a = await h.svc.add({ text: "Call the bank", at: "2026-11-24T13:00" });
  const b = await h.svc.add({ text: "Pay rent", at: "2026-11-24T14:00", via: "discord" });
  const m = await h.svc.add({ text: "Bring the charger", at: "2026-11-24T13:30", to: "anna" });
  const recent = await h.svc.add({ text: "Stretch", at: "2026-11-25T08:00", via: "discord" });

  // The bot was off from noon until 9 AM the next day.
  await h.tickAt("2026-11-25T09:00");
  const discord = h.sent.discord.map((s) => [s.to, s.text]);
  assert.deepEqual(discord.sort(), [
    [OWNER_DISCORD, "⏰ Stretch (due Wed Nov 25, 8:00 AM, sent late)"],
    [OWNER_DISCORD, "⏰ While I was offline, these came due:\n• Call the bank (due Tue Nov 24, 1:00 PM)\n• Pay rent (due Tue Nov 24, 2:00 PM)"],
    [ANNA_DISCORD, "⏰ Reminders from Alfred. While I was offline, these came due:\n• Bring the charger (due Tue Nov 24, 1:30 PM)"],
  ].sort());
  assert.deepEqual(h.sent.sms.map((s) => [s.to, s.text]), [
    [OWNER_SMS, "⏰ While I was offline, these came due:\n• Call the bank (due Tue Nov 24, 1:00 PM)\n• Pay rent (due Tue Nov 24, 2:00 PM)"],
  ]);
  for (const { entry } of [a, b, m, recent]) assert.equal(h.svc.get(entry.id).status, "done");
  assert.ok(h.notes.some((n) => /catch-up summary went to me by Discord and SMS/.test(n)), h.notes.join("\n"));
  assert.deepEqual(h.disk().missed, [], "the summary lines are used up");

  // The summary is at least once too: its SMS waits for a report.
  h.advance(11 * MIN);
  await h.svc.tick();
  assert.equal(h.sent.sms.length, 2, "no report for the owner's copy: sent again");
  await h.svc.onSmsReport({ id: h.sent.sms[1].id, statuses: ["delivered"] });
  h.advance(11 * MIN);
  await h.svc.tick();
  assert.equal(h.sent.sms.length, 2);
});

test("a repeating entry fires once after downtime and moves to the next future time", async () => {
  const h = await started();
  const { entry } = await h.svc.add({ text: "Pills", repeat: "daily", time: "09:00", via: "discord" });
  assert.equal(entry.dueText, "Wed Nov 25, 9:00 AM");

  // Down from Tuesday noon to Saturday 10 AM: four 9:00s passed, the last one 1 h ago.
  await h.tickAt("2026-11-28T10:00");
  assert.deepEqual(h.sent.discord.map((s) => s.text), ["⏰ Pills (due Sat Nov 28, 9:00 AM, sent late)"]);
  const after = h.svc.get(entry.id);
  assert.equal(after.dueText, "Sun Nov 29, 9:00 AM");
  assert.equal(after.status, "active");

  // Down again, until the last 9:00 is 14 h old: one summary line.
  await h.tickAt("2026-12-01T23:00");
  assert.equal(h.sent.discord.at(-1).text, "⏰ While I was offline, these came due:\n• Pills (due Tue Dec 1, 9:00 AM, missed 3 times)");
  assert.equal(h.svc.get(entry.id).dueText, "Wed Dec 2, 9:00 AM");
});

test("catch-up: a failed save after the fire loses nothing. The next service sends the summary", async () => {
  // The save that makes the summary fails: the disk is full, or the bot dies
  // at that moment.
  let full = false;
  const fs = {
    ...fsp,
    writeFile: async (file, text, opts) => {
      if (full && JSON.parse(text).digests.length) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      return fsp.writeFile(file, text, opts);
    },
  };
  const a = await started({ fs });
  const { entry } = await a.svc.add({ text: "Pay rent", at: "2026-11-24T13:00", via: "discord" });
  full = true;
  await a.tickAt("2026-11-25T14:00"); // 25 h late: a line for the summary
  assert.equal(a.sent.discord.length, 0);
  assert.equal(a.disk().entries[0].status, "done");
  assert.deepEqual(a.disk().missed.map((m) => m.line), ["Pay rent (due Tue Nov 24, 1:00 PM)"], "the line was saved with the fire");

  // The bot restarts, and the disk has room again.
  full = false;
  const b = await started({ file: a.file, clock: a.clock });
  await b.svc.tick();
  assert.deepEqual(b.sent.discord, [{ to: OWNER_DISCORD, text: "⏰ While I was offline, these came due:\n• Pay rent (due Tue Nov 24, 1:00 PM)" }]);
  assert.deepEqual(b.disk().missed, []);
  b.advance(MIN);
  await b.svc.tick();
  assert.equal(b.sent.discord.length, 1, "one summary, not two");
  assert.equal(b.svc.get(entry.id).status, "done");
});

test("catch-up: a summary that no channel can take is told to the owner", async () => {
  const a = await started();
  await a.svc.add({ text: "Bring the charger", at: "2026-11-24T13:00", to: "anna" });
  // The bot comes back a day late, and anna is no longer a contact.
  const b = await started({ file: a.file, clock: { t: et("2026-11-25T14:00") }, contacts: `mom=${MOM_SMS}` });
  await b.svc.tick();
  assert.deepEqual(b.sent.discord, [
    {
      to: OWNER_DISCORD,
      text: "⚠️ The catch-up summary did not go to anna: anna is not a contact now. It listed: Bring the charger (due Tue Nov 24, 1:00 PM)",
    },
  ]);
});

// ── Contacts and caps ───────────────────────────────────────────────────────

test("contacts: names only. A number, an id, or an unknown name is refused", async () => {
  const h = await started();
  for (const to of ["+15551234567", "5551234567", "discord:100000000000000009", "<@100000000000000009>", "bob@example.com"]) {
    await assert.rejects(h.svc.add({ text: "x", in: "5m", to }), (err) => err.status === 400 && /contact names only/.test(err.message), to);
  }
  await assert.rejects(h.svc.add({ text: "x", in: "5m", to: "bob" }), /"bob" is not a contact\. Contacts: me, mom, anna/);
  await assert.rejects(h.svc.add({ text: "x", in: "5m", to: "me,bob" }), /not a contact/);
  assert.equal(h.svc.list().length, 0);
});

test("contacts: a missing channel is skipped and said, a contact with no channel is refused", async () => {
  const h = await started();
  const { line } = await h.svc.add({ text: "Dinner at 7", in: "1h", to: "me,anna" });
  assert.match(line, /to me by Discord and SMS, anna by Discord\. Skipped: anna has no SMS\.$/);
  await assert.rejects(h.svc.add({ text: "x", in: "1h", to: "mom", via: "discord" }), /mom cannot get this by Discord: mom has no Discord/);
  // mom has a number, but SMS goes to "me" only for now (docs/phone-design.md).
  await assert.rejects(
    h.svc.add({ text: "x", in: "1h", to: "mom" }),
    /^Error: mom cannot get this by Discord and SMS: mom has no Discord, SMS goes to "me" only for now\.$/
  );
  await assert.rejects(h.svc.add({ text: "x", in: "1h", via: "fax" }), /via takes discord, sms, or both/);
});

test("caps: 300 active by default, at most 10 contacts per entry, 25 entries per contact", async () => {
  assert.equal(DEFAULTS.maxActive, 300);
  assert.equal(DEFAULTS.maxContacts, 10);
  assert.equal(DEFAULTS.maxPerContact, 25);
  const h = await started({ config: { maxActive: 4, maxPerContact: 2, maxContacts: 2 } });
  await h.svc.add({ text: "a", in: "1h", to: "anna" });
  await h.svc.add({ text: "b", in: "1h", to: "anna" });
  await assert.rejects(h.svc.add({ text: "c", in: "1h", to: "anna" }), /anna is on 2 reminders that are active or finished in the last 24 hours, the most allowed/);
  await assert.rejects(h.svc.add({ text: "c", in: "1h", to: "me,mom,anna" }), /2 contacts at most/);
  await h.svc.add({ text: "c", in: "1h" });
  await h.svc.add({ text: "d", in: "1h" });
  await assert.rejects(h.svc.add({ text: "e", in: "1h" }), /the list is full: 4 reminders and jobs are active or finished in the last 24 hours\. The most is 4\./);
  // A cancelled one keeps its place for 24 hours, then frees it.
  await h.svc.cancel(h.svc.list()[0].id);
  await assert.rejects(h.svc.add({ text: "e", in: "1h", to: "anna" }), /keeps its place for 24 hours/);
  h.advance(DAY);
  await h.svc.add({ text: "e", in: "1h", to: "anna" });
});

test("caps: a turn that adds short reminders in a loop meets the cap, though each one is done at once", async () => {
  const h = await started({ config: { maxPerContact: 3, maxActive: 6 } });
  for (let i = 0; i < 3; i++) {
    await h.svc.add({ text: `ping ${i}`, in: "1m", to: "anna" });
    h.advance(MIN);
    await h.svc.tick();
  }
  assert.equal(h.sent.discord.length, 3);
  assert.equal(h.svc.list().length, 0, "all three are done");
  await assert.rejects(h.svc.add({ text: "ping 3", in: "1m", to: "anna" }), (err) => err.status === 400 && /anna is on 3 reminders/.test(err.message));
  // The total cap counts the finished ones too.
  for (let i = 0; i < 3; i++) await h.svc.add({ text: `me ${i}`, in: "1m", via: "discord" });
  await assert.rejects(h.svc.add({ text: "me 3", in: "1m", via: "discord" }), /the list is full: 6 reminders and jobs/);
  // A day later, the places are free again.
  h.advance(DAY + MIN);
  await h.svc.tick();
  await h.svc.add({ text: "ping 4", in: "1m", to: "anna" });
});

// ── Changes ─────────────────────────────────────────────────────────────────

test("add refuses a time in the past, more than 2 years away, or missing", async () => {
  const h = await started();
  await assert.rejects(h.svc.add({ text: "x", at: "2026-11-24T11:58" }), /is in the past\. It is now Tue Nov 24, 12:00 PM/);
  await assert.rejects(h.svc.add({ text: "x", at: "2029-01-01T09:00" }), /more than 2 years/);
  await assert.rejects(h.svc.add({ text: "x" }), /say when/);
  await assert.rejects(h.svc.add({ text: "x", at: "tomorrow 5pm" }), /not a time I can read/);
  await assert.rejects(h.svc.add({ text: "x", at: "2026-11-25T17:00", in: "5m" }), /not both/);
  await assert.rejects(h.svc.add({ text: "x", at: "2026-11-25T17:00", time: "09:00" }), /do not go together/);
  await assert.rejects(h.svc.add({ text: "x", time: "09:00" }), /need --repeat/);
  await assert.rejects(h.svc.add({ text: "", in: "5m" }), /text is missing/);
  await assert.rejects(h.svc.add({ text: "x", in: "5m", phone: "+15551234567" }), /unknown field: phone/);
  // 30 s ago still counts as now, and fires at the next tick.
  const { entry } = await h.svc.add({ text: "now-ish", at: "2026-11-24T16:59:30Z", via: "discord" });
  await h.svc.tick();
  assert.equal(h.svc.get(entry.id).status, "done");
});

test("a repeating add says the rule and the next time", async () => {
  const h = await started();
  const { entry, line } = await h.svc.add({ text: "Stand-up", repeat: "weekly", days: "MO,WE", time: "09:00", via: "discord" });
  assert.equal(line, `${entry.id}: "Stand-up" — every Monday and Wednesday at 9:00 AM, next Wed Nov 25, 9:00 AM, to me by Discord`);
  assert.deepEqual(entry.repeat, { freq: "weekly", every: 1, time: "09:00", days: ["MO", "WE"], start: "2026-11-24" });
  await assert.rejects(h.svc.add({ text: "x", repeat: "monthly", time: "09:00", start: "2026-11-30" }), /"last"/);
  await assert.rejects(
    h.svc.add({ text: "x", repeat: "daily", time: "09:00", start: "2026-11-20", until: "2026-11-23" }),
    /has no time left/
  );
});

test("edit changes the text, the time or the rule, and computes due again", async () => {
  const h = await started();
  const { entry } = await h.svc.add({ text: "Dentist", at: "2026-11-25T09:00", via: "discord" });
  let r = await h.svc.edit(entry.id, { text: "Dentist, bring the card", at: "2026-11-25T10:30" });
  assert.equal(r.line, `${entry.id}: "Dentist, bring the card" — Wed Nov 25, 10:30 AM, to me by Discord`);

  r = await h.svc.edit(entry.id, { repeat: "weekly", time: "08:00" });
  assert.equal(r.entry.repeatText, "every Tuesday at 8:00 AM");
  assert.equal(r.entry.dueText, "Tue Dec 1, 8:00 AM");
  assert.equal(r.entry.at, null);

  r = await h.svc.edit(entry.id, { time: "07:15", days: "TU,TH" });
  assert.equal(r.entry.repeatText, "every Tuesday and Thursday at 7:15 AM", "the same repeat keeps its other fields");
  assert.equal(r.entry.dueText, "Thu Nov 26, 7:15 AM");

  r = await h.svc.edit(entry.id, { repeat: "monthly", day: "last" });
  assert.equal(r.entry.repeatText, "every month on the last day at 7:15 AM", "a new repeat keeps the time");

  r = await h.svc.edit(entry.id, { in: "2h" });
  assert.equal(r.entry.repeat, null);
  assert.equal(r.entry.dueText, "Tue Nov 24, 2:00 PM");

  await assert.rejects(h.svc.edit(entry.id, { time: "09:00" }), /need --repeat/);
  await assert.rejects(h.svc.edit(entry.id, {}), /nothing to change/);
  await assert.rejects(h.svc.edit(entry.id, { job: "backup" }), /cannot change/);
  await assert.rejects(h.svc.edit("zzzz", { text: "x" }), (err) => err.status === 404);
});

test("edit of a finished one-time reminder with a new time makes it active again", async () => {
  const h = await started();
  const { entry } = await h.svc.add({ text: "Stretch", in: "5m", via: "discord" });
  h.advance(5 * MIN);
  await h.svc.tick();
  assert.equal(h.svc.get(entry.id).status, "done");
  const r = await h.svc.edit(entry.id, { in: "1h" });
  assert.equal(r.entry.status, "active");
});

test("snooze after it fired: remind me again in 30 min", async () => {
  const h = await started();
  const { entry } = await h.svc.add({ text: "Stretch", in: "5m", via: "discord" });
  h.advance(5 * MIN);
  await h.svc.tick();
  const r = await h.svc.snooze(entry.id, { for: "30m" });
  assert.equal(r.entry.status, "active");
  assert.equal(r.line, `Snoozed ${entry.id}: "Stretch" — Tue Nov 24, 12:35 PM (snoozed), to me by Discord.`);
  h.advance(30 * MIN);
  await h.svc.tick();
  assert.equal(h.sent.discord.length, 2);
  assert.equal(h.svc.get(entry.id).status, "done");
});

test("snooze a repeating reminder: that one moves, the rule continues", async () => {
  const h = await started();
  const { entry } = await h.svc.add({ text: "Pills", repeat: "daily", time: "09:00", via: "discord" });
  await h.tickAt("2026-11-25T09:00");
  // Just after it fired: again at 9:30, and tomorrow's 9:00 stays.
  await h.svc.snooze(entry.id, { for: "30m" });
  await h.tickAt("2026-11-25T09:30");
  assert.equal(h.sent.discord.length, 2);
  assert.equal(h.svc.get(entry.id).dueText, "Thu Nov 26, 9:00 AM");

  // Ahead of time: move tomorrow's 9:00 to 11:00. It fires once, at 11:00.
  const r = await h.svc.snooze(entry.id, { until: "2026-11-26T11:00" });
  assert.doesNotMatch(r.line, /skipped/);
  await h.tickAt("2026-11-26T09:00");
  assert.equal(h.sent.discord.length, 2);
  await h.tickAt("2026-11-26T11:00");
  assert.equal(h.sent.discord.length, 3);
  assert.equal(h.svc.get(entry.id).dueText, "Fri Nov 27, 9:00 AM");

  // Past the following repeats: those are skipped, and the line says so.
  const far = await h.svc.snooze(entry.id, { until: "2026-11-29T12:00" });
  assert.match(far.line, /The repeats before then are skipped\./);
  await assert.rejects(h.svc.snooze(entry.id, {}), /--for <duration> or --until <time>/);
  await assert.rejects(h.svc.snooze(entry.id, { for: "30m", until: "2026-11-29T12:00" }), /one of them/);
  await assert.rejects(h.svc.snooze(entry.id, { until: "2026-11-20T12:00" }), /in the past/);
});

test("skip moves a repeating entry past its next time, and refuses a one-time one", async () => {
  const h = await started();
  const { entry } = await h.svc.add({ text: "Stand-up", repeat: "weekly", days: "MO,WE", time: "09:00", via: "discord" });
  const r = await h.svc.skip(entry.id);
  assert.equal(r.line, `Skipped Wed Nov 25, 9:00 AM. ${entry.id}: "Stand-up" — every Monday and Wednesday at 9:00 AM, next Mon Nov 30, 9:00 AM, to me by Discord.`);
  const once = await h.svc.add({ text: "x", in: "1h" });
  await assert.rejects(h.svc.skip(once.entry.id), /does not repeat/);

  // Skipping the last time of a repeat ends it.
  const last = await h.svc.add({ text: "y", repeat: "daily", time: "09:00", until: "2026-11-25", via: "discord" });
  assert.equal((await h.svc.skip(last.entry.id)).entry.status, "done");
});

test("cancel stops pending deliveries", async () => {
  const h = await started();
  h.ready = false;
  const { entry } = await h.svc.add({ text: "Call the bank", in: "5m" });
  h.advance(5 * MIN);
  await h.svc.tick();
  assert.deepEqual(h.deliveries(entry.id), ["me/discord:pending:0", "me/sms:sent:1"]);
  const r = await h.svc.cancel(entry.id);
  assert.equal(r.line, `Cancelled ${entry.id}: "Call the bank".`);
  assert.deepEqual(h.deliveries(entry.id), ["me/discord:cancelled:0", "me/sms:cancelled:1"]);

  h.ready = true;
  h.advance(HOUR);
  await h.svc.tick();
  assert.equal(h.sent.discord.length, 0);
  assert.equal(h.sent.sms.length, 1);
  await h.svc.onSmsReport({ id: "msg-1", statuses: ["delivered"] });
  assert.deepEqual(h.deliveries(entry.id), ["me/discord:cancelled:0", "me/sms:cancelled:1"]);
  assert.equal((await h.svc.cancel(entry.id)).line, `${entry.id} was already cancelled.`);
  assert.deepEqual(h.svc.list(), []);
  assert.equal(h.svc.list({ all: true })[0].status, "cancelled");
});

test("list: active ones first by due time, kinds apart, and finished ones only with all", async () => {
  const h = await started({ jobs: fakeJobs() });
  const late = await h.svc.add({ text: "later", in: "3h" });
  const soon = await h.svc.add({ text: "soon", in: "1h" });
  const job = await h.svc.add({ job: "backup", repeat: "daily", time: "03:00" });
  const gone = await h.svc.add({ text: "gone", in: "2h" });
  await h.svc.cancel(gone.entry.id);
  assert.deepEqual(h.svc.list().map((e) => e.id), [soon.entry.id, late.entry.id, job.entry.id]);
  assert.deepEqual(h.svc.list({ kind: "job" }).map((e) => e.id), [job.entry.id]);
  assert.deepEqual(h.svc.list({ kind: "reminders" }).map((e) => e.id), [soon.entry.id, late.entry.id]);
  assert.deepEqual(h.svc.list({ all: true }).map((e) => e.id).at(-1), gone.entry.id);
  assert.throws(() => h.svc.list({ kind: "events" }), /kind must be reminder, job or all/);
  assert.equal(job.line, `${job.entry.id}: job "backup" — every day at 3:00 AM, next Wed Nov 25, 3:00 AM`, "a code job sends nothing");
  for (const e of h.svc.list({ all: true })) assert.doesNotMatch(JSON.stringify(e), /\+1555|1000000000000000/);
});

test("contactList and jobList give names and channels, never numbers or ids", async () => {
  const h = await started({ jobs: fakeJobs() });
  // mom has a number, but SMS goes to "me" only for now.
  assert.deepEqual(h.svc.contactList(), [
    { name: "me", channels: ["discord", "sms"] },
    { name: "mom", channels: [] },
    { name: "anna", channels: ["discord"] },
  ]);
  assert.deepEqual(h.svc.jobList(), [
    { name: "backup", kind: "code" },
    { name: "brief", kind: "agent" },
  ]);
  const noSms = harness({ smsEnabled: false });
  await noSms.svc.load();
  assert.deepEqual(noSms.svc.contactList()[0], { name: "me", channels: ["discord"] });
  await assert.rejects(noSms.svc.add({ text: "x", in: "1h", to: "mom" }), /SMS is off/);
  assert.match((await noSms.svc.add({ text: "x", in: "1h" })).line, /to me by Discord\. Skipped: SMS is off on this machine\.$/);
});

test("finished entries are dropped after 30 days", async () => {
  const h = await started();
  const { entry } = await h.svc.add({ text: "Stretch", in: "5m", via: "discord" });
  h.advance(5 * MIN);
  await h.svc.tick();
  h.advance(29 * DAY);
  await h.svc.tick();
  assert.ok(h.svc.get(entry.id), "kept for 30 days");
  h.advance(2 * DAY);
  await h.svc.tick();
  assert.equal(h.svc.get(entry.id), null);
  assert.equal(h.disk().entries.length, 0);
});

test("a wait of days or weeks keeps the clock time across a daylight saving change", async () => {
  const h = await started({ clock: { t: et("2027-03-13T08:00") } });
  const { entry } = await h.svc.add({ text: "Pills", repeat: "daily", time: "09:00", via: "discord" });
  await h.tickAt("2027-03-13T09:00");
  // "Snooze it a day" on Saturday: Sunday at 9:00, though that Sunday has 23 hours.
  const r = await h.svc.snooze(entry.id, { for: "1d" });
  assert.match(r.line, /next Sun Mar 14, 9:00 AM \(snoozed\)/);
  assert.equal((await h.svc.add({ text: "Call", in: "1w", via: "discord" })).entry.dueText, "Sat Mar 20, 9:00 AM");
  // Hours stay exact: 2 h after 1:30 AM on the change day is 4:30 AM.
  h.at("2027-03-14T01:30");
  assert.equal((await h.svc.add({ text: "Late", in: "2h", via: "discord" })).entry.dueText, "Sun Mar 14, 4:30 AM");
  // The fall day has 25 hours. 1d is still 9:00.
  h.at("2027-11-06T09:00");
  assert.equal((await h.svc.add({ text: "Fall", in: "1d", via: "discord" })).entry.dueText, "Sun Nov 7, 9:00 AM");
});

// ── Calendar copy ───────────────────────────────────────────────────────────

test("calendar: add creates the event, edit updates it, cancel removes it", async () => {
  const cal = fakeCalendar();
  const h = await started({ calendar: cal.mirror });
  const { entry } = await h.svc.add({ text: "Call mom", at: "2026-11-25T17:00", via: "discord" });
  await h.svc.settle();
  const [op, args] = cal.calls[0];
  assert.equal(op, "insert");
  assert.equal(args.sendUpdates, "none");
  assert.equal(args.calendarId, "primary");
  const body = args.requestBody;
  assert.equal(body.summary, "⏰ Call mom");
  assert.deepEqual(body.start, { dateTime: "2026-11-25T17:00:00-05:00", timeZone: "America/New_York" });
  assert.deepEqual(body.end, { dateTime: "2026-11-25T17:15:00-05:00", timeZone: "America/New_York" });
  assert.equal(body.transparency, "transparent");
  assert.deepEqual(body.reminders, { useDefault: false });
  assert.deepEqual(body.extendedProperties, { private: { alfredReminder: entry.id } });
  assert.match(body.description, new RegExp(`reminder ${entry.id}[\\s\\S]*do not go back to Alfred`));
  assert.equal("attendees" in body, false);
  assert.equal("recurrence" in body, false);
  assert.deepEqual(h.svc.get(entry.id).calendar, { state: "ok" });

  await h.svc.edit(entry.id, { text: "Call mom about Sunday" });
  await h.svc.settle();
  const [patchOp, patch] = cal.writes()[1];
  assert.equal(patchOp, "patch", "the mirror patches its own fields, and keeps the rest of the event");
  assert.equal(patch.eventId, "ev1");
  assert.equal(patch.sendUpdates, "none");
  assert.deepEqual(Object.keys(patch.requestBody).sort(), ["description", "end", "start", "summary"]);
  assert.equal(patch.requestBody.summary, "⏰ Call mom about Sunday");

  // A change of contacts does not touch the event.
  await h.svc.edit(entry.id, { via: "sms" });
  await h.svc.settle();
  assert.equal(cal.writes().length, 2);

  const r = await h.svc.cancel(entry.id);
  assert.match(r.line, /The Google Calendar copy goes too\./);
  await h.svc.settle();
  assert.deepEqual(cal.writes()[2], ["delete", { calendarId: "primary", eventId: "ev1", sendUpdates: "none" }]);
  assert.equal(cal.events.size, 0);
  assert.deepEqual(h.svc.get(entry.id).calendar, { state: "removed" });
});

test("calendar: snooze and skip change only Alfred's list, and say so", async () => {
  const cal = fakeCalendar();
  const h = await started({ calendar: cal.mirror });
  const { entry } = await h.svc.add({ text: "Stand-up", repeat: "weekly", every: 2, days: "FR", time: "17:00", via: "discord" });
  await h.svc.settle();
  const body = cal.calls[0][1].requestBody;
  assert.deepEqual(body.recurrence, toCalendarRecurrence(h.svc.get(entry.id).repeat));
  assert.deepEqual(body.recurrence, ["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;WKST=MO"]);
  assert.deepEqual(body.start, { dateTime: "2026-11-27T17:00:00", timeZone: "America/New_York" }, "the series starts at the first time");

  assert.match((await h.svc.snooze(entry.id, { for: "1h" })).line, /Google Calendar keeps the original time\./);
  assert.match((await h.svc.skip(entry.id)).line, /Google Calendar still shows the skipped time\./);
  await h.svc.settle();
  assert.equal(cal.calls.length, 1);
});

test("calendar: a series starts at the first time Alfred fires it, not earlier that day", async () => {
  const cal = fakeCalendar();
  const h = await started({ calendar: cal.mirror });
  // Added at noon: today's 9:00 has passed, so the first time is tomorrow.
  const { entry } = await h.svc.add({ text: "Pills", repeat: "daily", time: "09:00", via: "discord" });
  await h.svc.settle();
  assert.equal(cal.calls[0][1].requestBody.start.dateTime, "2026-11-25T09:00:00");
  assert.deepEqual(cal.calls[0][1].requestBody.recurrence, ["RRULE:FREQ=DAILY"]);

  // A time edit moves the series. A text edit keeps its start.
  await h.svc.edit(entry.id, { time: "08:00" });
  await h.svc.settle();
  assert.equal(cal.writes()[1][0], "patch");
  assert.equal(cal.writes()[1][1].requestBody.start.dateTime, "2026-11-25T08:00:00");
  h.advance(3 * DAY);
  await h.svc.edit(entry.id, { text: "Pills with food" });
  await h.svc.settle();
  assert.equal(cal.writes()[2][1].requestBody.start.dateTime, "2026-11-25T08:00:00");
  assert.equal(cal.events.get("ev1").summary, "⏰ Pills with food");
});

test("calendar: a failed call stays pending, and tick tries again with backoff", async () => {
  const cal = fakeCalendar({ failInsert: 2 });
  const h = await started({ calendar: cal.mirror });
  const { entry } = await h.svc.add({ text: "Call mom", at: "2026-11-25T17:00", via: "discord" });
  assert.equal(entry.calendar.state, "pending", "the entry is stored before the calendar call");
  await h.svc.settle();
  assert.deepEqual(h.svc.get(entry.id).calendar, { state: "pending", op: "create" });

  h.advance(30 * 1000);
  await h.svc.tick();
  await h.svc.settle();
  assert.equal(cal.calls.length, 1, "not before the backoff");
  h.advance(30 * 1000);
  await h.svc.tick();
  await h.svc.settle();
  assert.equal(cal.calls.length, 2);
  h.advance(2 * MIN);
  await h.svc.tick();
  await h.svc.settle();
  assert.equal(cal.calls.length, 3);
  assert.deepEqual(h.svc.get(entry.id).calendar, { state: "ok" });
});

test("calendar: after 5 failed calls it stops, and the reminder still fires", async () => {
  const cal = fakeCalendar({ failAlways: true });
  const h = await started({ calendar: cal.mirror });
  const { entry } = await h.svc.add({ text: "Call mom", in: "2h", via: "discord" });
  await h.svc.settle();
  for (let i = 0; i < 10; i++) {
    h.advance(30 * MIN);
    await h.svc.tick();
    await h.svc.settle();
  }
  assert.equal(cal.calls.length, 5);
  assert.equal(h.svc.get(entry.id).calendar.state, "failed");
  assert.match(h.logs.join("\n"), /Google Calendar copy of .* failed 5 times/);
  assert.equal(h.sent.discord.length, 1);
});

test("calendar: a cancel during the create removes the new event", async () => {
  const cal = fakeCalendar();
  const h = await started({ calendar: cal.mirror });
  const { entry } = await h.svc.add({ text: "Call mom", in: "2h", via: "discord" });
  await h.svc.cancel(entry.id);
  await h.svc.settle();
  assert.deepEqual(cal.writes().map((c) => c[0]), ["insert", "delete"]);
  assert.equal(cal.events.size, 0);
  assert.deepEqual(h.svc.get(entry.id).calendar, { state: "removed" });
});

test("calendar: a series whose first time is in the spring gap repeats at its clock time in Google", async () => {
  const cal = fakeCalendar();
  const h = await started({ calendar: cal.mirror, clock: { t: et("2027-03-10T12:00") } });
  const { entry } = await h.svc.add({ text: "Water plants", repeat: "weekly", days: "SU", time: "02:30", via: "discord" });
  await h.svc.settle();
  // Alfred fires the first one at 3:30 AM: 2:30 does not exist that day.
  assert.equal(entry.dueText, "Sun Mar 14, 3:30 AM");
  const body = cal.calls[0][1].requestBody;
  // Google gets the clock time, so it repeats at 2:30 AM, as Alfred does.
  assert.deepEqual(body.start, { dateTime: "2027-03-14T02:30:00", timeZone: "America/New_York" });
  assert.deepEqual(body.end, { dateTime: "2027-03-14T02:45:00", timeZone: "America/New_York" });
  assert.deepEqual(body.recurrence, ["RRULE:FREQ=WEEKLY;BYDAY=SU"]);
});

test("calendar: a change between one time and a repeat replaces the copy", async () => {
  const cal = fakeCalendar();
  const h = await started({ calendar: cal.mirror });
  const { entry } = await h.svc.add({ text: "Pills", at: "2026-11-25T09:00", via: "discord" });
  await h.svc.settle();
  await h.svc.edit(entry.id, { repeat: "daily", time: "09:00" });
  await h.svc.settle();
  assert.deepEqual(cal.writes().map(([op]) => op), ["insert", "delete", "insert"]);
  assert.deepEqual([...cal.events.keys()], ["ev2"]);
  assert.deepEqual(cal.events.get("ev2").recurrence, ["RRULE:FREQ=DAILY"]);
  await h.svc.edit(entry.id, { at: "2026-11-26T10:00" });
  await h.svc.settle();
  assert.deepEqual([...cal.events.keys()], ["ev3"], "no old repeat stays behind");
  assert.equal("recurrence" in cal.events.get("ev3"), false);
  assert.deepEqual(h.svc.get(entry.id).calendar, { state: "ok" });
});

test("calendar: an event that someone gave guests is left alone, and the reminder gets a new copy", async () => {
  const logs = [];
  const cal = fakeCalendar({ log: (m) => logs.push(m) });
  const h = await started({ calendar: cal.mirror });
  const { entry } = await h.svc.add({ text: "Dinner plan", at: "2026-11-25T17:00", via: "discord" });
  await h.svc.settle();
  // In Google Calendar, the owner adds a guest to the copy.
  cal.events.get("ev1").attendees = [{ email: "guest@example.com" }];

  await h.svc.edit(entry.id, { text: "Dinner plan, 7 PM" });
  await h.svc.settle();
  assert.deepEqual(cal.writes().map(([op]) => op), ["insert", "insert"], "no change to the event with a guest");
  assert.equal(cal.events.get("ev1").summary, "⏰ Dinner plan");
  assert.deepEqual(cal.events.get("ev1").attendees, [{ email: "guest@example.com" }]);
  assert.equal(cal.events.get("ev2").summary, "⏰ Dinner plan, 7 PM");
  assert.match(logs.join("\n"), /event ev1 has 1 guest\(s\)\. It stays as it is, and reminder \w+ gets a new copy/);

  // The new copy gets a guest too. A cancel does not delete it: Google can mail a guest.
  cal.events.get("ev2").attendees = [{ email: "guest@example.com" }];
  await h.svc.cancel(entry.id);
  await h.svc.settle();
  assert.deepEqual(cal.writes().map(([op]) => op), ["insert", "insert"]);
  assert.ok(cal.events.has("ev1") && cal.events.has("ev2"));
  assert.match(logs.join("\n"), /event ev2 has 1 guest\(s\)\. Alfred did not delete it/);
  assert.deepEqual(h.svc.get(entry.id).calendar, { state: "removed" });
});

// ── Jobs ────────────────────────────────────────────────────────────────────

test("job: a code job runs at its time and sends nothing on success", async () => {
  const jobs = fakeJobs({ backup: () => ({ ok: true, output: "42 files", error: "", kind: "code" }) });
  const cal = fakeCalendar();
  const h = await started({ jobs, calendar: cal.mirror });
  const { entry } = await h.svc.add({ job: "backup", repeat: "daily", time: "03:00" });
  assert.match(entry.id, /^j[2-9a-z]{3}$/);
  await h.svc.settle();
  assert.equal(cal.calls.length, 0, "a job gets no calendar event");
  assert.equal(entry.calendar, undefined);

  await h.tickAt("2026-11-25T03:00");
  await h.svc.settle();
  await h.svc.tick();
  assert.deepEqual(jobs.runs, ["backup"]);
  const after = h.svc.get(entry.id);
  assert.deepEqual(after.run, { state: "idle", attempts: 0, lastRunAt: "2026-11-25T08:00:00.000Z", lastOk: true, lastError: null });
  assert.equal(after.dueText, "Thu Nov 26, 3:00 AM");
  assert.equal(h.sent.discord.length + h.sent.sms.length, 0);
});

test("job: refused when the name is not in the allowlist", async () => {
  const h = await started({ jobs: fakeJobs() });
  await assert.rejects(h.svc.add({ job: "../x", in: "1h" }), /not a job name/);
  await assert.rejects(h.svc.add({ job: "x/y", in: "1h" }), /not a job name/);
  await assert.rejects(h.svc.add({ job: "nope", in: "1h" }), /no job "nope"\. Jobs: backup, brief/);
  const off = await started();
  await assert.rejects(off.svc.add({ job: "backup", in: "1h" }), /jobs are off/);
});

test("job: a failure tries again after the retry wait, then the owner gets one alert", async () => {
  const jobs = fakeJobs({ backup: () => ({ ok: false, output: "", error: "exit 1: rsync: connection refused", kind: "code" }) });
  const h = await started({ jobs });
  const { entry } = await h.svc.add({ job: "backup", repeat: "daily", time: "03:00" });
  await h.tickAt("2026-11-25T03:00");
  await h.svc.settle();
  assert.equal(h.svc.get(entry.id).run.state, "retry");
  assert.match(h.svc.get(entry.id).line, /, try 2 at Wed Nov 25, 3:15 AM$/);

  h.advance(14 * MIN);
  await h.svc.tick();
  await h.svc.settle();
  assert.equal(jobs.runs.length, 1, "not before the retry wait");
  h.advance(MIN);
  await h.svc.tick();
  await h.svc.settle();
  assert.equal(jobs.runs.length, 2);
  h.advance(15 * MIN);
  await h.svc.tick();
  await h.svc.settle();
  assert.equal(jobs.runs.length, 3);
  assert.equal(h.svc.get(entry.id).run.state, "failed");
  await h.svc.tick(); // the alert goes out
  assert.equal(h.sent.discord.length, 1);
  assert.equal(h.sent.discord[0].to, OWNER_DISCORD);
  assert.match(h.sent.discord[0].text, new RegExp(`Job "backup" \\(${entry.id}\\) failed 3 times\\. The end of the error: exit 1: rsync: connection refused`));

  h.advance(2 * HOUR);
  await h.svc.tick();
  await h.svc.settle();
  assert.equal(jobs.runs.length, 3, "no more tries until its next time");
  assert.equal(h.sent.discord.length, 1, "one alert");
  await h.tickAt("2026-11-26T03:00");
  await h.svc.settle();
  assert.equal(jobs.runs.length, 4, "the next time runs again");
});

test("job: a run that was going when the bot stopped counts as a failed try and runs again", async () => {
  const hang = deferred();
  const begun = deferred();
  const a = await started({
    jobs: fakeJobs({
      backup: () => {
        begun.resolve();
        return hang.promise;
      },
    }),
  });
  const { entry } = await a.svc.add({ job: "backup", repeat: "daily", time: "03:00" });
  await a.tickAt("2026-11-25T03:00");
  await begun.promise; // the runner saved "running" before it started the job
  assert.equal(a.disk().entries[0].run.state, "running");

  // The bot restarts. The new runner finishes the job.
  const jobs = fakeJobs();
  const b = await started({ file: a.file, clock: { t: et("2026-11-25T03:05") }, jobs });
  const loaded = b.svc.get(entry.id);
  assert.equal(loaded.run.state, "retry");
  assert.equal(loaded.run.attempts, 1);
  assert.equal(loaded.run.lastError, "the bot stopped while the job ran");
  await b.svc.tick();
  await b.svc.settle();
  assert.deepEqual(jobs.runs, ["backup"]);
  assert.equal(b.svc.get(entry.id).run.state, "idle");
  hang.resolve({ ok: true, output: "" }); // let the old runner end
});

test("agent job: its result goes to the contacts like a reminder, a silent one does not", async () => {
  let output = "Rain at 3 PM. Two meetings.";
  const jobs = fakeJobs({ brief: () => ({ ok: true, output, error: "", kind: "agent" }) });
  const h = await started({ jobs });
  const { entry, line } = await h.svc.add({ job: "brief", text: "Morning brief", repeat: "daily", time: "07:00", to: "me,anna", via: "discord" });
  assert.equal(line, `${entry.id}: job "brief" (Morning brief) — every day at 7:00 AM, next Wed Nov 25, 7:00 AM, to me and anna by Discord`);
  await h.tickAt("2026-11-25T07:00");
  await h.svc.settle();
  await h.svc.tick();
  assert.deepEqual(h.sent.discord, [
    { to: OWNER_DISCORD, text: "⏰ Rain at 3 PM. Two meetings." },
    { to: ANNA_DISCORD, text: "⏰ Reminder from Alfred: Rain at 3 PM. Two meetings." },
  ]);
  assert.equal(h.notes.at(-1), `Job ${entry.id} "brief" ran. Its result went to me and anna by Discord: "Rain at 3 PM. Two meetings."`);

  output = "<no_reply>";
  await h.tickAt("2026-11-26T07:00");
  await h.svc.settle();
  await h.svc.tick();
  assert.equal(h.sent.discord.length, 2, "a silent result is not posted");
  output = "";
  await h.tickAt("2026-11-27T07:00");
  await h.svc.settle();
  await h.svc.tick();
  assert.equal(h.sent.discord.length, 2, "an empty result is not posted");
  assert.deepEqual(jobs.runs, ["brief", "brief", "brief"]);
});

test("job: a time that comes due while the job still runs is skipped", async () => {
  const hang = deferred();
  const jobs = fakeJobs({ backup: () => hang.promise });
  const h = await started({ jobs });
  const { entry } = await h.svc.add({ job: "backup", repeat: "daily", time: "03:00" });
  await h.tickAt("2026-11-25T03:00");
  await h.tickAt("2026-11-26T03:00");
  assert.deepEqual(jobs.runs, ["backup"], "one run at a time");
  assert.match(h.logs.join("\n"), /Job backup \(.*\) still runs\. Skipped its time at Thu Nov 26, 3:00 AM\./);
  assert.equal(h.svc.get(entry.id).dueText, "Fri Nov 27, 3:00 AM");
  hang.resolve({ ok: true, output: "", kind: "code" });
  await h.svc.settle();
  assert.equal(h.svc.get(entry.id).run.state, "idle");
});

test("jobs run one at a time, in order", async () => {
  const gates = { backup: deferred(), brief: deferred() };
  const begun = { backup: deferred(), brief: deferred() };
  const gated = (name) => () => {
    begun[name].resolve();
    return gates[name].promise;
  };
  const jobs = fakeJobs({ backup: gated("backup"), brief: gated("brief") });
  const h = await started({ jobs });
  await h.svc.add({ job: "backup", at: "2026-11-24T13:00" });
  await h.svc.add({ job: "brief", at: "2026-11-24T13:00", via: "discord" });
  await h.tickAt("2026-11-24T13:00");
  await begun.backup.promise;
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(jobs.runs, ["backup"], "the second job waits for the first");
  gates.backup.resolve({ ok: true, output: "", kind: "code" });
  await begun.brief.promise;
  assert.deepEqual(jobs.runs, ["backup", "brief"]);
  gates.brief.resolve({ ok: true, output: "", kind: "agent" });
  await h.svc.settle();
  assert.deepEqual(h.svc.list({ all: true }).map((e) => e.status), ["done", "done"], "a one-time job is done after its run");
});

test("cancel during a job run: the run ends, and its result is not sent", async () => {
  const gate = deferred();
  const jobs = fakeJobs({ brief: () => gate.promise });
  const h = await started({ jobs });
  const { entry } = await h.svc.add({ job: "brief", in: "5m", via: "discord" });
  h.advance(5 * MIN);
  await h.svc.tick();
  const r = await h.svc.cancel(entry.id);
  assert.match(r.line, /The run that started continues, but its result is not sent\./);
  gate.resolve({ ok: true, output: "hello", kind: "agent" });
  await h.svc.settle();
  await h.svc.tick();
  assert.equal(h.sent.discord.length, 0);
  assert.equal(h.svc.get(entry.id).run.state, "cancelled");
});

test("job: a failed save at its start does not strand it. The next tick runs it", async () => {
  let failStart = false;
  const fs = {
    ...fsp,
    writeFile: async (file, text, opts) => {
      if (failStart && JSON.parse(text).entries.some((e) => e.run?.state === "running")) {
        failStart = false;
        throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
      }
      return fsp.writeFile(file, text, opts);
    },
  };
  const jobs = fakeJobs();
  const h = await started({ fs, jobs });
  const { entry } = await h.svc.add({ job: "backup", repeat: "daily", time: "13:00" });
  failStart = true;
  await h.tickAt("2026-11-24T13:00");
  await h.svc.settle();
  assert.deepEqual(jobs.runs, [], "the start was not saved, so the job did not run");
  assert.equal(h.svc.get(entry.id).run.state, "queued");
  h.advance(MIN);
  await h.svc.tick();
  await h.svc.settle();
  assert.deepEqual(jobs.runs, ["backup"]);
  assert.equal(h.svc.get(entry.id).run.state, "idle");
  await h.tickAt("2026-11-25T13:00");
  await h.svc.settle();
  assert.deepEqual(jobs.runs, ["backup", "backup"], "the next day runs as usual");
  assert.doesNotMatch(h.logs.join("\n"), /still runs/);
});

test("job: a failed save at its end counts as a failed try at the next tick, and the job runs again", async () => {
  let failEnd = false;
  const fs = {
    ...fsp,
    writeFile: async (file, text, opts) => {
      if (failEnd && JSON.parse(text).entries.some((e) => e.run?.lastRunAt)) {
        failEnd = false;
        throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
      }
      return fsp.writeFile(file, text, opts);
    },
  };
  const jobs = fakeJobs();
  const h = await started({ fs, jobs });
  const { entry } = await h.svc.add({ job: "backup", repeat: "daily", time: "13:00" });
  failEnd = true;
  await h.tickAt("2026-11-24T13:00");
  await h.svc.settle();
  assert.equal(h.svc.get(entry.id).run.state, "running", "the end of the run was not saved");
  h.advance(MIN);
  await h.svc.tick();
  await h.svc.settle();
  assert.deepEqual(jobs.runs, ["backup", "backup"]);
  assert.equal(h.svc.get(entry.id).run.state, "idle");
  assert.equal(h.svc.get(entry.id).dueText, "Wed Nov 25, 1:00 PM");
});

test("job: a run that never ends frees the queue after the job timeout and a margin", async () => {
  // jobs.run has its own timeout (test/reminders-jobs.test.js). This is the
  // second guard, for a run that does not end even so.
  const jobs = fakeJobs({ backup: () => new Promise(() => {}) });
  const h = await started({ jobs, config: { jobTimeoutMs: 10, jobWatchdogMs: 10 } });
  assert.equal(DEFAULTS.jobWatchdogMs, MIN);
  const { entry } = await h.svc.add({ job: "backup", at: "2026-11-24T13:00" });
  await h.svc.add({ job: "brief", at: "2026-11-24T13:00", via: "discord" });
  await h.tickAt("2026-11-24T13:00");
  await h.svc.settle();
  assert.deepEqual(jobs.runs, ["backup", "brief"], "brief runs, though backup never ended");
  const { run } = h.svc.get(entry.id);
  assert.equal(run.state, "retry");
  assert.match(run.lastError, /^job backup timed out after/);
});

// ── A hand-edited list ──────────────────────────────────────────────────────
// Alfred is the same Unix user as bot.js, and var/ is his own state. So the
// list can change on disk without the service.

test("load drops a record that the code cannot read. The others still go out", async () => {
  const a = await started();
  const { entry } = await a.svc.add({ text: "Stretch", at: "2026-11-24T12:30", via: "discord" });
  const data = a.disk();
  data.entries.push({ ...structuredClone(data.entries[0]), id: "rbad", occurrence: {} });
  data.entries.push({ id: "rnot", kind: "reminder", status: "active" });
  data.digests.push({ id: "sbad", contact: "me", text: "x" });
  data.alerts.push({ id: "abad" });
  data.missed.push({ contact: "me" });
  writeFileSync(a.file, JSON.stringify(data));

  const b = await started({ file: a.file, clock: { t: et("2026-11-24T12:30") } });
  const logs = b.logs.join("\n");
  assert.match(logs, /dropped entry rbad from the list: the last time has no time/);
  assert.match(logs, /dropped entry rnot from the list: it has no text or no job name/);
  assert.match(logs, /dropped summary sbad from the list: the deliveries are not a list/);
  assert.match(logs, /dropped alert abad from the list: it has no id or text/);
  assert.match(logs, /dropped summary line with no id from the list: it has no contact, via or line/);
  assert.deepEqual(b.svc.list({ all: true }).map((e) => e.id), [entry.id]);
  await b.svc.tick();
  assert.deepEqual(b.sent.discord, [{ to: OWNER_DISCORD, text: "⏰ Stretch" }]);
  const disk = b.disk();
  assert.deepEqual([disk.entries.length, disk.digests.length, disk.alerts.length, disk.missed.length], [1, 0, 0, 0]);
});

test("a hand-edited list cannot text another contact: the delivery fails, and the owner hears it", async () => {
  const a = await started();
  const { entry } = await a.svc.add({ text: "Bring the pie", in: "5m", via: "sms" });
  const data = a.disk();
  const e = data.entries[0];
  const now = new Date(a.clock.t).toISOString();
  Object.assign(e, { to: ["mom"], status: "done", due: null, finishedAt: now });
  e.occurrence = {
    at: now,
    firedAt: now,
    late: false,
    text: e.text,
    deliveries: [{ contact: "mom", channel: "sms", state: "pending", attempts: 0, nextAt: now, messageIds: [] }],
  };
  writeFileSync(a.file, JSON.stringify(data));

  const b = await started({ file: a.file, clock: a.clock });
  await b.svc.tick();
  assert.equal(b.sent.sms.length, 0);
  assert.deepEqual(b.deliveries(entry.id), ["mom/sms:failed:0"]);
  assert.deepEqual(b.sent.discord.map((m) => [m.to, m.text]), [
    [OWNER_DISCORD, `⚠️ Reminder ${entry.id} "Bring the pie" did not reach mom by SMS: SMS goes to "me" only for now.`],
  ]);
});

test("calendar: an event id that a hand edit points at another event is never changed or deleted", async () => {
  const cal = fakeCalendar();
  cal.events.set("team-meeting", { id: "team-meeting", summary: "Team meeting", attendees: [{ email: "a@example.com" }] });
  cal.events.set("doctor", { id: "doctor", summary: "Doctor" });
  const a = await started({ calendar: cal.mirror });
  await a.svc.add({ text: "x", at: "2026-11-25T17:00", via: "discord" });
  await a.svc.add({ text: "y", at: "2026-11-25T18:00", via: "discord" });
  await a.svc.settle();
  const data = a.disk();
  const pending = { state: "pending", attempts: 0, nextAt: new Date(a.clock.t).toISOString() };
  Object.assign(data.entries[0], { status: "cancelled", due: null, finishedAt: data.entries[0].createdAt });
  Object.assign(data.entries[0].calendar, { eventId: "team-meeting", op: "remove", ...pending });
  Object.assign(data.entries[1], { rev: 2 });
  Object.assign(data.entries[1].calendar, { eventId: "doctor", op: "update", ...pending });
  writeFileSync(a.file, JSON.stringify(data));

  const b = await started({ file: a.file, clock: a.clock, calendar: cal.mirror });
  await b.svc.tick();
  await b.svc.settle();
  assert.deepEqual(cal.events.get("team-meeting"), { id: "team-meeting", summary: "Team meeting", attendees: [{ email: "a@example.com" }] });
  assert.deepEqual(cal.events.get("doctor"), { id: "doctor", summary: "Doctor" });
  const touched = cal.writes().filter(([op, args]) => op !== "insert" && ["team-meeting", "doctor"].includes(args.eventId));
  assert.deepEqual(touched, []);
  assert.equal(b.svc.get(data.entries[0].id).calendar.state, "removed", "the id is only forgotten");
});

// ── Config ──────────────────────────────────────────────────────────────────

test("reminderConfig reads REMINDER_* and keeps a default for a bad value", () => {
  const cfg = reminderConfig({
    REMINDER_SMS_MAX_ATTEMPTS: "4",
    REMINDER_CATCHUP_HOURS: "6",
    REMINDER_DISCORD_MAX_ATTEMPTS: "lots",
    REMINDER_JOB_RETRY_MS: "-5",
    REMINDER_TICK_MS: "30000",
  });
  assert.equal(cfg.smsMaxAttempts, 4);
  assert.equal(cfg.catchupHours, 6);
  assert.equal(cfg.discordMaxAttempts, 5);
  assert.equal(cfg.jobRetryMs, 15 * MIN);
  assert.equal(cfg.tickMs, 30_000);
  assert.equal(cfg.smsConfirmMs, 10 * MIN);
  assert.equal(cfg.jobMaxAttempts, 3);
  assert.equal(cfg.jobTimeoutMs, 15 * MIN);
});
