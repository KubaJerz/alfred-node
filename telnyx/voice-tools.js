// Direct tools for the 2B voice: Notion, the calendar and the time, done in
// about a second instead of a 6–9 s trip through Alfred (use_tools).
//
// They call the same broker routes Alfred's CLIs use, in process, so the same
// guards hold: no comments, no page deletes, no property overwrites (those stay
// with Alfred, who reports the old value), no calendar guests, no deleting an
// event that has guests.
//
// Lines and events are addressed by number. `read` numbers a page's lines (or a
// day's events); a write names a number from the latest read in this call, and
// the tool maps it to the real id. A write re-reads the page and returns the new
// numbering, so the voice never works from numbers a write has shifted.
//
// Every write calls `note` with one plain line, so Alfred learns what the voice
// did without him (see bot.js).

import { blockLine, markdownToBlocks } from "../notion/blocks.js";
import { TIMEZONE } from "../google/calendar-rules.js";

const NOTION_ACTIONS = ["search", "read", "add", "check", "uncheck", "edit", "remove", "create"];
const CALENDAR_ACTIONS = ["read", "add", "edit", "delete"];
const COLORS = ["banana", "tomato", "peacock", "grape", "basil", "tangerine"];

export const NOTION_TOOL = {
  type: "function",
  name: "notion",
  description:
    "The user's Notion pages: lists (like the shopping list), notes and ideas. Read a page before changing it; " +
    "lines are numbered, and a change names the line number. To add under a section, give its line number as " +
    "'under'. To make a new section, add the section line first, then add under it.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: NOTION_ACTIONS },
      page: { type: "string", description: "The page title, e.g. Shopping list. For search: words in the title." },
      line: { type: "integer", description: "check, uncheck, edit, remove: the line number from the last read." },
      under: { type: "integer", description: "add: put the items under this line." },
      items: { type: "array", items: { type: "string" }, description: "add, create: the lines to add, one per item." },
      text: { type: "string", description: "edit: the line's new text. create: the new page's title." },
    },
    required: ["action"],
  },
};

export const CALENDAR_TOOL = {
  type: "function",
  name: "calendar",
  description:
    "The user's Google Calendar. Times are Eastern, written like 2026-11-27T15:00; a date alone (2026-11-27) is all " +
    "day. Read a day before editing or deleting; events are numbered, and each change returns the day renumbered. " +
    "Never guess a time: ask. Colors: banana " +
    "school, tomato important personal, peacock general, grape AI Institute, basil Leo's group, tangerine Valafar lab.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: CALENDAR_ACTIONS },
      from: { type: "string", description: "read: first day (or time)." },
      to: { type: "string", description: "read: last day, if more than one." },
      event: { type: "integer", description: "edit, delete: the event number from the last read." },
      title: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      location: { type: "string" },
      color: { type: "string", enum: COLORS },
    },
    required: ["action"],
  },
};

export const REMEMBER_TOOL = {
  type: "function",
  name: "remember",
  description:
    "Write down something the caller asks you to remember (a fact, a preference, something for later), so it is " +
    "kept after the call. Use their words.",
  parameters: {
    type: "object",
    properties: { text: { type: "string", description: "What to remember, as one sentence." } },
    required: ["text"],
  },
};

export const TIME_TOOL = {
  type: "function",
  name: "get_time",
  description: "The current date, weekday and time where the user is.",
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

// A page's blocks as numbered lines, children indented under their parent. A
// subpage is one line; its own content is a different page.
export function numberLines(blocks) {
  const lines = [];
  const map = new Map();
  const walk = (bs, depth) => {
    for (const b of bs || []) {
      const n = lines.length + 1;
      const text = blockLine(b);
      map.set(n, { id: b.id, type: b.type, text, children: b.children || [] });
      lines.push(`${n}. ${"  ".repeat(depth)}${text}`);
      if (b.type !== "child_page") walk(b.children, depth + 1);
    }
  };
  walk(blocks, 0);
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

function eventLine(n, e) {
  const day = (iso) => (iso || "").slice(0, 10);
  const time = (iso) => (iso && iso.length > 10 ? iso.slice(11, 16) : "");
  const when = time(e.start) ? `${day(e.start)} ${time(e.start)}–${time(e.end)}` : `${day(e.start)} all day`;
  return `${n}. ${when} ${e.summary || "(no title)"}${e.location ? ` @ ${e.location}` : ""}`;
}

// One call's tools. Page ids and the latest numbering live here, so they last
// the call and no longer.
export function makeVoiceTools({ notionRoutes, calendarRoutes, fetchBlockChildren, note = () => {}, now = () => new Date() }) {
  const pages = new Map(); // lower-case title → { id, title }
  const reads = new Map(); // page id → numbered-line map from the latest read
  let events = null; // number → event, from the latest calendar read
  let range = null; // the latest read's { from, to }, re-read after a change

  const route = async (routes, key, args) => {
    const r = await routes[key]({ params: new URLSearchParams(), body: {}, ...args });
    if (r?.error) throw new Error(r.error);
    return r;
  };
  const N = (key, args) => route(notionRoutes, key, args);
  const C = (key, args) => route(calendarRoutes, key, args);

  async function findPage(name) {
    if (!name?.trim()) throw new Error("say which page");
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
    const numbered = numberLines(await fetchBlockChildren(page.id));
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

  // After a write: what happened, the note for Alfred, and the page renumbered.
  async function wrote(page, done) {
    note(`${done} (Notion page "${page.title}")`);
    return `Done: ${done}.\n\n${await readPage(page)}`;
  }

  async function notion(a) {
    const action = a.action;
    if (action === "search") {
      const { results } = await N("GET /notion/search", { params: params({ q: a.page || a.text || "", limit: 10 }) });
      if (!results.length) return "Nothing shared matches that.";
      return results.map((r) => `${r.title}${r.object === "database" ? " (database: ask use_tools)" : ""}`).join("\n");
    }
    const page = await findPage(a.page);
    if (action === "read") return readPage(page);

    if (action === "add") {
      const items = (a.items || []).map(String).map((s) => s.trim()).filter(Boolean);
      if (!items.length) throw new Error("give the items to add");
      let parentId = page.id;
      let style;
      let where = "";
      if (a.under) {
        const under = lineOf(page, a.under);
        parentId = under.id;
        style = under.children.find((c) => c.type !== "child_page")?.type || under.type;
        where = ` under "${words(under.text)}"`;
      } else {
        const top = reads.get(page.id)
          ? [...reads.get(page.id).values()]
          : (await fetchBlockChildren(page.id)).map((b) => ({ type: b.type }));
        style = top.filter((l) => l.type !== "child_page").at(-1)?.type;
      }
      const markdown = items.map((i) => lineFor(i, style)).join("\n");
      await N("POST /notion/append", { params: params({ id: parentId }), body: { markdown } });
      return wrote(page, `added ${quoted(items)}${where}`);
    }

    if (action === "check" || action === "uncheck") {
      const line = lineOf(page, a.line);
      const r = await N("PATCH /notion/block", { params: params({ id: line.id }), body: { checked: action === "check" } });
      return wrote(page, `${action === "check" ? "checked off" : "unchecked"} "${words(r.to)}"`);
    }

    if (action === "edit") {
      const line = lineOf(page, a.line);
      if (!a.text?.trim()) throw new Error("give the new text");
      // Keep the line's kind: a checkbox stays a checkbox, with its tick.
      const ticked = /^- \[x\]/.test(line.text);
      const markdown = line.type === "to_do" ? `- [${ticked ? "x" : " "}] ${a.text.trim()}` : lineFor(a.text, line.type);
      const r = await N("PATCH /notion/block", { params: params({ id: line.id }), body: { markdown } });
      return wrote(page, `changed "${words(r.from)}" to "${words(r.to)}"`);
    }

    if (action === "remove") {
      const line = lineOf(page, a.line);
      const r = await N("DELETE /notion/block", { params: params({ id: line.id }) });
      const extra = r.hasChildren ? " and the lines under it" : "";
      return wrote(page, `removed "${words(r.removed)}"${extra} (it is in Notion's Trash)`);
    }

    if (action === "create") {
      if (!a.text?.trim()) throw new Error("give the new page's title");
      const items = (a.items || []).map(String).map((s) => s.trim()).filter(Boolean);
      const r = await N("POST /notion/page", {
        body: { page: page.id, title: a.text.trim(), markdown: items.map((i) => `- ${i}`).join("\n") || undefined },
      });
      pages.set(a.text.trim().toLowerCase(), { id: r.id, title: a.text.trim() }); // new pages are not searchable yet
      note(`made the Notion page "${a.text.trim()}" under "${page.title}"`);
      return `Done: made the page "${a.text.trim()}" under "${page.title}".`;
    }
    throw new Error(`unknown action "${action}"`);
  }

  function eventOf(n) {
    if (!events) throw new Error("read the day first, so the event numbers are current");
    const e = events.get(Number(n));
    if (!e) throw new Error(`there is no event ${n} in the last read`);
    return e;
  }

  async function readRange() {
    const r = await C("GET /calendar/events", { params: params({ from: range.from, to: range.to, limit: 50 }) });
    events = new Map(r.events.map((e, i) => [i + 1, e]));
    if (!r.events.length) return `Nothing on the calendar from ${range.label}.`;
    return r.events.map((e, i) => eventLine(i + 1, e)).join("\n");
  }

  // After a change: what happened, and the last-read days renumbered, so the
  // next edit or delete works without another read.
  async function changed(done) {
    events = null; // the numbering has moved
    if (!range) return `Done: ${done}.`;
    return `Done: ${done}.\n\n${await readRange()}`;
  }

  async function calendar(a) {
    const action = a.action;
    if (action === "read") {
      if (!a.from) throw new Error("say which day");
      const to = a.to ? (a.to.length === 10 ? nextDay(a.to) : a.to) : a.from.length === 10 ? nextDay(a.from) : undefined;
      range = { from: a.from, to, label: a.to ? `${a.from} to ${a.to}` : a.from };
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
      return changed(done);
    }

    if (action === "edit") {
      const e = eventOf(a.event);
      const body = {};
      for (const [k, v] of [["summary", a.title], ["start", withSeconds(a.start)], ["end", withSeconds(a.end)], ["location", a.location], ["color", a.color]]) {
        if (v) body[k] = v;
      }
      if (!Object.keys(body).length) throw new Error("say what to change");
      await C("PATCH /calendar/events", { params: params({ id: e.id }), body });
      const done = `changed "${e.summary}" (${Object.entries(body).map(([k, v]) => `${k} ${v}`).join(", ")})`;
      note(`${done} on the calendar`);
      return changed(done);
    }

    if (action === "delete") {
      const e = eventOf(a.event);
      await C("DELETE /calendar/events", { params: params({ id: e.id }) });
      note(`deleted "${e.summary}" (${e.start}) from the calendar`);
      return changed(`deleted "${e.summary}" (it is in Google Calendar's Trash for 30 days)`);
    }
    throw new Error(`unknown action "${action}"`);
  }

  const run = {
    notion,
    calendar,
    get_time: async () => timeNow(now()),
    remember: async (a) => {
      const text = String(a.text || "").trim();
      if (!text) throw new Error("say what to remember");
      note(`was asked to remember: "${text}"`);
      return "Done: written down.";
    },
  };

  return {
    defs: [NOTION_TOOL, CALENDAR_TOOL, TIME_TOOL, REMEMBER_TOOL],
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
