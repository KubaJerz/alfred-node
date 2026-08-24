// Run with: npm test   (node's built-in runner, no network, no credentials)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClearCommand } from "../commands.js";

test("bare /c clears and waits — empty remainder", () => {
  assert.deepEqual(parseClearCommand("/c"), { remainder: "" });
  assert.deepEqual(parseClearCommand("/clear"), { remainder: "" });
});

test("bare command is case-insensitive and tolerates trailing space", () => {
  assert.deepEqual(parseClearCommand("/C"), { remainder: "" });
  assert.deepEqual(parseClearCommand("/CLEAR  "), { remainder: "" });
});

test("/c <text> clears then carries the text as the fresh turn", () => {
  assert.deepEqual(parseClearCommand("/c what's on my calendar?"), {
    remainder: "what's on my calendar?",
  });
  assert.deepEqual(parseClearCommand("/clear summarize the day"), {
    remainder: "summarize the day",
  });
});

test("the remainder is trimmed, including across a newline after the command", () => {
  assert.deepEqual(parseClearCommand("/c   hello"), { remainder: "hello" });
  assert.deepEqual(parseClearCommand("/c\nhello"), { remainder: "hello" });
});

test("a non-command message is not a clear", () => {
  assert.equal(parseClearCommand("what's up"), null);
  assert.equal(parseClearCommand("clear the table"), null); // no leading slash
});

test("word boundary keeps look-alike commands from matching", () => {
  assert.equal(parseClearCommand("/clearance forms"), null);
  assert.equal(parseClearCommand("/court date"), null);
  assert.equal(parseClearCommand("/cancel"), null);
});

test("a slash-command that merely starts with the letters is left alone", () => {
  // "/create" must not read as "/c" + "reate".
  assert.equal(parseClearCommand("/create an event"), null);
});

test("non-string input is coerced, not thrown", () => {
  assert.equal(parseClearCommand(undefined), null);
  assert.equal(parseClearCommand(null), null);
});
