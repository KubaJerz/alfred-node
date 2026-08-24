// bin/intervals.js against a stub broker on loopback — the same approach as
// notion-cli.test.js. The interesting assertions aren't "did it print something"
// but "what went on the wire": the token rides in the header only, every request
// names a route the broker actually serves, every request is a GET (the whole
// capability is read-only), and asking for help reaches no broker at all. Nothing
// here can reach Intervals.icu.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { INTERVALS_OPERATIONS } = await import("../intervals/broker.js");

const BIN = fileURLToPath(new URL("../bin/", import.meta.url));
const cliSource = readFileSync(new URL("../bin/intervals.js", import.meta.url), "utf8");
const TOKEN = "stub-broker-token-not-a-real-secret";

const CANNED = {
  "GET /intervals/activities": {
    activities: [
      {
        id: "i123",
        date: "2026-08-05T07:14:00",
        type: "Ride",
        name: "Morning spin",
        distance: 32100,
        movingTime: 4020,
        elevationGain: 210,
        avgHr: 145,
        maxHr: 172,
        avgWatts: 198,
        load: 88,
      },
    ],
    window: { from: "2026-08-01", to: "2026-08-07" },
  },
  "GET /intervals/activity": {
    activity: {
      id: "i123",
      date: "2026-08-05T07:14:00",
      type: "Ride",
      name: "Morning spin",
      distance: 32100,
      movingTime: 4020,
      avgHr: 145,
    },
  },
  "GET /intervals/wellness": {
    days: [
      { date: "2026-08-05", restingHR: 48, hrv: 62, sleepSecs: 27120, readiness: 85, weight: 74.2 },
    ],
    window: { from: "2026-08-01", to: "2026-08-07" },
  },
};

let server, stubUrl, requests = [];

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
    const status = canned ? 200 : 404;
    const payload = JSON.stringify(canned ?? { error: `no such operation: ${key}`, available: Object.keys(CANNED) });
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
    const child = spawn(process.execPath, [path.join(BIN, "intervals.js"), ...args], {
      env: env ?? { ...cleanEnv(), ALFRED_BROKER: stubUrl, ALFRED_BROKER_TOKEN: TOKEN },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const SURFACE = [
  ["activities", ["activities", "--from", "2026-08-01", "--to", "2026-08-07", "--limit", "5"]],
  ["activity", ["activity", "i123"]],
  ["wellness", ["wellness", "--from", "2026-08-01", "--to", "2026-08-07"]],
];

const calls = new Map();

before(async () => {
  await startStub();
  for (const [name, args] of SURFACE) {
    requests = [];
    const result = await run(args);
    assert.equal(requests.length, 1, `intervals ${name} made ${requests.length} requests: ${result.stderr}`);
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
    assert.ok(INTERVALS_OPERATIONS.includes(key), `${name} called ${key}, which the broker does not serve`);
  }
});

test("every request is a GET — the whole capability is read-only", () => {
  for (const [name, { request }] of calls) {
    assert.equal(request.method, "GET", `${name} issued a ${request.method}, but intervals is read-only`);
    assert.equal(request.body, null, `${name} sent a body on a read`);
  }
});

test("reads ask on the query string and print what came back", () => {
  assert.deepEqual(calls.get("activities").request.query, { from: "2026-08-01", to: "2026-08-07", limit: "5" });
  assert.deepEqual(calls.get("activity").request.query, { id: "i123" });
  assert.deepEqual(calls.get("wellness").request.query, { from: "2026-08-01", to: "2026-08-07" });

  // Activity summary: id, date, type, name, and the slim metrics formatted.
  assert.match(calls.get("activities").result.stdout, /\[i123\] 2026-08-05  Ride  Morning spin/);
  assert.match(calls.get("activities").result.stdout, /32\.1km/);
  assert.match(calls.get("activities").result.stdout, /HR 145\/172/);
  assert.match(calls.get("activity").result.stdout, /\[i123\] 2026-08-05  Ride  Morning spin/);
  // Wellness row: the date and its recovery figures.
  assert.match(calls.get("wellness").result.stdout, /2026-08-05/);
  assert.match(calls.get("wellness").result.stdout, /RHR 48/);
  assert.match(calls.get("wellness").result.stdout, /HRV 62/);

  for (const [name, { result }] of calls) {
    assert.equal(result.code, 0, `${name} exited ${result.code}: ${result.stderr}`);
  }
});

test("asking for help reaches no broker and exits 0", async () => {
  for (const args of [["--help"], ["activity", "--help"], ["wellness", "--help"], ["help", "activities"]]) {
    requests = [];
    const out = await run(args, cleanEnv()); // no broker in the environment at all
    assert.equal(out.code, 0, `${args.join(" ")} exited ${out.code}: ${out.stderr}`);
    assert.equal(requests.length, 0, `${args.join(" ")} reached the broker`);
    assert.match(out.stdout, /intervals\.js/);
  }
});

test("the CLI never reads the key or assembles auth — only the broker does", () => {
  // cli.test.js already scans all of bin/ for credential-shaped material; this is
  // the tighter, intervals-specific claim: the CLI holds no path that would reach
  // Intervals.icu directly. It must not read the key from the environment, and it
  // must not build the HTTP Basic header the API wants. Both live in
  // intervals/client.js, on the bot side of the broker. (Mentions in comments are
  // fine — these look for the read and the assembly, not the words.)
  assert.ok(!cliSource.includes("process.env.INTERVALS"), "bin/intervals.js reads INTERVALS_* from the environment");
  assert.ok(!cliSource.includes("API_KEY:"), "bin/intervals.js assembles the Basic-auth credential");
  assert.ok(!/Basic\s+\$\{/.test(cliSource), "bin/intervals.js builds a Basic auth header");
});
