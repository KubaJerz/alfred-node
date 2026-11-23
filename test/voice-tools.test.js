import { test } from "node:test";
import assert from "node:assert/strict";
import { makeVoiceTools, numberLines, nextDay, timeNow } from "../telnyx/voice-tools.js";

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
  assert.match(out, /5\.   - \[ \] Apples/);
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
  assert.match(await t.call("notion", { action: "remove", page: "Shopping list", line: 6 }), /removed "Eggs" \(it is in Notion's Trash\)/);
  assert.deepEqual(n.log.at(-1), ["delete", "b7"]);
  assert.equal(notes.length, 4);
});

test("a line number past the page is an error the voice can say", async () => {
  const { t } = tools();
  await t.call("notion", { action: "read", page: "Shopping list" });
  assert.match(await t.call("notion", { action: "remove", page: "Shopping list", line: 40 }), /has no line 40/);
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
  assert.match(await t.call("calendar", { action: "delete", event: 2 }), /didn't work: has guests/);
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
