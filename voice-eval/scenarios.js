// The test calls. Each one is a caller script, the world it starts in, and the
// checks that say whether Alfred got it right.
//
// A turn is { say } — spoken once Alfred has finished his turn — or
// { say, pauseMs } — spoken that long after the line before, whatever Alfred
// is doing (a caller who keeps talking) — or { say, bargeInMs } — spoken that
// long after Alfred's next reply starts (talking over him).
//
// A turn with rows ({ rows, say }) first writes those ledger rows, as bot.js
// would during the call (a text from the user, Alfred's reply to it); the live
// feed tells the call, as on a real call. The caller waits ROWS_QUIET_MS, then
// says the line. Give rows only to a turn that waits for Alfred to finish.
//
// A scenario with a briefing ({ user, memory, yesterday, today, rows }) starts
// from what the bot would know before the call: USER.md, MEMORY.md, the daily
// notes of yesterday and today, and ledger rows from before the call, each
// with its ts (at() below). The call's prompt is built from it by the bot's
// own builder (callBriefing in context.js). A scenario without one gets
// EVERYDAY, since a real call always starts with a background; --no-briefing
// runs the prompt alone.
//
// The calls run on a day: scenariosOn(day) builds them, with the world around
// that day. Each call's clock is 10:00 AM Eastern on it (s.now). The lab
// meeting is that day, the gym and the call with Mom are tomorrow, and the
// thesis review is in two days. A weekday that a caller or a text names is
// one of that week. scripts/voice-eval.mjs uses the day of the run, because
// OpenAI tells the model the real date itself. With no date in the prompt,
// both models took the real day (2026-11-24) for today. On a made-up
// Wednesday 2 December, mini still booked "Friday" from the real date, a week
// early. A real call never has the two dates disagree. The tests use
// Wednesday 2 December 2026, so "tomorrow" is Thursday the 3rd and "Friday"
// the 4th.

import path from "node:path";
import { attachmentName } from "../dailies.js";
import { callRow, inboundRow, toolRow } from "../ledger.js";
import { zonedIso, zonedToUtc } from "../reminders/schedule.js";
import { nextDay } from "../telnyx/voice-tools.js";

// ── The day ──────────────────────────────────────────────────────────────────
// A day (YYYY-MM-DD, Eastern) and the days after it. date(n) is the date n
// days on, weekday(n) its name, monthDay(n) like "Dec 4", time(n, "14:00") a
// time on it with its offset, and at("09:00", row) a row at that time on the
// day itself.
function daysFrom(day) {
  const date = (n) => Array.from({ length: n }).reduce((d) => nextDay(d), day);
  const name = (n, opts) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(new Date(`${date(n)}T12:00:00Z`));
  return {
    date,
    weekday: (n) => name(n, { weekday: "long" }),
    monthDay: (n) => name(n, { month: "short", day: "numeric" }),
    time: (n, hhmm) => zonedIso(zonedToUtc(date(n), hhmm)),
    at: (hhmm, row) => ({ ...row, ts: zonedToUtc(day, hhmm).toISOString() }),
  };
}

// ── The world ────────────────────────────────────────────────────────────────

const SHOPPING = `- [ ] Milk
- [ ] Butter
- [ ] Limes
- [ ] Kefir
- [x] Olive oil
- [ ] Greens
  - [ ] Spinach
  - [ ] Kale
- [ ] Eggs`;

const PAGES = [
  { title: "Teamspace Home", markdown: "Kuba's home page." },
  { title: "Shopping list", markdown: SHOPPING, parent: "Teamspace Home" },
  { title: "Do some day 🤷‍♀️", markdown: "- Learn to sail\n- Visit Kraków", parent: "Teamspace Home" },
  { title: "Reading list", markdown: "- [ ] The Mom Test\n- [x] Deep Work", parent: "Teamspace Home" },
];

// What is on the computer: Alfred's own to-do file in his folder.
const COMPUTER = {
  todo: ["Reminders and scheduled tasks (being built now)", "Connect to the KO systems on the computer"],
};

// ── Messages from elsewhere, during the call ─────────────────────────────────
// Rows as bot.js writes them: the user's message through the same inboundRow,
// with its files saved in the day's folder (texted, in scenariosOn), and
// Alfred's reply.

const AGENT_DIR = "/eval/agent";
const WHO = { discord: { tag: "kuba", id: "1", channel: "c1" }, sms: { tag: "sms:+10000000000", id: "+10000000000", channel: "sms" } };

const replied = (text, { via = "discord" } = {}) => ({ dir: "out", via, kind: "reply", text, files: 0 });

// ── What the bot knew before the call (the briefing) ────────────────────────
// All of it made up: the files the briefing reads, and rows from earlier the
// same morning (in scenariosOn, at their Eastern times on the day).

// A call earlier this morning, as it wrote itself into the ledger.
const EARLIER = { callId: "eval-earlier-call", caller: "+10000000000" };

// The shopping list after that call: Greens with kale, and no spinach yet.
const AFTER_EARLIER_CALL = `- [ ] Milk
- [ ] Butter
- [ ] Limes
- [ ] Greens
  - [ ] Kale
- [ ] Eggs`;
// Another list with a Greens section, where spinach could go just as well.
// Without the briefing, "the greens on the list we were adding to" could be
// either; only the last call says which.
const GARDEN = { title: "Garden list", markdown: "- [ ] Tomatoes\n- [ ] Greens\n  - [ ] Lettuce\n- [ ] Basil", parent: "Teamspace Home" };

// The photo in the live-photo calls. Only Alfred's reply says what it shows.
const SHOES = "Those are Hoka Clifton 9 running shoes, in blue. Light and well cushioned: a good pick for daily road runs.";
// Any word that says what is in the photo.
const SHOE_WORDS = /\b(shoes?|sneakers?|trainers?|runners|boots?|hoka|clifton|nike|adidas|asics|brooks|saucony|blue|black|white|red|green|gr[ae]y|pink|orange|yellow|purple|brown)\b/i;

// ── The stand-in Alfred (use_tools) ──────────────────────────────────────────
// He does what a plain request asks; a request he can't place gets a question
// back, as the real one would.

const ALFRED = [
  {
    // His own to-do file on the computer.
    match: /\b(to-?do|todo|task list)\b/i,
    reply: (req, w) => {
      if (/\b(add|put|append|write|include)\b/i.test(req)) {
        const item = /["“']([^"”']+)["”']/.exec(req)?.[1] || req;
        w.computer.todo.push(item);
        return `Added to TODO.md in my folder: "${item}". It now has ${w.computer.todo.length} items.`;
      }
      return `TODO.md in my folder has: ${w.computer.todo.map((t, i) => `${i + 1}. ${t}`).join(" ")}`;
    },
  },
  {
    // A new Notion page, made under Teamspace Home.
    match: /\b(create|make|new)\b.*\bpage\b|\bpage\b.*\b(create|make|called|named)\b/i,
    reply: async (req, w) => {
      const title = /(?:called|named|titled)\s+["“']?([^"”'.,]+)/i.exec(req)?.[1]?.trim() || "Untitled";
      const home = (await w.notion.routes["GET /notion/search"]({ params: new URLSearchParams({ q: "Teamspace Home" }) })).results[0];
      await w.notion.routes["POST /notion/page"]({ body: { page: home.id, title } });
      return `Made the Notion page "${title}" under Teamspace Home.`;
    },
  },
  {
    match: /\b(e-?mail|inbox|mail)\b/i,
    reply: "One new email from Sarah, yesterday at 4:12 PM: she says the draft looks good and asks whether Friday at 2 works for a call.",
  },
  { match: /\bweather\b/i, reply: "Sunny and 54 now; rain from about 6 PM." },
];

// What Alfred knows once he has looked at the photo (use_tools waits for him).
const PHOTO = { match: /\b(photo|picture|image|pic|sent|these|ones|shoes?)\b/i, reply: `The photo the user just sent: ${SHOES}` };

// ── Checks ───────────────────────────────────────────────────────────────────

const voiceEvents = (r) => r.events.filter((e) => e.kind === "voice");
const voice = (r) => voiceEvents(r).map((e) => e.text);
const allVoice = (r) => voice(r).join(" ");
const page = (r, title) => r.notion.lines(title) || [];
const findLine = (r, title, word) => page(r, title).find((l) => new RegExp(`\\b${word}\\b`, "i").test(l.text));
const useTools = (r) => r.events.filter((e) => e.kind === "use_tools");
const toolCalls = (r, name) => r.events.filter((e) => e.kind === "tool" && (!name || e.name === name));

const check = {
  added: (title, ...words) => ({
    name: `${words.join(", ")} on ${title}, unticked`,
    test: (r) => words.every((w) => findLine(r, title, w)?.checked === false),
  }),
  gone: (title, ...words) => ({
    name: `${words.join(", ")} gone from ${title}`,
    test: (r) => words.every((w) => !findLine(r, title, w)),
  }),
  kept: (title, ...words) => ({
    name: `${words.join(", ")} still on ${title}`,
    test: (r) => words.every((w) => findLine(r, title, w)),
  }),
  ticked: (title, ...words) => ({
    name: `${words.join(", ")} ticked on ${title}`,
    test: (r) => words.every((w) => findLine(r, title, w)?.checked === true),
  }),
  said: (label, re) => ({ name: `said ${label}`, test: (r) => re.test(allVoice(r)) }),
  // A word can give its spellings, "mom/mum": the voice talks like a British
  // butler, so "Call with Mom" can come out as "your mum".
  saidAll: (words) => ({
    name: `named ${words.join(", ")}`,
    test: (r) => words.every((w) => new RegExp(`\\b(?:${w.replace(/\//g, "|")})`, "i").test(allVoice(r))),
  }),
  askedAlfred: (label, re = /./) => ({
    name: `asked Alfred (use_tools) ${label}`,
    test: (r) => useTools(r).some((u) => re.test(u.request)),
  }),
  notAskedAlfred: () => ({ name: "did it without Alfred", test: (r) => useTools(r).length === 0 }),
  // What the briefing says needs no tool at all, not even a look.
  noTools: () => ({ name: "used no tool", test: (r) => toolCalls(r).length === 0 && useTools(r).length === 0 }),
  // A fresh read, where the briefing only says what a list or the calendar
  // held then.
  read: (tool, label) => ({
    name: `read ${label} fresh`,
    test: (r) => toolCalls(r, tool).some((e) => e.args?.action === "read"),
  }),
  // word is a line nested under the line with parent, on the page.
  under: (title, parent, word) => ({
    name: `${word} under ${parent} on ${title}`,
    test: (r) => {
      const lines = page(r, title);
      const top = lines.findIndex((l) => new RegExp(`\\b${parent}\\b`, "i").test(l.text));
      if (top === -1) return false;
      const end = lines.findIndex((l, i) => i > top && l.depth <= lines[top].depth);
      const inside = lines.slice(top + 1, end === -1 ? lines.length : end);
      return inside.some((l) => new RegExp(`\\b${word}\\b`, "i").test(l.text));
    },
  }),
  event: (label, fn) => ({ name: label, test: (r) => r.world.calendar.some(fn) }),
  pageExists: (re) => ({ name: `a page matching ${re} exists`, test: (r) => r.notion.titles().some((t) => re.test(t)) }),
  todoHas: (re) => ({ name: `Alfred's to-do file has ${re}`, test: (r) => r.world.computer.todo?.some((t) => re.test(t)) }),
  hungUp: () => ({ name: "hung up after the goodbye", test: (r) => r.endedByAlfred }),
  fewWords: (n) => ({
    name: `last reply at most ${n} words`,
    test: (r) => (voice(r).at(-1) || "").split(/\s+/).filter(Boolean).length <= n,
  }),
  // Messages from elsewhere ask nothing: no sound until the caller talks.
  quietOnRows: () => ({
    name: "said nothing when the messages came in",
    test: (r) => r.events.filter((e) => e.kind === "rows").every((e) => !e.spoke),
  }),
  // Nothing said before Alfred's first answer came back (or at all, if he was
  // never asked) matches re: what only he could know.
  noGuess: (label, re) => ({
    name: `did not guess ${label}`,
    test: (r) => {
      const answered = Math.min(...useTools(r).map((u) => u.done ?? Infinity));
      return !voiceEvents(r).some((e) => e.t < answered && re.test(e.text));
    },
  }),
  // Reads and the time only: a text gets its own answer, so the call acts on nothing.
  changedNothing: () => ({
    name: "changed nothing",
    test: (r) => toolCalls(r).every((e) => e.name === "get_time" || ["read", "search"].includes(e.args?.action)),
  }),
  // What a scenario is about reached the call. A scenario whose other checks
  // can pass without it (a lucky guess, an obvious list) needs one of these,
  // or a broken feed or briefing still passes.
  told: (label, re) => ({
    name: `was told ${label} mid-call`,
    test: (r) => r.events.some((e) => e.kind === "told" && re.test(e.text)),
  }),
  briefed: (label, text) => ({ name: `started the call knowing ${label}`, test: (r) => (r.briefing || "").includes(text) }),
};

// Every call is held to these as well.
export const COMMON_CHECKS = [
  {
    // Call 2 on 2026-11-24: "I can't access your computer" with use_tools at hand.
    name: "never claims it can't do something it can",
    test: (r) =>
      !/\b(can(?:'|’|no)?t|cannot|unable to|don(?:'|’)t have (?:access|the ability))\b[^.]{0,40}\b(access|reach|open|run|see|search|create|get into|look at)\b|only see what you (?:share|paste)/i.test(
        allVoice(r)
      ),
  },
  {
    name: "never names a tool or system",
    test: (r) => !/\b(use_tools|tool call|the tool|my tools?|the system|function|API|database)\b/i.test(allVoice(r)),
  },
  {
    // Call 3: the same failing create, four times over.
    name: "never repeats a failed tool call",
    test: (r) => {
      const failed = toolCalls(r).filter((e) => /^That didn't work/.test(e.result)).map((e) => e.name + JSON.stringify(e.args));
      return new Set(failed).size === failed.length;
    },
  },
];

// ── Scenarios ────────────────────────────────────────────────────────────────

// The scenarios on a day (YYYY-MM-DD, Eastern), each with its world, its
// briefing, the day and its clock (now: 10:00 AM Eastern on the day).
// everyday is the background of a call with none of its own.
export function scenariosOn(day) {
  const { date, weekday, monthDay, time, at } = daysFrom(day);
  const now = zonedToUtc(day, "10:00");

  const EVENTS = [
    { summary: "Lab meeting", start: time(0, "14:00"), end: time(0, "15:00") },
    { summary: "Gym", start: time(1, "07:00"), end: time(1, "08:00") },
    { summary: "Call with Mom", start: time(1, "18:00"), end: time(1, "18:30") },
    { summary: "Thesis review", start: time(2, "11:00"), end: time(2, "12:00"), guests: ["advisor@example.edu"] },
  ];
  const world = () => ({ pages: PAGES, events: EVENTS, computer: COMPUTER });
  // The usual world, with one page's text changed, and more pages after it.
  const worldWith = (title, markdown, more = []) => ({
    ...world(),
    pages: [...PAGES.map((p) => (p.title === title ? { ...p, markdown } : p)), ...more],
  });

  // A text from the user, with its files in the day's folder.
  const dayDir = path.join(AGENT_DIR, "var", "memories", "dailies", day);
  const texted = (text, { via = "discord", files = [] } = {}) =>
    inboundRow({ who: WHO[via], via, text, agentDir: AGENT_DIR, attachments: files.map((f, i) => path.join(dayDir, attachmentName("1", i, f))) });

  // The files, as small as the real ones, so the facts a caller asks about sit
  // among others, as they would.
  const BACKGROUND = {
    user: "# User\n- Kuba. Eastern time.\n- Likes short, plain answers.",
    memory:
      '# Memory\n- The shopping list is the Notion page "Shopping list".\n- Runs most mornings before the lab.\n' +
      `- Lab meeting every ${weekday(0)} at 2 PM.\n- Thesis advisor reviews chapters on ${weekday(2)}s.`,
    yesterday: "## 18:40 — Groceries\nWants oat milk next time.\n\n## 21:15 — Thesis\nSent chapter 3 to the advisor.",
    today: "## 07:05 — Run\nRan 5 miles before the lab.",
  };

  // A chat at the start of the day, in every briefing: one exchange by text.
  const MORNING = [
    at("08:15", texted("Morning! Anything on today?")),
    at("08:15", replied("Morning. Just the lab meeting at 2.")),
  ];

  // A call earlier this morning, as it wrote itself into the ledger: its lines,
  // the voice's own tool changes, and its end.
  const earlier = (hhmm, ev) => at(hhmm, callRow({ ...EARLIER, ...ev }));
  const EARLIER_CALL = [
    earlier("09:40", { type: "start" }),
    earlier("09:40", { type: "line", dir: "in", text: "Add a Greens section to my shopping list, with kale in it." }),
    earlier("09:40", { type: "line", dir: "out", text: "Got it." }),
    at("09:40", toolRow({ ...EARLIER, text: 'added "Greens" (Notion page "Shopping list")' })),
    at("09:40", toolRow({ ...EARLIER, text: 'added "Kale" under "Greens" (Notion page "Shopping list")' })),
    earlier("09:41", { type: "line", dir: "out", text: "Done, kale is under Greens." }),
    earlier("09:41", { type: "line", dir: "in", text: "Great, thanks. Bye." }),
    earlier("09:41", { type: "line", dir: "out", text: "Goodbye." }),
    earlier("09:41", { type: "end", ms: 62_000, reason: "Alfred hung up (end_call)" }),
  ];

  // What every other call starts knowing: a real call always has a background,
  // so a scenario without its own still gets the files and the morning's text.
  const EVERYDAY = { ...BACKGROUND, rows: MORNING };

  // The dentist, by SMS: six days on, so its weekday is never today or tomorrow.
  const dentistDay = weekday(6);

  const scenarios = [
    {
      id: "add-two",
      goal: "Add bread and coffee to the shopping list, then confirm briefly.",
      turns: [{ say: "Add bread and coffee to my shopping list." }],
      checks: [check.added("Shopping list", "Bread", "Coffee"), check.notAskedAlfred(), check.fewWords(15)],
    },
    {
      id: "remove-three",
      goal: "Remove milk and butter; say cheese wasn't on the list. One plain reply, no 'partly done'.",
      turns: [{ say: "Take milk, butter and cheese off the shopping list." }],
      checks: [check.gone("Shopping list", "Milk", "Butter"), check.kept("Shopping list", "Limes", "Eggs"), check.said("cheese isn't there", /cheese/i)],
    },
    {
      id: "read-list",
      goal: "Read every unticked item on the shopping list, in order, plainly.",
      turns: [{ say: "What's on my shopping list?" }],
      checks: [check.saidAll(["milk", "butter", "limes", "kefir", "eggs"]), check.notAskedAlfred()],
    },
    {
      id: "tick-two",
      goal: "Tick off limes and kefir.",
      turns: [{ say: "Check off limes and kefir." }],
      checks: [check.ticked("Shopping list", "Limes", "Kefir"), check.added("Shopping list", "Milk"), check.fewWords(15)],
    },
    {
      id: "calendar-tomorrow",
      goal: `Say what's on the calendar tomorrow (${weekday(1)}): gym at 7 and the call with Mom at 6 PM.`,
      turns: [{ say: "What do I have tomorrow?" }],
      checks: [check.saidAll(["gym", "mom/mum"]), check.notAskedAlfred()],
    },
    {
      id: "calendar-add",
      goal: `Add a one-hour dentist appointment this ${weekday(2)} (${monthDay(2)}) at 3 PM.`,
      turns: [{ say: `Put the dentist on my calendar ${weekday(2)} at 3 for an hour.` }],
      checks: [check.event(`dentist on ${weekday(2)} at 3 PM`, (e) => /dentist/i.test(e.summary) && e.start.startsWith(`${date(2)}T15:00`))],
    },
    {
      id: "calendar-move",
      goal: "Move today's lab meeting one hour later (3 to 4 PM).",
      turns: [{ say: "Push my lab meeting back an hour." }],
      checks: [check.event("lab meeting now 3–4 PM", (e) => /lab meeting/i.test(e.summary) && e.start.startsWith(`${date(0)}T15:00`))],
    },
    {
      id: "multi-request",
      goal: "Add bread to the shopping list AND say what's on tomorrow's calendar, in one turn.",
      turns: [{ say: "Add bread to the shopping list, and what's on my calendar tomorrow?" }],
      checks: [check.added("Shopping list", "Bread"), check.saidAll(["gym", "mom/mum"])],
    },
    {
      id: "time",
      goal: "Say the time (10 AM) in a few words.",
      turns: [{ say: "What time is it?" }],
      checks: [check.said("ten o'clock", /\b10\b|\bten\b/i), check.fewWords(15)],
    },
    {
      // Call 3 on 2026-11-24: create kept failing for want of a parent page.
      id: "create-page",
      goal: "Create a new Notion page called Think List (for topics to think about on long drives).",
      turns: [{ say: "Create a new page in Notion called Think List. It's for topics to think about on long drives." }],
      checks: [check.pageExists(/think ?list/i)],
    },
    {
      // Call 3 again, the way it was really said: in pieces, while Alfred works.
      id: "create-page-runon",
      goal: "Create a Notion page called ThinkList; the caller adds what it's for while Alfred works.",
      turns: [
        { say: "All right, create a new page called ThinkList." },
        { say: "It'll be about topics to think about when we have long drives.", pauseMs: 700 },
      ],
      checks: [check.pageExists(/think ?list/i)],
    },
    {
      // Call 1 on 2026-11-24: the request reached Alfred garbled, and a new file
      // was made instead of the existing to-do list.
      id: "computer-todo-add",
      goal: "Ask Alfred to add 'set up the reminders feature' to his own to-do file on the computer.",
      turns: [{ say: "Add 'set up the reminders feature' to your own to-do list on the computer, the one in your folder." }],
      checks: [check.askedAlfred("about the to-do list", /to-?do/i), check.todoHas(/remind/i)],
    },
    {
      // Call 2 on 2026-11-24: five Notion searches, then "I can't access your computer".
      id: "computer-todo-read",
      goal: "Ask Alfred what's on his to-do list on the computer and read it back.",
      turns: [{ say: "What's on your to-do list on the computer?" }],
      checks: [check.askedAlfred("about the to-do list", /to-?do/i), check.said("the items", /remind/i)],
    },
    {
      id: "computer-pushback",
      goal: "After 'the one on the computer, not Notion', ask Alfred for his to-do list; never claim no access.",
      turns: [{ say: "What's on the to-do list?" }, { say: "No, not Notion. The one on the computer, in your folder." }],
      checks: [check.askedAlfred("about the to-do list", /to-?do/i), check.said("the items", /remind/i)],
    },
    {
      id: "email",
      goal: "Ask Alfred whether Sarah emailed, and tell the caller what she said.",
      turns: [{ say: "Did Sarah email me?" }],
      checks: [check.askedAlfred("about email", /sarah|mail/i), check.said("what she asked", /friday/i)],
    },
    {
      id: "barge-in",
      goal: "Start reading the list; when cut off with 'just add apples', stop and add apples.",
      turns: [{ say: "What's on my shopping list?" }, { say: "Actually, stop. Just add apples.", bargeInMs: 1500 }],
      checks: [check.added("Shopping list", "Apples")],
    },
    {
      id: "goodbye",
      goal: "Say a short goodbye and hang up.",
      turns: [{ say: "Okay, that's everything. Thanks, bye." }],
      checks: [check.hungUp(), check.fewWords(8)],
    },
    // ── Messages from elsewhere, during the call (the live feed) ──
    {
      // A photo and Alfred's text reply land mid-call; the reply names the shoes.
      id: "live-photo",
      goal: "Mid-call, the user sends a photo by text and Alfred replies by text naming the shoes in it. Asked about them, say what the reply said, with no need to ask Alfred.",
      turns: [
        {
          rows: [texted("Thoughts on these?", { files: ["shoes.jpg"] }), replied(SHOES)],
          say: "What do you think of the ones I just sent you?",
        },
      ],
      checks: [check.said("the shoes by name", /clifton|hoka/i), check.notAskedAlfred(), check.quietOnRows()],
    },
    {
      id: "live-text",
      goal: "Mid-call, the user texts (SMS) that they are out of eggs and want a reminder later, and Alfred replies by text that he will remind them. Asked what they just texted, say it was about eggs. Do nothing about it: the text got its own answer.",
      turns: [
        {
          rows: [texted("I'm out of eggs, remind me later", { via: "sms" }), replied("Noted. I'll remind you about eggs this evening.", { via: "sms" })],
          say: "What did I just text you?",
        },
      ],
      checks: [check.said("eggs", /\beggs?\b/i), check.notAskedAlfred(), check.changedNothing(), check.quietOnRows()],
    },
    {
      // The photo lands, but Alfred has not replied yet: only he can say what it shows.
      id: "live-photo-pending",
      goal: "Mid-call, the user sends a photo by text; Alfred has not replied yet. Asked about it, never guess what it shows: ask Alfred (use_tools waits for his look at it), then say what he said.",
      turns: [{ rows: [texted("Thoughts on these?", { files: ["shoes.jpg"] })], say: "What do you think of the ones I just sent you?" }],
      alfred: [PHOTO, ...ALFRED],
      checks: [
        // A voice told nothing also asks Alfred about "the ones I just sent".
        check.told("of the photo", /\bsent a photo\b/),
        check.noGuess("what the photo shows", SHOE_WORDS),
        check.askedAlfred("about the photo", /\b(photo|picture|image|pic|sent|these|ones|shoes?)\b/i),
        check.said("the shoes, once Alfred said", /clifton|hoka/i),
        check.quietOnRows(),
      ],
    },
    // ── What the voice knows as the call starts (the briefing) ──
    {
      // Texted an hour before the call; the voice should just know.
      id: "brief-pasta",
      goal: "An hour before the call, the user texted that they are cooking pasta tonight. Asked what they are making tonight, say pasta, from what the call started with: no tool, no asking Alfred.",
      briefing: {
        ...BACKGROUND,
        rows: [...MORNING, at("09:00", texted("I'm cooking pasta tonight")), at("09:00", replied("Sounds good. Enjoy your dinner."))],
      },
      turns: [{ say: "What am I making tonight?" }],
      checks: [check.said("pasta", /\bpasta\b/i), check.noTools()],
    },
    {
      // Call A added kale under Greens; call B goes on with the same list. The
      // caller names the section: the notion tool nests a line only then, so
      // "add spinach to the list we were adding to" rightly put it at the end
      // of the list. Which list's greens, only the briefing says.
      id: "brief-last-call",
      goal: "A call 20 minutes ago added a Greens section with kale to the shopping list. Now 'add spinach to the greens on the list we were adding to': add spinach under Greens on the shopping list, with the kale (not the Garden list, which has Greens too), directly in Notion, without asking Alfred or the caller which list.",
      briefing: { ...BACKGROUND, rows: [...MORNING, ...EARLIER_CALL] },
      world: worldWith("Shopping list", AFTER_EARLIER_CALL, [GARDEN]),
      turns: [{ say: "Add spinach to the greens on the list we were adding to." }],
      checks: [
        // The Garden list has Greens too: only the briefing says which list.
        check.briefed("the last call's kale under Greens", 'you did (on the call): added "Kale" under "Greens" (Notion page "Shopping list")'),
        check.added("Shopping list", "Spinach"),
        check.under("Shopping list", "Greens", "Spinach"),
        check.notAskedAlfred(),
      ],
    },
    {
      // An SMS this morning; the calendar does not have it.
      id: "brief-dentist",
      goal: `This morning the user texted (SMS) that the dentist is ${dentistDay} at 3. Asked when the dentist is, say ${dentistDay} at 3, from what the call started with: no tool, not the calendar.`,
      briefing: {
        ...BACKGROUND,
        rows: [...MORNING, at("08:30", texted(`The dentist is ${dentistDay} at 3.`, { via: "sms" })), at("08:30", replied("Noted.", { via: "sms" }))],
      },
      turns: [{ say: "When's the dentist?" }],
      checks: [check.said(dentistDay, new RegExp(`\\b${dentistDay}\\b`, "i")), check.said("3 o'clock", /\b(3|three)\b/i), check.noTools()],
    },
    {
      // The briefing says what the list held two hours ago; it has more now.
      // Answered from the briefing, the caller would miss the kefir and eggs.
      id: "brief-stale-list",
      goal: "Two hours ago, by text, the user was told the shopping list was milk, butter and limes; it has changed since. Asked what's on the list, read it fresh in Notion and say what is on it now, kefir and eggs included.",
      briefing: {
        ...BACKGROUND,
        rows: [...MORNING, at("08:20", texted("What's on my shopping list?")), at("08:20", replied("Milk, butter and limes."))],
      },
      turns: [{ say: "What's on my shopping list?" }],
      checks: [check.read("notion", "the list"), check.said("kefir", /\bkefir\b/i), check.said("eggs", /\beggs?\b/i), check.notAskedAlfred()],
    },
    {
      // Memory has the gym on tomorrow's weekday, but not the call with Mom:
      // only the calendar has the whole day.
      id: "brief-calendar-fresh",
      goal: `Memory says the gym is on ${weekday(1)}s at 7. Asked what's on tomorrow (${weekday(1)}), read the calendar, not just memory, and say both the gym at 7 and the call with Mom at 6 PM.`,
      briefing: { ...BACKGROUND, memory: `${BACKGROUND.memory}\n- Gym on ${weekday(1)}s at 7 AM.`, rows: MORNING },
      turns: [{ say: "What do I have tomorrow?" }],
      checks: [check.read("calendar", "the calendar"), check.saidAll(["gym", "mom/mum"]), check.notAskedAlfred()],
    },
  ];

  for (const s of scenarios) {
    s.world ||= world();
    s.alfred ||= ALFRED;
    s.briefing ||= EVERYDAY;
    s.day = day;
    s.now = now;
  }
  return { scenarios, everyday: EVERYDAY };
}
