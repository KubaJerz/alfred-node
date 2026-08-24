// The Intervals.icu HTTP client. This is the one place INTERVALS_API_KEY is read
// and the one place it's sent, mirroring notion/client.js and google/auth.js:
// bot.js holds the key in its own environment, the broker calls through here, and
// the agent never touches it.
//
// Intervals.icu authenticates with HTTP Basic where the username is the literal
// string "API_KEY" and the password is the key itself (generated under Settings →
// Developer Settings). There is no OAuth dance and nothing persisted to disk — an
// API key is a single non-expiring secret, like Notion's, so there's no refresh
// and no consent round trip.
//
// The access boundary here is read-only *by construction*, not by convention:
// this module exposes GET and nothing else. There is no method parameter to set,
// so there is no path from any caller — a confused turn included — to a write.
// Intervals.icu can change training data and (with the right sync) push planned
// workouts back to Garmin; none of that is reachable from here, the same way
// "can't send mail" is a missing route rather than a declined one.

const BASE = "https://intervals.icu/api/v1";

function apiKey() {
  const k = process.env.INTERVALS_API_KEY;
  if (!k) {
    throw new Error(
      "INTERVALS_API_KEY is not set. Generate one at intervals.icu under " +
        "Settings → Developer Settings, then add it to .env."
    );
  }
  return k;
}

// Athlete 0 means "the authenticated athlete" to Intervals.icu, so the key alone
// identifies whose data to read — an explicit id is only needed to reach someone
// else's shared account, which this never does. INTERVALS_ATHLETE_ID overrides it
// for the rare case where the key's owner isn't the athlete of interest.
export function athleteId() {
  return process.env.INTERVALS_ATHLETE_ID || "0";
}

/**
 * One Intervals.icu API call. GET only — see the note above; this is the read
 * boundary. Returns the parsed JSON on success. On an API error, throws with
 * Intervals.icu's own message where it sends one, and carries the HTTP status so
 * the broker can pass it through instead of flattening everything to 500 (a 401
 * means a bad or missing key, a 403/404 a private or unknown activity).
 */
export async function intervals(path, query = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  // "API_KEY" is the literal username Intervals.icu expects, not a placeholder.
  const auth = Buffer.from(`API_KEY:${apiKey()}`).toString("base64");
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // A non-JSON body on an error (an HTML 500 page, say) shouldn't crash the
    // parse — keep the status meaningful and let the message carry the raw text.
    data = { message: text.slice(0, 200) };
  }
  if (!res.ok) {
    const err = new Error(
      data?.error || data?.message || `Intervals.icu returned ${res.status}`
    );
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Fetch a binary body (the activity-file download, a gzip'd FIT). Same auth as
 * `intervals`, but returns raw bytes as a Buffer rather than parsing JSON — the
 * FIT decoder needs the bytes, not a string. Still GET-only; still read.
 */
export async function intervalsFile(path, query = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  const auth = Buffer.from(`API_KEY:${apiKey()}`).toString("base64");
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) {
    const err = new Error(`Intervals.icu returned ${res.status} for ${path}`);
    err.status = res.status;
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}
