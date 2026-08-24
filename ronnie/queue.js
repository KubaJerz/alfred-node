// Ronnie's work queue — the durable to-do list of mail ids awaiting triage.
//
// This is the input side of the redesign: the Pub/Sub drain no longer processes
// mail inline, it *enqueues the message ids here*, and the consumer pops from
// this queue, acts, and removes an id only once it's genuinely handled. If
// Ronnie can't finish one — Haiku is down, the fetch failed — the id stays, so
// nothing is lost across a crash or an outage. Gmail still holds the content;
// this file holds only ids, so no message body or subject ever rests here (the
// codes-on-disk worry disappears — there's nothing to redact in an id).
//
// One process (bot.js) both enqueues and consumes, so there's no cross-process
// file race to fight; every mutation goes through an in-memory mutex and rewrites
// the whole (small) file, so a reader on disk always sees a complete list.
//
// Entry shape: { id, ts, attempts }. `attempts` is the poison-message guard —
// the consumer bumps it on a message-specific failure and fails that one id open
// once it's tried too many times, so a single unparseable message can't wedge
// the queue forever. Service-wide failures (Haiku down) are the breaker's job,
// not this counter's — those never touch `attempts`.

import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const REPO_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const AGENT_DIR = process.env.AGENT_DIR || path.join(REPO_DIR, "agent");
const STATE_DIR = process.env.STATE_DIR || path.join(AGENT_DIR, "var");

export const MAIL_QUEUE_FILE = path.join(STATE_DIR, "mail-queue.jsonl");

// A high cap so a long Haiku outage can pile mail up without bound — but not
// truly unbounded. Unlike the digest, dropping here loses *unprocessed* mail, so
// the cap is generous and the drop is logged, never silent.
const MAX_QUEUE = Number(process.env.MAIL_QUEUE_MAX) || 1000;

/**
 * @param {{
 *   file?: string,
 *   read?: () => Promise<string>,   // injectable for tests
 *   write?: (s: string) => Promise<void>,
 *   log?: (m: string) => void,
 * }} [opts]
 */
export function makeQueue({ file = MAIL_QUEUE_FILE, read, write, log = () => {} } = {}) {
  const _read =
    read ||
    (async () => {
      try {
        return await readFile(file, "utf8");
      } catch {
        return "";
      }
    });
  const _write =
    write ||
    (async (s) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, s, { mode: 0o600 });
    });

  let items = null; // [{id, ts, attempts}] once loaded, else null
  let chain = Promise.resolve(); // serialize every mutation

  const parse = (raw) =>
    raw
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

  const persist = () => _write(items.length ? items.map((e) => JSON.stringify(e)).join("\n") + "\n" : "");

  async function ensure() {
    if (items === null) items = parse(await _read());
  }

  // A tiny promise-chain mutex so enqueue (drain side) and remove/bump (consumer
  // side) never interleave a read-modify-write.
  function lock(fn) {
    const p = chain.then(fn);
    chain = p.then(
      () => {},
      () => {}
    );
    return p;
  }

  return {
    /** Load the queue from disk. Call once at startup. Returns the count. */
    load: () =>
      lock(async () => {
        items = parse(await _read());
        return items.length;
      }),

    size: () => (items ? items.length : 0),
    ids: () => (items ? items.map((e) => e.id) : []), // snapshot for a consume pass
    has: (id) => !!items && items.some((e) => e.id === id),
    get: (id) => (items ? items.find((e) => e.id === id) || null : null),

    /**
     * Add new ids, skipping any already queued (dedup by id — a re-listed drain
     * after a crash can't double-enqueue). Enforces the cap, keeping the newest.
     * @returns {{added:number, dropped:number}}
     */
    enqueue: (ids, now = Date.now()) =>
      lock(async () => {
        await ensure();
        const present = new Set(items.map((e) => e.id));
        let added = 0;
        for (const id of ids) {
          if (!id || present.has(id)) continue;
          items.push({ id, ts: now, attempts: 0 });
          present.add(id);
          added++;
        }
        let dropped = 0;
        if (items.length > MAX_QUEUE) {
          dropped = items.length - MAX_QUEUE;
          items = items.slice(-MAX_QUEUE);
          log(`⚠️ mail queue over ${MAX_QUEUE}; dropped ${dropped} oldest`);
        }
        if (added || dropped) await persist();
        return { added, dropped };
      }),

    /** Drop an id — the message is handled (or gone). */
    remove: (id) =>
      lock(async () => {
        await ensure();
        const before = items.length;
        items = items.filter((e) => e.id !== id);
        if (items.length !== before) await persist();
      }),

    /** Record one more message-specific attempt on an id. Returns the new count. */
    bump: (id) =>
      lock(async () => {
        await ensure();
        const e = items.find((x) => x.id === id);
        if (!e) return 0;
        e.attempts = (e.attempts || 0) + 1;
        await persist();
        return e.attempts;
      }),
  };
}
