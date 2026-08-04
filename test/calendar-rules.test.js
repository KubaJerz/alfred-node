// The invitation rule is the one where a mistake reaches real people and can't
// be recalled, so it's tested as a structural property rather than trusted to
// the ruleset Alfred reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  COLORS,
  TIMEZONE,
  resolveColor,
  toEventTime,
  toRangeBound,
  NEVER_NOTIFY,
} from "../google/calendar-rules.js";

const brokerSource = readFileSync(new URL("../google/broker.js", import.meta.url), "utf8");

test("no calendar write can populate attendees", () => {
  // Nothing in the broker may assign the attendees field. If a future change
  // adds one, this fails and the invitation guarantee gets re-examined
  // deliberately instead of lapsing.
  assert.ok(
    !/attendees\s*[:=]/.test(brokerSource),
    "broker.js assigns to attendees — invitations became possible"
  );
});

test("every calendar write suppresses notifications", () => {
  assert.deepEqual(NEVER_NOTIFY, { sendUpdates: "none" });
  const writes = brokerSource.match(/cal\.events\.(insert|patch)\(/g) || [];
  assert.ok(writes.length >= 2, "expected insert and patch to exist");
  // Each write call must spread NEVER_NOTIFY. Counting occurrences is crude but
  // catches the realistic regression: a new write path added without it.
  const guarded = brokerSource.match(/\.\.\.NEVER_NOTIFY/g) || [];
  assert.ok(
    guarded.length >= writes.length,
    `${writes.length} calendar writes but only ${guarded.length} guarded by NEVER_NOTIFY`
  );
});

test("colour names map to Google's ids", () => {
  assert.equal(resolveColor("banana"), "5");
  assert.equal(resolveColor("tomato"), "11");
  assert.equal(resolveColor("peacock"), "7");
  assert.equal(resolveColor("grape"), "3");
  assert.equal(resolveColor("basil"), "10");
  assert.equal(resolveColor("tangerine"), "6");
  assert.equal(new Set(Object.values(COLORS)).size, 6, "two names share an id");
});

test("an unknown colour fails loudly rather than defaulting", () => {
  assert.throws(() => resolveColor("burgundy"), /unknown colour/);
  // Absent is fine — that's "no colour", not a typo.
  assert.equal(resolveColor(undefined), undefined);
  assert.equal(resolveColor(""), undefined);
});

test("colour matching tolerates case and spacing", () => {
  assert.equal(resolveColor("  Basil "), "10");
  assert.equal(resolveColor("TANGERINE"), "6");
});

test("date-only input is all-day and carries no timezone", () => {
  // Google rejects an all-day event that also specifies a timeZone.
  assert.deepEqual(toEventTime("2026-01-21"), { date: "2026-01-21" });
  assert.deepEqual(toEventTime("2026-01-21T14:00:00"), {
    dateTime: "2026-01-21T14:00:00",
    timeZone: TIMEZONE,
  });
  assert.equal(TIMEZONE, "America/New_York");
});

// Alfred found this one in a live turn: `--from 2026-08-05` came back "Bad
// Request", so did `--from 2026-08-05T00:00:00`, and he gave up and listed the
// whole calendar. Google wants an offset; a date is what anyone would type.
test("range bounds accept a plain date, and land in Eastern", () => {
  assert.equal(toRangeBound("2026-08-05"), "2026-08-05T00:00:00-04:00");
  assert.equal(toRangeBound("2026-08-05T00:00:00"), "2026-08-05T00:00:00-04:00");
  assert.equal(toRangeBound("2026-08-05T14:30"), "2026-08-05T14:30:00-04:00");

  // Winter is -05:00. A hardcoded offset would be wrong for half the year.
  assert.equal(toRangeBound("2026-11-20"), "2026-11-20T00:00:00-05:00");

  // Anything already carrying a zone is left exactly as it is.
  for (const explicit of ["2026-08-05T00:00:00Z", "2026-08-05T00:00:00-07:00"]) {
    assert.equal(toRangeBound(explicit), explicit);
  }
  assert.equal(toRangeBound(""), undefined);
  assert.equal(toRangeBound(null), undefined);
});
