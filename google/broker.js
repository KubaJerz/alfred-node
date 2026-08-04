// The credential broker.
//
// Alfred never holds Google credentials. bot.js does, and exposes a deliberately
// small set of operations over loopback; Alfred reaches them through bin/gmail.js
// and bin/gcal.js, which carry no secrets of their own.
//
// This is what turns four separate promises into one mechanism:
//
//   "can't send mail"          -> there is no send route
//   "can't see login codes"    -> every response goes through screen()
//   "can't delete mail"        -> never granted the scope in the first place
//   "can't email anyone"       -> attendees unreachable; deleting an event
//                                 with guests is refused
//
// A capability that doesn't exist can't be misused by a confused turn, and
// doesn't depend on Alfred reading and obeying an instruction.
//
// Note what is *not* on that list: deleting a calendar event. The test is
// reversibility, not how destructive a verb sounds. Google keeps deleted events
// in a Trash for 30 days and restores them intact, so removal is an ordinary
// operation; Gmail deletion would need the scope that empties Trash for good,
// which is why it stays absent.
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
import { resolveColor, toEventTime, NEVER_NOTIFY, TIMEZONE } from "./calendar-rules.js";

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

// Header values are ASCII-only per RFC 5322; anything else has to be an RFC 2047
// encoded-word. Skipping this doesn't fail loudly — the receiving client reads
// the UTF-8 bytes as latin-1, so an em dash becomes "â€”" and an accented name
// becomes noise. Alfred writes prose, so em dashes and curly quotes are the
// common case, not the exotic one.
export function encodeHeader(value) {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
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
      `Subject: ${encodeHeader(subject || "(no subject)")}`,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      // Base64 rather than raw 8-bit. charset=utf-8 describes the bytes but
      // doesn't license sending them unencoded, and a long line of prose with
      // no CRLF can also exceed the 998-octet line limit.
      Buffer.from(text, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
    ].join("\r\n");
    const r = await gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: {
          threadId,
          raw: Buffer.from(mime, "utf8").toString("base64url"),
        },
      },
    });
    return { draftId: r.data.id, note: "Draft saved. Sending is not available here." };
  },

  // A reply is not a draft with "Re:" typed into the subject. Threading lives in
  // In-Reply-To and References, which point at the original's Message-ID — get
  // those wrong and the recipient's client files it as a new conversation. So
  // the broker builds the reply from the original rather than asking Alfred to
  // assemble headers he cannot see.
  "POST /mail/reply": async ({ body }) => {
    const { id, text } = body || {};
    if (!id || !text) return { error: "id and text required", status: 400 };
    const gmail = await gmailClient();
    const r = await gmail.users.messages.get({ userId: "me", id, format: "full" });
    const h = headerMap(r.data.payload);

    // Refuse before composing. A reply quotes and addresses the original, so
    // replying to a withheld message is a way to route its content back out
    // through a path that isn't screened — and there is no sane reason to
    // answer a verification code anyway.
    const verdict = classify({
      from: h.from,
      subject: h.subject,
      snippet: r.data.snippet,
      body: extractBody(r.data.payload),
    });
    if (verdict.sensitive) {
      return { error: "that message is withheld; there is nothing to reply to", status: 403 };
    }

    const messageId = h["message-id"];
    if (!messageId) return { error: "original has no Message-ID to thread against", status: 422 };
    const to = h["reply-to"] || h.from;
    if (!to) return { error: "original has no sender to reply to", status: 422 };
    const subject = /^re:/i.test(h.subject || "") ? h.subject : `Re: ${h.subject || "(no subject)"}`;
    // References accumulates the whole chain; In-Reply-To names only the parent.
    const references = [h.references, messageId].filter(Boolean).join(" ");

    const draft = await gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: {
          threadId: r.data.threadId,
          raw: Buffer.from(
            [
              `To: ${to}`,
              `Subject: ${encodeHeader(subject)}`,
              `In-Reply-To: ${messageId}`,
              `References: ${references}`,
              "Content-Type: text/plain; charset=utf-8",
              "Content-Transfer-Encoding: base64",
              "",
              Buffer.from(text, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
            ].join("\r\n"),
            "utf8"
          ).toString("base64url"),
        },
      },
    });
    return {
      draftId: draft.data.id,
      to,
      subject,
      note: "Reply saved as a draft, in-thread. Sending is not available here.",
    };
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
      // Without this, Google formats times in the *calendar's* default zone,
      // which is not necessarily the one we write in — a calendar left on
      // Europe/Warsaw returns 18:00+02:00 for a noon Eastern meeting. Reads and
      // writes have to agree, or Alfred reports times six hours off.
      timeZone: TIMEZONE,
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

  // Delete exists, on two specific grounds — this was refused for a while, so
  // the reasoning matters.
  //
  // First, it is recoverable. Google Calendar keeps deleted events in a per-
  // calendar Trash for 30 days and restores them with guests, location and
  // description intact. That is categorically unlike Gmail, where deletion
  // needs the one scope that empties Trash for good, which we never requested.
  // The pattern here isn't "deny everything irreversible", it's "deny what
  // can't be taken back".
  //
  // Second, the rules that were missing now exist, in the gcal skill, and they
  // load themselves when calendar work starts rather than waiting to be read.
  //
  // What is still refused is deleting an event with guests on it. Google's own
  // documentation says of the notification controls that "some emails might
  // still be sent even if you set the value to false" — so on an event with
  // attendees, cancellation mail reaching real people is possible and not
  // fully in our control. "Nobody gets email because of Alfred" is the promise
  // held hardest here, so the uncontrollable case is the one carved out.
  "DELETE /calendar/events": async ({ params }) => {
    const id = params.get("id");
    if (!id) return { error: "id required", status: 400 };
    const cal = await calendarClient();
    const existing = await cal.events.get({ calendarId: "primary", eventId: id });
    if (existing.data.attendees?.length) {
      return {
        error:
          `"${existing.data.summary || id}" has ${existing.data.attendees.length} guest(s). ` +
          "Deleting it can send them cancellation email, which can't be reliably " +
          "suppressed, so this one is Kuba's to remove.",
        status: 403,
      };
    }
    await cal.events.delete({ calendarId: "primary", eventId: id, ...NEVER_NOTIFY });
    return {
      id,
      summary: existing.data.summary || "",
      note: "Deleted. Recoverable from Google Calendar's Trash for 30 days.",
    };
  },

  // Note what is *not* destructured out of the body: attendees. It isn't
  // rejected, it's unreachable — there is no path from caller input to the
  // attendees field, so "never send invitations" holds even if Alfred asks for
  // it, misreads the rules, or never read them. Attendee names belong in the
  // description, which is a convention the gcal skill explains.
  "POST /calendar/events": async ({ body }) => {
    const { summary, start, end, location, description, color } = body || {};
    if (!summary || !start || !end) {
      return { error: "summary, start and end required (ISO 8601)", status: 400 };
    }
    let colorId;
    try {
      colorId = resolveColor(color);
    } catch (err) {
      return { error: err.message, status: 400 };
    }
    const cal = await calendarClient();
    const r = await cal.events.insert({
      calendarId: "primary",
      ...NEVER_NOTIFY,
      requestBody: {
        summary,
        location,
        description,
        colorId,
        start: toEventTime(start),
        end: toEventTime(end),
      },
    });
    return { id: r.data.id, htmlLink: r.data.htmlLink };
  },

  "PATCH /calendar/events": async ({ params, body }) => {
    const id = params.get("id");
    if (!id) return { error: "id required", status: 400 };
    const { summary, start, end, location, description, color } = body || {};
    const patch = {};
    if (summary !== undefined) patch.summary = summary;
    if (location !== undefined) patch.location = location;
    if (description !== undefined) patch.description = description;
    if (start) patch.start = toEventTime(start);
    if (end) patch.end = toEventTime(end);
    if (color !== undefined) {
      try {
        patch.colorId = resolveColor(color);
      } catch (err) {
        return { error: err.message, status: 400 };
      }
    }
    if (!Object.keys(patch).length) return { error: "nothing to change", status: 400 };
    const cal = await calendarClient();
    // NEVER_NOTIFY matters more here than on insert: an event created elsewhere
    // may already carry attendees, and patching it would mail every one of them.
    const r = await cal.events.patch({
      calendarId: "primary",
      eventId: id,
      ...NEVER_NOTIFY,
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
      // PATCH belongs here as much as POST. It was missing, and the failure was
      // silent in exactly the wrong way: `PATCH /calendar/events` got body=null,
      // built an empty patch, and returned "nothing to change" — which reads as
      // "you asked for nothing" rather than "this route cannot receive input".
      // Calendar update had never once worked.
      if (req.method === "POST" || req.method === "PATCH") {
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
