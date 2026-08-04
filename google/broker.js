// The credential broker.
//
// Alfred never holds Google credentials. bot.js does, and exposes a deliberately
// small set of operations over loopback; Alfred reaches them through bin/mail.js,
// which carries no secrets of its own.
//
// This is what turns three separate promises into one mechanism:
//
//   "can't send mail"          -> there is no send route
//   "can't see login codes"    -> every response goes through screen()
//   "can't hard-delete"        -> never granted the scope in the first place
//
// A capability that doesn't exist can't be misused by a confused turn, and
// doesn't depend on Alfred reading and obeying an instruction.
//
// What this does NOT fix on its own: Alfred runs as the same Unix user as
// bot.js, so he can still read agent/var/google/token.json and call Google
// directly. That's a kernel-level fact and no amount of application code
// changes it — running the agent as a separate user is what closes it (see
// CONTRIBUTING.md). The broker is what makes that separation *useful*, because
// once the token is unreadable this is the only remaining path.

import http from "http";
import { randomBytes } from "crypto";
import { gmailClient, calendarClient } from "./auth.js";
import { classify, redact, screen } from "./mail-filter.js";

// Header rather than a query param: query strings land in logs and shell
// history, and Alfred's Bash invocations are echoed to the bot log.
const AUTH_HEADER = "x-alfred-broker";

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

// Gmail returns headers as a name/value list; pull the ones we care about.
function headerMap(payload) {
  const out = {};
  for (const h of payload?.headers || []) out[h.name.toLowerCase()] = h.value;
  return out;
}

function toMessage(msg) {
  const h = headerMap(msg.payload);
  return {
    id: msg.id,
    threadId: msg.threadId,
    ts: msg.internalDate ? Number(msg.internalDate) : null,
    from: h.from || "",
    to: h.to || "",
    subject: h.subject || "",
    snippet: msg.snippet || "",
  };
}

const ROUTES = {
  // Search returns metadata only. Bodies require an explicit fetch, so a broad
  // query can't pull a mailbox worth of content into the transcript by accident.
  "GET /mail/search": async ({ params }) => {
    const gmail = await gmailClient();
    const list = await gmail.users.messages.list({
      userId: "me",
      q: params.get("q") || "",
      maxResults: Math.min(Number(params.get("limit")) || 10, 50),
    });
    const ids = (list.data.messages || []).map((m) => m.id);
    const full = await Promise.all(
      ids.map((id) =>
        gmail.users.messages
          .get({ userId: "me", id, format: "metadata",
                 metadataHeaders: ["From", "To", "Subject", "Date"] })
          .then((r) => toMessage(r.data))
      )
    );
    // Screened before it leaves the broker — not at the CLI, which Alfred could
    // edit, and not in a prompt instruction, which he could misread.
    return { messages: screen(full) };
  },

  "GET /mail/message": async ({ params }) => {
    const id = params.get("id");
    if (!id) return { error: "id required", status: 400 };
    const gmail = await gmailClient();
    const r = await gmail.users.messages.get({ userId: "me", id, format: "full" });
    const meta = toMessage(r.data);
    const body = extractBody(r.data.payload);

    // Classified against the body too: a bland subject with the code inside is
    // exactly the shape a metadata-only check misses.
    const verdict = classify({ ...meta, body });
    if (verdict.sensitive) return { message: redact(meta) };
    return { message: { ...meta, body } };
  },

  // Draft, never send. users.messages.send is reachable with the scope we hold,
  // which is precisely why it isn't reachable here.
  "POST /mail/draft": async ({ body }) => {
    const { to, subject, text, threadId } = body || {};
    if (!to || !text) return { error: "to and text required", status: 400 };
    const gmail = await gmailClient();
    const mime = [
      `To: ${to}`,
      `Subject: ${subject || "(no subject)"}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      text,
    ].join("\r\n");
    const r = await gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: {
          threadId,
          raw: Buffer.from(mime).toString("base64url"),
        },
      },
    });
    return { draftId: r.data.id, note: "Draft saved. Sending is not available here." };
  },

  // Triage: archive, mark read, relabel. This is what gmail.modify is for, and
  // it's what makes the digest workflow work — Alfred can clear what he's
  // already summarized instead of resurfacing it every turn.
  "POST /mail/modify": async ({ body }) => {
    const { id, archive, markRead, addLabels, removeLabels } = body || {};
    if (!id) return { error: "id required", status: 400 };
    const add = [...(addLabels || [])];
    const remove = [...(removeLabels || [])];
    if (archive) remove.push("INBOX");
    if (markRead) remove.push("UNREAD");
    if (!add.length && !remove.length) {
      return { error: "nothing to change", status: 400 };
    }
    const gmail = await gmailClient();
    await gmail.users.messages.modify({
      userId: "me",
      id,
      requestBody: { addLabelIds: add, removeLabelIds: remove },
    });
    return { id, added: add, removed: remove };
  },

  "GET /mail/labels": async () => {
    const gmail = await gmailClient();
    const r = await gmail.users.labels.list({ userId: "me" });
    return {
      labels: (r.data.labels || []).map((l) => ({ id: l.id, name: l.name })),
    };
  },

  "GET /calendar/events": async ({ params }) => {
    const cal = await calendarClient();
    const r = await cal.events.list({
      calendarId: "primary",
      timeMin: params.get("from") || new Date().toISOString(),
      timeMax: params.get("to") || undefined,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: Math.min(Number(params.get("limit")) || 25, 100),
    });
    return {
      events: (r.data.items || []).map((e) => ({
        id: e.id,
        summary: e.summary || "",
        start: e.start?.dateTime || e.start?.date || null,
        end: e.end?.dateTime || e.end?.date || null,
        location: e.location || "",
      })),
    };
  },

  // Create and update, but no delete route. The ruleset governing how Alfred
  // may reshape the calendar isn't written yet, and the pattern that holds
  // everywhere else here is that an absent capability beats a rule he has to
  // remember. Removal stays a human action until those rules exist; when they
  // land, this is the place they get enforced.
  "POST /calendar/events": async ({ body }) => {
    const { summary, start, end, location, description } = body || {};
    if (!summary || !start || !end) {
      return { error: "summary, start and end required (ISO 8601)", status: 400 };
    }
    const cal = await calendarClient();
    const r = await cal.events.insert({
      calendarId: "primary",
      requestBody: {
        summary,
        location,
        description,
        // Date-only strings are all-day events; anything else carries a time.
        start: start.length === 10 ? { date: start } : { dateTime: start },
        end: end.length === 10 ? { date: end } : { dateTime: end },
      },
    });
    return { id: r.data.id, htmlLink: r.data.htmlLink };
  },

  "PATCH /calendar/events": async ({ params, body }) => {
    const id = params.get("id");
    if (!id) return { error: "id required", status: 400 };
    const { summary, start, end, location, description } = body || {};
    const patch = {};
    if (summary !== undefined) patch.summary = summary;
    if (location !== undefined) patch.location = location;
    if (description !== undefined) patch.description = description;
    if (start) patch.start = start.length === 10 ? { date: start } : { dateTime: start };
    if (end) patch.end = end.length === 10 ? { date: end } : { dateTime: end };
    if (!Object.keys(patch).length) return { error: "nothing to change", status: 400 };
    const cal = await calendarClient();
    const r = await cal.events.patch({
      calendarId: "primary",
      eventId: id,
      requestBody: patch,
    });
    return { id: r.data.id, htmlLink: r.data.htmlLink };
  },
};

function extractBody(payload, depth = 0) {
  if (!payload || depth > 8) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf8");
  }
  for (const part of payload.parts || []) {
    const found = extractBody(part, depth + 1);
    if (found) return found;
  }
  return "";
}

/**
 * Start the broker. Returns { url, token, close } — the caller hands url/token
 * to the spawned agent via env, so the shared secret never touches disk.
 */
export async function startBroker({ port = 0, log = console.log } = {}) {
  const token = randomBytes(24).toString("hex");

  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers[AUTH_HEADER] !== token) return json(res, 401, { error: "unauthorized" });

      const url = new URL(req.url, "http://127.0.0.1");
      const key = `${req.method} ${url.pathname}`;
      const route = ROUTES[key];
      if (!route) {
        return json(res, 404, {
          error: `no such operation: ${key}`,
          available: Object.keys(ROUTES),
        });
      }

      let body = null;
      if (req.method === "POST") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        // Cap the body so a runaway loop can't exhaust memory in the bot process.
        const raw = Buffer.concat(chunks).slice(0, 1_000_000).toString("utf8");
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          return json(res, 400, { error: "body must be JSON" });
        }
      }

      const out = await route({ params: url.searchParams, body });
      json(res, out?.status || 200, out);
    } catch (err) {
      // The message may name a missing credential file, which is useful, but
      // never echo a stack or token material back to the caller.
      log(`⚠️  broker: ${err.stack || err.message}`);
      json(res, 500, { error: err.message || "broker failure" });
    }
  });

  // 127.0.0.1 only. Binding 0.0.0.0 would expose the mailbox to the network.
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  log(`🔐 Credential broker on ${url} (${Object.keys(ROUTES).length} operations, no send route)`);

  return { url, token, close: () => new Promise((r) => server.close(r)) };
}

export const OPERATIONS = Object.keys(ROUTES);
