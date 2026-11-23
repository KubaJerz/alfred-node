import { test } from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import { mkdtemp, readFile, writeFile } from "fs/promises";
import {
  mediaParts,
  downloadMedia,
  pickMmsFiles,
  makeMediaHost,
  contentTypeFor,
  MEDIA_ROUTE,
  MMS_MAX_BYTES,
  MMS_MAX_FILES,
} from "../telnyx/mms.js";
import { sendSms, startTelnyxWebhook } from "../telnyx/sms.js";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "mms-"));

test("mediaParts drops SMIL and text parts and names the rest", () => {
  const parts = mediaParts([
    { url: "https://m.telnyx.com/a/smil.xml", content_type: "application/smil" },
    { url: "https://m.telnyx.com/a/text_0.txt", content_type: "text/plain" },
    { url: "https://m.telnyx.com/a/IMG_1.jpeg", content_type: "image/jpeg", size: 10 },
    { url: "https://m.telnyx.com/a/abc123", content_type: "audio/amr" },
  ]);
  assert.deepEqual(parts.map((p) => [p.name, p.contentType]), [["IMG_1.jpeg", "image/jpeg"], ["part1.amr", "audio/amr"]]);
});

test("downloadMedia saves each part and skips the ones that fail", async () => {
  const dir = await tmp();
  const logs = [];
  const fetchImpl = async (url) =>
    url.endsWith("bad") ? { ok: false, status: 404 } : { ok: true, arrayBuffer: async () => Buffer.from("PIC") };
  const saved = await downloadMedia({
    media: [
      { url: "https://m/x/photo.jpg", content_type: "image/jpeg" },
      { url: "https://m/x/bad", content_type: "image/png" },
    ],
    dir,
    nameFor: (i, name) => `sms-1-${i}-${name}`,
    fetchImpl,
    log: (l) => logs.push(l),
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].path, path.join(dir, "sms-1-0-photo.jpg"));
  assert.equal(await readFile(saved[0].path, "utf8"), "PIC");
  assert.ok(logs.some((l) => /HTTP 404/.test(l)));
});

test("downloadMedia refuses a part over the size cap", async () => {
  const dir = await tmp();
  const saved = await downloadMedia({
    media: [{ url: "https://m/x/big.mp4", content_type: "video/mp4", size: 999 }],
    dir,
    nameFor: (i, n) => n,
    maxBytes: 100,
    fetchImpl: async () => assert.fail("should not fetch"),
    log: () => {},
  });
  assert.deepEqual(saved, []);
});

test("pickMmsFiles lets big photos through for transcoding but not big PDFs", async () => {
  const dir = await tmp();
  const big = Buffer.alloc(MMS_MAX_BYTES + 1);
  await writeFile(path.join(dir, "a.jpg"), big);
  await writeFile(path.join(dir, "b.pdf"), big);
  await writeFile(path.join(dir, "c.pdf"), "small");
  const { send, skip } = await pickMmsFiles([
    { path: path.join(dir, "a.jpg"), name: "attachment_0.jpg" },
    { path: path.join(dir, "b.pdf"), name: "attachment_1.pdf" },
    { path: path.join(dir, "c.pdf"), name: "attachment_2.pdf" },
    { path: path.join(dir, "gone.png"), name: "attachment_3.png" },
  ]);
  assert.deepEqual(send.map((f) => f.name), ["attachment_0.jpg", "attachment_2.pdf"]);
  assert.deepEqual(skip.map((f) => f.name), ["attachment_1.pdf", "attachment_3.png"]);
  assert.equal(send[1].contentType, "application/pdf");
});

test("pickMmsFiles stops at the per-message file limit", async () => {
  const dir = await tmp();
  const files = [];
  for (let i = 0; i < MMS_MAX_FILES + 2; i++) {
    const p = path.join(dir, `${i}.png`);
    await writeFile(p, "x");
    files.push({ path: p, name: `${i}.png` });
  }
  const { send, skip } = await pickMmsFiles(files);
  assert.equal(send.length, MMS_MAX_FILES);
  assert.equal(skip.length, 2);
});

test("contentTypeFor knows common types", () => {
  assert.equal(contentTypeFor("x.JPG"), "image/jpeg");
  assert.equal(contentTypeFor("x.pdf"), "application/pdf");
  assert.equal(contentTypeFor("x.weird"), "application/octet-stream");
});

test("the media host serves a published file until it expires", async () => {
  const dir = await tmp();
  const file = path.join(dir, "pic.png");
  await writeFile(file, "PNGDATA");
  let t = 1000;
  const host = makeMediaHost({ publicUrl: "https://box.example/", ttlMs: 500, now: () => t });
  const hook = await startTelnyxWebhook({ publicKey: "", httpRoutes: { [MEDIA_ROUTE]: host.route }, log: () => {} });
  try {
    const url = host.publish({ path: file, name: "attachment_0.png" });
    assert.match(url, /^https:\/\/box\.example\/telnyx\/media\/[0-9a-f]{32}\/attachment_0\.png$/);
    const local = hook.url + new URL(url).pathname;

    const res = await fetch(local);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(await res.text(), "PNGDATA");

    assert.equal((await fetch(`${hook.url}${MEDIA_ROUTE}${"0".repeat(32)}/x.png`)).status, 404);
    assert.equal((await fetch(local, { method: "POST", body: "x" })).status, 404);

    t += 501;
    assert.equal((await fetch(local)).status, 404);
    assert.equal(host.size, 0);
  } finally {
    await hook.close();
  }
});

test("sendSms sends media_urls as an MMS and may omit the text", async () => {
  let body;
  const fetchImpl = async (_url, opts) => {
    body = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ data: { id: "m2" } }) };
  };
  await sendSms({ apiKey: "k", from: "+1800", to: "+1555", text: "", mediaUrls: ["https://x/a.png"], fetchImpl });
  assert.deepEqual(body, { from: "+1800", to: "+1555", media_urls: ["https://x/a.png"] });
});
