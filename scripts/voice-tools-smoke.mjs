#!/usr/bin/env node
// Live check of the phone voice's direct tools (telnyx/voice-tools.js) against
// the real Notion and Google Calendar, before a test call. It touches only what
// it makes: a scratch subpage under --parent, and one event on --day at 23:00.
// Both are put in the Trash at the end (Notion's and Google's), so a failed run
// leaves them for a person to look at, not lost.
//
//   STATE_DIR=agent/var NOTION_TOKEN=… node scripts/voice-tools-smoke.mjs \
//     --parent "Some page" --day 2026-12-31
//
// Each step prints the tool's own answer, then a read back that proves it.

import { NOTION_ROUTES } from "../notion/broker.js";
import { notion as notionApi, fetchBlockChildren } from "../notion/client.js";
import { GOOGLE_ROUTES } from "../google/broker.js";
import { makeVoiceTools } from "../telnyx/voice-tools.js";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : null;
};
const parent = arg("parent");
const day = arg("day");
if (!parent || !/^\d{4}-\d{2}-\d{2}$/.test(day || "")) {
  console.error('usage: voice-tools-smoke.mjs --parent "<shared page title>" --day YYYY-MM-DD');
  process.exit(2);
}

const notes = [];
const t = makeVoiceTools({ notionRoutes: NOTION_ROUTES, calendarRoutes: GOOGLE_ROUTES, fetchBlockChildren, note: (n) => notes.push(n) });
let failed = 0;
const PAGE = `Phone tool test ${new Date().toISOString().slice(0, 16)}`;

async function step(label, name, args, expect) {
  const t0 = Date.now();
  const out = await t.call(name, args);
  const ok = expect.test(out);
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} ${label} (${Date.now() - t0} ms)\n   ${out.replace(/\n/g, "\n   ")}`);
  return out;
}

// Notion: a scratch page, then every action on it.
await step("create a scratch page", "notion", { action: "create", page: parent, text: PAGE, items: [] }, /^Done: made the page/);
await step("read the empty page", "notion", { action: "read", page: PAGE }, /empty|Page/);
await step("add two items", "notion", { action: "add", page: PAGE, items: ["test apples", "Greens"] }, /^Done: added/);
await step("add under a section", "notion", { action: "add", page: PAGE, under: 2, items: ["test lettuce"] }, /under "Greens"[\s\S]*3\. +test lettuce/);
await step("edit a line", "notion", { action: "edit", page: PAGE, line: 1, text: "test pears" }, /changed "test apples" to "test pears"/);
await step("remove a section with its child", "notion", { action: "remove", page: PAGE, line: 2 }, /removed "Greens" and the lines under it/);
// No search step: a page this new is not in Notion's search index yet.

// Checkboxes need a to-do line; the scratch page starts as plain lines, so check
// one on a to-do added straight through the route.
// The id comes from the tool's own create, never from a search: Notion's index
// lags a new page, and its fuzzy top hit can be a different, real page.
const scratch = t.pageId(PAGE);
if (!scratch) throw new Error("the scratch page's id is unknown; stopping before any write");
await NOTION_ROUTES["POST /notion/append"]({ params: new URLSearchParams({ id: scratch }), body: { markdown: "- [ ] test box" } });
await step("read again", "notion", { action: "read", page: PAGE }, /\[ \] test box/);
await step("check a box", "notion", { action: "check", page: PAGE, line: 2 }, /checked off "test box"[\s\S]*\[x\] test box/);
await step("uncheck it", "notion", { action: "uncheck", page: PAGE, line: 2 }, /unchecked "test box"[\s\S]*\[ \] test box/);
await step("add matches the checkbox style", "notion", { action: "add", page: PAGE, items: ["test grapes"] }, /\[ \] test grapes/);
// Page now: 1 test pears, 2 [ ] test box, 3 [ ] test grapes.
await step("write a nested list inside a line", "notion", { action: "write", page: PAGE, under: 2, markdown: "- test sublist\n  - [ ] test milk" }, /2\. - \[ \] test box\n3\. {3}- test sublist\n4\. {5}- \[ \] test milk/);
await step("write a heading after a line (Notion's after)", "notion", { action: "write", page: PAGE, after: 1, markdown: "## test head\n- [ ] test socks" }, /1\. test pears\n2\. ## test head\n3\. - \[ \] test socks\n4\. - \[ \] test box/);
await step("add under a heading goes to the end of its section", "notion", { action: "add", page: PAGE, under: 2, items: ["test charger"] }, /test grapes\n8\. - \[ \] test charger/);

// Calendar: one event late on --day, then edit and delete it.
await step("time", "get_time", {}, /Eastern/);
await step("add an event", "calendar", { action: "add", title: "Phone tool test", start: `${day}T23:00`, end: `${day}T23:30` }, /^Done: added/);
const list = await step("read the day", "calendar", { action: "read", from: day }, /Phone tool test/);
const n = Number(/(\d+)\. \S+ \S+ Phone tool test/.exec(list)?.[1]);
// A change returns the day renumbered, so the delete needs no read in between.
const moved = await step("move it", "calendar", { action: "edit", event: n, start: `${day}T23:15`, end: `${day}T23:45` }, /^Done: changed[\s\S]*23:15–23:45 Phone tool test/);
const m = Number(/(\d+)\. \S+ 23:15–23:45 Phone tool test/.exec(moved)?.[1]);
await step("delete it, no read between", "calendar", { action: "delete", event: m }, /deleted "Phone tool test".*Trash/);
await step("it is gone", "calendar", { action: "read", from: day }, /^(?![\s\S]*Phone tool test)/);

// Clean up: the scratch page to Notion's Trash.
// Trash it only if the id still names the page this run made.
const made = await notionApi("GET", `/pages/${scratch}`);
const madeTitle = Object.values(made.properties || {}).find((p) => p.type === "title")?.title?.map((x) => x.plain_text).join("");
if (madeTitle !== PAGE) throw new Error(`refusing to trash ${scratch}: its title is "${madeTitle}", not "${PAGE}"`);
await notionApi("PATCH", `/pages/${scratch}`, { archived: true });
console.log(`🧹 Scratch page "${PAGE}" is in Notion's Trash.`);
console.log(`📝 ${notes.length} notes for Alfred:\n   ${notes.join("\n   ")}`);
console.log(failed ? `❌ ${failed} step(s) failed` : "✅ All steps passed");
process.exit(failed ? 1 : 0);
