// The Node side of voice notes: hand a downloaded audio file to the Python
// transcriber (voice/transcribe.py) and get its text back. The heavy lifting —
// ffmpeg decode + the Parakeet int8 ONNX model — lives in Python because that's
// where onnxruntime and the model are; this module is only the bridge, the same
// shape strength/plot.js draws over strength/plot.py.
//
// Spawned async (not spawnSync): a voice note takes ~3s to load the model and
// transcribe, and blocking the event loop that long would freeze the whole bot.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const TRANSCRIBE_PY = fileURLToPath(new URL("./transcribe.py", import.meta.url));

// The interpreter to run the transcriber with. Prefer an explicit override, then
// the user's standard venv (which carries onnx-asr + a static ffmpeg), then
// whatever python3 is on PATH. Kept resolvable so transcriptionAvailable() and
// the tests can gate on it.
export function pythonBin() {
  if (process.env.VOICE_PYTHON) return process.env.VOICE_PYTHON;
  const venv = path.join(os.homedir(), ".virenv/base/bin/python");
  return existsSync(venv) ? venv : "python3";
}

// The default runner: spawn Python, resolve with { code, stdout, stderr }. The
// timeout is generous — cold model load on this CPU is ~2s and a long note a few
// seconds more, but a wedged onnxruntime shouldn't hang a turn forever.
function spawnPython(audioPath, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonBin(), [TRANSCRIBE_PY, audioPath], {
      env: process.env,
      timeout: timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * True if voice transcription can run here: the interpreter exists and it can
 * import onnx_asr and reach ffmpeg. Cheap enough to call at startup; it does not
 * load the model. Mirrors strength/plot.js's plotAvailable().
 */
export function transcriptionAvailable() {
  // A tiny probe process rather than trusting a flag: catches a half-installed
  // venv the same way the real call would, without the model-load cost. It
  // checks the two things the transcriber needs beyond the interpreter —
  // onnx_asr importable and ffmpeg reachable (next to python, or on PATH).
  const probe = spawnSync(
    pythonBin(),
    ["-c", "import onnx_asr, shutil, os, sys; "
      + "sys.exit(0 if (shutil.which('ffmpeg') or "
      + "os.path.isfile(os.path.join(os.path.dirname(sys.executable),'ffmpeg'))) else 1)"],
    { stdio: "ignore" }
  );
  return probe.status === 0;
}

/**
 * Transcribe one audio file to text.
 *
 * @param {string} audioPath        the file to transcribe (Opus/Ogg, wav, …)
 * @param {object} [opts]
 * @param {Function} [opts.run]      injected runner (audioPath, opts) ->
 *                                   Promise<{code, stdout, stderr}>. Defaults to
 *                                   spawning Python; overridden in tests.
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<string>}        the transcript; "" means ran-but-silent.
 * @throws  when the transcriber can't run (missing deps/model, decode error,
 *          timeout) — exit code 2 or a spawn error. The caller distinguishes a
 *          throw ("couldn't transcribe") from "" ("heard nothing").
 */
export async function transcribe(audioPath, { run = spawnPython, timeoutMs } = {}) {
  if (!audioPath) throw new Error("transcribe: no audio path given");
  let result;
  try {
    result = await run(audioPath, { timeoutMs });
  } catch (err) {
    throw new Error(`could not run the transcriber (${pythonBin()}): ${err.message}`);
  }
  const { code, stdout, stderr } = result;
  if (code !== 0) {
    throw new Error(`transcription failed (exit ${code}): ${(stderr || "").trim().slice(-400)}`);
  }
  return (stdout || "").trim();
}
