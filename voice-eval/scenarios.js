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
// The clock in every call is Wednesday 2 December 2026, 10:00 AM Eastern
// (openai-call.js), so "tomorrow" is Thursday the 3rd and "Friday" the 4th.

import path from "node:path";
import { attachmentName } from "../dailies.js";
import { inboundRow } from "../ledger.js";

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

const ET = "-05:00";
const EVENTS = [
  { summary: "Lab meeting", start: `2026-12-02T14:00:00${ET}`, end: `2026-12-02T15:00:00${ET}` },
  { summary: "Gym", start: `2026-12-03T07:00:00${ET}`, end: `2026-12-03T08:00:00${ET}` },
  { summary: "Call with Mom", start: `2026-12-03T18:00:00${ET}`, end: `2026-12-03T18:30:00${ET}` },
  { summary: "Thesis review", start: `2026-12-04T11:00:00${ET}`, end: `2026-12-04T12:00:00${ET}`, guests: ["advisor@example.edu"] },
];

// What is on the computer: Alfred's own to-do file in his folder.
const COMPUTER = {
  todo: ["Reminders and scheduled tasks (being built now)", "Connect to the KO systems on the computer"],
};

const world = () => ({ pages: PAGES, events: EVENTS, computer: COMPUTER });

// ── Messages from elsewhere, during the call ─────────────────────────────────
// Rows as bot.js writes them: the user's message through the same inboundRow,
// with its files saved in the day's folder, and Alfred's reply.

const AGENT_DIR = "/eval/agent";
const DAY_DIR = path.join(AGENT_DIR, "var", "memories", "dailies", "2026-12-02");
const WHO = { discord: { tag: "kuba", id: "1", channel: "c1" }, sms: { tag: "sms:+10000000000", id: "+10000000000", channel: "sms" } };

const texted = (text, { via = "discord", files = [] } = {}) =>
  inboundRow({ who: WHO[via], via, text, agentDir: AGENT_DIR, attachments: files.map((f, i) => path.join(DAY_DIR, attachmentName("1", i, f))) });
const replied = (text, { via = "discord" } = {}) => ({ dir: "out", via, kind: "reply", text, files: 0 });

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
  saidAll: (words) => ({
    name: `named ${words.join(", ")}`,
    test: (r) => words.every((w) => new RegExp(`\\b${w}`, "i").test(allVoice(r))),
  }),
  askedAlfred: (label, re = /./) => ({
    name: `asked Alfred (use_tools) ${label}`,
    test: (r) => useTools(r).some((u) => re.test(u.request)),
  }),
  notAskedAlfred: () => ({ name: "did it without Alfred", test: (r) => useTools(r).length === 0 }),
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

export const SCENARIOS = [
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
    goal: "Say what's on the calendar tomorrow (Thursday): gym at 7 and the call with Mom at 6 PM.",
    turns: [{ say: "What do I have tomorrow?" }],
    checks: [check.saidAll(["gym", "mom"]), check.notAskedAlfred()],
  },
  {
    id: "calendar-add",
    goal: "Add a one-hour dentist appointment this Friday (Dec 4) at 3 PM.",
    turns: [{ say: "Put the dentist on my calendar Friday at 3 for an hour." }],
    checks: [check.event("dentist on Friday at 3 PM", (e) => /dentist/i.test(e.summary) && e.start.startsWith("2026-12-04T15:00"))],
  },
  {
    id: "calendar-move",
    goal: "Move today's lab meeting one hour later (3 to 4 PM).",
    turns: [{ say: "Push my lab meeting back an hour." }],
    checks: [check.event("lab meeting now 3–4 PM", (e) => /lab meeting/i.test(e.summary) && e.start.startsWith("2026-12-02T15:00"))],
  },
  {
    id: "multi-request",
    goal: "Add bread to the shopping list AND say what's on tomorrow's calendar, in one turn.",
    turns: [{ say: "Add bread to the shopping list, and what's on my calendar tomorrow?" }],
    checks: [check.added("Shopping list", "Bread"), check.saidAll(["gym", "mom"])],
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
      check.noGuess("what the photo shows", SHOE_WORDS),
      check.askedAlfred("about the photo", /\b(photo|picture|image|pic|sent|these|ones|shoes?)\b/i),
      check.said("the shoes, once Alfred said", /clifton|hoka/i),
      check.quietOnRows(),
    ],
  },
];

for (const s of SCENARIOS) {
  s.world ||= world();
  s.alfred ||= ALFRED;
}
