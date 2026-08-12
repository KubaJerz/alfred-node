// The Notion HTTP client. This is the one place the integration secret is read
// and the one place it's sent, mirroring google/auth.js: bot.js holds the token
// in its own environment, the broker calls through here, and the agent never
// touches either.
//
// Unlike Google there is no OAuth dance — an internal integration is a single
// non-expiring bearer secret, so there's no refresh, no consent round trip, and
// nothing persisted to disk. The real access boundary isn't a scope list here;
// it's per-page sharing on Notion's side. The integration sees only what's been
// connected to it, so a page nobody shared simply doesn't exist as far as this
// client is concerned — finer-grained than any single OAuth scope, and enforced
// by Notion rather than by us.

const BASE = "https://api.notion.com/v1";

// Pinned on purpose. Notion versions its API by date, and 2025-09-03 reshapes a
// database into one-or-more "data sources" — databases.query becomes a
// data_sources.query, and the database object returns a data_sources[] array.
// Everything here is written against the 2022-06-28 object model; bumping this
// without porting those call sites breaks database reads silently.
const NOTION_VERSION = "2022-06-28";

function token() {
  const t = process.env.NOTION_TOKEN;
  if (!t) {
    throw new Error(
      "NOTION_TOKEN is not set. Create an internal integration at " +
        "https://notion.so/my-integrations, then add its secret to .env."
    );
  }
  return t;
}

/**
 * One Notion API call. Returns the parsed JSON on success; on an API error
 * throws with Notion's own message (e.g. "Could not find page … Make sure the
 * relevant pages and databases are shared with your integration"), which is
 * exactly the guidance a not-yet-shared page needs, and carries the HTTP status
 * so the broker can pass it through rather than flattening everything to 500.
 */
export async function notion(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Notion-Version": NOTION_VERSION,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.message || `Notion API returned ${res.status}`);
    err.status = res.status;
    err.notionCode = data?.code;
    throw err;
  }
  return data;
}

// Blocks come back a page at a time and can nest, so a full read is a recursive
// walk. Two bounds keep a deep or huge page from turning into a request storm or
// a runaway: depth is capped (past it, children are left unfetched), and total
// blocks are capped across the whole tree. Both mirror the depth guard on the
// Gmail part walker.
const MAX_DEPTH = 5;
const MAX_BLOCKS = 500;

export async function fetchBlockChildren(blockId, depth = 0, budget = { count: 0 }) {
  const children = [];
  let cursor;
  do {
    const qs = new URLSearchParams({ page_size: "100" });
    if (cursor) qs.set("start_cursor", cursor);
    const page = await notion("GET", `/blocks/${blockId}/children?${qs}`);
    for (const block of page.results || []) {
      if (budget.count >= MAX_BLOCKS) return children;
      budget.count++;
      if (block.has_children && depth < MAX_DEPTH) {
        block.children = await fetchBlockChildren(block.id, depth + 1, budget);
      }
      children.push(block);
    }
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return children;
}

// Notion's block append takes at most 100 children per call. Batch so a long
// note isn't an all-or-nothing 100-block write.
export async function appendBlocks(blockId, blocks) {
  let appended = 0;
  for (let i = 0; i < blocks.length; i += 100) {
    await notion("PATCH", `/blocks/${blockId}/children`, {
      children: blocks.slice(i, i + 100),
    });
    appended += Math.min(100, blocks.length - i);
  }
  return appended;
}

// The title of a page or database object, from whichever shape it is. A database
// carries a top-level `title`; a page carries its title inside the title-typed
// property, whose name varies, so it's found by type.
export function objectTitle(obj) {
  if (obj.object === "database") {
    return richTextPlain(obj.title);
  }
  const titleProp = Object.values(obj.properties || {}).find((p) => p.type === "title");
  return richTextPlain(titleProp?.title);
}

function richTextPlain(rt) {
  return (rt || []).map((t) => t.plain_text ?? t.text?.content ?? "").join("") || "";
}
