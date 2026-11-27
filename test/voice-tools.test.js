import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeVoiceTools, numberLines, nextDay, timeNow, REMINDERS_TOOL } from "../telnyx/voice-tools.js";
import { makeStore } from "../reminders/store.js";
import { makeReminders } from "../reminders/service.js";
import { parseContacts } from "../reminders/contacts.js";
import { makeReminderRoutes } from "../reminders/routes.js";

const todo = (id, text, checked = false, children) => ({
  id, type: "to_do", to_do: { checked, rich_text: [{ plain_text: text, text: { content: text }, annotations: {} }] },
  ...(children ? { has_children: true, children } : {}),
});

// A Notion that holds one page in memory and records each route call.
function fakeNotion() {
  const log = [];
  let blocks = [
    todo("b1", "Milk"),
    todo("b2", "Greens", false, [todo("b3", "Sprite Zero"), todo("b4", "Shot cups", true)]),
    { id: "b5", type: "child_page", child_page: { title: "Old list" }, children: [todo("b6", "inside")] },
    todo("b7", "Eggs"),
  ];
  const find = (id, bs = blocks) => {
    for (const b of bs) {
      if (b.id === id) return b;
      const c = b.children && find(id, b.children);
      if (c) return c;
    }
  };
  const routes = {
    "GET /notion/search": async ({ params }) => {
      log.push(["search", params.get("q")]);
      return { results: [{ id: "p1", object: "page", title: "Shopping list" }, { id: "p2", object: "page", title: "Shopping ideas" }] };
    },
    "POST /notion/append": async ({ params, body }) => {
      log.push(["append", params.get("id"), body.markdown, ...(body.after ? [body.after] : [])]);
      const lines = body.markdown.split("\n").map((l, i) => todo(`n${log.length}_${i}`, l.replace(/^- \[ \] /, "")));
      if (params.get("id") === "p1") blocks.push(...lines);
      else find(params.get("id")).children.push(...lines);
      return { appended: lines.length };
    },
    "PATCH /notion/block": async ({ params, body }) => {
      log.push(["patch", params.get("id"), body]);
      const b = find(params.get("id"));
      const from = `- [${b.to_do.checked ? "x" : " "}] ${b.to_do.rich_text[0].plain_text}`;
      if (body.checked !== undefined) b.to_do.checked = body.checked;
      if (body.markdown) {
        const m = /^- \[([ x])\] (.*)$/.exec(body.markdown);
        b.to_do.checked = m[1] === "x";
        b.to_do.rich_text[0].plain_text = m[2];
      }
      return { id: b.id, from, to: `- [${b.to_do.checked ? "x" : " "}] ${b.to_do.rich_text[0].plain_text}` };
    },
    "DELETE /notion/block": async ({ params }) => {
      log.push(["delete", params.get("id")]);
      const b = find(params.get("id"));
      blocks = blocks.filter((x) => x.id !== b.id);
      return { id: b.id, removed: `- [ ] ${b.to_do.rich_text[0].plain_text}`, hasChildren: Boolean(b.children) };
    },
    "POST /notion/page": async ({ body }) => {
      log.push(["create", body]);
      return { id: "p9", url: "" };
    },
  };
  return { routes, log, fetchBlockChildren: async () => structuredClone(blocks) };
}

function fakeCalendar() {
  const log = [];
  const routes = {
    "GET /calendar/events": async ({ params }) => {
      log.push(["list", params.get("from"), params.get("to")]);
      return {
        events: [
          { id: "e1", summary: "Lab meeting", start: "2026-11-27T15:00:00-05:00", end: "2026-11-27T16:00:00-05:00", location: "" },
          { id: "e2", summary: "Holiday", start: "2026-11-27", end: "2026-11-28", location: "" },
        ],
      };
    },
    "POST /calendar/events": async ({ body }) => (log.push(["add", body]), { id: "e9" }),
    "PATCH /calendar/events": async ({ params, body }) => (log.push(["edit", params.get("id"), body]), { id: params.get("id") }),
    "DELETE /calendar/events": async ({ params }) =>
      params.get("id") === "e1" ? (log.push(["delete", "e1"]), { id: "e1" }) : { error: "has guests", status: 403 },
  };
  return { routes, log };
}

function tools() {
  const n = fakeNotion();
  const c = fakeCalendar();
  const notes = [];
  const t = makeVoiceTools({
    notionRoutes: n.routes,
    calendarRoutes: c.routes,
    fetchBlockChildren: n.fetchBlockChildren,
    note: (x) => notes.push(x),
    now: () => new Date("2026-11-22T20:04:00Z"),
  });
  return { t, n, c, notes };
}

test("numberLines numbers every line, indents children, and keeps a subpage to one line", () => {
  const { text, map } = numberLines([todo("a", "Milk"), todo("b", "Greens", false, [todo("c", "Lettuce", true)]),
    { id: "d", type: "child_page", child_page: { title: "Old" }, children: [todo("e", "x")] }]);
  assert.equal(text, "1. - [ ] Milk\n2. - [ ] Greens\n3.   - [x] Lettuce\n4. - 📄 Old");
  assert.equal(map.get(3).id, "c");
  assert.equal(map.size, 4);
});

test("the time is Eastern, with the weekday", () => {
  assert.match(timeNow(new Date("2026-11-22T20:04:00Z")), /^Sunday, November 22, 2026 at 3:04 PM \(Eastern\)$/);
  assert.equal(nextDay("2026-12-31"), "2027-01-01");
});

test("tools are listed, and get_time answers", async () => {
  const { t } = tools();
  assert.deepEqual(t.names, ["notion", "calendar", "get_time"]);
  assert.deepEqual(t.defs.map((d) => d.name), t.names);
  assert.match(await t.call("get_time", {}), /Sunday/);
});

test("notion read finds the page by exact title and numbers it", async () => {
  const { t } = tools();
  const out = await t.call("notion", { action: "read", page: "shopping list" });
  assert.match(out, /^Page "Shopping list":\n1\. - \[ \] Milk\n2\. - \[ \] Greens\n3\.   - \[ \] Sprite Zero/);
  assert.doesNotMatch(out, /inside/, "a subpage's content is not part of the page");
});

test("a write before any read is refused, not guessed", async () => {
  const { t, n, notes } = tools();
  const out = await t.call("notion", { action: "check", page: "Shopping list", line: 1 });
  assert.match(out, /didn't work: read "Shopping list" first/);
  assert.equal(n.log.filter((l) => l[0] === "patch").length, 0);
  assert.equal(notes.length, 0);
});

test("add under a section uses its checkboxes, notes it, and renumbers", async () => {
  const { t, n, notes } = tools();
  await t.call("notion", { action: "read", page: "Shopping list" });
  const out = await t.call("notion", { action: "add", page: "Shopping list", under: 2, items: ["Apples", "Flowers"] });
  assert.deepEqual(n.log.find((l) => l[0] === "append"), ["append", "b2", "- [ ] Apples\n- [ ] Flowers"]);
  assert.match(out, /^Done: added "Apples", "Flowers" under "Greens"\./);
  // New lines get the next numbers; the old lines keep theirs.
  assert.match(out, /7\.   - \[ \] Apples\n8\.   - \[ \] Flowers\n5\. - 📄 Old list\n6\. - \[ \] Eggs/);
  assert.deepEqual(notes, ['added "Apples", "Flowers" under "Greens" (Notion page "Shopping list")']);
});

test("add with no section goes to the end of the page in the page's style", async () => {
  const { t, n } = tools();
  await t.call("notion", { action: "add", page: "Shopping list", items: ["Bread"] });
  assert.deepEqual(n.log.find((l) => l[0] === "append"), ["append", "p1", "- [ ] Bread"]);
});

test("check, uncheck, edit and remove act on the numbered line", async () => {
  const { t, n, notes } = tools();
  await t.call("notion", { action: "read", page: "Shopping list" });
  assert.match(await t.call("notion", { action: "uncheck", page: "Shopping list", line: 4 }), /Done: unchecked "Shot cups"/);
  assert.deepEqual(n.log.at(-1), ["patch", "b4", { checked: false }]);
  assert.match(await t.call("notion", { action: "check", page: "Shopping list", line: 1 }), /Done: checked off "Milk"/);
  // Edit keeps the tick: Milk is checked now.
  const edit = await t.call("notion", { action: "edit", page: "Shopping list", line: 1, text: "Oat milk" });
  assert.deepEqual(n.log.at(-1), ["patch", "b1", { markdown: "- [x] Oat milk" }]);
  assert.match(edit, /changed "Milk" to "Oat milk"/);
  // Numbers are current after each write: Eggs is still line 6.
  assert.match(await t.call("notion", { action: "remove", page: "Shopping list", line: 6 }), /^Done: removed "Eggs" \(in Notion's Trash\)\./);
  assert.deepEqual(n.log.at(-1), ["delete", "b7"]);
  assert.equal(notes.length, 4);
});

test("a line number past the page is an error the voice can say", async () => {
  const { t } = tools();
  await t.call("notion", { action: "read", page: "Shopping list" });
  assert.match(await t.call("notion", { action: "remove", page: "Shopping list", line: 40 }), /didn't work: no line 40/);
});

test("search lists titles, and create makes a subpage", async () => {
  const { t, n, notes } = tools();
  assert.equal(await t.call("notion", { action: "search", page: "shopping" }), "Shopping list\nShopping ideas");
  const out = await t.call("notion", { action: "create", page: "Shopping list", text: "Party", items: ["Cups"] });
  assert.match(out, /made the page "Party" under "Shopping list"/);
  assert.deepEqual(n.log.at(-1)[1], { page: "p1", title: "Party", markdown: "- Cups" });
  assert.equal(notes.length, 1);
});

test("calendar read numbers a day's events and asks for the next day as the end", async () => {
  const { t, c } = tools();
  const out = await t.call("calendar", { action: "read", from: "2026-11-27" });
  assert.deepEqual(c.log[0], ["list", "2026-11-27", "2026-11-28"]);
  assert.equal(out, "1. 2026-11-27 15:00–16:00 Lab meeting\n2. 2026-11-27 all day Holiday");
});

test("calendar add, edit and delete; edits need a read; guests block a delete", async () => {
  const { t, c, notes } = tools();
  assert.match(await t.call("calendar", { action: "edit", event: 1, title: "x" }), /read the day first/);
  assert.match(await t.call("calendar", { action: "add", title: "Dentist", start: "2026-11-27T15:00" }), /give an end time/);
  assert.match(await t.call("calendar", { action: "add", title: "Dentist", start: "2026-11-27T15:00", end: "2026-11-27T16:00", color: "tomato" }), /Done: added "Dentist"/);
  assert.deepEqual(c.log.at(-1), ["add", { summary: "Dentist", start: "2026-11-27T15:00:00", end: "2026-11-27T16:00:00", location: undefined, color: "tomato" }]);
  assert.match(await t.call("calendar", { action: "add", title: "Trip", start: "2026-11-28" }), /all day/);
  await t.call("calendar", { action: "read", from: "2026-11-27" });
  assert.match(await t.call("calendar", { action: "edit", event: 1, start: "2026-11-27T16:00", end: "2026-11-27T17:00" }), /Done: changed "Lab meeting"/);
  await t.call("calendar", { action: "read", from: "2026-11-27" });
  assert.match(await t.call("calendar", { action: "delete", event: 1 }), /deleted "Lab meeting".*Trash/);
  await t.call("calendar", { action: "read", from: "2026-11-27" });
  assert.match(await t.call("calendar", { action: "delete", event: 2 }), /didn't work: "Holiday" was not deleted: has guests/);
  assert.equal(notes.length, 4);
});

test("a page is found by its exact title only, never by a fuzzy top hit", async () => {
  const { t, n, notes } = tools();
  const out = await t.call("notion", { action: "add", page: "temporary list", items: ["Apples"] });
  assert.match(out, /no page is called exactly "temporary list". Close titles: "Shopping list", "Shopping ideas"/);
  assert.equal(n.log.filter((l) => l[0] === "append").length, 0, "nothing was written");
  assert.equal(notes.length, 0);
});

test("calendar times get seconds, which Google requires", async () => {
  const { t, c } = tools();
  await t.call("calendar", { action: "add", title: "X", start: "2026-11-27T15:00", end: "2026-11-27T16:00" });
  assert.equal(c.log.at(-1)[1].start, "2026-11-27T15:00:00");
  assert.equal(c.log.at(-1)[1].end, "2026-11-27T16:00:00");
});

test("a calendar change returns the day renumbered, so the next change needs no read", async () => {
  const { t, c } = tools();
  await t.call("calendar", { action: "read", from: "2026-11-27" });
  const out = await t.call("calendar", { action: "edit", event: 1, start: "2026-11-27T16:00", end: "2026-11-27T17:00" });
  assert.match(out, /Done: changed "Lab meeting"[\s\S]*\n1\. .*Lab meeting\n2\. .*Holiday/);
  assert.deepEqual(c.log.at(-1), ["list", "2026-11-27", "2026-11-28"]);
  assert.match(await t.call("calendar", { action: "delete", event: 1 }), /Done: deleted "Lab meeting"/);
});

test("write nests markdown inside a line; after puts lines next to one, at its level", async () => {
  const { t, n, notes } = tools();
  await t.call("notion", { action: "read", page: "Shopping list" });
  const out = await t.call("notion", { action: "write", page: "Shopping list", under: 2, markdown: "- Temporary list\n  - [ ] Milk" });
  assert.match(out, /Done: added "Temporary list", "Milk" under "Greens"/);
  assert.deepEqual(n.log.at(-1), ["append", "b2", "- Temporary list\n  - [ ] Milk"]);
  await t.call("notion", { action: "add", page: "Shopping list", after: 3, items: ["Lime"] });
  assert.deepEqual(n.log.at(-1), ["append", "b2", "- [ ] Lime", "b3"]); // b3 sits inside Greens
  await t.call("notion", { action: "add", page: "Shopping list", after: 1, items: ["Oats"] });
  assert.deepEqual(n.log.at(-1).slice(1), ["p1", "- [ ] Oats", "b1"]);
  assert.match(await t.call("notion", { action: "write", page: "Shopping list" }), /give the markdown/);
  assert.equal(notes.length, 3);
});

test("under a heading means the end of its section, since a heading holds no lines", async () => {
  const h = (id, text) => ({ id, type: "heading_2", heading_2: { rich_text: [{ plain_text: text, text: { content: text }, annotations: {} }] } });
  const blocks = [h("h1", "Food"), todo("f1", "Milk"), todo("f2", "Eggs", false, [todo("f3", "brown")]), h("h2", "Other"), todo("o1", "Soap")];
  const log = [];
  const t = makeVoiceTools({
    notionRoutes: {
      "GET /notion/search": async () => ({ results: [{ id: "p1", object: "page", title: "List" }] }),
      "POST /notion/append": async ({ params, body }) => (log.push([params.get("id"), body.markdown, body.after]), { appended: 1 }),
    },
    calendarRoutes: {},
    fetchBlockChildren: async () => structuredClone(blocks),
  });
  await t.call("notion", { action: "read", page: "List" });
  await t.call("notion", { action: "add", page: "List", under: 1, items: ["Bread"] });
  assert.deepEqual(log.at(-1), ["p1", "- [ ] Bread", "f2"]); // after Eggs, not after its child
  await t.call("notion", { action: "add", page: "List", under: 5, items: ["Sponge"] });
  assert.deepEqual(log.at(-1), ["p1", "- [ ] Sponge", "o1"]);
});

test("numberLines records each line's parent", () => {
  const { map } = numberLines([todo("a", "A", false, [todo("b", "B")]), todo("c", "C")]);
  assert.deepEqual([...map.values()].map((l) => l.parentId), [null, "a", null]);
});

test("add or write with line means under that line", async () => {
  const { t, n } = tools();
  await t.call("notion", { action: "read", page: "Shopping list" });
  await t.call("notion", { action: "write", page: "Shopping list", line: 2, markdown: "- Temporary list\n  - [ ] Milk" });
  assert.deepEqual(n.log.at(-1), ["append", "b2", "- Temporary list\n  - [ ] Milk"]);
});

test("a change with no page goes to the page last read", async () => {
  const { t, n } = tools();
  assert.match(await t.call("notion", { action: "add", items: ["x"] }), /say which page/);
  await t.call("notion", { action: "read", page: "Shopping list" });
  assert.match(await t.call("notion", { action: "add", under: 2, items: ["Bread"] }), /Done: added "Bread" under "Greens"/);
  assert.deepEqual(n.log.at(-1), ["append", "b2", "- [ ] Bread"]);
});

test("remove takes several lines in one call; numbers from one read hold after each removal", async () => {
  const { t, n, notes } = tools();
  await t.call("notion", { action: "read", page: "Shopping list" });
  const out = await t.call("notion", { action: "remove", page: "Shopping list", lines: [1, 6] });
  assert.match(out, /^Done: removed "Milk", "Eggs" \(in Notion's Trash\)\./);
  assert.deepEqual(n.log.filter((l) => l[0] === "delete"), [["delete", "b1"], ["delete", "b7"]]);
  assert.match(out, /\n2\. - \[ \] Greens\n3\.   - \[ \] Sprite Zero/, "Greens keeps its number");
  assert.equal(notes.length, 1, "one note for the batch");
});

test("a number from an earlier read still names the same line after other lines went", async () => {
  const { t, n } = tools();
  await t.call("notion", { action: "read", page: "Shopping list" });
  await t.call("notion", { action: "remove", page: "Shopping list", lines: [1] });
  await t.call("notion", { action: "remove", page: "Shopping list", lines: [6] });
  assert.deepEqual(n.log.at(-1), ["delete", "b7"], "6 is still Eggs");
});

test("parallel removes from one read hit the right lines", async () => {
  const { t, n } = tools();
  await t.call("notion", { action: "read", page: "Shopping list" });
  await Promise.all([
    t.call("notion", { action: "remove", page: "Shopping list", lines: [6] }),
    t.call("notion", { action: "remove", page: "Shopping list", lines: [1] }),
  ]);
  assert.deepEqual(n.log.filter((l) => l[0] === "delete"), [["delete", "b7"], ["delete", "b1"]]);
});

test("items name lines by their words, with no read first", async () => {
  const { t, n } = tools();
  const out = await t.call("notion", { action: "remove", page: "Shopping list", items: ["milk", "egg"] });
  assert.match(out, /^Done: removed "Milk", "Eggs"/);
  assert.deepEqual(n.log.filter((l) => l[0] === "delete"), [["delete", "b1"], ["delete", "b7"]]);
});

test("some found, some not: says what went, then what did not, in plain words", async () => {
  const { t, n } = tools();
  const out = await t.call("notion", { action: "remove", page: "Shopping list", items: ["milk", "caviar"] });
  assert.match(out, /^Removed "Milk" \(in Notion's Trash\)\. No line says "caviar"\./);
  assert.equal(n.log.filter((l) => l[0] === "delete").length, 1);
});

test("none found is an error; words that fit several lines ask which", async () => {
  const { t, n } = tools();
  assert.match(await t.call("notion", { action: "remove", page: "Shopping list", items: ["caviar"] }), /^That didn't work: no line says "caviar"\.$/);
  await t.call("notion", { action: "add", page: "Shopping list", items: ["Shot glasses"] });
  const out = await t.call("notion", { action: "remove", page: "Shopping list", items: ["shot"] });
  assert.match(out, /"shot" could be "Shot cups" or "Shot glasses"; say which/);
  assert.equal(n.log.filter((l) => l[0] === "delete").length, 0);
});

test("check and edit take items too", async () => {
  const { t, n } = tools();
  assert.match(await t.call("notion", { action: "check", page: "Shopping list", items: ["sprite zero", "eggs"] }), /^Done: checked off "Sprite Zero", "Eggs"\./);
  assert.deepEqual(n.log.filter((l) => l[0] === "patch").map((l) => l[1]), ["b3", "b7"]);
  assert.match(await t.call("notion", { action: "edit", page: "Shopping list", items: ["eggs"], text: "Brown eggs" }), /changed "Eggs" to "Brown eggs"/);
});

test("calendar delete takes several events; one blocked is said plainly", async () => {
  const { t, c } = tools();
  await t.call("calendar", { action: "read", from: "2026-11-27" });
  const out = await t.call("calendar", { action: "delete", events: [1, 2] });
  assert.match(out, /^Deleted "Lab meeting" \(in Google Calendar's Trash for 30 days\)\. "Holiday" was not deleted: has guests\./);
  assert.deepEqual(c.log.filter((l) => l[0] === "delete"), [["delete", "e1"]]);
});

test("calendar match finds an event by its title on a day, with no read first", async () => {
  const { t, c } = tools();
  assert.match(await t.call("calendar", { action: "delete", match: "lab", from: "2026-11-27" }), /^Done: deleted "Lab meeting"/);
  assert.deepEqual(c.log.filter((l) => l[0] === "delete"), [["delete", "e1"]]);
  assert.match(await t.call("calendar", { action: "delete", match: "dentist", from: "2026-11-27" }), /didn't work: no event called "dentist" on 2026-11-27/);
});

test("calendar edit of several events changes one field on each, never their times", async () => {
  const { t, c } = tools();
  await t.call("calendar", { action: "read", from: "2026-11-27" });
  assert.match(await t.call("calendar", { action: "edit", events: [1, 2], color: "tomato" }), /^Done: changed "Lab meeting", "Holiday" \(color tomato\)\./);
  assert.equal(c.log.filter((l) => l[0] === "edit").length, 2);
  assert.match(await t.call("calendar", { action: "edit", events: [1, 2], start: "2026-11-27T16:00" }), /change times one event at a time/);
});

// ── Reminders ───────────────────────────────────────────────────────────────

// A reminder list in memory that answers with the reminder routes' shapes.
function fakeReminders() {
  const log = [];
  const r = (id, text, dueText, extra = {}) => ({ id, kind: "reminder", text, dueText, repeatText: null, snoozed: false, to: ["me"], status: "active", ...extra });
  const list = [
    r("r2aa", "Call the bank", "Wed Nov 25, 9:00 AM"),
    r("r3bb", "Stand-up", "Wed Nov 25, 9:30 AM", { repeatText: "every Monday and Wednesday at 9:30 AM" }),
    r("r4cc", "Take out the bins", "Thu Nov 26, 7:00 PM", { to: ["me", "mom"] }),
    r("r5dd", "Bank transfer", "Fri Nov 27, 8:00 AM"),
  ];
  const find = (params) => list.find((e) => e.id === params.get("id"));
  const routes = {
    "GET /reminders": async ({ params }) => {
      log.push(["list", params.get("kind")]);
      return { entries: list.filter((e) => e.status === "active") };
    },
    "POST /reminders": async ({ body }) => {
      log.push(["add", body]);
      if (body.at === "2026-11-01T09:00") return { error: "Sun Nov 1, 9:00 AM is in the past", status: 400 };
      const entry = r(`r9${list.length}`, body.text, "Fri Nov 27, 3:00 PM", body.repeat ? { repeatText: `every day at ${body.time}` } : {});
      list.unshift(entry); // due first, so it lists first
      return { entry, line: `${entry.id}: "${entry.text}"` };
    },
    "DELETE /reminders": async ({ params }) => {
      log.push(["cancel", params.get("id")]);
      const e = find(params);
      if (e.id === "r5dd") return { error: "the list is not loaded yet", status: 503 };
      e.status = "cancelled";
      return { entry: e, line: `Cancelled ${e.id}: "${e.text}".` };
    },
    "POST /reminders/snooze": async ({ params, body }) => {
      log.push(["snooze", params.get("id"), body]);
      const e = find(params);
      Object.assign(e, { dueText: body.for ? "Tue Nov 24, 3:30 PM" : "Wed Nov 25, 10:00 AM", snoozed: true });
      return { entry: e, line: `Snoozed ${e.id}` };
    },
  };
  return { routes, log };
}

function reminderTools(routes = fakeReminders().routes) {
  const notes = [];
  const t = makeVoiceTools({
    notionRoutes: {},
    calendarRoutes: {},
    reminderRoutes: routes,
    fetchBlockChildren: async () => [],
    note: (x) => notes.push(x),
    now: () => new Date("2026-11-24T20:00:00Z"),
  });
  return { t, notes };
}

test("the reminders tool is there only with reminder routes, in the defs too", () => {
  const { t } = reminderTools();
  assert.deepEqual(t.names, ["notion", "calendar", "reminders", "get_time"]);
  assert.deepEqual(t.defs.map((d) => d.name), t.names);
  assert.match(REMINDERS_TOOL.description, /Never guess a time: ask/);
  assert.match(REMINDERS_TOOL.description, /Eastern, written like 2026-11-27T15:00/);
  // No field takes a person: a reminder from the voice goes to the user only.
  assert.ok(!["to", "phone", "number", "via"].some((k) => k in REMINDERS_TOOL.parameters.properties));
});

test("reminders list numbers the user's reminders, and names only other people", async () => {
  const f = fakeReminders();
  const { t } = reminderTools(f.routes);
  assert.equal(
    await t.call("reminders", { action: "list" }),
    "1. Call the bank — Wed Nov 25, 9:00 AM\n" +
      "2. Stand-up — every Monday and Wednesday at 9:30 AM, next Wed Nov 25, 9:30 AM\n" +
      "3. Take out the bins — Thu Nov 26, 7:00 PM, to me and mom\n" +
      "4. Bank transfer — Fri Nov 27, 8:00 AM"
  );
  assert.deepEqual(f.log[0], ["list", "reminder"], "jobs are not the voice's to see");
});

test("reminders add: a time, a wait, or a repeat. Each add is noted", async () => {
  const f = fakeReminders();
  const { t, notes } = reminderTools(f.routes);
  assert.equal(await t.call("reminders", { action: "add", text: "Call mom", at: "2026-11-27T15:00" }), 'Done: added "Call mom" for Fri Nov 27, 3:00 PM.');
  assert.deepEqual(f.log.at(-1), ["add", { text: "Call mom", at: "2026-11-27T15:00" }]);
  await t.call("reminders", { action: "add", text: "Laundry", in: "30m", days: [], day: "" });
  assert.deepEqual(f.log.at(-1), ["add", { text: "Laundry", in: "30m" }], "empty fields are left out");
  const weekly = await t.call("reminders", { action: "add", text: "Pills", repeat: "weekly", time: "08:00", days: ["MO", "TH"] });
  assert.deepEqual(f.log.at(-1), ["add", { text: "Pills", repeat: "weekly", time: "08:00", days: ["MO", "TH"] }]);
  assert.equal(weekly, 'Done: added "Pills", every day at 08:00.');
  assert.deepEqual(notes, [
    'added the reminder "Call mom" for Fri Nov 27, 3:00 PM',
    'added the reminder "Laundry" for Fri Nov 27, 3:00 PM',
    'added the reminder "Pills", every day at 08:00',
  ]);
});

test("reminders add with no time asks, and makes no call", async () => {
  const f = fakeReminders();
  const { t, notes } = reminderTools(f.routes);
  assert.match(await t.call("reminders", { action: "add", text: "Call mom" }), /^That didn't work: say when\. Never guess a time: ask the caller\.$/);
  assert.match(await t.call("reminders", { action: "add", at: "2026-11-27T15:00" }), /say what the reminder is for/);
  assert.equal(f.log.length, 0);
  // A refusal from the route is words the voice can say, and nothing is noted.
  assert.match(await t.call("reminders", { action: "add", text: "x", at: "2026-11-01T09:00" }), /^That didn't work: Sun Nov 1, 9:00 AM is in the past\.$/);
  assert.equal(notes.length, 0);
});

test("reminders cancel by number needs a list, and the numbers hold after a change", async () => {
  const f = fakeReminders();
  const { t, notes } = reminderTools(f.routes);
  assert.match(await t.call("reminders", { action: "cancel", reminders: [1] }), /list the reminders first, or give match/);
  await t.call("reminders", { action: "list" });
  const out = await t.call("reminders", { action: "cancel", reminders: [1, 3] });
  assert.match(out, /^Done: cancelled "Call the bank", "Take out the bins"\./);
  assert.deepEqual(f.log.filter((l) => l[0] === "cancel"), [["cancel", "r2aa"], ["cancel", "r4cc"]]);
  // The list again, numbers kept: Stand-up is still 2.
  assert.match(out, /\n\n2\. Stand-up .*\n4\. Bank transfer/);
  assert.deepEqual(notes, ['cancelled the reminders "Call the bank", "Take out the bins"']);
  // A new reminder gets the next number, not a free one.
  assert.match(await t.call("reminders", { action: "add", text: "Dentist", at: "2026-11-27T15:00" }), /\n\n5\. Dentist — /);
});

test("reminders cancel by match needs no list. Several matches ask which", async () => {
  const f = fakeReminders();
  const { t, notes } = reminderTools(f.routes);
  assert.match(await t.call("reminders", { action: "cancel", match: "stand-up" }), /^Done: cancelled "Stand-up"\./);
  assert.deepEqual(f.log.filter((l) => l[0] === "cancel"), [["cancel", "r3bb"]]);
  const several = await t.call("reminders", { action: "cancel", match: "bank" });
  assert.match(several, /"bank" could be:\n1\. Call the bank .*\n4\. Bank transfer .*\nsay which by number/);
  assert.equal(f.log.filter((l) => l[0] === "cancel").length, 1, "nothing more was cancelled");
  assert.match(await t.call("reminders", { action: "cancel", match: "dentist" }), /no reminder says "dentist"/);
  // One failed, one done: both are said plainly.
  const mixed = await t.call("reminders", { action: "cancel", reminders: [1, 4, 7] });
  assert.match(mixed, /^Cancelled "Call the bank"\. No reminder 7\. "Bank transfer" was not cancelled: the list is not loaded yet\./);
  assert.equal(notes.length, 2);
});

test("reminders snooze: for a wait or until a time, one reminder at a time", async () => {
  const f = fakeReminders();
  const { t, notes } = reminderTools(f.routes);
  assert.match(await t.call("reminders", { action: "snooze", match: "bins" }), /say for how long \(for\), or until when \(at\)/);
  assert.match(await t.call("reminders", { action: "snooze", match: "bins", for: "1h", at: "2026-11-25T10:00" }), /give for or at, not both/);
  assert.equal(await t.call("reminders", { action: "snooze", match: "bins", for: "1h" }), 'Done: snoozed "Take out the bins" to Tue Nov 24, 3:30 PM.\n\n' +
    "1. Call the bank — Wed Nov 25, 9:00 AM\n" +
    "2. Stand-up — every Monday and Wednesday at 9:30 AM, next Wed Nov 25, 9:30 AM\n" +
    "3. Take out the bins — Tue Nov 24, 3:30 PM (snoozed), to me and mom\n" +
    "4. Bank transfer — Fri Nov 27, 8:00 AM");
  assert.deepEqual(f.log.filter((l) => l[0] === "snooze"), [["snooze", "r4cc", { for: "1h" }]]);
  await t.call("reminders", { action: "snooze", reminders: [1], at: "2026-11-25T10:00" });
  assert.deepEqual(f.log.at(-2), ["snooze", "r2aa", { until: "2026-11-25T10:00" }]);
  assert.match(await t.call("reminders", { action: "snooze", reminders: [1, 2], for: "1h" }), /snooze one reminder at a time/);
  assert.deepEqual(notes, [
    'snoozed the reminder "Take out the bins" to Tue Nov 24, 3:30 PM',
    'snoozed the reminder "Call the bank" to Wed Nov 25, 10:00 AM',
  ]);
});

// The fields the tool sends must be ones the real routes accept. A fake
// cannot show that, so this runs the real service on a temp file.
test("reminders on the real routes: the tool's fields are ones the service accepts", async () => {
  const clock = { t: Date.parse("2026-11-24T17:00:00Z") }; // Tue Nov 24, 12:00 PM Eastern
  const service = makeReminders({
    store: makeStore({ file: path.join(mkdtempSync(path.join(tmpdir(), "alfred-voice-reminders-")), "reminders.json") }),
    contacts: parseContacts({ spec: "mom=discord:100000000000000002|+15550000002", ownerDiscordId: "100000000000000001", ownerSms: "+15550000001" }),
    jobs: {
      available: () => [{ name: "backup", kind: "code" }],
      has: (name) => name === "backup",
      run: async () => ({ ok: true, output: "", error: "", kind: "code" }),
    },
    sendDiscord: async () => {},
    sendSms: async () => "msg-1",
    smsEnabled: true,
    now: () => clock.t,
    log: () => {},
  });
  await service.load();
  await service.add({ job: "backup", repeat: "daily", time: "03:00" }); // a job: never the voice's
  await service.add({ text: "Call mom", in: "1h", to: "mom" });
  const { t, notes } = reminderTools(makeReminderRoutes(service));

  assert.equal(await t.call("reminders", { action: "add", text: "Call the bank", at: "2026-11-25T17:00" }), 'Done: added "Call the bank" for Wed Nov 25, 5:00 PM.');
  assert.equal(await t.call("reminders", { action: "add", text: "Laundry", in: "30m" }), 'Done: added "Laundry" for Tue Nov 24, 12:30 PM.');
  assert.equal(
    await t.call("reminders", { action: "add", text: "Stand-up", repeat: "weekly", time: "09:00", days: ["MO", "WE"] }),
    'Done: added "Stand-up", every Monday and Wednesday at 9:00 AM.'
  );
  assert.equal(
    await t.call("reminders", { action: "add", text: "Pay rent", repeat: "monthly", time: "08:00", day: "last" }),
    'Done: added "Pay rent", every month on the last day at 8:00 AM.'
  );
  assert.match(await t.call("reminders", { action: "add", text: "Pills", repeat: "daily", time: "8am" }), /^That didn't work: time must be HH:MM/);

  assert.equal(
    await t.call("reminders", { action: "list" }),
    "1. Laundry — Tue Nov 24, 12:30 PM\n" +
      "2. Call mom — Tue Nov 24, 1:00 PM, to mom\n" +
      "3. Stand-up — every Monday and Wednesday at 9:00 AM, next Wed Nov 25, 9:00 AM\n" +
      "4. Call the bank — Wed Nov 25, 5:00 PM\n" +
      "5. Pay rent — every month on the last day at 8:00 AM, next Mon Nov 30, 8:00 AM"
  );
  assert.match(await t.call("reminders", { action: "snooze", match: "bank", at: "2026-11-25T18:00" }), /^Done: snoozed "Call the bank" to Wed Nov 25, 6:00 PM\./);
  assert.match(await t.call("reminders", { action: "cancel", reminders: [1] }), /^Done: cancelled "Laundry"\./);

  const active = service.list({ kind: "reminder" });
  assert.deepEqual(active.map((e) => e.text), ["Call mom", "Stand-up", "Call the bank", "Pay rent"]);
  assert.equal(active[2].dueText, "Wed Nov 25, 6:00 PM");
  assert.ok(active.filter((e) => e.text !== "Call mom").every((e) => e.to.length === 1 && e.to[0] === "me"), "the voice reminds the user only");
  assert.equal(service.list({ kind: "job" }).length, 1, "the job is still there");
  assert.equal(notes.length, 6);
});

// "Remind me again in 10 minutes" right after a reminder went out: the
// reminder is done, so the list leaves it out, but snooze finds it.
test("reminders snooze by match finds a one-time reminder that went out in the last hours", async () => {
  const clock = { t: Date.parse("2026-11-24T17:00:00Z") }; // Tue Nov 24, 12:00 PM Eastern
  const sent = [];
  const service = makeReminders({
    store: makeStore({ file: path.join(mkdtempSync(path.join(tmpdir(), "alfred-voice-snooze-")), "reminders.json") }),
    contacts: parseContacts({ ownerDiscordId: "100000000000000001", ownerSms: "+15550000001" }),
    sendDiscord: async (to, text) => sent.push(text),
    sendSms: async () => "msg-1",
    smsEnabled: true,
    now: () => clock.t,
    log: () => {},
  });
  await service.load();
  const notes = [];
  const t = makeVoiceTools({
    notionRoutes: {},
    calendarRoutes: {},
    reminderRoutes: makeReminderRoutes(service),
    fetchBlockChildren: async () => [],
    note: (x) => notes.push(x),
    now: () => new Date(clock.t),
  });
  assert.equal(await t.call("reminders", { action: "add", text: "Laundry", in: "10m" }), 'Done: added "Laundry" for Tue Nov 24, 12:10 PM.');
  clock.t += 10 * 60_000;
  await service.tick();
  assert.deepEqual(sent, ["⏰ Laundry"]);
  assert.equal(await t.call("reminders", { action: "list" }), "No reminders are set.", "a reminder that went out is not in the list");

  assert.equal(
    await t.call("reminders", { action: "snooze", match: "laundry", for: "10m" }),
    'Done: snoozed "Laundry" to Tue Nov 24, 12:20 PM.\n\n1. Laundry — Tue Nov 24, 12:20 PM (snoozed)'
  );
  assert.equal(notes.at(-1), 'snoozed the reminder "Laundry" to Tue Nov 24, 12:20 PM');
  assert.equal(service.list({ kind: "reminder" })[0].status, "active");

  // Six hours later it is too old to find, and cancel never looks at it.
  clock.t += 10 * 60_000;
  await service.tick();
  clock.t += 6 * 3_600_000;
  assert.match(await t.call("reminders", { action: "snooze", match: "laundry", for: "10m" }), /no reminder says "laundry"/);
  assert.match(await t.call("reminders", { action: "cancel", match: "laundry" }), /no reminder says "laundry"/);
});
