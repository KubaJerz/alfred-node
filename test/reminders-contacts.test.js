// Run with: npm test   (node's built-in runner, no network, no credentials)
//
// Who can get a reminder. The list comes from REMINDER_CONTACTS and the owner
// settings, never from a turn. A bad item is logged and skipped, never fatal,
// and the log never shows a phone number.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseContacts, channelsOf, CONTACT_NAME_RE } from "../reminders/contacts.js";

const OWNER = { ownerDiscordId: "100000000000000001", ownerSms: "(555) 000-0001" };

test('"me" always exists, with the owner\'s Discord id and number when set', () => {
  const contacts = parseContacts(OWNER);
  assert.deepEqual([...contacts.values()], [{ name: "me", discord: "100000000000000001", sms: "+15550000001" }]);
  assert.deepEqual([...parseContacts().values()], [{ name: "me" }], "with nothing set, me has no channel");
});

test("REMINDER_CONTACTS: a number, a Discord id, or both", () => {
  const contacts = parseContacts({
    ...OWNER,
    spec: "mom=+15551230000; anna=discord:123456789012345678|+1 555 987 0000 ;Team-Lead=sms:5554443333",
  });
  assert.deepEqual([...contacts.keys()], ["me", "mom", "anna", "team-lead"]);
  assert.deepEqual(contacts.get("mom"), { name: "mom", sms: "+15551230000" });
  assert.deepEqual(contacts.get("anna"), { name: "anna", discord: "123456789012345678", sms: "+15559870000" });
  assert.deepEqual(contacts.get("team-lead"), { name: "team-lead", sms: "+15554443333" });
  assert.deepEqual(channelsOf(contacts.get("anna")), ["discord", "sms"]);
  assert.deepEqual(channelsOf(contacts.get("mom")), ["sms"]);
});

test("a bad item is logged and skipped, and the rest still load", () => {
  const logs = [];
  const contacts = parseContacts({
    ...OWNER,
    log: (m) => logs.push(m),
    spec: [
      "mom=+15551230000",
      "me=+15550009999", // reserved
      "9lives=+15550000003", // starts with a digit
      "bob", // no channels
      "carl=", // no channels
      "dana=discord:12", // short id
      "eve=12", // not a number
      "fred=+15550000004|+15550000005", // two numbers
      "mom=+15550000006", // already a contact
      "x".repeat(40) + "=+15550000007", // name too long
      "gina=discord:123456789012345678",
    ].join(";"),
  });
  assert.deepEqual([...contacts.keys()], ["me", "mom", "gina"]);
  assert.equal(contacts.get("me").sms, "+15550000001", "REMINDER_CONTACTS cannot change me");
  assert.equal(logs.length, 9);
  for (const line of logs) {
    assert.match(line, /^⚠️  REMINDER_CONTACTS: skipped item \d+/);
    assert.doesNotMatch(line, /\d{7}/, `a number leaked into the log: ${line}`);
  }
});

test("contact names are lower case, start with a letter, and are short", () => {
  for (const ok of ["me", "mom", "anna-b", "a1"]) assert.ok(CONTACT_NAME_RE.test(ok), ok);
  for (const bad of ["Mom", "1a", "-a", "a_b", "a b", "+15551230000", "a".repeat(32)]) assert.ok(!CONTACT_NAME_RE.test(bad), bad);
});
