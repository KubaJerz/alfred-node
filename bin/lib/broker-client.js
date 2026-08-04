// Shared plumbing for Alfred's service CLIs (bin/gmail.js, bin/gcal.js).
//
// The broker address and its one-time secret arrive in the environment bot.js
// sets on the agent process. They stay module-private — nothing exported hands
// them out, so a new CLI can reach the broker without ever being in a position
// to log the token. Nothing here touches disk; there is no file for a stray
// `cat` to find.
//
// The env check runs at import rather than in each CLI: it's the same failure
// for both, and a check that runs unconditionally isn't one a third CLI can
// forget. That does mean importing this exits when the env is absent, so tests
// must spawn the CLIs rather than import them — exit code and stderr are the
// contract anyway.

const BASE = process.env.ALFRED_BROKER;
const TOKEN = process.env.ALFRED_BROKER_TOKEN;

if (!BASE || !TOKEN) {
  console.error(
    "Broker unavailable — ALFRED_BROKER/ALFRED_BROKER_TOKEN are not set.\n" +
      "This runs inside a turn spawned by bot.js; it can't be used standalone."
  );
  process.exit(1);
}

// Every non-zero exit goes through here — usage, the refusals, broker errors,
// caught throws — so "failed" always means the same thing to whoever is reading
// the transcript: stderr, then exit 1.
export function fail(...lines) {
  console.error(lines.join("\n"));
  process.exit(1);
}

// --key value pairs; everything else is positional.
export function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) flags[args[i].slice(2)] = args[++i];
    else rest.push(args[i]);
  }
  return { flags, rest };
}

// An id may be given positionally or as --id, on every command that takes one.
// Shared rather than repeated so that stays a property of the CLIs instead of a
// coincidence that holds until someone adds a command and forgets the `|| flags.id`.
export function requireId(rest, flags, usage) {
  const id = rest[0] || flags.id;
  if (!id) throw new Error(`usage: ${usage}`);
  return id;
}

export async function call(method, path, { query = {}, body } = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method,
    headers: {
      "x-alfred-broker": TOKEN,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    fail(
      `Error: ${data.error || res.status}`,
      ...(data.available ? [`Available: ${data.available.join(", ")}`] : [])
    );
  }
  return data;
}
