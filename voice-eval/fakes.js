// The world a test call runs in: Notion pages, calendar events and the
// computer Alfred works on, all in memory. The voice's direct tools
// (telnyx/voice-tools.js) run unchanged on top of these routes, so a test call
// exercises the same tool code a real call does; only the network is gone.
//
// Route shapes follow notion/broker.js and google/broker.js: the same params,
// bodies, answers and error strings the voice tools read.

import { markdownToBlocks, blockLine, blockUpdate } from "../notion/blocks.js";

// markdownToBlocks nests children inside the type object; the Notion API (and
// fetchBlockChildren) puts them on the block. Give every block an id too.
function normalize(blocks, nextId) {
  return blocks.map((b) => {
    const inner = b[b.type] || {};
    const { children, ...rest } = inner;
    const out = { id: nextId(), type: b.type, [b.type]: rest };
    if (children?.length) {
      out.has_children = true;
      out.children = normalize(children, nextId);
    }
    return out;
  });
}

// pages: [{ title, markdown, parent? }]. A page with a parent shows up as a
// subpage line on it.
export function fakeNotion(pages = []) {
  let n = 0;
  const nextId = () => `blk${++n}`;
  const byId = new Map(); // page id → { id, title, blocks }
  const calls = [];

  const addPage = (title, markdown = "", parentId = null) => {
    const id = `page${byId.size + 1}`;
    byId.set(id, { id, title, blocks: normalize(markdownToBlocks(markdown || ""), nextId) });
    if (parentId) byId.get(parentId).blocks.push({ id, type: "child_page", child_page: { title } });
    return id;
  };
  for (const p of pages) {
    const parent = p.parent ? [...byId.values()].find((x) => x.title === p.parent)?.id : null;
    addPage(p.title, p.markdown, parent);
  }

  // A block anywhere, with the list that holds it.
  const locate = (id) => {
    const walk = (list) => {
      for (const b of list) {
        if (b.id === id) return { block: b, list };
        if (b.children) {
          const hit = walk(b.children);
          if (hit) return hit;
        }
      }
    };
    for (const p of byId.values()) {
      const hit = walk(p.blocks);
      if (hit) return hit;
    }
    return null;
  };
  const err = (error, status = 400) => ({ error, status });

  const routes = {
    // Notion's search is fuzzy: any page whose title shares a word with the
    // query, best first. Like the real one, it returns near misses too.
    "GET /notion/search": async ({ params }) => {
      const q = (params.get("q") || "").toLowerCase().trim();
      calls.push(["search", q]);
      const words = q.split(/\W+/).filter((w) => w.length > 2);
      const scored = [...byId.values()]
        .map((p) => {
          const t = p.title.toLowerCase();
          const score = t === q ? 3 : t.includes(q) ? 2 : words.some((w) => t.includes(w)) ? 1 : 0;
          return { p, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      return { results: scored.map(({ p }) => ({ id: p.id, object: "page", title: p.title, url: "" })) };
    },
    "POST /notion/page": async ({ body }) => {
      calls.push(["create", body]);
      if (!body?.db && !body?.page) return err("a parent is required: db or page");
      if (!body.title) return err("title required");
      if (!byId.has(body.page)) return err("that page is not shared with the integration", 404);
      const id = addPage(body.title, body.markdown, body.page);
      return { id, url: "", title: body.title };
    },
    "POST /notion/append": async ({ params, body }) => {
      const id = params.get("id");
      calls.push(["append", id, body?.markdown, body?.after]);
      if (!body?.markdown) return err("markdown required");
      const blocks = normalize(markdownToBlocks(body.markdown), nextId);
      let list;
      if (byId.has(id)) list = byId.get(id).blocks;
      else {
        const hit = locate(id);
        if (!hit) return err("no such block", 404);
        hit.block.children ||= [];
        hit.block.has_children = true;
        list = hit.block.children;
      }
      const at = body.after ? list.findIndex((b) => b.id === body.after) + 1 : list.length;
      list.splice(at || list.length, 0, ...blocks);
      return { id, appended: blocks.length };
    },
    "PATCH /notion/block": async ({ params, body }) => {
      const id = params.get("id");
      calls.push(["patch", id, body]);
      const hit = locate(id);
      if (!hit) return err("no such block", 404);
      const b = hit.block;
      const from = blockLine(b);
      if (body?.markdown) {
        let parsed;
        try {
          parsed = blockUpdate(b.type, body.markdown);
        } catch (e) {
          return err(e.message);
        }
        b[b.type] = parsed[b.type];
      }
      if (body?.checked !== undefined) {
        if (b.type !== "to_do") return err(`checking applies to a to-do; that block is a ${b.type}`);
        b.to_do.checked = Boolean(body.checked);
      }
      return { id, from, to: blockLine(b) };
    },
    "DELETE /notion/block": async ({ params }) => {
      const id = params.get("id");
      calls.push(["delete", id]);
      const hit = locate(id);
      if (!hit) return err("no such block", 404);
      if (hit.block.type === "child_page") return err("deleting a page is not allowed from here", 403);
      hit.list.splice(hit.list.indexOf(hit.block), 1);
      return { id, removed: blockLine(hit.block), hasChildren: Boolean(hit.block.children?.length) };
    },
  };

  const fetchBlockChildren = async (id) => structuredClone(byId.get(id)?.blocks || locate(id)?.block.children || []);

  // A page as plain lines, children indented: what the checks read.
  const lines = (title) => {
    const p = [...byId.values()].find((x) => x.title.toLowerCase() === title.toLowerCase());
    if (!p) return null;
    const out = [];
    const walk = (list, depth) => {
      for (const b of list) {
        out.push({ text: blockLine(b), depth, checked: b.type === "to_do" ? b.to_do.checked : undefined });
        if (b.children && b.type !== "child_page") walk(b.children, depth + 1);
      }
    };
    walk(p.blocks, 0);
    return out;
  };
  const titles = () => [...byId.values()].map((p) => p.title);
  const dump = () =>
    Object.fromEntries([...byId.values()].map((p) => [p.title, lines(p.title).map((l) => `${"  ".repeat(l.depth)}${l.text}`)]));
  return { routes, fetchBlockChildren, calls, lines, titles, dump };
}

// events: [{ summary, start, end, location?, guests? }], times in ISO with offset.
export function fakeCalendar(events = []) {
  let n = 0;
  let list = events.map((e) => ({ id: `ev${++n}`, location: "", ...e }));
  const calls = [];
  const err = (error, status = 400) => ({ error, status });
  const routes = {
    "GET /calendar/events": async ({ params }) => {
      const from = params.get("from");
      const to = params.get("to");
      calls.push(["list", from, to]);
      const hits = list
        .filter((e) => (!from || e.end > from) && (!to || e.start < to))
        .sort((a, b) => (a.start < b.start ? -1 : 1));
      return { events: hits.map(({ guests, ...e }) => ({ ...e })) };
    },
    "POST /calendar/events": async ({ body }) => {
      calls.push(["add", body]);
      if (!body?.summary || !body.start || !body.end) return err("summary, start and end are required");
      const e = { id: `ev${++n}`, summary: body.summary, start: body.start, end: body.end, location: body.location || "" };
      list.push(e);
      return { id: e.id };
    },
    "PATCH /calendar/events": async ({ params, body }) => {
      const id = params.get("id");
      calls.push(["edit", id, body]);
      const e = list.find((x) => x.id === id);
      if (!e) return err("no such event", 404);
      for (const k of ["summary", "start", "end", "location"]) if (body?.[k] != null) e[k] = body[k];
      return { id };
    },
    "DELETE /calendar/events": async ({ params }) => {
      const id = params.get("id");
      calls.push(["delete", id]);
      const e = list.find((x) => x.id === id);
      if (!e) return err("no such event", 404);
      if (e.guests?.length) return err("that event has guests; ask Alfred", 403);
      list = list.filter((x) => x !== e);
      return { id };
    },
  };
  return { routes, calls, events: () => list.map((e) => ({ ...e })) };
}

// A stand-in for Alfred, who answers use_tools. Each handler is
// { match: RegExp, reply: string | (request, world) => string | Promise }, and
// world holds { computer, notion, calendar }, so a handler can change the same
// pages the voice's own tools see. The first
// match answers, after `delayMs` (a real Alfred turn takes 6–15 s). With no
// match the reply says what Alfred would have needed, so a test sees a vague
// request fail rather than pass by luck.
export function fakeAlfred({ handlers = [], delayMs = 4000, world = {} } = {}) {
  const requests = [];
  const onTurn = async ({ text }) => {
    const at = Date.now();
    const h = handlers.find((x) => x.match.test(text));
    const reply = h
      ? typeof h.reply === "function" ? await h.reply(text, world) : h.reply
      : "I wasn't sure what to do with that. Say what you need in one plain sentence.";
    await new Promise((r) => setTimeout(r, delayMs));
    requests.push({ request: text, reply, handled: Boolean(h), ms: Date.now() - at });
    return reply;
  };
  return { onTurn, requests, world };
}
