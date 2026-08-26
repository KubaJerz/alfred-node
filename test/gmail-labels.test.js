// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureLabels } from "../google/gmail-labels.js";

// A fake Gmail labels API: starts with two labels, records creates.
function fakeGmail(existing = []) {
  let seq = 0;
  const labels = existing.map((name, i) => ({ id: `L_${i}`, name }));
  const created = [];
  return {
    _created: created,
    users: {
      labels: {
        list: async () => ({ data: { labels } }),
        create: async ({ requestBody }) => {
          const id = `NEW_${seq++}`;
          labels.push({ id, name: requestBody.name });
          created.push(requestBody);
          return { data: { id, name: requestBody.name } };
        },
      },
    },
  };
}

test("returns ids for labels that already exist, creating none", async () => {
  const gmail = fakeGmail(["Taxes", "Jobs"]);
  const { ids, created } = await ensureLabels(["Taxes", "Jobs"], { gmail });
  assert.deepEqual(ids, { Taxes: "L_0", Jobs: "L_1" });
  assert.deepEqual(created, []);
  assert.equal(gmail._created.length, 0);
});

test("creates the missing labels and reports which", async () => {
  const gmail = fakeGmail(["Taxes"]);
  const { ids, created } = await ensureLabels(["Taxes", "Jobs", "Banking"], { gmail });
  assert.equal(ids.Taxes, "L_0"); // reused
  assert.match(ids.Jobs, /^NEW_/); // created
  assert.match(ids.Banking, /^NEW_/);
  assert.deepEqual(created, ["Jobs", "Banking"]);
  // Created labels are visible + nested-friendly.
  assert.equal(gmail._created[0].labelListVisibility, "labelShow");
});

test("a duplicate name in the input is only created once", async () => {
  const gmail = fakeGmail([]);
  const { ids } = await ensureLabels(["Jobs", "Jobs"], { gmail });
  assert.equal(gmail._created.length, 1);
  assert.ok(ids.Jobs);
});
