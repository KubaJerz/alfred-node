import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bearerOk,
  trailingUserTexts,
  speakable,
  makeCallState,
  makeVoiceLlmRoutes,
} from "../telnyx/voice.js";
import { startTelnyxWebhook, normalizeNumber } from "../telnyx/sms.js";

const TOKEN = "s3cret-token";
const OWNER = "+15551234567";
const BASE = "/telnyx/voice/v1";

test("bearerOk accepts only the exact token", () => {
  assert.equal(bearerOk(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(bearerOk(`bearer ${TOKEN}`, TOKEN), true);
  assert.equal(bearerOk(`Bearer ${TOKEN}x`, TOKEN), false);
  assert.equal(bearerOk(TOKEN, TOKEN), false);
  assert.equal(bearerOk(undefined, TOKEN), false);
  assert.equal(bearerOk(`Bearer ${TOKEN}`, ""), false);
});

test("trailingUserTexts takes the caller words after the last assistant message", () => {
  const msgs = [
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hey" },
    { role: "user", content: "what's on today" },
    { role: "user", content: [{ type: "text", text: "and tomorrow" }] },
  ];
  assert.deepEqual(trailingUserTexts(msgs), ["what's on today", "and tomorrow"]);
  assert.deepEqual(trailingUserTexts([{ role: "assistant", content: "hi" }]), []);
});

test("speakable removes markdown and emoji", () => {
  assert.equal(
    speakable("## Plan\n- **Gym** at `6pm` 💪\n- See [the doc](https://x.y/z)\n"),
    "Plan Gym at 6pm See the doc",
  );
});

test("makeCallState does not send the same caller words two times", () => {
  const st = makeCallState();
  const turn1 = [{ role: "user", content: "a" }];
  assert.deepEqual(st.take(OWNER, turn1), ["a"]);
  // Telnyx never got the reply to "a", so the next request repeats it.
  assert.deepEqual(st.take(OWNER, [...turn1, { role: "user", content: "b" }]), ["b"]);
  st.heard(OWNER);
  const turn2 = [...turn1, { role: "user", content: "b" }, { role: "assistant", content: "ok" }, { role: "user", content: "a" }];
  assert.deepEqual(st.take(OWNER, turn2), ["a"]);
  st.missed(OWNER);
  assert.equal(st.takeMissed(OWNER), true);
  assert.equal(st.takeMissed(OWNER), false);
});

async function withServer(onTurn, fn, opts = {}) {
  const logs = [];
  const hook = await startTelnyxWebhook({
    publicKey: "",
    httpRoutes: makeVoiceLlmRoutes({
      token: TOKEN,
      allowFrom: [OWNER],
      normalize: normalizeNumber,
      onTurn,
      log: (m) => logs.push(m),
      keepAliveMs: 10,
      ...opts,
    }),
    log: () => {},
  });
  const post = (body, auth = `Bearer ${TOKEN}`, opts = {}) =>
    fetch(`${hook.url}${BASE}/chat/completions`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify(body),
      ...opts,
    });
  try {
    await fn({ post, url: hook.url, logs });
  } finally {
    await hook.close();
  }
}

const req = (text, extra = {}) => ({
  model: "alfred",
  stream: true,
  messages: [{ role: "system", content: "x" }, { role: "user", content: text }],
  extra_metadata: { telnyx_end_user_target: OWNER },
  ...extra,
});

// The content of an SSE stream, joined.
function sseText(raw) {
  return raw
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)).choices[0].delta.content || "")
    .join("");
}

test("the voice route rejects a bad token and serves /models with a good one", async () => {
  await withServer(async () => "x", async ({ post, url }) => {
    assert.equal((await post(req("hi"), "Bearer nope")).status, 401);
    assert.equal((await post(req("hi"), "")).status, 401);
    const bad = await fetch(`${url}${BASE}/models`);
    assert.equal(bad.status, 401);
    const ok = await fetch(`${url}${BASE}/models`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal((await ok.json()).data[0].id, "alfred");
  });
});

test("the voice route streams Alfred's reply as speakable text", async () => {
  const turns = [];
  await withServer(async (t) => {
    turns.push(t);
    await new Promise((r) => setTimeout(r, 40)); // long enough for pings
    return "**Sure.** It's at 6pm 🕕";
  }, async ({ post }) => {
    const res = await post(req("when is the gym"));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const raw = await res.text();
    assert.match(raw, /: ping/);
    assert.match(raw, /data: \[DONE\]/);
    assert.equal(sseText(raw), "Sure. It's at 6pm");
    assert.equal(turns.length, 1);
    assert.equal(turns[0].text, "when is the gym");
    assert.equal(turns[0].caller, OWNER);
  });
});

test("a slow turn speaks a filler line before the reply, a fast one does not", async () => {
  let delay = 60;
  await withServer(async () => {
    await new Promise((r) => setTimeout(r, delay));
    return "Here it is.";
  }, async ({ post }) => {
    assert.equal(sseText(await (await post(req("slow"))).text()), "On it, one sec. Here it is.");
    delay = 0;
    assert.equal(sseText(await (await post(req("fast"))).text()), "Here it is.");
  }, { fillerMs: 25, fillerRepeatMs: 1000 });
});

test("the voice route answers a JSON request when stream is off", async () => {
  await withServer(async () => "Done.", async ({ post }) => {
    const res = await post(req("hi", { stream: false }));
    const json = await res.json();
    assert.equal(json.choices[0].message.content, "Done.");
  });
});

test("the voice route refuses a caller not in the allow list, with no turn", async () => {
  let ran = false;
  await withServer(async () => { ran = true; return "x"; }, async ({ post }) => {
    const res = await post(req("hi", { extra_metadata: { telnyx_end_user_target: "+15550000000" } }));
    assert.match(sseText(await res.text()), /can't take calls/);
    assert.equal(ran, false);
  });
});

test("a stream that Telnyx closes early marks the reply as not heard", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const seen = [];
  await withServer(async ({ text, takeMissed }) => {
    seen.push({ text, missed: takeMissed() });
    if (seen.length === 1) await gate;
    return "reply";
  }, async ({ post, logs }) => {
    const ac = new AbortController();
    const first = post(req("first"), undefined, { signal: ac.signal });
    const res = await first;
    const reader = res.body.getReader();
    await reader.read(); // the role chunk arrived
    ac.abort();
    await new Promise((r) => setTimeout(r, 20));
    release();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(logs.some((l) => /did not hear/.test(l)));

    // Telnyx never got a reply, so it repeats "first" with the new words.
    const second = await post({
      ...req("x"),
      messages: [{ role: "user", content: "first" }, { role: "user", content: "second" }],
    });
    assert.equal(sseText(await second.text()), "reply");
    assert.deepEqual(seen, [{ text: "first", missed: false }, { text: "second", missed: true }]);
  });
});

test("the voice route serves the background MP3 with no token", async () => {
  const hook = await startTelnyxWebhook({
    publicKey: "",
    httpRoutes: makeVoiceLlmRoutes({
      token: TOKEN,
      onTurn: async () => "",
      log: () => {},
      backgroundAudio: new URL("../telnyx/assets/whoosh.mp3", import.meta.url).pathname,
    }),
    log: () => {},
  });
  try {
    const res = await fetch(`${hook.url}${BASE}/background.mp3`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "audio/mpeg");
    assert.ok((await res.arrayBuffer()).byteLength > 1000);
  } finally {
    await hook.close();
  }
});
