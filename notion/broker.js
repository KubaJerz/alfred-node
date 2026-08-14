// Notion routes for the credential broker. These mount on the same loopback
// server as the Google routes (bot.js merges them), so the agent reaches Notion
// with the same bearer token and base URL it already uses — one server, one
// secret. The design mirrors google/broker.js deliberately: a small set of
// operations, validated here where no prompt can talk them out of firing.
//
// What is deliberately absent, and why:
//
//   no comment route      A comment reaches other people and Notion exposes no
//                         way to delete one — it's the `send` of Notion. Same
//                         reasoning that keeps mail send unreachable.
//
//   no page delete/archive  Removing a *body block* is here (see below), but
//                         removing or archiving a whole *page* is not. Scope, not
//                         reversibility: a page is a bigger, rarer thing to take
//                         out, and the block routes cover the "check that off,
//                         fix that line, drop that line" the append-only surface
//                         couldn't. Page archive is the natural next add.
//
// The block edits (`PATCH`/`DELETE /notion/block`) address one body line by its
// own id, which `read`'s `ids` option surfaces. The sharp edge is the opposite
// of the intuition: `set` (a property overwrite) is irreversible and unlogged by
// Notion, while a block `DELETE` lands in Trash and is recoverable. So every
// in-place write here reads before it writes and reports the old value — the
// `from → to` a `set`/`edit` prints and the line a `remove` names are the undo
// the API otherwise doesn't give.

import { notion, fetchBlockChildren, appendBlocks, objectTitle } from "./client.js";
import { markdownToBlocks, blocksToMarkdown, blockUpdate, blockLine } from "./blocks.js";
import {
  readProperties,
  readProperty,
  titleKey,
  buildProperty,
  equalsFilter,
} from "./props.js";

// An expected Notion API error (page not shared, bad id) carries an HTTP status;
// surface it with that status instead of letting it hit the generic 500 handler,
// which would log a stack for what is really a 404. An error with no status is
// unexpected and is left to bubble.
const asRoute = (fn) => async (ctx) => {
  try {
    return await fn(ctx);
  } catch (err) {
    if (err.status) return { error: err.message, status: err.status };
    throw err;
  }
};

// A page or database's schema, i.e. its property definitions with types. Needed
// before any typed write, so the string "Done" becomes the right shape for a
// status vs. a checkbox.
async function databaseSchema(id) {
  const db = await notion("GET", `/databases/${id}`);
  return db.properties || {};
}

export const NOTION_ROUTES = {
  // Metadata only, like mail search — id, type, title, url, last edited. Bodies
  // and rows come from an explicit read/query, so a broad search can't pull a
  // workspace into the transcript.
  "GET /notion/search": asRoute(async ({ params }) => {
    const q = params.get("q") || "";
    const filterType = params.get("type"); // "page" | "database", optional
    const res = await notion("POST", "/search", {
      query: q,
      ...(filterType ? { filter: { property: "object", value: filterType } } : {}),
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: Math.min(Number(params.get("limit")) || 15, 50),
    });
    return {
      results: (res.results || []).map((r) => ({
        id: r.id,
        object: r.object,
        title: objectTitle(r) || "(untitled)",
        url: r.url || "",
        lastEdited: r.last_edited_time || "",
      })),
    };
  }),

  // One page: its properties (if it's a database row) and its body rendered to
  // markdown. The body is a recursive, paginated block walk, bounded in client.js.
  "GET /notion/page": asRoute(async ({ params }) => {
    const id = params.get("id");
    if (!id) return { error: "id required", status: 400 };
    const page = await notion("GET", `/pages/${id}`);
    const blocks = await fetchBlockChildren(id);
    // `ids` prefixes each line with its block id, the handle edit/check/remove
    // need. Off by default: the uuids are noise until a line is being changed.
    const withIds = Boolean(params.get("ids"));
    return {
      page: {
        id: page.id,
        title: objectTitle(page) || "(untitled)",
        url: page.url || "",
        properties: readProperties(page.properties),
        markdown: blocksToMarkdown(blocks, { ids: withIds }),
      },
    };
  }),

  // Rows of a database. The schema read serves double duty: it types the
  // optional equals-filter and it renders each row's properties.
  "GET /notion/db/query": asRoute(async ({ params }) => {
    const id = params.get("id");
    if (!id) return { error: "id required", status: 400 };
    const schema = await databaseSchema(id);

    let filter;
    const where = params.get("where");
    if (where) {
      const eq = where.indexOf("=");
      if (eq === -1) return { error: `--where wants NAME=VALUE, got "${where}"`, status: 400 };
      const name = where.slice(0, eq).trim();
      const value = where.slice(eq + 1);
      if (!schema[name]) return { error: `no property "${name}" on that database`, status: 400 };
      try {
        filter = equalsFilter(schema[name].type, value, name);
      } catch (err) {
        return { error: err.message, status: 400 };
      }
    }

    const res = await notion("POST", `/databases/${id}/query`, {
      ...(filter ? { filter } : {}),
      page_size: Math.min(Number(params.get("limit")) || 25, 100),
    });
    return {
      rows: (res.results || []).map((row) => ({
        id: row.id,
        title: objectTitle(row) || "(untitled)",
        url: row.url || "",
        properties: readProperties(row.properties),
      })),
    };
  }),

  // Create a page: a row in a database (--db) or a subpage under a page (--page).
  // Exactly one parent. A database row's typed columns are built against the live
  // schema; a subpage takes only a title (a plain page has no arbitrary columns).
  "POST /notion/page": asRoute(async ({ body }) => {
    const { db, page, title, properties, markdown } = body || {};
    if (!db && !page) return { error: "a parent is required: db or page", status: 400 };
    if (db && page) return { error: "give one parent, not both db and page", status: 400 };
    if (!title) return { error: "title required", status: 400 };

    const children = markdown ? markdownToBlocks(markdown) : undefined;

    let parent, props;
    if (db) {
      const schema = await databaseSchema(db);
      const tk = titleKey(schema);
      if (!tk) return { error: "that database has no title column", status: 422 };
      props = { [tk]: buildProperty("title", title, tk) };
      for (const [name, value] of Object.entries(properties || {})) {
        if (!schema[name]) return { error: `no property "${name}" on that database`, status: 400 };
        try {
          props[name] = buildProperty(schema[name].type, value, name);
        } catch (err) {
          return { error: err.message, status: 400 };
        }
      }
      parent = { database_id: db };
    } else {
      if (properties && Object.keys(properties).length) {
        return { error: "properties apply to database rows; a subpage takes only a title", status: 400 };
      }
      parent = { page_id: page };
      props = { title: { title: buildProperty("title", title).title } };
    }

    const created = await notion("POST", "/pages", {
      parent,
      properties: props,
      ...(children ? { children } : {}),
    });
    return { id: created.id, url: created.url || "", title };
  }),

  // Append markdown to an existing page. Additive — the safest write here, since
  // nothing is overwritten.
  "POST /notion/append": asRoute(async ({ params, body }) => {
    const id = params.get("id");
    if (!id) return { error: "id required", status: 400 };
    const { markdown } = body || {};
    if (!markdown) return { error: "markdown required", status: 400 };
    const blocks = markdownToBlocks(markdown);
    if (!blocks.length) return { error: "nothing to append", status: 400 };
    const appended = await appendBlocks(id, blocks);
    return { id, appended };
  }),

  // Set database-row properties. Read-before-write: the page is fetched first so
  // each column's type is known (to build the new value) and its old value is
  // captured (to report). The reported from/to is the undo record — Notion keeps
  // no per-property history reachable through the API.
  "PATCH /notion/page": asRoute(async ({ params, body }) => {
    const id = params.get("id");
    if (!id) return { error: "id required", status: 400 };
    const { properties } = body || {};
    if (!properties || !Object.keys(properties).length) {
      return { error: "nothing to change", status: 400 };
    }
    const current = await notion("GET", `/pages/${id}`);

    const write = {};
    const changes = [];
    for (const [name, value] of Object.entries(properties)) {
      const prop = current.properties?.[name];
      if (!prop) return { error: `no property "${name}" on that page`, status: 400 };
      try {
        write[name] = buildProperty(prop.type, value, name);
      } catch (err) {
        return { error: err.message, status: 400 };
      }
      changes.push({ property: name, from: readProperty(prop), to: value });
    }

    const updated = await notion("PATCH", `/pages/${id}`, { properties: write });
    return { id: updated.id, url: updated.url || "", changes };
  }),

  // Edit or tick one body block, addressed by its own id (from `read`'s `ids`
  // option). Read-before-write, like `set`: the block is fetched so its current
  // line can be echoed and — for an edit — so a line that would change the
  // block's *type* is refused rather than silently ignored by the API. `checked`
  // toggles a to-do; `markdown` replaces the line's text (and, if the line
  // carries [ ]/[x], its checked state too). Both may be given; the explicit
  // `checked` wins.
  "PATCH /notion/block": asRoute(async ({ params, body }) => {
    const id = params.get("id");
    if (!id) return { error: "id required", status: 400 };
    const { markdown, checked } = body || {};
    const hasMarkdown = markdown !== undefined && markdown !== null && markdown !== "";
    if (!hasMarkdown && checked === undefined) {
      return { error: "nothing to change — give markdown to edit, or checked to tick", status: 400 };
    }

    const current = await notion("GET", `/blocks/${id}`);
    const from = blockLine(current);

    let patch, after;
    if (hasMarkdown) {
      let parsed;
      try {
        parsed = blockUpdate(current.type, markdown);
      } catch (err) {
        return { error: err.message, status: 400 };
      }
      if (checked !== undefined && parsed.type === "to_do") parsed.to_do.checked = Boolean(checked);
      patch = { [parsed.type]: parsed[parsed.type] };
      after = parsed;
    } else {
      if (current.type !== "to_do") {
        return { error: `checking applies to a to-do; that block is a ${current.type}`, status: 400 };
      }
      patch = { to_do: { checked: Boolean(checked) } };
      after = { type: "to_do", to_do: { ...current.to_do, checked: Boolean(checked) } };
    }

    const updated = await notion("PATCH", `/blocks/${id}`, patch);
    return { id: updated.id, from, to: blockLine(after) };
  }),

  // Remove one body block, addressed by its id. Unlike `set`, this is
  // reversible — Notion archives the block to the workspace Trash — so it's the
  // safe kind of destructive, the same call as calendar delete. Still
  // read-before-write: the removed line is echoed so a wrong removal is visible
  // and restorable the same turn. A block with children takes them with it, so
  // that's flagged.
  "DELETE /notion/block": asRoute(async ({ params }) => {
    const id = params.get("id");
    if (!id) return { error: "id required", status: 400 };
    const current = await notion("GET", `/blocks/${id}`);
    const removed = blockLine(current);
    const hasChildren = Boolean(current.has_children);
    await notion("DELETE", `/blocks/${id}`);
    return { id, removed, hasChildren };
  }),
};

export const NOTION_OPERATIONS = Object.keys(NOTION_ROUTES);
