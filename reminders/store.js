// The durable list of reminders and recurring jobs: one JSON file in the state
// dir (bot.js passes <STATE_DIR>/reminders.json). bot.js is the only writer.
//
// The idiom is ronnie/queue.js: one process, the data in memory, and a promise
// chain that serializes every change. Two things are stricter here, because a
// lost reminder costs more than a lost queue entry:
//
//   - A save is atomic. The new text goes to a temp file in the same
//     directory, then a rename puts it in place. A crash during a save leaves
//     the old list or the new list on disk, never half of one.
//   - A change applies to a copy. update(fn) runs fn on a copy of the data and
//     keeps the copy only after the save succeeds. A failed save, or an error
//     that fn throws, leaves memory the same as the disk.
//
// A corrupt file must not stop the bot. load() moves it to
// reminders.json.corrupt-<n>, logs that, and starts with an empty list.
//
// The data: { version: 1, entries: [...], digests: [...], alerts: [...],
// missed: [...] }. reminders/service.js owns the shape of each item, and its
// load() drops an item that it cannot read.

import * as fsp from "fs/promises";
import path from "path";

const empty = () => ({ version: 1, entries: [], digests: [], alerts: [], missed: [] });

// The shape check is shallow on purpose. The service validates what it writes.
// This catches a file that is not the list at all.
function parse(raw) {
  const data = JSON.parse(raw);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not a JSON object");
  if (!Array.isArray(data.entries)) throw new Error("no entries list");
  return {
    ...data,
    version: 1,
    entries: data.entries.filter((e) => e && typeof e === "object" && typeof e.id === "string"),
    digests: Array.isArray(data.digests) ? data.digests : [],
    alerts: Array.isArray(data.alerts) ? data.alerts : [],
    missed: Array.isArray(data.missed) ? data.missed : [],
  };
}

/**
 * @param {{
 *   file: string,
 *   log?: (m: string) => void,
 *   fs?: object,   // fs/promises, injectable for tests
 * }} opts
 */
export function makeStore({ file, log = () => {}, fs = fsp }) {
  if (!file) throw new Error("makeStore needs a file path");
  let data = empty();
  let saved = null; // the text on disk after the latest load or save
  let chain = Promise.resolve();
  let seq = 0;

  // The same promise-chain mutex as ronnie/queue.js.
  function lock(fn) {
    const p = chain.then(fn);
    chain = p.then(
      () => {},
      () => {}
    );
    return p;
  }

  async function exists(p) {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  // The first free reminders.json.corrupt-<n>.
  async function moveAside() {
    for (let n = 1; n < 1000; n++) {
      const to = `${file}.corrupt-${n}`;
      if (await exists(to)) continue;
      await fs.rename(file, to);
      return to;
    }
    throw new Error("too many corrupt copies already");
  }

  async function save(next) {
    const text = JSON.stringify(next, null, 2) + "\n";
    if (text === saved) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${++seq}`;
    try {
      // flush: the bytes reach the disk before the rename makes them the list.
      await fs.writeFile(tmp, text, { mode: 0o600, flush: true });
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
    saved = text;
  }

  return {
    file,

    /**
     * Read the file. Call once at startup. A missing file is an empty list. A
     * corrupt file is moved aside. Rejects only on an I/O error (for example,
     * no permission), because an empty list would then overwrite the file.
     * Returns the number of entries.
     */
    load: () =>
      lock(async () => {
        let raw;
        try {
          raw = await fs.readFile(file, "utf8");
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
          data = empty();
          saved = null;
          return 0;
        }
        try {
          data = parse(raw);
          saved = raw;
          const dropped = (JSON.parse(raw).entries?.length || 0) - data.entries.length;
          if (dropped) log(`⚠️  Reminders: dropped ${dropped} entr${dropped === 1 ? "y" : "ies"} with no id from ${path.basename(file)}`);
        } catch (err) {
          let where;
          try {
            where = `Moved it to ${path.basename(await moveAside())}`;
          } catch (moveErr) {
            where = `Could not move it (${moveErr.message})`;
          }
          log(`⚠️  Reminders: ${path.basename(file)} is corrupt (${err.message}). ${where}. Starting with an empty list.`);
          data = empty();
          saved = null;
        }
        return data.entries.length;
      }),

    /** The current data. Read it, do not change it: use update(). */
    data: () => data,
    entries: () => data.entries,

    /**
     * Change the data. fn gets a copy and changes it in place. fn must not
     * wait for I/O: the lock is held while it runs. The copy is saved, then it
     * becomes the data. Resolves to what fn returns. If fn throws or the save
     * fails, nothing changes and the promise rejects.
     */
    update: (fn) =>
      lock(async () => {
        const draft = structuredClone(data);
        const out = fn(draft);
        await save(draft);
        data = draft;
        return out;
      }),
  };
}
