// Run with: npm test   (node's built-in runner, no network, no credentials)
//
// The reminder list on disk. A lost or half-written list loses reminders, so
// the tests cover the save path more than the happy path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeStore } from "../reminders/store.js";

const tempFile = () => path.join(mkdtempSync(path.join(tmpdir(), "alfred-reminders-store-")), "reminders.json");
const onDisk = (file) => JSON.parse(readFileSync(file, "utf8"));

test("a missing file is an empty list", async () => {
  const store = makeStore({ file: tempFile() });
  assert.equal(await store.load(), 0);
  assert.deepEqual(store.data(), { version: 1, entries: [], digests: [], alerts: [], missed: [] });
});

test("round trip: what one store saves, a new store loads", async () => {
  const file = tempFile();
  const a = makeStore({ file });
  await a.load();
  const out = await a.update((data) => {
    data.entries.push({ id: "r7k2", text: "Call mom" });
    data.alerts.push({ id: "a1", text: "hello" });
    data.missed.push({ contact: "me", via: ["discord"], line: "Pay rent" });
    return "done";
  });
  assert.equal(out, "done", "update resolves to what fn returns");
  assert.equal(onDisk(file).entries[0].text, "Call mom");

  const b = makeStore({ file });
  assert.equal(await b.load(), 1);
  assert.deepEqual(b.entries(), [{ id: "r7k2", text: "Call mom" }]);
  assert.deepEqual(b.data().alerts, [{ id: "a1", text: "hello" }]);
  assert.deepEqual(b.data().missed, [{ contact: "me", via: ["discord"], line: "Pay rent" }]);
});

test("the file is private to the owner", async () => {
  const file = tempFile();
  const store = makeStore({ file });
  await store.load();
  await store.update((data) => data.entries.push({ id: "r1" }));
  const { mode } = await fsp.stat(file);
  assert.equal(mode & 0o777, 0o600);
});

test("a save writes a temp file in the same directory, then renames it", async () => {
  const file = tempFile();
  const calls = [];
  const fs = {
    ...fsp,
    writeFile: async (p, ...rest) => {
      calls.push(["write", p]);
      return fsp.writeFile(p, ...rest);
    },
    rename: async (from, to) => {
      calls.push(["rename", from, to]);
      return fsp.rename(from, to);
    },
  };
  const store = makeStore({ file, fs });
  await store.load();
  await store.update((data) => data.entries.push({ id: "r1" }));
  const [write, rename] = calls;
  assert.equal(write[0], "write");
  assert.equal(path.dirname(write[1]), path.dirname(file), "the temp file is in the same directory");
  assert.notEqual(write[1], file, "the list itself is never written in place");
  assert.deepEqual(rename, ["rename", write[1], file]);
  assert.deepEqual(readdirSync(path.dirname(file)), ["reminders.json"], "no temp file is left");
});

test("a failed save leaves the old file and the old data, and removes the temp file", async () => {
  const file = tempFile();
  let failRename = false;
  const fs = {
    ...fsp,
    rename: async (from, to) => {
      if (failRename) throw new Error("disk full");
      return fsp.rename(from, to);
    },
  };
  const store = makeStore({ file, fs });
  await store.load();
  await store.update((data) => data.entries.push({ id: "r1", text: "old" }));
  const before = readFileSync(file, "utf8");

  failRename = true;
  await assert.rejects(
    store.update((data) => {
      data.entries[0].text = "new";
    }),
    /disk full/
  );
  assert.equal(readFileSync(file, "utf8"), before, "the file on disk did not change");
  assert.equal(store.entries()[0].text, "old", "memory still matches the disk");
  assert.deepEqual(readdirSync(path.dirname(file)), ["reminders.json"], "the temp file was removed");

  // The next save works again and carries only its own change.
  failRename = false;
  await store.update((data) => data.entries.push({ id: "r2" }));
  assert.deepEqual(
    onDisk(file).entries.map((e) => [e.id, e.text]),
    [["r1", "old"], ["r2", undefined]]
  );
});

test("an error in fn changes nothing", async () => {
  const file = tempFile();
  const store = makeStore({ file });
  await store.load();
  await store.update((data) => data.entries.push({ id: "r1" }));
  await assert.rejects(
    store.update((data) => {
      data.entries.push({ id: "half" });
      throw new Error("invalid input");
    }),
    /invalid input/
  );
  assert.deepEqual(store.entries().map((e) => e.id), ["r1"]);
  assert.deepEqual(onDisk(file).entries.map((e) => e.id), ["r1"]);
});

test("a corrupt file is moved aside, logged, and the list starts empty", async () => {
  const file = tempFile();
  writeFileSync(file, "{not json");
  const logs = [];
  const store = makeStore({ file, log: (m) => logs.push(m) });
  assert.equal(await store.load(), 0);
  assert.equal(readFileSync(`${file}.corrupt-1`, "utf8"), "{not json", "the bad file is kept for a person to read");
  assert.equal(existsSync(file), false);
  assert.match(logs.join("\n"), /corrupt.*reminders\.json\.corrupt-1.*empty list/);

  // The bot keeps working: the next change saves a fresh list.
  await store.update((data) => data.entries.push({ id: "r1" }));
  assert.deepEqual(onDisk(file).entries, [{ id: "r1" }]);

  // A second corrupt file does not overwrite the first copy.
  writeFileSync(file, JSON.stringify({ entries: "nope" }));
  await makeStore({ file, log: (m) => logs.push(m) }).load();
  assert.equal(readFileSync(`${file}.corrupt-1`, "utf8"), "{not json");
  assert.match(readFileSync(`${file}.corrupt-2`, "utf8"), /nope/);
});

test("valid JSON that is not the list counts as corrupt", async () => {
  for (const text of ["[]", "null", "42", '{"entries": {}}']) {
    const file = tempFile();
    writeFileSync(file, text);
    const logs = [];
    assert.equal(await makeStore({ file, log: (m) => logs.push(m) }).load(), 0, text);
    assert.ok(existsSync(`${file}.corrupt-1`), text);
    assert.equal(logs.length, 1, text);
  }
});

test("an entry with no id is dropped at load, and logged", async () => {
  const file = tempFile();
  writeFileSync(file, JSON.stringify({ entries: [{ id: "r1" }, { text: "no id" }, null] }));
  const logs = [];
  const store = makeStore({ file, log: (m) => logs.push(m) });
  assert.equal(await store.load(), 1);
  assert.match(logs.join("\n"), /dropped 2 entries/);
});

test("changes are serialized: one save at a time, and none is lost", async () => {
  const file = tempFile();
  let inFlight = 0;
  let most = 0;
  const fs = {
    ...fsp,
    writeFile: async (...args) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      try {
        return await fsp.writeFile(...args);
      } finally {
        inFlight--;
      }
    },
  };
  const store = makeStore({ file, fs });
  await store.load();
  await store.update((data) => data.entries.push({ id: "count", n: 0 }));
  // Twenty changes, started together. Each reads the count and adds one.
  await Promise.all(
    Array.from({ length: 20 }, () =>
      store.update((data) => {
        data.entries[0].n += 1;
      })
    )
  );
  assert.equal(most, 1, "two saves overlapped");
  assert.equal(store.entries()[0].n, 20);
  assert.equal(onDisk(file).entries[0].n, 20);
});

test("a change that changes nothing does not write the file", async () => {
  const file = tempFile();
  let writes = 0;
  const fs = {
    ...fsp,
    writeFile: async (...args) => {
      writes++;
      return fsp.writeFile(...args);
    },
  };
  const store = makeStore({ file, fs });
  await store.load();
  await store.update((data) => data.entries.push({ id: "r1" }));
  await store.update(() => {});
  assert.equal(writes, 1);
});
