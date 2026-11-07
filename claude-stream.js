// Read the output of `claude -p --output-format stream-json
// --include-partial-messages --verbose`, one JSON object per line.
//
// runClaude uses this only for a phone call turn that speaks its reply while
// Alfred writes it. Every other turn keeps `--output-format json`.
//
// The lines that matter:
//   {"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"text"}}}
//   {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}
//   {"type":"stream_event","event":{"type":"content_block_stop","index":0}}
//   {"type":"result","result":"...","session_id":"...","is_error":false,...}
// The "result" line is the same object that json mode prints. Other lines
// (system, assistant, user, tool input deltas, thinking) carry no spoken text.
//
// The text deltas include text that Alfred writes before a tool call ("Let me
// check."), and text from each assistant message of the turn. The result has
// only the text of the last message. At the end of each text block, the parser
// gives a "\n". Then the text before a tool call is a complete unit at once
// (it does not wait for the tool), and two texts do not run together.

import { StringDecoder } from "node:string_decoder";

// The spoken text in one parsed line. Returns { text } for a text delta,
// { textStart: index } for the start of a text block, { blockStop: index } for
// the end of any block, { result: true } for the final line, or null. A line
// from a subagent (parent_tool_use_id set) is not Alfred's reply: null.
export function classifyStreamLine(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (obj.type === "result") return { result: true };
  if (obj.type !== "stream_event" || obj.parent_tool_use_id) return null;
  const ev = obj.event;
  if (ev?.type === "content_block_start" && ev.content_block?.type === "text") return { textStart: ev.index ?? 0 };
  if (ev?.type === "content_block_stop") return { blockStop: ev.index ?? 0 };
  if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
    return { text: ev.delta.text };
  }
  return null;
}

// A line parser for the stdout of the child. push() takes Buffers or strings
// in any split. onText(delta) gets each text delta in order. An exception in
// onText is caught, so it cannot stop the turn.
//
// After end(), body() gives the text that json mode would print: the raw
// "result" line. Without a result line (the child failed early), it gives the
// lines that are not JSON, for example a plain error message.
export function makeStreamParser({ onText = () => {}, onError = () => {} } = {}) {
  const decoder = new StringDecoder("utf8");
  let buf = "";
  let resultLine = null;
  const plain = [];
  let textBlock = null; // the index of the open text block
  let stopped = false;

  const emit = (t) => {
    if (stopped || !t) return;
    try {
      onText(t);
    } catch (err) {
      onError(err);
    }
  };

  const line = (raw) => {
    if (!raw.trim()) return;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      plain.push(raw);
      return;
    }
    const c = classifyStreamLine(obj);
    if (!c) return;
    if (c.result) resultLine = raw;
    else if ("textStart" in c) textBlock = c.textStart;
    else if ("blockStop" in c) {
      if (c.blockStop !== textBlock) return;
      textBlock = null;
      emit("\n");
    } else if (c.text) emit(c.text);
  };

  const drain = () => {
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      line(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  };

  return {
    push(chunk) {
      buf += typeof chunk === "string" ? chunk : decoder.write(chunk);
      drain();
    },
    end() {
      buf += decoder.end();
      drain();
      if (buf) line(buf);
      buf = "";
    },
    // Stop the onText calls (the turn was aborted). Parsing continues.
    stop() {
      stopped = true;
    },
    body() {
      return resultLine ?? plain.join("\n");
    },
    get resultLine() {
      return resultLine;
    },
  };
}
