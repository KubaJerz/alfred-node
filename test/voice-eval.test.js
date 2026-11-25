import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { makeVoiceTools } from "../telnyx/voice-tools.js";
import { makeRealtimeSession } from "../telnyx/realtime.js";
import { liveUpdate } from "../context.js";
import { fakeAlfred, fakeCalendar, fakeNotion } from "../voice-eval/fakes.js";
import { makeCallLedger } from "../voice-eval/openai-call.js";
import { SCENARIOS, COMMON_CHECKS } from "../voice-eval/scenarios.js";
import { scoreChecks, transcript, graderPrompt } from "../voice-eval/score.js";

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

test("a tick with no page finds the page that has the items, else lists the recent pages", async () => {
  const { notion, tools } = world();
  assert.match(await tools.call("notion", { action: "check", items: ["kale", "eggs"] }), /^Done: checked off "Kale", "Eggs"/);
  assert.deepEqual(notion.lines("Shopping list").filter((l) => l.checked).map((l) => l.text), ["- [x] Kale", "- [x] Eggs"]);

  const fresh = world();
  assert.match(await fresh.tools.call("notion", { action: "check", items: ["caviar"] }), /say which page.*Recent pages: "Home", "Shopping list"/);
  assert.match(await fresh.tools.call("notion", { action: "add", items: ["Bread"] }), /Recent pages/);
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

// ── Messages from elsewhere, during the call ────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await sleep(5);
  }
};

// A stand-in for the OpenAI socket: it opens, and keeps what is sent.
class FakeWs extends EventEmitter {
  static last = null;
  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
    FakeWs.last = this;
    setImmediate(() => {
      this.readyState = 1;
      this.emit("open");
    });
  }
  send(s) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.readyState = 3;
  }
  server(ev) {
    this.emit("message", Buffer.from(JSON.stringify(ev)), false);
  }
}

test("a scenario's rows reach the call by the bot's live feed, as system items with no reply; the call's own rows do not", async () => {
  const told = [];
  const call = makeCallLedger({ told: (text) => told.push(text) });
  const session = makeRealtimeSession({
    callControlId: "eval-live-photo",
    caller: "+10000000000",
    sendFrame: () => {},
    onTurn: async () => "",
    hangup: async () => {},
    log: () => {},
    apiKey: "sk-test",
    greeting: "",
    WebSocketImpl: FakeWs,
    feed: call.feed,
    onCallEvent: call.onCallEvent,
  });
  session.start();
  const ws = FakeWs.last;
  await until(() => ws.sent.length >= 1);

  const { rows } = SCENARIOS.find((s) => s.id === "live-photo").turns[0];
  await call.inject(rows);
  const items = ws.sent.filter((e) => e.type === "conversation.item.create").map((e) => e.item);
  assert.deepEqual(items, rows.map((row) => ({ type: "message", role: "system", content: [{ type: "input_text", text: liveUpdate(row) }] })));
  assert.deepEqual(told, rows.map((row) => liveUpdate(row)), "the record has what the call was told");
  assert.equal(ws.sent.filter((e) => e.type === "response.create").length, 0, "no reply asked");

  // The voice's own line and its use_tools turn land in the ledger, as on the
  // box, and never go back into the call.
  ws.server({ type: "response.created", response: { id: "r1" } });
  ws.server({ type: "response.output_audio_transcript.done", response_id: "r1", item_id: "o1", transcript: "They look lovely." });
  await call.asked({ text: "What is in the photo?", caller: "+10000000000", callId: "eval-live-photo" });
  await call.answered({ callId: "eval-live-photo" }, "Blue running shoes.");
  await until(async () => (await call.ledger.readAll()).some((r) => r.text === "They look lovely."));
  assert.deepEqual((await call.ledger.readAll()).map((r) => [r.src, r.via, r.kind ?? null]), [
    ["call", "call", "start"],
    ["chat", "discord", null],
    ["chat", "discord", "reply"],
    ["call", "call", null],
    ["chat", "call", null],
    ["chat", "call", "reply"],
  ]);
  assert.equal(told.length, 2);
  session.end("test hung up", { hang: false });
  call.close();
  assert.equal(existsSync(path.dirname(call.ledger.file)), false, "the temp ledger is gone");
});

test("the live scenarios carry rows the call is told about, and each holds the voice to quiet", () => {
  const live = SCENARIOS.filter((s) => s.turns.some((t) => t.rows));
  assert.deepEqual(live.map((s) => s.id), ["live-photo", "live-text", "live-photo-pending"]);
  for (const s of live) {
    for (const row of s.turns.flatMap((t) => t.rows || [])) assert.ok(liveUpdate(row), `${s.id}: the call is told this row`);
    assert.ok(s.checks.some((c) => c.name === "said nothing when the messages came in"), s.id);
  }
  // Discord and SMS both, both ways.
  const vias = live.flatMap((s) => s.turns.flatMap((t) => t.rows)).map((r) => `${r.dir}:${r.via}`);
  for (const want of ["in:discord", "out:discord", "in:sms", "out:sms"]) assert.ok(vias.includes(want), want);
  // A pending photo is named, never described: only Alfred can say what it shows.
  const [photo] = live.find((s) => s.id === "live-photo-pending").turns[0].rows;
  assert.deepEqual(photo.files, ["var/memories/dailies/2026-12-02/1-0-shoes.jpg"]);
  assert.match(liveUpdate(photo), /and sent a photo\./);
  assert.doesNotMatch(liveUpdate(photo), /shoe|hoka|blue/i);
});

const run = (events) => ({ events, world: { calendar: [], computer: { todo: [] } }, notion: fakeNotion([]) });
const passes = (r, id) => Object.fromEntries(scoreChecks(r, SCENARIOS.find((s) => s.id === id)).checks.map((c) => [c.name, c.pass]));

test("live-photo-pending: asking Alfred and passing on his answer passes; a guess, or a sound unprompted, does not", () => {
  const good = [
    { t: 1000, kind: "rows", rows: 1, spoke: false },
    { t: 3000, kind: "caller", text: "What do you think of the ones I just sent you?" },
    { t: 4000, kind: "voice", text: "One moment." },
    { t: 4200, done: 8200, kind: "use_tools", request: "What is in the photo the user just sent?", reply: "Hoka Clifton 9 running shoes, in blue." },
    { t: 9000, kind: "voice", text: "They're Hoka Clifton 9s, in blue. A good pick." },
  ];
  const ok = passes(run(good), "live-photo-pending");
  assert.ok(Object.values(ok).every(Boolean), JSON.stringify(ok));
  const guessed = passes(run([...good.slice(0, 2), { t: 4000, kind: "voice", text: "Nice blue trainers!" }, ...good.slice(3)]), "live-photo-pending");
  assert.equal(guessed["did not guess what the photo shows"], false);
  const spoke = passes(run([{ ...good[0], spoke: true }, ...good.slice(1)]), "live-photo-pending");
  assert.equal(spoke["said nothing when the messages came in"], false);
  // Never asking Alfred: every line counts as before his answer.
  const unasked = passes(run([good[0], good[1], { t: 4000, kind: "voice", text: "Lovely blue shoes." }]), "live-photo-pending");
  assert.equal(unasked["did not guess what the photo shows"], false);
  assert.equal(unasked['asked Alfred (use_tools) about the photo'], false);
});

test("live-text: saying what was texted passes; acting on the text does not", () => {
  const said = { t: 4000, kind: "voice", text: "You said you're out of eggs, and I'll remind you this evening." };
  const read = { t: 3500, kind: "tool", name: "notion", args: { action: "read", page: "Shopping list" }, result: "1. Eggs" };
  const ok = passes(run([{ t: 1000, kind: "rows", rows: 2, spoke: false }, read, said]), "live-text");
  assert.ok(Object.values(ok).every(Boolean), JSON.stringify(ok));
  const add = { t: 3500, kind: "tool", name: "notion", args: { action: "add", page: "Shopping list", items: ["Eggs"] }, result: 'Done: added "Eggs".' };
  assert.equal(passes(run([add, said]), "live-text")["changed nothing"], false);
});

test("the transcript and the grader show what the call was told mid-call", () => {
  const told = '[Meanwhile, by text, the user said: "Thoughts on these?", and sent a photo.]';
  const r = record(["They're Hoka Clifton 9s."], [{ t: 1100, kind: "rows", rows: 1, spoke: true }, { t: 1200, kind: "told", text: told }]);
  const text = transcript(r);
  assert.match(text, /\(Alfred made a sound before the caller said anything\)\n.*\(told mid-call, no reply asked: \[Meanwhile, by text/);
  assert.equal(transcript(record(["Hi."], [{ t: 1100, kind: "rows", rows: 1, spoke: false }])).includes("made a sound"), false);
  const prompt = graderPrompt(r, SCENARIOS.find((s) => s.id === "live-photo"));
  assert.match(prompt, /Lines marked "told mid-call" are messages from elsewhere/);
  assert.ok(prompt.includes(told), "the grader reads the item whole");
  // A call that was told nothing is graded on the same prompt as before.
  assert.doesNotMatch(graderPrompt(record(["Done."]), SCENARIOS[0]), /told mid-call/);
});
