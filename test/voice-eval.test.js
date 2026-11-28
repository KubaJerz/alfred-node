import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeVoiceTools } from "../telnyx/voice-tools.js";
import { makeRealtimeSession } from "../telnyx/realtime.js";
import { callBriefing, liveUpdate } from "../context.js";
import { fakeAlfred, fakeCalendar, fakeNotion } from "../voice-eval/fakes.js";
import { makeCallLedger, runOpenAICall } from "../voice-eval/openai-call.js";
import { scenariosOn, COMMON_CHECKS } from "../voice-eval/scenarios.js";
import { scoreChecks, transcript, graderPrompt } from "../voice-eval/score.js";

// The tests' day: Wednesday 2 December 2026. Each call's clock is 10:00 AM
// Eastern on it.
const { scenarios: SCENARIOS, everyday: EVERYDAY } = scenariosOn("2026-12-02");
const EVAL_NOW = SCENARIOS[0].now;

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
    assert.equal(s.now.toISOString(), "2026-12-02T15:00:00.000Z", `${s.id}: 10:00 AM Eastern`);
  }
});

// OpenAI tells the model the real date itself, so the calls run on the day of
// the run, with the world built around it.
test("scenarios on another day: the world, the weekdays and the clock follow the day", () => {
  const { scenarios, everyday } = scenariosOn("2027-07-09"); // a Friday, in summer time
  const s = (id) => scenarios.find((x) => x.id === id);
  assert.ok(scenarios.every((x) => x.now.toISOString() === "2027-07-09T14:00:00.000Z" && x.day === "2027-07-09"));
  assert.deepEqual(s("add-two").world.events.map((e) => [e.summary, e.start]), [
    ["Lab meeting", "2027-07-09T14:00:00-04:00"],
    ["Gym", "2027-07-10T07:00:00-04:00"],
    ["Call with Mom", "2027-07-10T18:00:00-04:00"],
    ["Thesis review", "2027-07-11T11:00:00-04:00"],
  ]);
  assert.match(everyday.memory, /Lab meeting every Friday at 2 PM\.\n- Thesis advisor reviews chapters on Sundays\./);
  assert.ok(everyday.rows.every((r) => r.ts.startsWith("2027-07-09T12:15")), "08:15 Eastern");
  // Two days on is Sunday: what the caller says, and what the check wants.
  const add = s("calendar-add");
  assert.equal(add.turns[0].say, "Put the dentist on my calendar Sunday at 3 for an hour.");
  assert.match(add.goal, /this Sunday \(Jul 11\) at 3 PM/);
  const booked = (start) => scoreChecks({ ...run([]), world: { calendar: [{ summary: "Dentist", start }], computer: {} } }, add).checks[0].pass;
  assert.equal(booked("2027-07-11T15:00:00"), true);
  assert.equal(booked("2026-12-04T15:00:00"), false);
  assert.match(graderPrompt(run([]), add), /It is Friday, July 9, 2027 at 10:00 AM \(Eastern\), during the call\./);
  // The dentist by SMS is six days on: Thursday.
  assert.ok(s("brief-dentist").briefing.rows.some((r) => r.text === "The dentist is Thursday at 3."));
  assert.deepEqual(s("live-photo").turns[0].rows[0].files, ["var/memories/dailies/2027-07-09/1-0-shoes.jpg"]);
  // On the tests' Wednesday, the line is the one the TTS cache already has.
  assert.equal(SCENARIOS.find((x) => x.id === "calendar-add").turns[0].say, "Put the dentist on my calendar Friday at 3 for an hour.");
});

test("a scenario with no clock is refused before any call or text-to-speech", async () => {
  await assert.rejects(runOpenAICall({ id: "x", turns: [{ say: "Hi." }] }, { apiKey: "sk-test" }), /Scenario x has no clock: build it with scenariosOn/);
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

test("the calendar scenarios take Mom said the British way, as Mum", () => {
  const named = (id, text) =>
    scoreChecks(record([text]), SCENARIOS.find((s) => s.id === id)).checks.find((c) => c.name === "named gym, mom/mum").pass;
  for (const id of ["calendar-tomorrow", "multi-request"]) {
    assert.equal(named(id, "The gym at 7, then a call with your mum at 6."), true, id);
    assert.equal(named(id, "The gym at 7, then the call with Mom at 6."), true, id);
    assert.equal(named(id, "Just the gym at 7."), false, id);
  }
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

test("live-photo-pending: asking Alfred and passing on his answer passes; a guess, a sound unprompted, or a call never told, does not", () => {
  const [photo] = SCENARIOS.find((s) => s.id === "live-photo-pending").turns[0].rows;
  const good = [
    { t: 1000, kind: "rows", rows: 1, spoke: false },
    { t: 1000, kind: "told", text: liveUpdate(photo) },
    { t: 3000, kind: "caller", text: "What do you think of the ones I just sent you?" },
    { t: 4000, kind: "voice", text: "One moment." },
    { t: 4200, done: 8200, kind: "use_tools", request: "What is in the photo the user just sent?", reply: "Hoka Clifton 9 running shoes, in blue." },
    { t: 9000, kind: "voice", text: "They're Hoka Clifton 9s, in blue. A good pick." },
  ];
  const ok = passes(run(good), "live-photo-pending");
  assert.ok(Object.values(ok).every(Boolean), JSON.stringify(ok));
  const guessed = passes(run([...good.slice(0, 3), { t: 4000, kind: "voice", text: "Nice blue trainers!" }, ...good.slice(4)]), "live-photo-pending");
  assert.equal(guessed["did not guess what the photo shows"], false);
  const spoke = passes(run([{ ...good[0], spoke: true }, ...good.slice(1)]), "live-photo-pending");
  assert.equal(spoke["said nothing when the messages came in"], false);
  // Never asking Alfred: every line counts as before his answer.
  const unasked = passes(run([...good.slice(0, 3), { t: 4000, kind: "voice", text: "Lovely blue shoes." }]), "live-photo-pending");
  assert.equal(unasked["did not guess what the photo shows"], false);
  assert.equal(unasked['asked Alfred (use_tools) about the photo'], false);
  // A broken feed: the voice, told nothing, asks Alfred about "the ones I just
  // sent" and says his answer. Every other check passes; this one does not.
  const untold = passes(run(good.filter((e) => e.kind !== "told")), "live-photo-pending");
  assert.deepEqual(Object.entries(untold).filter(([, pass]) => !pass).map(([name]) => name), ["was told of the photo mid-call"]);
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

// ── What the voice knows as the call starts (the briefing) ──────────────────

const BRIEFED = ["brief-pasta", "brief-last-call", "brief-dentist", "brief-stale-list", "brief-calendar-fresh"];
const scenario = (id) => SCENARIOS.find((s) => s.id === id);
// A test call's ledger at the eval's clock, with the scenario's world in it.
async function seeded(id) {
  const call = makeCallLedger({ now: () => EVAL_NOW.getTime() });
  await call.seed(scenario(id).briefing);
  return call;
}

test("the briefing scenarios carry a made-up world from before the call, and every other call starts with the everyday one", () => {
  assert.deepEqual(SCENARIOS.filter((s) => s.briefing !== EVERYDAY).map((s) => s.id), BRIEFED);
  assert.ok(SCENARIOS.every((s) => s.briefing), "a real call always has a background");
  for (const id of [...BRIEFED, "add-two"]) {
    const { briefing } = scenario(id);
    assert.ok(briefing.user && briefing.memory && briefing.yesterday && briefing.today, id);
    for (const row of briefing.rows) assert.ok(Date.parse(row.ts) < EVAL_NOW.getTime(), `${id}: ${row.text} is from before the call`);
  }
  // The last call left kale under Greens; spinach is not on the list yet.
  const notion = fakeNotion(scenario("brief-last-call").world.pages);
  const list = notion.lines("Shopping list").map((l) => l.text);
  assert.ok(list.includes("- [ ] Kale") && !list.some((l) => /spinach/i.test(l)), list.join("\n"));
  // Another list has Greens too, so without the briefing "the list we were
  // adding to" could be either.
  assert.ok(notion.lines("Garden list").some((l) => /Greens/.test(l.text)));
  assert.equal(scenario("add-two").world.pages.some((p) => p.title === "Garden list"), false, "only in this scenario's world");
});

test("a briefing scenario's world goes where the bot keeps it, and the call's prompt is the bot's callBriefing of it", async () => {
  const facts = {
    "brief-pasta": "the user said (by text): I'm cooking pasta tonight",
    "brief-last-call": 'you did (on the call): added "Kale" under "Greens" (Notion page "Shopping list")',
    "brief-dentist": "the user said (by SMS): The dentist is Tuesday at 3.",
    "brief-stale-list": "Milk, butter and limes.",
    "brief-calendar-fresh": "- Gym on Thursdays at 7 AM.",
  };
  for (const id of BRIEFED) {
    const call = await seeded(id);
    const memories = path.join(call.stateDir, "memories");
    assert.equal(readFileSync(path.join(call.stateDir, "USER.md"), "utf8"), scenario(id).briefing.user);
    assert.ok(existsSync(path.join(memories, "MEMORY.md")));
    assert.ok(existsSync(path.join(memories, "dailies", "2026-12-01", "daily.md")), "yesterday's note");
    assert.ok(existsSync(path.join(memories, "dailies", "2026-12-02", "daily.md")), "today's note");
    const built = await call.buildInstructions({ callId: `eval-${id}`, caller: "+10000000000", prompt: "PROMPT" });
    const bots = await callBriefing({ stateDir: call.stateDir, ledger: call.ledger, prompt: "PROMPT", callId: `eval-${id}`, now: EVAL_NOW });
    assert.equal(built.text, bots.text, `${id}: the same builder as the bot`);
    assert.ok(built.text.startsWith("PROMPT\n\n=== BACKGROUND"), id);
    assert.ok(built.text.includes(facts[id]), `${id}:\n${built.text}`);
    assert.deepEqual(built.dropped, [], `${id}: nothing left out`);
    assert.equal(call.briefing(), built, "the record gets what was built");
    call.close();
  }
});

test("a call seeded with no briefing world gets the prompt alone", async () => {
  const call = makeCallLedger({ now: () => EVAL_NOW.getTime() });
  await call.seed(undefined);
  const built = await call.buildInstructions({ callId: "eval-add-two", prompt: "PROMPT" });
  assert.equal(built.text, "PROMPT");
  assert.equal(built.background, "");
  call.close();
});

test("a briefing row with no ts is a mistake in the scenario, said at once", async () => {
  const call = makeCallLedger();
  await assert.rejects(call.seed({ rows: [{ dir: "in", text: "when?" }] }), /A briefing row needs its ts/);
  call.close();
});

test("through the session: the call's session.update carries the briefing, after the date line and the prompt", async () => {
  const call = await seeded("brief-dentist");
  const session = makeRealtimeSession({
    callControlId: "eval-brief-dentist",
    caller: "+10000000000",
    sendFrame: () => {},
    onTurn: async () => "",
    hangup: async () => {},
    log: () => {},
    apiKey: "sk-test",
    greeting: "",
    instructions: "THE VOICE PROMPT",
    clock: () => EVAL_NOW,
    WebSocketImpl: FakeWs,
    feed: call.feed,
    onCallEvent: call.onCallEvent,
    buildInstructions: call.buildInstructions,
  });
  session.start();
  const ws = FakeWs.last;
  await until(() => ws.sent.length >= 1);
  const { instructions } = ws.sent[0].session;
  assert.ok(instructions.startsWith("It is Wednesday, December 2, 2026 at 10:00 AM (Eastern) as the call starts.\n\nTHE VOICE PROMPT\n\n=== BACKGROUND"), instructions);
  assert.ok(instructions.includes("08:30 the user said (by SMS): The dentist is Tuesday at 3.\n08:30 you said (by SMS): Noted."));
  assert.equal(instructions.includes("(a phone call started)"), false, "the test call's own start is no background");
  session.end("test hung up", { hang: false });
  call.close();
});

test("brief-pasta and brief-dentist: the answer from the briefing with no tool passes; a tool, or no answer, does not", () => {
  const voice = (t, text) => ({ t, kind: "voice", text });
  const caller = (text) => ({ t: 1000, kind: "caller", text });
  const pasta = passes(run([caller("What am I making tonight?"), voice(2000, "Pasta, you said.")]), "brief-pasta");
  assert.ok(Object.values(pasta).every(Boolean), JSON.stringify(pasta));
  const looked = { t: 1500, kind: "tool", name: "notion", args: { action: "search", page: "dinner" }, result: "Nothing shared matches that." };
  assert.equal(passes(run([caller("x"), looked, voice(2000, "Pasta.")]), "brief-pasta")["used no tool"], false, "even a read is a tool");
  const asked = { t: 1500, done: 5000, kind: "use_tools", request: "What is the user cooking tonight?", reply: "Pasta." };
  assert.equal(passes(run([caller("x"), asked, voice(6000, "Pasta.")]), "brief-pasta")["used no tool"], false);

  const dentist = passes(run([caller("When's the dentist?"), voice(2000, "Tuesday at three.")]), "brief-dentist");
  assert.ok(Object.values(dentist).every(Boolean), JSON.stringify(dentist));
  const cal = { t: 1500, kind: "tool", name: "calendar", args: { action: "read" }, result: "Nothing on those days." };
  const missed = passes(run([caller("x"), cal, voice(2000, "I don't see a dentist appointment.")]), "brief-dentist");
  assert.equal(missed["used no tool"], false);
  assert.equal(missed["said Tuesday"], false);
});

test("brief-last-call: spinach under Greens with no Alfred passes; spinach at the end of the list, asking Alfred, or a call with no briefing, does not", async () => {
  // The list as the voice changes it: read, then add (under the Greens line, or at the end).
  const listAfter = async (add) => {
    const notion = fakeNotion(scenario("brief-last-call").world.pages);
    const tools = makeVoiceTools({ notionRoutes: notion.routes, calendarRoutes: {}, fetchBlockChildren: notion.fetchBlockChildren });
    assert.match(await tools.call("notion", { action: "read", page: "Shopping list" }), /4\. - \[ \] Greens\n5\. {3}- \[ \] Kale/);
    assert.match(await tools.call("notion", { action: "add", page: "Shopping list", items: ["Spinach"], ...add }), /^Done: added "Spinach"/);
    return notion;
  };
  // The background the call starts with, from the bot's own builder.
  const call = await seeded("brief-last-call");
  const { background } = await call.buildInstructions({ callId: "eval-brief-last-call", prompt: "PROMPT" });
  call.close();
  const good = { events: [{ t: 1000, kind: "voice", text: "Done, spinach is under Greens." }], briefing: background, world: { calendar: [], computer: {} }, notion: await listAfter({ under: 4 }) };
  const ok = passes(good, "brief-last-call");
  assert.ok(Object.values(ok).every(Boolean), JSON.stringify(ok));
  // A call that started with no briefing can still pick the right list by
  // luck: it does not pass.
  const unbriefed = passes({ ...good, briefing: "" }, "brief-last-call");
  assert.deepEqual(Object.entries(unbriefed).filter(([, pass]) => !pass).map(([name]) => name), ["started the call knowing the last call's kale under Greens"]);

  const atEnd = passes({ ...good, notion: await listAfter({}) }, "brief-last-call");
  assert.equal(atEnd["Spinach on Shopping list, unticked"], true);
  assert.equal(atEnd["Spinach under Greens on Shopping list"], false);
  const viaAlfred = passes({ ...good, events: [...good.events, { t: 500, done: 900, kind: "use_tools", request: "add spinach", reply: "Done." }] }, "brief-last-call");
  assert.equal(viaAlfred["did it without Alfred"], false);
});

test("the grader reads what the call started with, and only for a call that had a briefing", () => {
  const background = "=== BACKGROUND: WHAT YOU KNOW FROM BEFORE THIS CALL ===\n…\n09:00 the user said (by text): I'm cooking pasta tonight\n\n=== END OF BACKGROUND ===";
  const briefed = { ...record(["Pasta."]), briefing: background };
  const prompt = graderPrompt(briefed, scenario("brief-pasta"));
  assert.match(prompt, /Alfred started this call with the background shown below in his\s+instructions/);
  assert.ok(prompt.includes(`What Alfred knew as the call started (the background in his instructions):\n${background}`));
  // Without one, the prompt is as before: no briefing rubric, no background.
  const plain = graderPrompt({ ...record(["Done."]), briefing: "" }, SCENARIOS[0]);
  assert.equal(plain, graderPrompt(record(["Done."]), SCENARIOS[0]));
  assert.doesNotMatch(plain, /started this call with the background|What Alfred knew as the call started/);
});
