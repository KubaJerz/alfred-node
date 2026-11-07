import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyStreamLine, makeStreamParser } from "../claude-stream.js";

// Lines in the shape that `claude -p --output-format stream-json
// --include-partial-messages --verbose` printed on 2026-11-06 for a turn with
// text, one Bash tool call, thinking, and more text. Ids are shortened.
const ev = (event, extra = {}) => JSON.stringify({ type: "stream_event", event, session_id: "s1", parent_tool_use_id: null, uuid: "u", ...extra });
const textDelta = (text, extra) => ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, extra);
const RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 2,
  result: "The clock says 9:48 PM. That matches today.",
  session_id: "s1",
};
const LINES = [
  JSON.stringify({ type: "system", subtype: "init", cwd: "/tmp/x", session_id: "s1", tools: ["Bash"], model: "m" }),
  JSON.stringify({ type: "system", subtype: "status", status: "requesting", session_id: "s1" }),
  ev({ type: "message_start", message: { id: "msg_1" } }),
  ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  textDelta("I'll check the current"),
  textDelta(" date now"),
  textDelta("."),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "I'll check the current date now." }] }, session_id: "s1" }),
  ev({ type: "content_block_stop", index: 0 }),
  ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "Bash", input: {} } }),
  ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command": "date"}' } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] }, session_id: "s1" }),
  ev({ type: "content_block_stop", index: 1 }),
  ev({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
  ev({ type: "message_stop" }),
  JSON.stringify({ type: "rate_limit_event" }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "Fri Nov  6 21:48" }] } }),
  ev({ type: "message_start", message: { id: "msg_2" } }),
  ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
  ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "The user wants" } }),
  ev({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc" } }),
  ev({ type: "content_block_stop", index: 0 }),
  ev({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
  textDelta("The clock says 9:48 PM"),
  textDelta(". That matches today."),
  ev({ type: "content_block_stop", index: 1 }),
  ev({ type: "message_stop" }),
  JSON.stringify(RESULT),
];

test("classifyStreamLine finds text deltas, text block starts, and the result", () => {
  assert.deepEqual(classifyStreamLine(JSON.parse(textDelta("Hi"))), { text: "Hi" });
  assert.deepEqual(classifyStreamLine(JSON.parse(LINES[3])), { textStart: 0 });
  assert.deepEqual(classifyStreamLine(JSON.parse(LINES[8])), { blockStop: 0 });
  assert.deepEqual(classifyStreamLine(RESULT), { result: true });
  assert.equal(classifyStreamLine(JSON.parse(LINES[9])), null); // tool_use block start
  assert.equal(classifyStreamLine(JSON.parse(LINES[10])), null); // tool input delta
  assert.equal(classifyStreamLine(JSON.parse(LINES[19])), null); // thinking delta
  assert.equal(classifyStreamLine(JSON.parse(LINES[0])), null); // system init
  assert.equal(classifyStreamLine(null), null);
  // Text from a subagent is not Alfred's reply.
  assert.equal(classifyStreamLine(JSON.parse(textDelta("sub", { parent_tool_use_id: "toolu_1" }))), null);
});

test("makeStreamParser gives the text deltas in order, with a newline at the end of each text block", () => {
  const got = [];
  const p = makeStreamParser({ onText: (t) => got.push(t) });
  p.push(LINES.join("\n") + "\n");
  p.end();
  // The thinking and tool blocks that stop in between give no newline.
  assert.deepEqual(got, ["I'll check the current", " date now", ".", "\n", "The clock says 9:48 PM", ". That matches today.", "\n"]);
  // body() is the result line, the same text as json mode prints.
  assert.deepEqual(JSON.parse(p.body()), RESULT);
});

test("makeStreamParser handles lines and UTF-8 characters split across chunks", () => {
  const got = [];
  const p = makeStreamParser({ onText: (t) => got.push(t) });
  const all = Buffer.from([textDelta("Café — naïve ✓"), JSON.stringify(RESULT)].join("\n"));
  for (let i = 0; i < all.length; i += 7) p.push(all.subarray(i, i + 7));
  p.end(); // the last line has no newline
  assert.deepEqual(got, ["Café — naïve ✓"]);
  assert.equal(JSON.parse(p.body()).result, RESULT.result);
});

test("makeStreamParser: no result line gives the plain lines, and stop() ends the text", () => {
  const got = [];
  const p = makeStreamParser({ onText: (t) => got.push(t) });
  p.push("Not logged in · Please run /login\n");
  p.push(textDelta("one") + "\n");
  p.stop();
  p.push(textDelta("two") + "\n");
  p.end();
  assert.deepEqual(got, ["one"]);
  assert.equal(p.body(), "Not logged in · Please run /login");
  assert.equal(p.resultLine, null);
});

test("makeStreamParser: an exception in onText is reported, and parsing continues", () => {
  const errors = [];
  const p = makeStreamParser({
    onText: () => {
      throw new Error("boom");
    },
    onError: (e) => errors.push(e.message),
  });
  p.push(`${textDelta("a")}\n${JSON.stringify(RESULT)}\n`);
  p.end();
  assert.deepEqual(errors, ["boom"]);
  assert.ok(p.resultLine);
});
