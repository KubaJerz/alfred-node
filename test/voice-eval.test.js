import { test } from "node:test";
import assert from "node:assert/strict";
import { makeVoiceTools } from "../telnyx/voice-tools.js";
import { fakeAlfred, fakeCalendar, fakeNotion } from "../voice-eval/fakes.js";
import { SCENARIOS, COMMON_CHECKS } from "../voice-eval/scenarios.js";
import { scoreChecks, transcript } from "../voice-eval/score.js";

const world = () => {
  const notion = fakeNotion([
    { title: "Home", markdown: "" },
    { title: "Shopping list", markdown: "- [ ] Milk\n- [ ] Greens\n  - [ ] Kale\n- [ ] Eggs", parent: "Home" },
  ]);
  const calendar = fakeCalendar([
    { summary: "Gym", start: "2026-12-03T07:00:00-05:00", end: "2026-12-03T08:00:00-05:00" },
    { summary: "Review", start: "2026-12-04T11:00:00-05:00", end: "2026-12-04T12:00:00-05:00", guests: ["a@b.c"] },
  ]);
  const tools = makeVoiceTools({
    notionRoutes: notion.routes,
    calendarRoutes: calendar.routes,
    fetchBlockChildren: notion.fetchBlockChildren,
    now: () => new Date("2026-12-02T15:00:00Z"),
  });
  return { notion, calendar, tools };
};

test("the real voice tools read and change the fake Notion", async () => {
  const { notion, tools } = world();
  const read = await tools.call("notion", { action: "read", page: "Shopping list" });
  assert.match(read, /1\. - \[ \] Milk\n2\. - \[ \] Greens\n3\. {3}- \[ \] Kale\n4\. - \[ \] Eggs/);
  assert.match(await tools.call("notion", { action: "add", page: "Shopping list", items: ["Bread"] }), /^Done: added "Bread"/);
  assert.match(await tools.call("notion", { action: "check", page: "Shopping list", items: ["eggs"] }), /^Done/);
  assert.match(await tools.call("notion", { action: "remove", page: "Shopping list", items: ["milk", "cheese"] }), /Removed "Milk"/);
  const lines = notion.lines("Shopping list");
  assert.deepEqual(lines.map((l) => l.text), ["- [ ] Greens", "- [ ] Kale", "- [x] Eggs", "- [ ] Bread"]);
  assert.equal(lines[1].depth, 1);
});

test("the fake Notion's search is fuzzy, and a new page lands under its parent", async () => {
  const { notion, tools } = world();
  const { results } = await notion.routes["GET /notion/search"]({ params: new URLSearchParams({ q: "shopping" }) });
  assert.deepEqual(results.map((r) => r.title), ["Shopping list"]);
  assert.match(await tools.call("notion", { action: "create", page: "Home", text: "Think List" }), /made the page "Think List" under "Home"/);
  assert.deepEqual(notion.titles(), ["Home", "Shopping list", "Think List"]);
  assert.match(notion.dump().Home.join("\n"), /Think List/);
});

test("create with no parent makes the page in the home page, and a later add goes to it", async () => {
  const notion = fakeNotion([{ title: "Teamspace Home" }, { title: "Shopping list", markdown: "- [ ] Milk", parent: "Teamspace Home" }]);
  const tools = makeVoiceTools({ notionRoutes: notion.routes, calendarRoutes: {}, fetchBlockChildren: notion.fetchBlockChildren });
  await tools.call("notion", { action: "read", page: "Shopping list" });
  assert.equal(await tools.call("notion", { action: "create", text: "Think List" }), 'Done: made the page "Think List".');
  assert.deepEqual(notion.dump()["Teamspace Home"], ["- 📄 Shopping list", "- 📄 Think List"]);
  assert.match(await tools.call("notion", { action: "add", items: ["Why pay for anything?"] }), /^Done: added "Why pay for anything\?"/);
  assert.deepEqual(notion.dump()["Think List"], ["Why pay for anything?"]);
  assert.match(await tools.call("notion", { action: "create" }), /title as text/);
});

test("the fake calendar filters by range and refuses to delete an event with guests", async () => {
  const { calendar, tools } = world();
  const out = await tools.call("calendar", { action: "read", from: "2026-12-03" });
  assert.match(out, /Gym/);
  assert.doesNotMatch(out, /Review/);
  await tools.call("calendar", { action: "read", from: "2026-12-04" });
  assert.match(await tools.call("calendar", { action: "delete", events: [2] }), /was not deleted: that event has guests/);
  assert.equal(calendar.events().length, 2);
});

test("the stand-in Alfred answers the first matching handler, and asks back otherwise", async () => {
  const alfred = fakeAlfred({
    delayMs: 0,
    world: { computer: { todo: [] } },
    handlers: [{ match: /to-?do/i, reply: (req, w) => (w.computer.todo.push(req), "Added.") }],
  });
  assert.equal(await alfred.onTurn({ text: "Add X to the to-do list" }), "Added.");
  assert.match(await alfred.onTurn({ text: "Order pizza" }), /wasn't sure/);
  assert.deepEqual(alfred.world.computer.todo, ["Add X to the to-do list"]);
  assert.deepEqual(alfred.requests.map((r) => r.handled), [true, false]);
});

test("scenarios have unique ids, a goal, lines and checks", () => {
  const ids = SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of SCENARIOS) {
    assert.ok(s.goal && s.turns.length && s.checks.length, s.id);
    assert.ok(s.world.pages.length && s.alfred.length, s.id);
  }
});

const record = (voice, extra = []) => ({
  events: [
    { t: 1000, kind: "caller", text: "What's on your to-do list on the computer?" },
    ...extra,
    ...voice.map((text, i) => ({ t: 2000 + i, kind: "voice", text })),
    { t: 9000, kind: "latency", ms: 400 },
    { t: 9500, kind: "end", reason: "stream stopped", usd: 0.01 },
  ],
  world: { calendar: [], computer: { todo: [] } },
  notion: fakeNotion([]),
});

test("the common checks catch a false 'I can't' and a repeated failed call", () => {
  const failed = { t: 1500, kind: "tool", name: "notion", args: { action: "create", text: "X" }, result: "That didn't work: say which page." };
  const r = record(["I can't access files on your computer from here."], [failed, { ...failed, t: 1600 }]);
  const s = scoreChecks(r, { checks: [] });
  const byName = Object.fromEntries(s.checks.map((c) => [c.name, c.pass]));
  assert.equal(byName[COMMON_CHECKS[0].name], false);
  assert.equal(byName[COMMON_CHECKS[2].name], false);
  assert.equal(s.metrics.toolErrors, 2);
  assert.equal(s.metrics.firstAudioMs, 400);
  assert.equal(s.metrics.usd, 0.01);

  const fine = scoreChecks(record(["Two things: reminders, then the KO systems."]), { checks: [] });
  assert.equal(fine.passed, fine.total);
});

test("the transcript shows the script, what was heard, and tool calls in order", () => {
  const r = record(["Got it."], [{ t: 1500, kind: "use_tools", request: "Read TODO.md", reply: "1. Reminders" }]);
  const text = transcript(r);
  assert.match(text, /CALLER \(script\): What's on your to-do list[\s\S]*asked Alfred: "Read TODO.md" → "1. Reminders"[\s\S]*ALFRED: Got it\./);
});
