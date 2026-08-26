// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mailEmbed, inviteEmbed, post, notifyMail, COLORS } from "../ronnie/notify.js";

test("mailEmbed colours priority green and bulk blue", () => {
  assert.equal(mailEmbed({ from: "a@x", subject: "hi", category: "priority" }).color, COLORS.priority);
  assert.equal(mailEmbed({ from: "a@x", subject: "sale", category: "bulk" }).color, COLORS.bulk);
});

test("mailEmbed defuses an @everyone in the subject", () => {
  const e = mailEmbed({ from: "a@x", subject: "@everyone free money" });
  // The literal "@everyone" must not survive intact, or the webhook would ping.
  assert.ok(!e.title.includes("@everyone"));
});

test("mailEmbed fills sensible defaults for missing fields", () => {
  const e = mailEmbed({});
  assert.equal(e.author.name, "unknown sender");
  assert.equal(e.title, "(no subject)");
});

test("a priority mailEmbed carries a mail: undo handle; bulk does not", () => {
  const personal = mailEmbed({ id: "m1", from: "a@x", subject: "hi", category: "priority" });
  assert.match(personal.footer.text, /undo mail:m1/);
  const bulk = mailEmbed({ id: "m2", from: "a@x", subject: "sale", category: "bulk" });
  assert.equal(bulk.footer.text, "filed — bulk"); // no undo handle on silent filing
});

test("inviteEmbed puts the UID in the footer as the undo handle", () => {
  const e = inviteEmbed({ action: "added", summary: "Standup", uid: "abc-123", when: "Tue 10:30" });
  assert.equal(e.color, COLORS.invite);
  assert.match(e.footer.text, /undo cal:abc-123/);
  const rm = inviteEmbed({ action: "removed", summary: "Standup", uid: "abc-123" });
  assert.equal(rm.color, COLORS.undo);
  assert.match(rm.title, /removed/);
});

test("post is a no-op when no webhook is configured", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { ok: true, status: 204 };
  };
  const r = await post([{ title: "x" }], { webhookUrl: "", fetchImpl });
  assert.equal(r.posted, false);
  assert.equal(called, false); // never touched the network
});

test("post sends embeds and identifies as Ronnie", async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, body: JSON.parse(opts.body) };
    return { ok: true, status: 204 };
  };
  const r = await post([{ title: "one" }, { title: "two" }], {
    webhookUrl: "https://discord/webhook",
    fetchImpl,
  });
  assert.equal(r.posted, true);
  assert.equal(seen.url, "https://discord/webhook");
  assert.equal(seen.body.username, "Ronnie");
  assert.equal(seen.body.embeds.length, 2);
});

test("post throws on a non-ok response so the caller can log it", async () => {
  const fetchImpl = async () => ({ ok: false, status: 429 });
  await assert.rejects(
    () => post([{ title: "x" }], { webhookUrl: "https://d/w", fetchImpl }),
    /429/
  );
});

test("notifyMail builds one embed per entry", async () => {
  let seen;
  const fetchImpl = async (_url, opts) => {
    seen = JSON.parse(opts.body);
    return { ok: true, status: 204 };
  };
  await notifyMail(
    [
      { from: "a@x", subject: "one", category: "priority" },
      { from: "n@brand", subject: "sale", category: "bulk" },
    ],
    { webhookUrl: "https://d/w", fetchImpl }
  );
  assert.equal(seen.embeds.length, 2);
  assert.equal(seen.embeds[0].color, COLORS.priority);
  assert.equal(seen.embeds[1].color, COLORS.bulk);
});
