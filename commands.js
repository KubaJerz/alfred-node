// commands.js — parsing for the inline chat commands Alfred accepts in Discord.
//
// Pure and dependency-free so the branching stays unit-testable and out of the
// message handler. Today there is one command; keep new ones here too.

// "/clear" and "/c" are accepted as a *prefix*, not a bare command:
//   "/c"            -> clear the session and wait for the next message.
//   "/c <text>"     -> clear, then run <text> as the fresh session's first turn,
//                      so a single message both resets and asks (no round-trip).
//
// Returns null when the text isn't a clear command, otherwise { remainder } —
// the trimmed text after the command ("" for a bare "/c"). A word boundary
// after the command keeps "/clearance" or "/court" from matching.
export function parseClearCommand(text) {
  const s = String(text);
  const m = s.match(/^\/(?:clear|c)\b\s*/i);
  if (!m) return null;
  return { remainder: s.slice(m[0].length).trim() };
}
