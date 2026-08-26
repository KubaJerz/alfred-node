// voice/transcribe.js — the Node bridge over the Python transcriber. The model
// itself is heavy and machine-provisioned, so these tests never load it: the
// bridge takes an injected `run` (the same dependency-injection shape
// strength/digest.js uses for its model) and we assert on how it maps the
// Python process's {code, stdout, stderr} into a transcript or a throw. That
// contract — trim stdout, "" means heard-nothing, non-zero exit throws with the
// tail of stderr, a spawn error is wrapped — is the whole surface bot.js leans on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { transcribe, pythonBin } from "../voice/transcribe.js";

// A canned runner: resolves with the process result you hand it, and records the
// arguments it was called with so we can assert the audio path is passed through.
function runner(result, calls) {
  return async (audioPath, opts) => {
    calls.push({ audioPath, opts });
    return result;
  };
}

test("returns the trimmed transcript on exit 0", async () => {
  const calls = [];
  const text = await transcribe("/tmp/note.ogg", {
    run: runner({ code: 0, stdout: "  hello there  \n", stderr: "" }, calls),
  });
  assert.equal(text, "hello there");
  assert.equal(calls[0].audioPath, "/tmp/note.ogg");
});

test("empty stdout on exit 0 means heard-nothing (returns \"\", does not throw)", async () => {
  const text = await transcribe("/tmp/silence.ogg", {
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  assert.equal(text, "");
});

test("a non-zero exit throws, carrying the tail of stderr", async () => {
  await assert.rejects(
    () => transcribe("/tmp/note.ogg", {
      run: async () => ({ code: 2, stdout: "", stderr: "onnx-asr not installed: boom" }),
    }),
    /transcription failed \(exit 2\).*onnx-asr not installed/s
  );
});

test("a spawn error (interpreter missing) is wrapped, not leaked raw", async () => {
  await assert.rejects(
    () => transcribe("/tmp/note.ogg", {
      run: async () => { throw new Error("ENOENT"); },
    }),
    /could not run the transcriber.*ENOENT/s
  );
});

test("no audio path is a programmer error, thrown before any spawn", async () => {
  let ran = false;
  await assert.rejects(
    () => transcribe("", { run: async () => { ran = true; return { code: 0, stdout: "x" }; } }),
    /no audio path/
  );
  assert.equal(ran, false, "must not spawn when there's nothing to transcribe");
});

test("pythonBin honours the VOICE_PYTHON override", () => {
  const saved = process.env.VOICE_PYTHON;
  try {
    process.env.VOICE_PYTHON = "/custom/python";
    assert.equal(pythonBin(), "/custom/python");
  } finally {
    if (saved === undefined) delete process.env.VOICE_PYTHON;
    else process.env.VOICE_PYTHON = saved;
  }
});
