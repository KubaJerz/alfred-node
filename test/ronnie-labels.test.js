// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRonnieLabels, TIER_TOPICS } from "../ronnie/labels.js";

// A fake Gmail labels API seeded with the three parents (proper-cased) + records creates.
function fakeGmail(extra = []) {
  const labels = [
    { id: "L_PRI", name: "Priority" },
    { id: "L_INT", name: "Interesting" },
    { id: "L_BULK", name: "Bulk" },
    ...extra,
  ];
  let seq = 0;
  const created = [];
  return {
    _created: created,
    users: {
      labels: {
        list: async () => ({ data: { labels } }),
        create: async ({ requestBody }) => {
          const id = `NEW_${seq++}`;
          labels.push({ id, name: requestBody.name });
          created.push(requestBody.name);
          return { data: { id, name: requestBody.name } };
        },
      },
    },
  };
}

test("resolve without create: children that don't exist come back empty", async () => {
  const gmail = fakeGmail();
  const r = await resolveRonnieLabels({ gmail, priorityId: "L_PRI", interestingId: "L_INT", bulkId: "L_BULK", create: false });
  assert.equal(r.interesting, "L_INT");
  assert.equal(r.general, "L_BULK");
  assert.equal(r.topics.interesting.banking, ""); // not created
  assert.equal(gmail._created.length, 0);
});

test("resolve with create: builds nested names under the real parent names", async () => {
  const gmail = fakeGmail();
  const r = await resolveRonnieLabels({ gmail, priorityId: "L_PRI", interestingId: "L_INT", bulkId: "L_BULK", create: true });
  // Names are parentName/Title, so they nest in Gmail's sidebar.
  assert.deepEqual(
    gmail._created.sort(),
    ["Priority/Banking", "Priority/Entropy", "Priority/Jobs", "Bulk/Banking", "Bulk/Entropy", "Bulk/Jobs", "Interesting/Banking", "Interesting/Entropy", "Interesting/Jobs", "Interesting/Taxes"].sort()
  );
  assert.match(r.topics.interesting.jobs, /^NEW_/);
  assert.match(r.topics.general.banking, /^NEW_/);
});

test("taxes exists only under interesting and records, never general or priority", () => {
  assert.ok(TIER_TOPICS.interesting.includes("taxes"));
  assert.ok(TIER_TOPICS.records.includes("taxes"));
  assert.ok(!TIER_TOPICS.general.includes("taxes"));
  assert.ok(!TIER_TOPICS.priority.includes("taxes"));
});

test("records and meetings resolve as parents; meetings has no topic children", async () => {
  const gmail = fakeGmail([
    { id: "L_REC", name: "Records" },
    { id: "L_MEET", name: "Meetings" },
  ]);
  const r = await resolveRonnieLabels({
    gmail, priorityId: "L_PRI", interestingId: "L_INT", recordsId: "L_REC",
    generalId: "L_BULK", meetingsId: "L_MEET", create: true,
  });
  assert.equal(r.records, "L_REC");
  assert.equal(r.meetings, "L_MEET");
  assert.equal(r.general, "L_BULK");
  assert.match(r.topics.records.taxes, /^NEW_/);
  assert.ok(gmail._created.includes("Records/Banking"));
  assert.deepEqual(r.topics.meetings, {});
  assert.ok(!gmail._created.some((n) => n.startsWith("Meetings/")));
});

test("an already-existing child is reused, not recreated", async () => {
  const gmail = fakeGmail([{ id: "EXIST", name: "Interesting/Banking" }]);
  const r = await resolveRonnieLabels({ gmail, priorityId: "L_PRI", interestingId: "L_INT", bulkId: "L_BULK", create: true });
  assert.equal(r.topics.interesting.banking, "EXIST");
  assert.ok(!gmail._created.includes("Interesting/Banking"));
});
