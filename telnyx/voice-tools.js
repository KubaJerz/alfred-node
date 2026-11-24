// Direct tools for the 2B voice: Notion, the calendar and the time, done in
// about a second instead of a 6–9 s trip through Alfred (use_tools).
//
// They call the same broker routes Alfred's CLIs use, in process, so the same
// guards hold: no comments, no page deletes, no property overwrites (those stay
// with Alfred, who reports the old value), no calendar guests, no deleting an
// event that has guests.
//
// Lines and events are addressed by number, or by their words. `read` numbers a
// page's lines (or a day's events), and a number holds for the whole call: a
// line keeps it after other lines go or come, and a new line gets the next one.
// So several numbers from one read stay right however many changes follow.
// check, uncheck and remove take several lines in one call: every target is
// found first, then the writes run one after another, and the page is re-read
// once at the end.
//
// Every write calls `note` with one plain line, so Alfred learns what the voice
// did without him (see bot.js).

import { blockLine, markdownToBlocks } from "../notion/blocks.js";
import { TIMEZONE } from "../google/calendar-rules.js";

const NOTION_ACTIONS = ["search", "read", "add", "write", "check", "uncheck", "edit", "remove", "create"];
export const DEFAULT_HOME_PAGE = "Teamspace Home";
const CALENDAR_ACTIONS = ["read", "add", "edit", "delete"];
const COLORS = ["banana", "tomato", "peacock", "grape", "basil", "tangerine"];

export const NOTION_TOOL = {
  type: "function",
  name: "notion",
  description:
    "Quick. Before a change, say just \"Got it.\" or \"Will do.\"; nothing before a read. The user's Notion pages: lists, notes " +
    "and ideas. Name the page by its exact title; search only when unsure of it. Lines are numbered, and a number " +
    "stays the same all call. Several lines are one call: check, uncheck and remove take lines (numbers) or items " +
    "(the lines' words, no read needed). To add under a section, give its line number as 'under', or 'after' to " +
    "put them right after a line. add is for a few plain items; for a new sub-list, a heading with items, or " +
    "anything with structure, use write with markdown.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: NOTION_ACTIONS },
      page: {
        type: "string",
        description: "The page title, e.g. Shopping list. For search: words in the title. create: the page to put it inside, only if the caller names one; leave it out for a new page of its own.",
      },
      lines: { type: "array", items: { type: "integer" }, description: "check, uncheck, remove: line numbers, one or many." },
      line: { type: "integer", description: "edit: the line number (or give its words as items)." },
      under: { type: "integer", description: "add, write: put the new lines inside this line. Only when the caller names a section; otherwise leave it out and the lines go at the end of the page." },
      after: { type: "integer", description: "add, write: put the new lines right after this line, at its level." },
      markdown: {
        type: "string",
        description:
          "write: the lines, one per line. '- [ ] ' checkbox, '- ' bullet, '1. ' numbered, '## ' heading, '> ' quote, " +
          "plain text for a note. Indent 2 spaces to put a line inside the line above, at most 2 deep. A heading " +
          "holds nothing: put its items after it, not indented. Don't repeat the line you write under. Example, under " +
          "Greens: '- Temporary list\\n  - [ ] Milk'.",
      },
      items: {
        type: "array",
        items: { type: "string" },
        description: "add, create: the lines to add, one per item. check, uncheck, remove, edit: the lines' words, as the caller said them.",
      },
      text: { type: "string", description: "edit: the line's new text. create: the new page's title (required)." },
    },
    required: ["action"],
  },
};

export const CALENDAR_TOOL = {
  type: "function",
  name: "calendar",
  description:
    "Quick. Before a change, say just \"Got it.\" or \"Will do.\"; nothing before a read. The user's Google Calendar. Times are Eastern, written like 2026-11-27T15:00; a date alone (2026-11-27) is all " +
    "day. Events are numbered, and a number stays the same all call. Several events are one call: edit and delete " +
    "take events (numbers), or match (title words, with from as the day, no read needed). " +
    "Never guess a time: ask. Colors: banana " +
    "school, tomato important personal, peacock general, grape AI Institute, basil Leo's group, tangerine Valafar lab.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: CALENDAR_ACTIONS },
      from: { type: "string", description: "read: first day (or time)." },
      to: { type: "string", description: "read: last day, if more than one." },
      events: { type: "array", items: { type: "integer" }, description: "edit, delete: event numbers, one or many." },
      match: { type: "string", description: "edit, delete: words of the event's title, instead of numbers. Give from too." },
      title: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      location: { type: "string" },
      color: { type: "string", enum: COLORS },
    },
    required: ["action"],
  },
};

export const TIME_TOOL = {
  type: "function",
  name: "get_time",
  description: "Quick: call it without saying anything first. The current date, weekday and time where the user is.",
  parameters: { type: "object", properties: {} },
};

export function timeNow(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date) + " (Eastern)";
}

// The day after a YYYY-MM-DD date, as YYYY-MM-DD.
export function nextDay(date) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// A number that holds for the whole call: an id keeps the number it got first.
export const numbering = () => ({ byId: new Map(), next: 1 });
const numberOf = (nums, id) => {
  if (!nums.byId.has(id)) nums.byId.set(id, nums.next++);
  return nums.byId.get(id);
};

// A page's blocks as numbered lines, children indented under their parent. A
// subpage is one line; its own content is a different page. With `nums`, the
// call's numbering, a line keeps its number across reads (gaps where lines
// went); without it, lines are numbered from 1.
export function numberLines(blocks, nums = numbering()) {
  const lines = [];
  const map = new Map();
  const walk = (bs, depth, parentId) => {
    for (const b of bs || []) {
      const n = numberOf(nums, b.id);
      const text = blockLine(b);
      map.set(n, { id: b.id, type: b.type, text, children: b.children || [], parentId });
      lines.push(`${n}. ${"  ".repeat(depth)}${text}`);
      if (b.type !== "child_page") walk(b.children, depth + 1, b.id);
    }
  };
  walk(blocks, 0, null); // a top-level line's parent is the page
  return { text: lines.join("\n") || "(the page is empty)", map };
}

// A new line takes the style of its neighbours: a checkbox list gets checkboxes.
function lineFor(item, styleType) {
  const t = String(item).trim();
  if (styleType === "to_do") return `- [ ] ${t}`;
  if (styleType === "bulleted_list_item") return `- ${t}`;
  if (styleType === "numbered_list_item") return `1. ${t}`;
  return t;
}

// Google rejects a dateTime without seconds ("2026-11-27T15:00").
export const withSeconds = (t) => (t && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t) ? `${t}:00` : t);

const params = (o) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(v)]));
// A line's words without its list marker, for notes and replies.
const words = (line) => line.replace(/^[-*] (\[[ x]\] )?|^\d+\. |^#+ /, "").trim();
const quoted = (list) => list.map((s) => `"${s}"`).join(", ");
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Whole words, with or without a plural s: "egg" finds "Eggs".
const wordsRe = (term) => new RegExp(`\\b${escape(term.trim().replace(/s$/i, ""))}s?\\b`, "i");

// Numbers from `lines` (or one `line`/`event`), as integers.
const numbersIn = (many, one) => [...(Array.isArray(many) ? many : []), ...(one ? [one] : [])].map(Number);
const termsIn = (items) => (Array.isArray(items) ? items : []).map(String).map((t) => t.trim()).filter(Boolean);

// A batch's answer, in plain words: "Done: removed …" when every target went;
// what went, then what did not, when some did; an error when none did.
function batchAnswer(verb, done, missing, tail = "") {
  if (!done.length) throw new Error(missing.join("; ") || `nothing to ${verb}`);
  const what = `${verb} ${quoted(done)}${tail}`;
  return { what, head: missing.length ? `${cap(what)}. ${missing.map(cap).join(". ")}.` : `Done: ${what}.` };
}

function eventLine(n, e) {
  const day = (iso) => (iso || "").slice(0, 10);
  const time = (iso) => (iso && iso.length > 10 ? iso.slice(11, 16) : "");
  const when = time(e.start) ? `${day(e.start)} ${time(e.start)}–${time(e.end)}` : `${day(e.start)} all day`;
  return `${n}. ${when} ${e.summary || "(no title)"}${e.location ? ` @ ${e.location}` : ""}`;
}

// One call's tools. Page ids and the latest numbering live here, so they last
// the call and no longer.
// homePage: where a new page goes when the caller names no parent. Notion lets
// an internal integration create a page only inside a page shared with it, so
// a "new page of its own" lives in the top shared page.
export function makeVoiceTools({
  notionRoutes,
  calendarRoutes,
  fetchBlockChildren,
  note = () => {},
  now = () => new Date(),
  homePage = DEFAULT_HOME_PAGE,
}) {
  const pages = new Map(); // lower-case title → { id, title }
  const reads = new Map(); // page id → numbered-line map from the latest read
  const nums = new Map(); // page id → the call's numbering for its lines
  let events = null; // number → event, from the latest calendar read
  const eventNums = numbering(); // event id → its number, for the whole call
  let range = null; // the latest read's { from, to }, re-read after a change

  // One tool call at a time: parallel calls from one reply would otherwise
  // re-read and write the same page at once.
  let busy = Promise.resolve();
  const serial = (fn) => (a) => {
    const p = busy.then(() => fn(a));
    busy = p.catch(() => {});
    return p;
  };

  const route = async (routes, key, args) => {
    const r = await routes[key]({ params: new URLSearchParams(), body: {}, ...args });
    if (r?.error) throw new Error(r.error);
    return r;
  };
  const N = (key, args) => route(notionRoutes, key, args);
  const C = (key, args) => route(calendarRoutes, key, args);

  async function findPage(name) {
    if (!name?.trim()) throw new Error("say which page, by its exact title");
    const key = name.trim().toLowerCase();
    if (pages.has(key)) return pages.get(key);
    // Exact title only. Notion's search is fuzzy and its index lags new pages,
    // so its top hit can be a different page; a write there lands on the wrong
    // page. Anything short of an exact title gets the candidates back instead.
    const { results } = await N("GET /notion/search", { params: params({ q: name, type: "page" }) });
    const hits = results.filter((r) => r.title.trim().toLowerCase() === key);
    if (hits.length > 1) throw new Error(`more than one page is called "${name}"; ask use_tools`);
    const hit = hits[0];
    if (!hit) {
      const near = results.slice(0, 5).map((r) => `"${r.title}"`).join(", ");
      throw new Error(`no page is called exactly "${name}"${near ? `. Close titles: ${near}` : ""}. Use the exact title`);
    }
    const page = { id: hit.id, title: hit.title };
    pages.set(key, page);
    pages.set(hit.title.toLowerCase(), page);
    return page;
  }

  async function readPage(page) {
    if (!nums.has(page.id)) nums.set(page.id, numbering());
    const numbered = numberLines(await fetchBlockChildren(page.id), nums.get(page.id));
    reads.set(page.id, numbered.map);
    return `Page "${page.title}":\n${numbered.text}`;
  }

  function lineOf(page, n) {
    const map = reads.get(page.id);
    if (!map) throw new Error(`read "${page.title}" first, so the line numbers are current`);
    const line = map.get(Number(n));
    if (!line) throw new Error(`"${page.title}" has no line ${n}`);
    return line;
  }

  // The line a caller's words name. An exact match wins (the first one not
  // already taken, so "bread" twice takes both copies); else the one line that
  // has the words. Several → ask which.
  function matchLine(page, term, taken) {
    const open = [...reads.get(page.id).values()].filter((l) => !taken.has(l.id) && l.type !== "child_page");
    const plain = (l) => words(l.text).toLowerCase();
    const exact = open.find((l) => plain(l) === term.toLowerCase());
    if (exact) return { line: exact };
    const re = wordsRe(term);
    const near = open.filter((l) => re.test(plain(l)));
    if (near.length === 1) return { line: near[0] };
    if (near.length) return { why: `"${term}" could be ${near.slice(0, 3).map((l) => `"${words(l.text)}"`).join(" or ")}; say which` };
    return { why: `no line says "${term}"` };
  }

  // The lines a change names, by number and by words, all found before
  // anything changes. Words need no read; numbers need one from this call.
  async function targets(page, a) {
    const numbers = numbersIn(a.lines, a.line);
    const terms = termsIn(a.items);
    if (!numbers.length && !terms.length) throw new Error("say which lines, by number or by their words");
    if (numbers.length && !reads.has(page.id)) throw new Error(`read "${page.title}" first, or give the lines' words as items`);
    if (!reads.has(page.id)) await readPage(page);
    const found = new Map();
    const missing = [];
    for (const n of numbers) {
      const line = reads.get(page.id).get(n);
      if (line) found.set(line.id, line);
      else missing.push(`no line ${n}`);
    }
    for (const t of terms) {
      const r = matchLine(page, t, found);
      if (r.line) found.set(r.line.id, r.line);
      else missing.push(r.why);
    }
    return { lines: [...found.values()], missing };
  }

  // Where new lines go: inside a line (`under`), right after one (`after`), or
  // at the end of the page. A heading holds no children in Notion, so "under a
  // heading" means the end of its section: after the last line before the next
  // heading at its level. `style` is the line kind to copy for plain items.
  async function place(page, a) {
    if (a.after) {
      const line = lineOf(page, a.after);
      return { parentId: line.parentId || page.id, after: line.id, style: line.type, where: ` after "${words(line.text)}"` };
    }
    if (a.under) {
      const line = lineOf(page, a.under);
      const where = ` under "${words(line.text)}"`;
      if (!/^heading_/.test(line.type)) {
        const style = line.children.find((c) => c.type !== "child_page")?.type || line.type;
        return { parentId: line.id, style, where };
      }
      const siblings = [...reads.get(page.id).values()].filter((l) => l.parentId === line.parentId);
      const section = siblings.slice(siblings.indexOf(line) + 1);
      const end = section.findIndex((l) => /^heading_/.test(l.type));
      const body = end === -1 ? section : section.slice(0, end);
      const last = body.at(-1) || line;
      return {
        parentId: line.parentId || page.id,
        after: last.id,
        style: body.find((l) => l.type !== "child_page")?.type,
        where,
      };
    }
    const top = reads.get(page.id)
      ? [...reads.get(page.id).values()].filter((l) => !l.parentId)
      : (await fetchBlockChildren(page.id)).map((b) => ({ type: b.type }));
    return { parentId: page.id, style: top.filter((l) => l.type !== "child_page").at(-1)?.type, where: "" };
  }

  // After a write: what happened, the note for Alfred, and the page renumbered.
  async function wrote(page, done) {
    note(`${done} (Notion page "${page.title}")`);
    return `Done: ${done}.\n\n${await readPage(page)}`;
  }

  let lastPage = null; // the page this call last read or changed

  async function notion(a) {
    const action = a.action;
    if (action === "search") {
      const { results } = await N("GET /notion/search", { params: params({ q: a.page || a.text || "", limit: 10 }) });
      if (!results.length) return "Nothing shared matches that.";
      return results.map((r) => `${r.title}${r.object === "database" ? " (database: ask use_tools)" : ""}`).join("\n");
    }
    // The model often names the page on the read and drops it on the change
    // that follows; the page it last read is the one it means.
    // A new page goes inside the page named, or else the home page, never
    // the page last read.
    if (action === "create") return create(a, await findPage(a.page?.trim() || homePage));
    const page = !a.page?.trim() && lastPage ? lastPage : await findPage(a.page);
    lastPage = page;
    if (action === "read") return readPage(page);

    if (action === "add" || action === "write") {
      if (a.line && !a.under && !a.after) a = { ...a, under: a.line }; // the model sometimes says line for under
      let markdown, what;
      const spot = await place(page, a);
      if (action === "add") {
        const items = (a.items || []).map(String).map((s) => s.trim()).filter(Boolean);
        if (!items.length) throw new Error("give the items to add");
        markdown = items.map((i) => lineFor(i, spot.style)).join("\n");
        what = quoted(items);
      } else {
        markdown = String(a.markdown || "").replace(/\s+$/, "");
        if (!markdown.trim()) throw new Error("give the markdown to write");
        what = quoted(markdown.split("\n").map((l) => words(l.trim())).filter(Boolean));
      }
      await N("POST /notion/append", { params: params({ id: spot.parentId }), body: { markdown, after: spot.after } });
      return wrote(page, `added ${what}${spot.where}`);
    }

    if (action === "check" || action === "uncheck" || action === "remove") {
      const { lines, missing } = await targets(page, a);
      const done = [];
      let under = false;
      for (const line of lines) {
        try {
          if (action === "remove") {
            const r = await N("DELETE /notion/block", { params: params({ id: line.id }) });
            done.push(words(r.removed));
            under ||= r.hasChildren;
          } else {
            const r = await N("PATCH /notion/block", { params: params({ id: line.id }), body: { checked: action === "check" } });
            done.push(words(r.to));
          }
        } catch (err) {
          missing.push(`"${words(line.text)}" failed: ${err.message}`);
        }
      }
      const verb = { check: "checked off", uncheck: "unchecked", remove: "removed" }[action];
      const tail = action === "remove" ? `${under ? (done.length > 1 ? " and the lines under them" : " and the lines under it") : ""} (in Notion's Trash)` : "";
      const { what, head } = batchAnswer(verb, done, missing, tail);
      note(`${what} (Notion page "${page.title}")`);
      return `${head}\n\n${await readPage(page)}`;
    }

    if (action === "edit") {
      if (!a.text?.trim()) throw new Error("give the new text");
      const { lines, missing } = await targets(page, { line: a.line, items: (a.items || []).slice(0, 1) });
      if (!lines.length) throw new Error(missing.join("; "));
      const line = lines[0];
      // Keep the line's kind: a checkbox stays a checkbox, with its tick.
      const ticked = /^- \[x\]/.test(line.text);
      const markdown = line.type === "to_do" ? `- [${ticked ? "x" : " "}] ${a.text.trim()}` : lineFor(a.text, line.type);
      const r = await N("PATCH /notion/block", { params: params({ id: line.id }), body: { markdown } });
      return wrote(page, `changed "${words(r.from)}" to "${words(r.to)}"`);
    }

    throw new Error(`unknown action "${action}"`);
  }

  async function create(a, page) {
    const title = a.text?.trim();
    if (!title) throw new Error("give the new page's title as text");
    const items = (a.items || []).map(String).map((s) => s.trim()).filter(Boolean);
    const r = await N("POST /notion/page", {
      body: { page: page.id, title, markdown: items.map((i) => `- ${i}`).join("\n") || undefined },
    });
    const made = { id: r.id, title };
    pages.set(title.toLowerCase(), made); // new pages are not searchable yet
    lastPage = made;
    note(`made the Notion page "${title}" under "${page.title}"`);
    const where = page.title.toLowerCase() === homePage.toLowerCase() ? "" : ` under "${page.title}"`;
    return `Done: made the page "${title}"${where}.`;
  }

  const setRange = (from, to) => {
    const end = to ? (to.length === 10 ? nextDay(to) : to) : from.length === 10 ? nextDay(from) : undefined;
    range = { from, to: end, label: to ? `${from} to ${to}` : from };
  };

  async function readRange() {
    const r = await C("GET /calendar/events", { params: params({ from: range.from, to: range.to, limit: 50 }) });
    events = new Map();
    if (!r.events.length) return `Nothing on the calendar from ${range.label}.`;
    return r.events
      .map((e) => {
        const n = numberOf(eventNums, e.id);
        events.set(n, e);
        return eventLine(n, e);
      })
      .join("\n");
  }

  // The events a change names: numbers from a read, or `match`, title words
  // on the day `from` (read here, no separate read needed).
  async function eventTargets(a) {
    if (a.match?.trim()) {
      if (a.from) {
        setRange(a.from, a.to);
        await readRange();
      }
      if (!events) throw new Error("give from, the day of the event");
      const re = wordsRe(a.match);
      const hits = [...events.values()].filter((e) => re.test(e.summary || ""));
      if (!hits.length) throw new Error(`no event called "${a.match.trim()}" on ${range.label}`);
      if (hits.length > 1 && !numbersIn(a.events, a.event).length) {
        const which = [...events.entries()].filter(([, e]) => hits.includes(e)).map(([n, e]) => eventLine(n, e));
        throw new Error(`"${a.match.trim()}" could be:\n${which.join("\n")}\nsay which by number`);
      }
      return { list: hits, missing: [] };
    }
    const numbers = numbersIn(a.events, a.event);
    if (!numbers.length) throw new Error("say which event, by number or match");
    if (!events) throw new Error("read the day first, or give match and from");
    const list = [];
    const missing = [];
    for (const n of numbers) {
      const e = events.get(n);
      if (e && !list.includes(e)) list.push(e);
      else if (!e) missing.push(`no event ${n}`);
    }
    return { list, missing };
  }

  // After a change: what happened, and the last-read days again (numbers kept),
  // so the next edit or delete works without another read.
  async function changed(head) {
    if (!range) return head;
    return `${head}\n\n${await readRange()}`;
  }

  async function calendar(a) {
    const action = a.action;
    if (action === "read") {
      if (!a.from) throw new Error("say which day");
      setRange(a.from, a.to);
      return readRange();
    }

    if (action === "add") {
      if (!a.title || !a.start) throw new Error("give a title and a start");
      const end = a.end || (a.start.length === 10 ? nextDay(a.start) : null);
      if (!end) throw new Error("give an end time, or ask the caller how long it is");
      const body = { summary: a.title, start: withSeconds(a.start), end: withSeconds(end), location: a.location, color: a.color };
      await C("POST /calendar/events", { body });
      const done = `added "${a.title}" on ${a.start}${a.start.length > 10 ? `–${end.slice(11, 16)}` : " (all day)"}`;
      note(`${done} to the calendar`);
      return changed(`Done: ${done}.`);
    }

    if (action === "edit") {
      const body = {};
      for (const [k, v] of [["summary", a.title], ["start", withSeconds(a.start)], ["end", withSeconds(a.end)], ["location", a.location], ["color", a.color]]) {
        if (v) body[k] = v;
      }
      if (!Object.keys(body).length) throw new Error("say what to change");
      const { list, missing } = await eventTargets(a);
      if (list.length > 1 && (body.start || body.end)) throw new Error("change times one event at a time");
      const done = [];
      for (const e of list) {
        try {
          await C("PATCH /calendar/events", { params: params({ id: e.id }), body });
          done.push(e.summary);
        } catch (err) {
          missing.push(`"${e.summary}" failed: ${err.message}`);
        }
      }
      const fields = Object.entries(body).map(([k, v]) => `${k} ${v}`).join(", ");
      const { what, head } = batchAnswer("changed", done, missing, ` (${fields})`);
      note(`${what} on the calendar`);
      return changed(head);
    }

    if (action === "delete") {
      const { list, missing } = await eventTargets(a);
      const done = [];
      for (const e of list) {
        try {
          await C("DELETE /calendar/events", { params: params({ id: e.id }) });
          done.push(e.summary);
        } catch (err) {
          missing.push(`"${e.summary}" was not deleted: ${err.message}`);
        }
      }
      const { what, head } = batchAnswer("deleted", done, missing, " (in Google Calendar's Trash for 30 days)");
      note(`${what} from the calendar`);
      return changed(head);
    }
    throw new Error(`unknown action "${action}"`);
  }

  const run = {
    notion: serial(notion),
    calendar: serial(calendar),
    get_time: async () => timeNow(now()),
  };

  return {
    defs: [NOTION_TOOL, CALENDAR_TOOL, TIME_TOOL],
    // The id of a page this call found or made, by title (for the smoke test).
    pageId: (title) => pages.get(String(title).trim().toLowerCase())?.id || null,
    names: Object.keys(run),
    // Never throws: an error becomes words the voice can say.
    async call(name, args) {
      try {
        return await run[name](args || {});
      } catch (err) {
        return `That didn't work: ${err.message}.`;
      }
    },
  };
}
