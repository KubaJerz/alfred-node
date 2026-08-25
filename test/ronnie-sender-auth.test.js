// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAddress, parseAuthResults, isForwardFromOwner } from "../ronnie/sender-auth.js";

const OWNERS = ["kuba@gmail.com", "kuba.work@outlook.com"];
const google = (verdicts) => `mx.google.com; ${verdicts}`;

test("parseAddress extracts and lowercases the bare address", () => {
  assert.equal(parseAddress("Kuba <Kuba@Gmail.com>"), "kuba@gmail.com");
  assert.equal(parseAddress("kuba@gmail.com"), "kuba@gmail.com");
  assert.equal(parseAddress("not an address"), "");
});

test("parseAuthResults reads authserv-id and the three verdicts", () => {
  const r = parseAuthResults(google("dkim=pass header.i=@gmail.com; spf=pass; dmarc=pass header.from=gmail.com"));
  assert.equal(r.authservId, "mx.google.com");
  assert.equal(r.dkim, "pass");
  assert.equal(r.dmarc, "pass");
  assert.equal(r.headerFrom, "gmail.com");
});

test("a genuine DKIM/DMARC-passing forward from an owner is accepted", () => {
  const r = isForwardFromOwner(
    { from: "Kuba <kuba@gmail.com>", authResults: [google("dkim=pass; dmarc=pass header.from=gmail.com")] },
    { owners: OWNERS }
  );
  assert.equal(r.ok, true);
  assert.equal(r.address, "kuba@gmail.com");
});

test("exact-match kills a lookalike even with a passing verdict", () => {
  const r = isForwardFromOwner(
    { from: "kuba@gmail.com.evil.com", authResults: [google("dkim=pass; dmarc=pass header.from=evil.com")] },
    { owners: OWNERS }
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /not an owner/);
});

test("a forged Authentication-Results from a non-Google authserv is ignored", () => {
  // The attacker sets From to the real owner AND injects their own dmarc=pass —
  // but under their own authserv-id, which we don't trust. Fails closed.
  const r = isForwardFromOwner(
    { from: "kuba@gmail.com", authResults: ["evil.attacker.com; dkim=pass; dmarc=pass header.from=gmail.com"] },
    { owners: OWNERS }
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /no trusted/);
});

test("an owner address whose DMARC did not pass is rejected", () => {
  const r = isForwardFromOwner(
    { from: "kuba@gmail.com", authResults: [google("dkim=fail; spf=softfail; dmarc=fail header.from=gmail.com")] },
    { owners: OWNERS }
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /DMARC/);
});

test("no Authentication-Results at all fails closed", () => {
  const r = isForwardFromOwner({ from: "kuba@gmail.com", authResults: [] }, { owners: OWNERS });
  assert.equal(r.ok, false);
  assert.match(r.reason, /failing closed/);
});

test("a DMARC verdict for a different From domain is rejected", () => {
  const r = isForwardFromOwner(
    { from: "kuba@gmail.com", authResults: [google("dkim=pass; dmarc=pass header.from=other.com")] },
    { owners: OWNERS }
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /different From domain/);
});

test("with no owners configured, the gate is off (never ok)", () => {
  const r = isForwardFromOwner(
    { from: "kuba@gmail.com", authResults: [google("dmarc=pass")] },
    { owners: [] }
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /no owner addresses/);
});
