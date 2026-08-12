// Three things this asserts, in one file because they share no fixtures with the
// Google suite:
//
//   1. The markdown↔blocks converters round-trip — this is the layer every read
//      and write passes through, and a silent loss here corrupts a page.
//   2. Typed properties build into the right Notion shape from a bare string.
//   3. The broker's Notion routes keep their promises: no comment/delete/archive
//      route exists, and every write validates before a single API call.
//
// (3) needs no Notion token — the validation paths return before reaching the
// API, and anything that would reach it fails closed at the missing-token check,
// so nothing here can touch a real workspace.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  markdownToBlocks,
  blocksToMarkdown,
  markdownToRichText,
  richTextToMarkdown,
} from "../notion/blocks.js";
import {
  readProperty,
  readProperties,
  titleKey,
  buildProperty,
  equalsFilter,
  parsePair,
} from "../notion/props.js";

// No Notion token in scope: a route that reaches the API must fail at the token
// check, not call out. auth.js (pulled in by google/broker.js) resolves credential
// paths at import, so point STATE_DIR at an empty dir before importing it.
delete process.env.NOTION_TOKEN;
process.env.STATE_DIR = mkdtempSync(path.join(tmpdir(), "alfred-notion-test-"));
const { startBroker } = await import("../google/broker.js");
const { NOTION_ROUTES, NOTION_OPERATIONS } = await import("../notion/broker.js");

// ── Converters ───────────────────────────────────────────────────────────────

test("every supported block type round-trips markdown → blocks → markdown", () => {
  const md = [
    "# H1",
    "## H2",
    "### H3",
    "a paragraph",
    "- bullet one",
    "- bullet two",
    "- [ ] todo open",
    "- [x] todo done",
    "> a quote",
    "---",
  ].join("\n");
  const blocks = markdownToBlocks(md);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["heading_1", "heading_2", "heading_3", "paragraph",
      "bulleted_list_item", "bulleted_list_item", "to_do", "to_do", "quote", "divider"]
  );
  const back = blocksToMarkdown(blocks);
  for (const line of ["# H1", "### H3", "- bullet one", "- [ ] todo open", "- [x] todo done", "> a quote", "---"]) {
    assert.ok(back.includes(line), `round-trip dropped: ${line}`);
  }
});

test("a fenced code block is captured whole, not parsed as markdown", () => {
  const blocks = markdownToBlocks("```js\n# not a heading\nconst x = 1;\n```");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "code");
  assert.equal(blocks[0].code.language, "js");
  assert.equal(blocks[0].code.rich_text[0].text.content, "# not a heading\nconst x = 1;");
});

test("inline emphasis parses by earliest marker and round-trips", () => {
  const rt = markdownToRichText("plain **bold** then *italic* then `code` and ~~gone~~");
  assert.deepEqual(rt.find((n) => n.annotations?.bold)?.text.content, "bold");
  assert.deepEqual(rt.find((n) => n.annotations?.italic)?.text.content, "italic");
  assert.deepEqual(rt.find((n) => n.annotations?.code)?.text.content, "code");
  assert.deepEqual(rt.find((n) => n.annotations?.strikethrough)?.text.content, "gone");
  assert.equal(richTextToMarkdown(rt.map((n) => ({ ...n, plain_text: n.text.content, annotations: n.annotations || {} }))),
    "plain **bold** then *italic* then `code` and ~~gone~~");
});

test("a link becomes a text node with a url, and wraps outermost on the way back", () => {
  const rt = markdownToRichText("see [the docs](https://example.com/x)");
  const link = rt.find((n) => n.text.link);
  assert.equal(link.text.link.url, "https://example.com/x");
  assert.equal(link.text.content, "the docs");
  // A bold link must render [**x**](url), link outside emphasis.
  const md = richTextToMarkdown([
    { plain_text: "x", annotations: { bold: true }, href: "u" },
  ]);
  assert.equal(md, "[**x**](u)");
});

test("text over Notion's 2000-char limit is split across objects", () => {
  const rt = markdownToRichText("a".repeat(4500));
  assert.equal(rt.length, 3);
  assert.ok(rt.every((n) => n.text.content.length <= 2000));
  assert.equal(rt.map((n) => n.text.content).join("").length, 4500);
});

test("numbered lists count within a run and reset after it breaks", () => {
  const blocks = [
    { type: "numbered_list_item", numbered_list_item: { rich_text: [{ plain_text: "a" }] } },
    { type: "numbered_list_item", numbered_list_item: { rich_text: [{ plain_text: "b" }] } },
    { type: "paragraph", paragraph: { rich_text: [{ plain_text: "break" }] } },
    { type: "numbered_list_item", numbered_list_item: { rich_text: [{ plain_text: "c" }] } },
  ];
  const md = blocksToMarkdown(blocks);
  assert.ok(md.includes("1. a"));
  assert.ok(md.includes("2. b"));
  assert.ok(md.includes("1. c"), "the counter didn't reset after the paragraph");
});

test("an unsupported block survives as a visible marker, never dropped", () => {
  const md = blocksToMarkdown([{ type: "table", table: {} }]);
  assert.equal(md, "*[table]*");
});

test("fetched children render indented under their parent", () => {
  const md = blocksToMarkdown([
    {
      type: "bulleted_list_item",
      bulleted_list_item: { rich_text: [{ plain_text: "parent" }] },
      children: [
        { type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "child" }] } },
      ],
    },
  ]);
  assert.ok(md.includes("- parent"));
  assert.ok(md.includes("  - child"), `child not indented:\n${md}`);
});

// ── Properties ───────────────────────────────────────────────────────────────

test("buildProperty shapes a bare string by the column's type", () => {
  assert.deepEqual(buildProperty("select", "Done"), { select: { name: "Done" } });
  assert.deepEqual(buildProperty("status", "Done"), { status: { name: "Done" } });
  assert.deepEqual(buildProperty("checkbox", "true"), { checkbox: true });
  assert.deepEqual(buildProperty("checkbox", "no"), { checkbox: false });
  assert.deepEqual(buildProperty("number", "42"), { number: 42 });
  assert.deepEqual(buildProperty("date", "2026-08-20"), { date: { start: "2026-08-20" } });
  assert.deepEqual(buildProperty("url", "https://x.com"), { url: "https://x.com" });
  assert.deepEqual(buildProperty("multi_select", "a, b ,c"), {
    multi_select: [{ name: "a" }, { name: "b" }, { name: "c" }],
  });
  assert.equal(buildProperty("title", "Hi").title[0].text.content, "Hi");
});

test("buildProperty refuses a number that isn't one, and a type it can't set", () => {
  assert.throws(() => buildProperty("number", "soon", "Due"), /Due is a number/);
  assert.throws(() => buildProperty("people", "someone", "Owner"), /Owner is a people/);
});

test("readProperty renders each type, and 0 is not treated as empty", () => {
  assert.equal(readProperty({ type: "select", select: { name: "Todo" } }), "Todo");
  assert.equal(readProperty({ type: "checkbox", checkbox: true }), "true");
  assert.equal(readProperty({ type: "number", number: 0 }), "0");
  assert.equal(readProperty({ type: "date", date: { start: "2026-01-01", end: "2026-01-02" } }), "2026-01-01 → 2026-01-02");
  assert.equal(readProperty({ type: "multi_select", multi_select: [{ name: "x" }, { name: "y" }] }), "x, y");
});

test("read-only automatic columns render their value, not a type marker", () => {
  assert.equal(readProperty({ type: "created_time", created_time: "2026-08-11T00:00:00Z" }), "2026-08-11T00:00:00Z");
  assert.equal(readProperty({ type: "last_edited_by", last_edited_by: { name: "Kuba" } }), "Kuba");
  assert.equal(readProperty({ type: "unique_id", unique_id: { prefix: "TASK", number: 42 } }), "TASK-42");
});

test("readProperties drops empty columns; titleKey finds the title by type", () => {
  const props = {
    Name: { type: "title", title: [{ plain_text: "Ship" }] },
    Status: { type: "status", status: { name: "Done" } },
    Notes: { type: "rich_text", rich_text: [] },
  };
  assert.deepEqual(readProperties(props), { Name: "Ship", Status: "Done" });
  assert.equal(titleKey(props), "Name");
  assert.equal(titleKey({ x: { type: "number" } }), null);
});

test("equalsFilter keys by type; parsePair splits on the first =", () => {
  assert.deepEqual(equalsFilter("status", "Done", "Status"), { property: "Status", status: { equals: "Done" } });
  assert.deepEqual(equalsFilter("checkbox", "yes", "Done"), { property: "Done", checkbox: { equals: true } });
  assert.throws(() => equalsFilter("people", "x", "Owner"), /can't filter/);
  assert.deepEqual(parsePair("URL=https://a.com/?x=1"), ["URL", "https://a.com/?x=1"]);
});

// ── Broker security ──────────────────────────────────────────────────────────

let broker;
const hit = (p, opts = {}) =>
  fetch(broker.url + p, { ...opts, headers: { "x-alfred-broker": broker.token, ...(opts.headers || {}) } });
const post = (p, body) =>
  hit(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

before(async () => {
  broker = await startBroker({ log: () => {}, extraRoutes: NOTION_ROUTES });
});
after(async () => {
  await broker.close();
});

test("no comment, delete or archive route exists — the capability is absent", async () => {
  for (const forbidden of [/comment/i, /delete/i, /archive/i]) {
    assert.ok(
      !NOTION_OPERATIONS.some((op) => forbidden.test(op)),
      `a ${forbidden} operation exists: ${NOTION_OPERATIONS.filter((o) => forbidden.test(o))}`
    );
  }
  // And they 404 rather than being quietly served by something.
  for (const [method, p] of [["POST", "/notion/comment"], ["DELETE", "/notion/page"], ["POST", "/notion/archive"]]) {
    const res = await hit(p, { method });
    assert.equal(res.status, 404, `${method} ${p} was reachable`);
  }
});

test("Notion routes mounted on the broker and require the token", async () => {
  assert.ok(NOTION_OPERATIONS.includes("GET /notion/search"), "search route missing");
  const none = await fetch(broker.url + "/notion/search?q=x");
  assert.equal(none.status, 401, "an unauthenticated Notion call was served");
});

test("every write validates locally before any API call", async () => {
  // No token is set, so a call that reached the API would 500 at the token check.
  // A 400 here proves validation returned first — nothing left the box.
  const cases = [
    ["POST", "/notion/page", {}, /parent is required/],          // no parent
    ["POST", "/notion/page", { db: "d", page: "p", title: "t" }, /one parent, not both/],
    ["POST", "/notion/page", { db: "d" }, /title required/],     // no title
    ["PATCH", "/notion/page?id=x", {}, /nothing to change/],     // empty patch
    ["POST", "/notion/append?id=x", {}, /markdown required/],    // nothing to append
  ];
  for (const [method, p, body, re] of cases) {
    const res = await hit(p, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(res.status, 400, `${method} ${p} should have been rejected locally`);
    assert.match((await res.json()).error, re);
  }
});

test("id-less reads are rejected before the API, not forwarded", async () => {
  for (const p of ["/notion/page", "/notion/db/query"]) {
    const res = await hit(p);
    assert.equal(res.status, 400, `${p} with no id was forwarded`);
    assert.match((await res.json()).error, /id required/);
  }
});

test("a valid-shaped call with no token fails closed without leaking anything", async () => {
  // Shape is fine, so this would reach the API — but there's no token, so it must
  // stop at the token check. 500, an error that names the setup step, no stack,
  // no broker token echoed.
  const res = await post("/notion/append?id=x", { markdown: "hi" });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /NOTION_TOKEN/);
  assert.ok(!/stack|at Object|node:internal/i.test(body.error), "a stack leaked to the caller");
  assert.ok(!body.error.includes(broker.token), "the broker token was echoed back");
});
