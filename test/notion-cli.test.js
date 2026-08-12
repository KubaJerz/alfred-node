// bin/notion.js against a stub broker on loopback — the same approach as
// cli.test.js. The interesting assertion isn't "did it print something" but
// "what went on the wire": the token rides in the header only, every request
// names a route the broker actually serves, and each write sends exactly the
// body its route unpacks. Nothing here can reach Notion.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { NOTION_OPERATIONS } = await import("../notion/broker.js");

const BIN = fileURLToPath(new URL("../bin/", import.meta.url));
const brokerSource = readFileSync(new URL("../notion/broker.js", import.meta.url), "utf8");
const TOKEN = "stub-broker-token-not-a-real-secret";

const CANNED = {
  "GET /notion/search": { results: [{ id: "p1", object: "page", title: "Reading list", url: "https://n.so/p1" }] },
  "GET /notion/page": {
    page: { id: "p1", title: "Reading list", url: "https://n.so/p1", properties: { Status: "Todo" }, markdown: "- a\n- b" },
  },
  "GET /notion/db/query": { rows: [{ id: "r1", title: "Ship it", url: "", properties: { Status: "Done" } }] },
  "POST /notion/page": { id: "p9", url: "https://n.so/p9", title: "Ship it" },
  "POST /notion/append": { id: "p1", appended: 2 },
  "PATCH /notion/page": { id: "r1", url: "", changes: [{ property: "Status", from: "Todo", to: "Done" }] },
};

let server, stubUrl, requests = [], override = null;

async function startStub() {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: req.method,
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      raw,
      body: raw ? JSON.parse(raw) : null,
    });
    const key = `${req.method} ${url.pathname}`;
    const canned = CANNED[key];
    const status = override?.status ?? (canned ? 200 : 404);
    const payload = JSON.stringify(
      override?.body ?? canned ?? { error: `no such operation: ${key}`, available: Object.keys(CANNED) }
    );
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
    res.end(payload);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  stubUrl = `http://127.0.0.1:${server.address().port}`;
}
after(async () => { await new Promise((r) => server.close(r)); });

const cleanEnv = () => {
  const env = { ...process.env };
  delete env.ALFRED_BROKER;
  delete env.ALFRED_BROKER_TOKEN;
  return env;
};

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(BIN, "notion.js"), ...args], {
      env: env ?? { ...cleanEnv(), ALFRED_BROKER: stubUrl, ALFRED_BROKER_TOKEN: TOKEN },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const SURFACE = [
  ["search", ["search", "reading", "list", "--type", "page"]],
  ["read", ["read", "p1"]],
  ["query", ["query", "d1", "--where", "Status=Done", "--limit", "5"]],
  ["create", ["create", "--db", "d1", "--title", "Ship it", "Status=Todo", "Priority=High", "--body", "- one"]],
  ["append", ["append", "p1", "--body", "- more"]],
  ["set", ["set", "r1", "Status=Done"]],
];

const calls = new Map();

before(async () => {
  await startStub();
  for (const [name, args] of SURFACE) {
    requests = [];
    const result = await run(args);
    assert.equal(requests.length, 1, `notion ${name} made ${requests.length} requests: ${result.stderr}`);
    calls.set(name, { result, request: requests[0] });
  }
});

test("every command authenticates with the broker token, in the header only", () => {
  for (const [name, { request }] of calls) {
    assert.equal(request.headers["x-alfred-broker"], TOKEN, `${name} did not present the token`);
    assert.ok(!request.raw.includes(TOKEN), `${name} put the token in the body`);
    assert.ok(!JSON.stringify(request.query).includes(TOKEN), `${name} put the token in the query`);
  }
});

test("every request names a route the broker actually serves", () => {
  for (const [name, { request }] of calls) {
    const key = `${request.method} ${request.pathname}`;
    assert.ok(NOTION_OPERATIONS.includes(key), `${name} called ${key}, which the broker does not serve`);
  }
});

// The keys each write route destructures from its body, read from broker.js. A
// field the CLI sends that the route never unpacks is silently discarded.
function bodyKeysOf(routeKey) {
  const starts = [...brokerSource.matchAll(/"((?:GET|POST|PATCH|PUT|DELETE) \/[^"]*)":/g)];
  const i = starts.findIndex((m) => m[1] === routeKey);
  assert.ok(i >= 0, `broker.js no longer defines ${routeKey}`);
  const block = brokerSource.slice(starts[i].index, starts[i + 1]?.index ?? brokerSource.length);
  const destructure = /const \{([^}]*)\} = body \|\| \{\};/.exec(block);
  assert.ok(destructure, `${routeKey} no longer destructures its body`);
  return destructure[1].split(",").map((s) => s.trim()).filter(Boolean);
}

test("write commands send exactly the body the broker route unpacks", () => {
  const expected = {
    create: {
      route: "POST /notion/page",
      // page is absent, not empty — one parent only. properties come from the
      // positional NAME=VALUE pairs, not repeated flags.
      body: { db: "d1", title: "Ship it", properties: { Status: "Todo", Priority: "High" }, markdown: "- one" },
    },
    append: { route: "POST /notion/append", body: { markdown: "- more" } },
    set: { route: "PATCH /notion/page", body: { properties: { Status: "Done" } } },
  };
  for (const [name, want] of Object.entries(expected)) {
    const { request } = calls.get(name);
    assert.equal(`${request.method} ${request.pathname}`, want.route, `${name} called the wrong route`);
    assert.deepEqual(request.body, want.body, `${name} sent an unexpected body`);
    const unpacked = bodyKeysOf(want.route);
    for (const key of Object.keys(want.body)) {
      assert.ok(unpacked.includes(key), `${name} sends ${key}, which ${want.route} no longer reads`);
    }
  }
  // The id for a set and an append rides the query string, where the route reads
  // it — never the body.
  assert.deepEqual(calls.get("set").request.query, { id: "r1" });
  assert.deepEqual(calls.get("append").request.query, { id: "p1" });
  assert.equal(calls.get("set").request.body.id, undefined, "set put the id in the body too");
});

test("read commands ask on the query string and print what came back", () => {
  assert.deepEqual(calls.get("search").request.query, { q: "reading list", type: "page" });
  assert.deepEqual(calls.get("read").request.query, { id: "p1" });
  assert.deepEqual(calls.get("query").request.query, { id: "d1", where: "Status=Done", limit: "5" });

  assert.match(calls.get("search").result.stdout, /\[p1\] \(page\) Reading list/);
  assert.match(calls.get("read").result.stdout, /# Reading list/);
  assert.match(calls.get("read").result.stdout, /Status: Todo/);
  assert.match(calls.get("create").result.stdout, /Created "Ship it"/);
  assert.match(calls.get("set").result.stdout, /Status: Todo → Done/);
  assert.match(calls.get("append").result.stdout, /Appended 2 block/);
  for (const [name, { result }] of calls) {
    assert.equal(result.code, 0, `${name} exited ${result.code}: ${result.stderr}`);
  }
});

test("an id may be positional or --id on read and set", async () => {
  requests = [];
  let out = await run(["read", "--id", "p1"]);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(requests[0].query.id, "p1");

  // With --id, the positionals are all NAME=VALUE pairs, none swallowed as the id.
  requests = [];
  out = await run(["set", "--id", "r1", "Status=Done"]);
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(requests[0].query, { id: "r1" });
  assert.deepEqual(requests[0].body, { properties: { Status: "Done" } });
});

test("a malformed NAME=VALUE pair fails before reaching the broker", async () => {
  requests = [];
  const out = await run(["set", "r1", "StatusDone"]);
  assert.notEqual(out.code, 0);
  assert.equal(requests.length, 0, "a bad pair was forwarded");
  assert.match(out.stderr, /expected NAME=VALUE/);
});

test("--help prints usage on stdout and exits 0 with no broker needed", async () => {
  for (const args of [["--help"], ["-h"], ["help"], []]) {
    requests = [];
    const out = await run(args, cleanEnv());
    assert.equal(out.code, 0, `${args.join(" ")} exited ${out.code}`);
    assert.match(out.stdout, /usage: node \.\.\/bin\/notion\.js/);
    assert.equal(out.stderr, "");
    assert.equal(requests.length, 0);
  }
  // The absences are stated in the overview, readable without attempting anything.
  assert.match((await run(["--help"], cleanEnv())).stdout, /No delete, no archive, no/);
});

test("per-command help works and never performs the command", async () => {
  for (const [command, marker] of [["set", /only record/], ["create", /subpage/], ["search", /shared with the integration/]]) {
    for (const args of [[command, "--help"], ["help", command]]) {
      requests = [];
      const out = await run(args, cleanEnv());
      assert.equal(out.code, 0, `${args.join(" ")} exited ${out.code}`);
      assert.match(out.stdout, new RegExp(`usage: node \\.\\./bin/notion\\.js ${command}`));
      assert.match(out.stdout, marker);
      assert.equal(requests.length, 0, `${args.join(" ")} reached the broker`);
    }
  }
});

test("an unrecognised command errors and reaches nothing, unlike --help", async () => {
  requests = [];
  const out = await run(["frobnicate"]);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /no such command: frobnicate/);
  assert.equal(out.stdout, "");
  assert.equal(requests.length, 0);
});

test("without the broker env it explains itself and reaches nothing", async () => {
  for (const args of [["search", "x"], ["read", "p1"], ["set", "r1", "Status=Done"]]) {
    requests = [];
    const out = await run(args, cleanEnv());
    assert.equal(out.code, 1, `${args.join(" ")} exited ${out.code}`);
    assert.match(out.stderr, /Broker unavailable/);
    assert.equal(requests.length, 0);
  }
});

test("a broker error is relayed on stderr, not swallowed", async () => {
  requests = [];
  override = { status: 400, body: { error: 'no property "Nope" on that database' } };
  const out = await run(["create", "--db", "d1", "--title", "x", "Nope=1"]);
  override = null;
  assert.equal(out.code, 1);
  assert.equal(out.stdout, "");
  assert.match(out.stderr, /no property "Nope"/);
});
