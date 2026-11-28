// The reminder engine: the list, the tick that fires it, and the delivery
// rules. bot.js builds one service, mounts its routes on the broker
// (reminders/routes.js), and calls tick() about once a minute.
//
// Delivery is plain code, not the model, so a Claude outage cannot swallow a
// reminder. Delivery is at least once:
//
//   - tick() picks every active entry with due <= now. It never looks for an
//     exact match, so a late tick or a sleeping box still catches up.
//   - Before each attempt, the attempt count is saved. After a crash, a
//     delivery that is not confirmed is attempted again. A rare duplicate is
//     acceptable. A lost reminder is not.
//   - Discord is confirmed when sendDiscord resolves. SMS is confirmed by the
//     Telnyx delivery report (onSmsReport), not by the send call.
//
// After downtime, an occurrence that came due more than REMINDER_CATCHUP_HOURS
// ago is not sent alone. It goes in one summary message per contact.
//
// Every change goes through store.update (reminders/store.js), which
// serializes changes and saves atomically. store.update gives a copy, so the
// code here finds an entry by id inside each change and never keeps an entry
// across an await.
//
// An entry:
//   id          "r" (reminder) or "j" (job), then 3 random characters
//   kind        "reminder" | "job"
//   text        the reminder text, or a label for a job
//   job         the job name, from the allowlist in agent/jobs (kind "job")
//   at          the time of a one-time entry (UTC ISO), else null
//   rule        the rule of a repeating entry (reminders/schedule.js), else null
//   due         the next fire time (UTC ISO), or null when nothing is left
//   firstDue    the first fire time of the schedule (set by add and by a time
//               edit). The calendar event starts here.
//   snoozed     true while due is a time that snooze set
//   to, via     contact names, and a subset of ["discord", "sms"]
//   status      "active" | "done" | "cancelled"
//   occurrence  the latest fired occurrence: { at, firedAt, late, text,
//               deliveries: [{ contact, channel, state, attempts, ... }] }
//   run         the run state of a job: { state, at, attempts, nextAt, ... }
//   calendar    the Google Calendar copy: { eventId, rev, state, op, ... }
//   rev         goes up when the calendar event must change
//
// A delivery state is "pending", "sent" (SMS, waiting for its report),
// "delivered", "unconfirmed", "failed" or "cancelled". The last four are final.
//
// The list also holds:
//   digests     the catch-up summaries, with their deliveries
//   alerts      owner messages that wait for Discord
//   missed      the lines of old occurrences that wait for their summary
//
// SMS goes to "me" only. The 10DLC campaign of the number lets it text another
// person only after the opt-in steps in docs/phone-design.md: a confirmation
// text, an opt-in record, STOP records, and the owner's name in each text.
// Those steps are not built yet, so another contact gets Discord only.

import { randomInt } from "crypto";
import { parseWhen, addWait, validateRule, nextOccurrence, describeRule, formatWhen } from "./schedule.js";
import { CONTACT_NAME_RE, CHANNELS } from "./contacts.js";
import { JOB_NAME_RE } from "./jobs.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// The tunable values. reminderConfig() reads them from REMINDER_* in the env.
export const DEFAULTS = Object.freeze({
  discordMaxAttempts: 5,
  smsMaxAttempts: 3,
  smsConfirmMs: 10 * MIN,
  catchupHours: 12,
  jobRetryMs: 15 * MIN,
  jobMaxAttempts: 3,
  jobTimeoutMs: 15 * MIN, // used by bot.js for makeJobRunner
  jobWatchdogMs: MIN, // after jobTimeoutMs, the service stops waiting for a run
  tickMs: MIN, // used by bot.js for the tick timer
  maxActive: 300,
  maxContacts: 10,
  maxPerContact: 25,
  sendTimeoutMs: MIN,
});

const ENV_KEYS = {
  discordMaxAttempts: "REMINDER_DISCORD_MAX_ATTEMPTS",
  smsMaxAttempts: "REMINDER_SMS_MAX_ATTEMPTS",
  smsConfirmMs: "REMINDER_SMS_CONFIRM_MS",
  catchupHours: "REMINDER_CATCHUP_HOURS",
  jobRetryMs: "REMINDER_JOB_RETRY_MS",
  jobMaxAttempts: "REMINDER_JOB_MAX_ATTEMPTS",
  jobTimeoutMs: "REMINDER_JOB_TIMEOUT_MS",
  tickMs: "REMINDER_TICK_MS",
};

/** DEFAULTS, with each REMINDER_* value from env that is a positive number. */
export function reminderConfig(env = process.env) {
  const out = { ...DEFAULTS };
  for (const [key, name] of Object.entries(ENV_KEYS)) {
    const n = Number(env[name]);
    if (env[name] && Number.isFinite(n) && n > 0) out[key] = n;
  }
  return out;
}

const LATE_MS = 5 * MIN; // a send later than this says "sent late"
const PAST_GRACE_MS = MIN; // a time this far in the past still counts as now
const MAX_AHEAD_MS = 731 * DAY; // two years
const KEEP_FINISHED_MS = 30 * DAY;
const KEEP_PLACE_MS = DAY; // a finished entry holds its place in the caps this long
const EARLY_REPORT_MS = 30 * MIN;
const EARLY_REPORT_CAP = 500;
const BACKOFF_MIN = [1, 2, 5, 10, 30];
const CALENDAR_MAX_ATTEMPTS = 5;
const ALERT_MAX_ATTEMPTS = 3;
const MAX_TEXT = 500;
const DISCORD_MAX = 2000;
const SUMMARY_LINES = 20;
const ID_CHARS = "23456789abcdefghjkmnpqrstuvwxyz"; // no 0, 1, i, l or o: easy to read and type
const LABEL = { discord: "Discord", sms: "SMS" };
const FINAL = new Set(["delivered", "unconfirmed", "failed", "cancelled"]);
const FIELDS = ["text", "job", "at", "in", "repeat", "time", "every", "days", "day", "start", "until", "to", "via"];
const RULE_FIELDS = ["repeat", "time", "every", "days", "day", "start", "until"];
// Telnyx says one of these when the number sent STOP or a carrier blocks it.
// For STOP, the error is code 40300, "Blocked due to STOP message", with the
// detail "... due to an existing block rule". Another send cannot help.
const REFUSED_RE = /\b40300\b|opt(ed)?[\s-]?out|\bstop\b|blocked|block rule|blacklist|unsubscribed/i;
const REFUSED_CODES = new Set(["40300"]);

function bad(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const given = (v) => v !== undefined && v !== null && v !== "";
const joinAnd = (list) => (list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const iso = (ms) => new Date(ms).toISOString();
const msOf = (text) => Date.parse(text);
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const tail = (text, max) => (text.length > max ? `…${text.slice(-(max - 1))}` : text);
const backoff = (attempts) => BACKOFF_MIN[Math.min(Math.max(attempts, 1), BACKOFF_MIN.length) - 1] * MIN;
const busy = (run) => ["queued", "running", "retry"].includes(run?.state);
const oneLine = (text) => String(text ?? "").replace(/\s*\n\s*/g, " / ").trim();
// A Telnyx error can name the phone number. Routes and alerts get names only.
const scrub = (text) => String(text ?? "").replace(/\+?\d{10,15}/g, "[number]").slice(0, 500);
// See the header: SMS goes to "me" only, until the opt-in steps exist.
const smsAllowed = (name) => name === "me";
const NO_SMS = 'SMS goes to "me" only for now';
const randomId = (prefix, length) => {
  let id = prefix;
  for (let i = 0; i < length; i++) id += ID_CHARS[randomInt(ID_CHARS.length)];
  return id;
};

// fn may also throw at once. A send that never settles must not stop the tick.
function withTimeout(fn, limit, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(limit / 1000)} s`)), limit);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve().then(fn), timeout]).finally(() => clearTimeout(timer));
}

// ── The shape of a loaded list ──────────────────────────────────────────────
// The service writes every record itself, but the file is in var/, and a
// hand edit can break a record. load() drops a record that the code cannot
// read, with a log line, so that one bad record cannot stop the others.
// Each check returns what is wrong, or null.

const isText = (v) => typeof v === "string";
const isId = (v) => typeof v === "string" && v.length > 0;
const isTime = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isNames = (v) => Array.isArray(v) && v.every(isId);
const isChannels = (v) => Array.isArray(v) && v.every((c) => CHANNELS.includes(c));
const isNone = (v) => v === null || v === undefined;

function deliveryProblem(d) {
  if (!isObject(d) || !isId(d.contact) || !CHANNELS.includes(d.channel) || !isId(d.state)) {
    return "a delivery has no contact, channel or state";
  }
  if (d.state === "pending" && !isTime(d.nextAt)) return "a pending delivery has no time";
  if (d.state === "sent" && !isTime(d.sentAt)) return "a sent delivery has no send time";
  return null;
}

const deliveriesProblem = (list) =>
  Array.isArray(list) ? list.map(deliveryProblem).find(Boolean) || null : "the deliveries are not a list";

function entryProblem(e) {
  if (!isObject(e) || !isId(e.id)) return "it has no id";
  if (!["reminder", "job"].includes(e.kind)) return `kind "${e.kind}" is not reminder or job`;
  if (!["active", "done", "cancelled"].includes(e.status)) return `status "${e.status}" is not active, done or cancelled`;
  if (!isText(e.text) || (e.kind === "job" && !isId(e.job))) return "it has no text or no job name";
  if (!isNames(e.to) || !isChannels(e.via)) return "to is not a list of names, or via is not a list of channels";
  if (!isNone(e.due) && !isTime(e.due)) return "due is not a time";
  if (!isTime(e.createdAt) || !isTime(e.updatedAt) || !(isNone(e.finishedAt) || isTime(e.finishedAt))) {
    return "a change time is not a time";
  }
  if (isNone(e.rule)) {
    if (!isTime(e.at)) return "a one-time entry has no time";
  } else {
    try {
      validateRule(e.rule);
    } catch (err) {
      return `the repeat is bad: ${err.message}`;
    }
  }
  if (!isNone(e.occurrence)) {
    if (!isObject(e.occurrence) || !isTime(e.occurrence.at)) return "the last time has no time";
    const problem = deliveriesProblem(e.occurrence.deliveries);
    if (problem) return problem;
  }
  if (!isNone(e.run) && (!isObject(e.run) || !isText(e.run.state))) return "the run state is bad";
  if (e.run?.state === "retry" && !isTime(e.run.nextAt)) return "a job that waits to try again has no time";
  if (!isNone(e.calendar) && !isObject(e.calendar)) return "the calendar state is bad";
  return null;
}

function digestProblem(g) {
  if (!isObject(g) || !isId(g.id) || !isId(g.contact) || !isText(g.text)) return "it has no id, contact or text";
  return deliveriesProblem(g.deliveries);
}

const alertProblem = (a) => (isObject(a) && isId(a.id) && isText(a.text) ? null : "it has no id or text");
const missedProblem = (m) => (isObject(m) && isId(m.contact) && isChannels(m.via) && isText(m.line) ? null : "it has no contact, via or line");

/**
 * Build the reminder service.
 *
 * @param {{
 *   store: ReturnType<import("./store.js").makeStore>,
 *   contacts: Map<string, {name: string, discord?: string, sms?: string}>,
 *   jobs?: ReturnType<import("./jobs.js").makeJobRunner> | null,
 *   calendar?: ReturnType<import("./calendar-mirror.js").makeCalendarMirror> | null,
 *   sendDiscord: (userId: string, text: string) => Promise<unknown>,  // resolves when Discord accepted it
 *   discordReady?: () => boolean,
 *   sendSms: (to: string, text: string) => Promise<string>,           // resolves the Telnyx message id
 *   smsEnabled?: boolean,
 *   now?: () => number | Date,
 *   log?: (line: string) => void,
 *   note?: (line: string) => void,      // tells Alfred what went out
 *   silent?: (text: string) => boolean, // an agent-job result that must not be posted
 *   config?: Partial<typeof DEFAULTS>,
 * }} opts
 */
export function makeReminders({
  store,
  contacts,
  jobs = null,
  calendar = null,
  sendDiscord = async () => {
    throw new Error("Discord is not configured");
  },
  discordReady = () => true,
  sendSms = async () => {
    throw new Error("SMS is not configured");
  },
  smsEnabled = false,
  now = () => Date.now(),
  log = console.log,
  note = () => {},
  silent = () => false,
  config = {},
}) {
  const cfg = { ...DEFAULTS, ...config };
  const t = () => +now();
  const when = (ms) => formatWhen(new Date(ms), new Date(t()));
  const owner = contacts.get("me") || { name: "me" };

  let loaded = false;
  let ticking = false;
  const tasks = new Set(); // background work that settle() waits for
  const earlyReports = new Map(); // Telnyx message id -> { statuses, at }, for a report that came first
  let jobQueue = []; // ids of queued jobs, in run order
  let jobRunning = null; // the id of the job that runs now
  const calendarBusy = new Set(); // ids with a calendar call in flight

  const commit = (fn) => store.update(fn);
  const findIn = (data, id) => data.entries.find((e) => e.id === id);
  const normId = (id) => String(id ?? "").trim().toLowerCase().replace(/^#/, "");
  const jobKind = (name) => jobs?.available().find((j) => j.name === name)?.kind || null;
  const jobKinds = () => new Map((jobs?.available() || []).map((j) => [j.name, j.kind]));

  function ready() {
    if (!loaded) throw bad("the reminder list is not loaded yet. Try again in a moment.", 503);
  }

  function mustFind(data, id) {
    const e = findIn(data, normId(id));
    if (!e) throw bad(`no reminder or job "${normId(id)}". See them all with: node ../bin/remind.js list --all`, 404);
    return e;
  }

  // Run fn in the background. settle() waits for it. A failure is logged.
  function later(fn, what) {
    const p = Promise.resolve()
      .then(fn)
      .catch((err) => log(`⚠️  Reminders: ${what} failed: ${err.message}`))
      .finally(() => tasks.delete(p));
    tasks.add(p);
    return p;
  }

  // ── Who gets what ─────────────────────────────────────────────────────────

  // The (contact, channel) pairs that an entry reaches now, and what is missing.
  function targets(to, via) {
    const out = [];
    const skipped = [];
    for (const name of to) {
      const contact = contacts.get(name);
      if (!contact) {
        skipped.push(`${name} is not a contact now`);
        continue;
      }
      for (const channel of via) {
        if (channel === "sms" && !smsEnabled) skipped.push("SMS is off on this machine");
        else if (!contact[channel]) skipped.push(`${name} has no ${LABEL[channel]}`);
        else if (channel === "sms" && !smsAllowed(name)) skipped.push(NO_SMS);
        else out.push({ contact: name, channel });
      }
    }
    return { out, skipped: [...new Set(skipped)] };
  }

  // "me by Discord and SMS, anna by Discord"
  function reach(pairs) {
    const byContact = new Map();
    for (const { contact, channel } of pairs) byContact.set(contact, [...(byContact.get(contact) || []), channel]);
    const groups = new Map();
    for (const [name, channels] of byContact) {
      const key = joinAnd(CHANNELS.filter((c) => channels.includes(c)).map((c) => LABEL[c]));
      groups.set(key, [...(groups.get(key) || []), name]);
    }
    return [...groups].map(([channels, names]) => `${joinAnd(names)} by ${channels}`).join(", ");
  }

  // A reminder, and an agent job's result, go to contacts. A code job sends nothing.
  const sends = (e, kinds) => e.kind === "reminder" || (kinds ? kinds.get(e.job) : jobKind(e.job)) === "agent";

  function runWords(run) {
    if (run.state === "queued") return "waits to run";
    if (run.state === "running") return "runs now";
    return `try ${run.attempts + 1} at ${when(msOf(run.nextAt))}`;
  }

  // One line about an entry, for lists and change results:
  // r7k2: "Call mom" — Wed Nov 25, 5:00 PM, to me by Discord and SMS
  function line(e, kinds) {
    const what = e.kind === "job" ? `job "${e.job}"${e.text && e.text !== e.job ? ` (${e.text})` : ""}` : `"${e.text}"`;
    const snoozed = e.snoozed ? " (snoozed)" : "";
    let time;
    if (e.status === "cancelled") time = "cancelled";
    else if (e.rule) {
      time = describeRule(e.rule);
      if (e.due) time += `, next ${when(msOf(e.due))}${snoozed}`;
      else if (e.status === "done") time += ", ended";
    } else if (e.due) time = `${when(msOf(e.due))}${snoozed}`;
    else time = `${e.status === "done" ? "done, " : ""}was due ${when(msOf(e.at))}`;
    if (e.kind === "job" && e.status === "active" && busy(e.run)) time += `, ${runWords(e.run)}`;
    const who = e.status !== "cancelled" && sends(e, kinds) ? `, to ${reach(targets(e.to, e.via).out) || "nobody"}` : "";
    return `${e.id}: ${what} — ${time}${who}`;
  }

  const withSkipped = (text, skipped) => (skipped.length ? `${text}. Skipped: ${skipped.join(", ")}.` : text);

  // The public form of an entry. Contact names only: no number, no Discord id.
  function view(e, kinds) {
    const o = e.occurrence;
    return {
      id: e.id,
      kind: e.kind,
      text: e.text,
      ...(e.kind === "job" ? { job: e.job } : {}),
      status: e.status,
      due: e.due,
      dueText: e.due ? when(msOf(e.due)) : null,
      at: e.at,
      repeat: e.rule ? { ...e.rule } : null,
      repeatText: e.rule ? describeRule(e.rule) : null,
      snoozed: !!e.snoozed,
      to: [...e.to],
      via: [...e.via],
      line: line(e, kinds),
      last: o
        ? {
            at: o.at,
            atText: when(msOf(o.at)),
            firedAt: o.firedAt,
            late: !!o.late,
            // A job result as Discord got it, so "show" can answer about it.
            ...(e.kind === "job" ? { text: clip(o.text, DISCORD_MAX) } : {}),
            deliveries: o.deliveries.map((d) => ({
              contact: d.contact,
              channel: d.channel,
              state: d.state,
              attempts: d.attempts,
              ...(d.error ? { error: d.error } : {}),
            })),
          }
        : null,
      ...(e.run
        ? {
            run: {
              state: e.run.state,
              attempts: e.run.attempts,
              lastRunAt: e.run.lastRunAt || null,
              lastOk: e.run.lastOk ?? null,
              lastError: e.run.lastError || null,
            },
          }
        : {}),
      ...(e.calendar
        ? { calendar: { state: e.calendar.state, ...(e.calendar.state === "pending" ? { op: e.calendar.op } : {}) } }
        : {}),
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      finishedAt: e.finishedAt,
    };
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  function checkFields(input, { edit = false } = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("the request body must be a JSON object");
    const unknown = Object.keys(input).filter((k) => !FIELDS.includes(k) && input[k] !== undefined);
    if (unknown.length) throw bad(`unknown field: ${unknown.join(", ")}. The fields are: ${FIELDS.join(", ")}.`);
    if (edit && given(input.job)) throw bad("the job of an entry cannot change. Cancel it and add a new one.");
    return input;
  }

  function cleanText(value) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!text) throw bad("the text is missing. Say what the reminder is for (--text).");
    if (text.length > MAX_TEXT) throw bad(`the text has ${text.length} characters. The most is ${MAX_TEXT}.`);
    return text;
  }

  const contactNames = () => [...contacts.keys()].join(", ");

  // Security: a reminder reaches people by contact name only. A number or an
  // account id is refused here, so no turn can text a stranger.
  function parseTo(value) {
    if (!given(value)) return ["me"];
    const names = [
      ...new Set(
        (Array.isArray(value) ? value : String(value).split(","))
          .map((n) => String(n).trim().toLowerCase())
          .filter(Boolean)
      ),
    ];
    if (!names.length) throw bad(`say who gets it, by contact name. Contacts: ${contactNames()}.`);
    for (const name of names) {
      if (/\d{5,}/.test(name) || /^[+(]/.test(name) || /[@:<]/.test(name)) {
        throw bad(`"${name}" looks like a number or an account id. A reminder goes to contact names only. Contacts: ${contactNames()}.`);
      }
      if (!CONTACT_NAME_RE.test(name) || !contacts.has(name)) {
        throw bad(`"${name}" is not a contact. Contacts: ${contactNames()}. Only the owner can add a contact, in REMINDER_CONTACTS.`);
      }
    }
    if (names.length > cfg.maxContacts) throw bad(`one entry can go to ${cfg.maxContacts} contacts at most`);
    return names;
  }

  function parseVia(value) {
    if (!given(value)) return [...CHANNELS];
    const list = (Array.isArray(value) ? value : String(value).split(","))
      .map((v) => String(v).trim().toLowerCase())
      .filter(Boolean);
    if (list.includes("both")) return [...CHANNELS];
    const unknown = list.filter((v) => !CHANNELS.includes(v));
    if (!list.length || unknown.length) {
      throw bad(`via takes discord, sms, or both (discord,sms), not "${unknown.join(",") || value}"`);
    }
    return CHANNELS.filter((c) => list.includes(c));
  }

  // Each contact must get the entry on one channel at least. A missing channel
  // is skipped, and the result line says so.
  function checkReach(to, via) {
    const { out, skipped } = targets(to, via);
    const nothing = to.filter((name) => !out.some((p) => p.contact === name));
    if (nothing.length) {
      throw bad(`${joinAnd(nothing)} cannot get this by ${joinAnd(via.map((c) => LABEL[c]))}: ${skipped.join(", ")}.`);
    }
    return skipped;
  }

  function checkWindow(at, tNow) {
    if (at < tNow - PAST_GRACE_MS) throw bad(`${when(at)} is in the past. It is now ${when(tNow)}, Eastern.`);
    if (at > tNow + MAX_AHEAD_MS) throw bad(`${when(at)} is more than 2 years from now`);
  }

  // A repeat rule from the fields, on top of the old rule for an edit. The
  // same repeat keeps its other fields. A new repeat keeps the time and until.
  function buildRule(f, old, tNow) {
    if (!given(f.repeat) && !old) {
      throw bad("--time, --every, --days, --day, --start and --until need --repeat daily|weekly|monthly");
    }
    const freq = given(f.repeat) ? String(f.repeat).trim().toLowerCase() : old.freq;
    const base = !old ? {} : freq === old.freq ? { ...old } : { time: old.time, until: old.until };
    const input = { ...base, freq };
    for (const k of ["every", "time", "days", "day", "start"]) if (given(f[k])) input[k] = f[k];
    if (given(f.until)) input.until = String(f.until).trim().toLowerCase() === "none" ? undefined : f.until;
    let rule;
    try {
      rule = validateRule(input, new Date(tNow));
    } catch (err) {
      throw bad(err.message);
    }
    const first = nextOccurrence(rule, new Date(tNow));
    if (!first) throw bad(`"${describeRule(rule)}" has no time left: it ends before its first time`);
    checkWindow(+first, tNow);
    return { at: null, rule, due: iso(first) };
  }

  // The time fields as { at, rule, due }, or null when there are none.
  function parseSchedule(f, old, tNow) {
    const oneTime = given(f.at) || given(f.in);
    const repeat = RULE_FIELDS.some((k) => given(f[k]));
    if (!oneTime && !repeat) return null;
    if (given(f.at) && given(f.in)) throw bad("give --at or --in, not both");
    if (oneTime && repeat) throw bad("a one-time time (--at, --in) and a repeat (--repeat, --time, ...) do not go together");
    if (repeat) return buildRule(f, old, tNow);
    let at;
    try {
      at = given(f.at) ? +parseWhen(f.at, new Date(tNow)) : +addWait(new Date(tNow), f.in);
    } catch (err) {
      throw bad(err.message);
    }
    checkWindow(at, tNow);
    return { at: iso(at), rule: null, due: iso(at) };
  }

  // The caps limit the cost and the spam if a turn goes wrong. An entry holds
  // a place while it is active, and for 24 hours after it finished. So a turn
  // that adds short reminders in a loop meets the cap, also when each one
  // fires and is done at once.
  function checkCaps(data, to, selfId, { activating = true } = {}) {
    const tNow = t();
    const holds = (e) =>
      e.id !== selfId && (e.status === "active" || (!!e.finishedAt && tNow - msOf(e.finishedAt) < KEEP_PLACE_MS));
    const counted = data.entries.filter(holds);
    const why = "A finished one keeps its place for 24 hours.";
    if (activating && counted.length >= cfg.maxActive) {
      throw bad(`the list is full: ${counted.length} reminders and jobs are active or finished in the last 24 hours. The most is ${cfg.maxActive}. ${why}`);
    }
    for (const name of to) {
      if (name === "me") continue;
      const n = counted.filter((e) => e.to.includes(name)).length;
      if (n >= cfg.maxPerContact) {
        throw bad(`${name} is on ${n} reminders that are active or finished in the last 24 hours, the most allowed. ${why}`);
      }
    }
  }

  function newId(data, kind) {
    const taken = new Set(data.entries.map((e) => e.id));
    for (let i = 0; i < 500; i++) {
      const id = randomId(kind === "job" ? "j" : "r", 3);
      if (!taken.has(id)) return id;
    }
    throw new Error("no free id. Cancel or let old entries expire.");
  }

  // ── Changes ───────────────────────────────────────────────────────────────

  async function add(input = {}) {
    ready();
    const f = checkFields(input);
    const tNow = t();
    const kind = given(f.job) ? "job" : "reminder";
    let job = null;
    let text;
    if (kind === "job") {
      if (!jobs) throw bad("jobs are off on this machine");
      job = String(f.job).trim();
      if (!JOB_NAME_RE.test(job)) throw bad(`"${job}" is not a job name. A job name is lower-case letters, digits and dashes.`);
      if (!jobs.has(job)) {
        const names = jobs.available().map((j) => j.name).join(", ") || "none";
        throw bad(`no job "${job}". Jobs: ${names}. A job is a file in agent/jobs that git has committed, with no change since.`);
      }
      text = given(f.text) ? cleanText(f.text) : job;
    } else {
      text = cleanText(f.text);
    }
    const time = parseSchedule(f, null, tNow);
    if (!time) throw bad("say when: --at <time>, --in <duration>, or --repeat with --time");
    const to = parseTo(f.to);
    const via = parseVia(f.via);
    const skipped = kind === "reminder" || jobKind(job) === "agent" ? checkReach(to, via) : [];

    const e = await commit((data) => {
      checkCaps(data, to, null);
      const entry = {
        id: newId(data, kind),
        kind,
        text,
        ...(job ? { job } : {}),
        at: time.at,
        rule: time.rule,
        due: time.due,
        firstDue: time.due,
        snoozed: false,
        to,
        via,
        status: "active",
        createdAt: iso(tNow),
        updatedAt: iso(tNow),
        finishedAt: null,
        occurrence: null,
        rev: 1,
        ...(kind === "job" ? { run: { state: "idle", attempts: 0 } } : {}),
        ...(calendar && kind === "reminder"
          ? { calendar: { eventId: null, rev: 0, state: "pending", op: "create", attempts: 0, nextAt: iso(tNow) } }
          : {}),
      };
      data.entries.push(entry);
      return entry;
    });
    log(`⏰ Reminders: added ${e.id}`);
    syncCalendarLater(e.id);
    return { entry: view(e), line: withSkipped(line(e), skipped) };
  }

  /** The entries, active first by due time. kind: "reminder", "job" or "all". all: also the finished ones. */
  function list({ kind = "all", all = false } = {}) {
    const k = String(kind || "all").trim().toLowerCase().replace(/s$/, "");
    if (!["reminder", "job", "all"].includes(k)) throw bad(`kind must be reminder, job or all, not "${kind}"`);
    const kinds = jobKinds();
    const order = (e) => (e.status === "active" ? 0 : 1);
    return store
      .entries()
      .filter((e) => (k === "all" || e.kind === k) && (all || e.status === "active"))
      .sort(
        (a, b) =>
          order(a) - order(b) ||
          (a.status === "active"
            ? (a.due ? msOf(a.due) : Infinity) - (b.due ? msOf(b.due) : Infinity)
            : (b.finishedAt ? msOf(b.finishedAt) : 0) - (a.finishedAt ? msOf(a.finishedAt) : 0))
      )
      .flatMap((e) => {
        // One entry that cannot show must not hide the rest of the list.
        try {
          return [view(e, kinds)];
        } catch (err) {
          log(`⚠️  Reminders: ${e.id} cannot show: ${err.message}`);
          return [];
        }
      });
  }

  function get(id) {
    const e = findIn(store.data(), normId(id));
    return e ? view(e) : null;
  }

  async function edit(id, patch = {}) {
    ready();
    const f = checkFields(patch, { edit: true });
    if (!FIELDS.some((k) => given(f[k]))) throw bad("nothing to change");
    const tNow = t();
    let skipped = [];
    const e = await commit((data) => {
      const e = mustFind(data, id);
      if (e.status === "cancelled") throw bad(`${e.id} is cancelled. Add a new one instead.`);
      let eventChanged = false;
      if (given(f.text)) {
        const text = cleanText(f.text);
        eventChanged = text !== e.text;
        e.text = text;
      }
      const time = parseSchedule(f, e.rule, tNow);
      if (time) {
        Object.assign(e, time, { firstDue: time.due, snoozed: false });
        eventChanged = true;
        if (e.status === "done") {
          checkCaps(data, e.to, e.id);
          e.status = "active";
          e.finishedAt = null;
        }
      }
      if (given(f.to)) e.to = parseTo(f.to);
      if (given(f.via)) e.via = parseVia(f.via);
      if ((given(f.to) || given(f.via)) && sends(e)) skipped = checkReach(e.to, e.via);
      if (given(f.to) && e.status === "active") checkCaps(data, e.to, e.id, { activating: false });
      if (eventChanged && e.calendar) {
        e.rev = (e.rev || 1) + 1;
        markCalendar(e, tNow);
      }
      e.updatedAt = iso(tNow);
      return e;
    });
    syncCalendarLater(e.id);
    return { entry: view(e), line: withSkipped(line(e), skipped) };
  }

  /**
   * Move only the next fire time: { for: "30m" } or { until: <time> }. A
   * repeating entry goes back to its rule after that one. Right after a
   * reminder fired, this is "remind me again in 30 min". The calendar copy
   * does not move.
   */
  async function snooze(id, opts = {}) {
    ready();
    const by = opts?.for;
    const until = opts?.until;
    if (given(by) === given(until)) throw bad("snooze needs --for <duration> or --until <time>, one of them");
    const tNow = t();
    let target;
    try {
      target = given(by) ? +addWait(new Date(tNow), by) : +parseWhen(until, new Date(tNow));
    } catch (err) {
      throw bad(err.message);
    }
    checkWindow(target, tNow);
    let skipsRepeats = false;
    const e = await commit((data) => {
      const e = mustFind(data, id);
      if (e.status === "cancelled") throw bad(`${e.id} is cancelled. Add a new one instead.`);
      if (e.kind === "job" && busy(e.run)) throw bad(`job ${e.id} ${runWords(e.run)}. Snooze it after this run.`);
      if (e.status === "done") {
        if (e.rule) throw bad(`${e.id} has ended. To extend it, edit --until.`);
        checkCaps(data, e.to, e.id);
        e.status = "active";
        e.finishedAt = null;
      }
      if (e.rule && e.due && msOf(e.due) < target) {
        const following = nextOccurrence(e.rule, new Date(msOf(e.due)));
        skipsRepeats = !!following && +following <= target;
      }
      e.due = iso(target);
      e.snoozed = true;
      e.updatedAt = iso(tNow);
      return e;
    });
    const notes = [`Snoozed ${line(e)}.`];
    if (skipsRepeats) notes.push("The repeats before then are skipped.");
    if (e.calendar) notes.push("Google Calendar keeps the original time.");
    return { entry: view(e), line: notes.join(" ") };
  }

  /** Skip the next occurrence of a repeating entry. The calendar copy does not change. */
  async function skip(id) {
    ready();
    const tNow = t();
    let skipped = null;
    const e = await commit((data) => {
      const e = mustFind(data, id);
      if (!e.rule) throw bad(`${e.id} does not repeat. Cancel it to remove it, or snooze it to move it.`);
      if (e.status !== "active" || !e.due) throw bad(`${e.id} is ${e.status}. It has no next time to skip.`);
      skipped = msOf(e.due);
      const next = nextOccurrence(e.rule, new Date(skipped));
      e.due = next ? iso(next) : null;
      e.snoozed = false;
      if (!next && !busy(e.run)) {
        e.status = "done";
        e.finishedAt = iso(tNow);
      }
      e.updatedAt = iso(tNow);
      return e;
    });
    const cal = e.calendar ? " Google Calendar still shows the skipped time." : "";
    return { entry: view(e), line: `Skipped ${when(skipped)}. ${line(e)}.${cal}` };
  }

  /** Cancel an entry. Pending deliveries stop. The calendar copy is removed. */
  async function cancel(id) {
    ready();
    const tNow = t();
    let was = null;
    const e = await commit((data) => {
      const e = mustFind(data, id);
      was = e.status;
      if (e.status === "cancelled") return e;
      e.status = "cancelled";
      e.due = null;
      e.snoozed = false;
      e.finishedAt = iso(tNow);
      e.updatedAt = iso(tNow);
      for (const d of e.occurrence?.deliveries || []) if (!FINAL.has(d.state)) d.state = "cancelled";
      if (e.run && ["queued", "retry"].includes(e.run.state)) e.run.state = "cancelled";
      if (e.calendar) markCalendar(e, tNow);
      return e;
    });
    jobQueue = jobQueue.filter((x) => x !== e.id);
    syncCalendarLater(e.id);
    if (was === "cancelled") return { entry: view(e), line: `${e.id} was already cancelled.` };
    const what = e.kind === "job" ? `job "${e.job}"` : `"${e.text}"`;
    const running = e.run?.state === "running" ? " The run that started continues, but its result is not sent." : "";
    const cal = e.calendar?.eventId ? " The Google Calendar copy goes too." : "";
    return { entry: view(e), line: `Cancelled ${e.id}: ${what}.${running}${cal}` };
  }

  /** The contacts and the channels each can get now. Names only: no numbers, no ids. */
  function contactList() {
    return [...contacts.values()].map((c) => ({
      name: c.name,
      channels: CHANNELS.filter((ch) => c[ch] && (ch !== "sms" || (smsEnabled && smsAllowed(c.name)))),
    }));
  }

  /** The job allowlist: [{ name, kind: "code" | "agent" }]. */
  const jobList = () => (jobs ? jobs.available() : []);

  // ── Firing ────────────────────────────────────────────────────────────────

  function newDelivery({ contact, channel }, tNow) {
    return {
      contact,
      channel,
      state: "pending",
      attempts: 0,
      nextAt: iso(tNow),
      lastAttemptAt: null,
      ...(channel === "sms" ? { messageId: null, messageIds: [], sentAt: null } : {}),
      deliveredAt: null,
      error: null,
    };
  }

  // A new occurrence replaces the old one. Deliveries of the old one stop.
  function supersede(e) {
    const open = (e.occurrence?.deliveries || []).filter((d) => !FINAL.has(d.state));
    if (open.length) log(`⚠️  Reminders: ${e.id} fired again before ${plural(open.length, "delivery")} of its last time ended. Those stop.`);
  }

  // The owner hears about a failure once, by Discord. With no owner Discord,
  // or when that is the channel that failed, it goes to the log only.
  function pushAlert(data, text, { logOnly = false } = {}) {
    log(`⚠️  Reminders: ${text.replace(/^⚠️\s*/, "")}`);
    if (logOnly || !owner.discord) return;
    data.alerts.push({ id: randomId("a", 6), text, createdAt: iso(t()), attempts: 0 });
  }

  async function fireDue(tNow) {
    const ids = store
      .entries()
      .filter((e) => e.status === "active" && e.due && msOf(e.due) <= tNow)
      .map((e) => e.id);
    for (const id of ids) {
      try {
        await fireOne(id, tNow);
      } catch (err) {
        log(`⚠️  Reminders: ${id} did not fire: ${err.message}`);
      }
    }
    // The lines for the catch-up summary wait in data.missed. Each line was
    // saved in the same change as the fire of its entry. So a crash or a
    // failed save here loses no line: the next tick makes the summary.
    if (store.data().missed.length) await makeSummaries(tNow);
  }

  // Fire one due entry. An occurrence too old to send alone leaves a line in
  // data.missed for the catch-up summary.
  async function fireOne(id, tNow) {
    const result = { fired: null, queued: false };
    await commit((data) => {
      const e = findIn(data, id);
      if (!e || e.status !== "active" || !e.due || msOf(e.due) > tNow) return;
      // Walk to the latest occurrence at or before now. The ones before it do
      // not fire: a repeating entry fires once after downtime.
      let latest = msOf(e.due);
      let count = 1;
      let next = null;
      if (e.rule) {
        next = nextOccurrence(e.rule, new Date(latest));
        while (next && +next <= tNow && count < 100_000) {
          latest = +next;
          count++;
          next = nextOccurrence(e.rule, next);
        }
      }
      const old = tNow - latest > cfg.catchupHours * HOUR;
      const missedText = `due ${when(latest)}${count > 1 ? `, missed ${count} times` : ""}`;
      e.due = next ? iso(next) : null;
      e.snoozed = false;
      e.updatedAt = iso(tNow);

      if (e.kind === "job") {
        if (busy(e.run)) {
          log(`⏭️  Job ${e.job} (${e.id}) still ${e.run.state === "retry" ? "waits to try again" : "runs"}. Skipped its time at ${when(latest)}.`);
        } else if (!jobs) {
          log(`⚠️  Job ${e.job} (${e.id}) came due, but jobs are off. Skipped.`);
        } else if (old) {
          log(`⏭️  Job ${e.job} (${e.id}) was due ${when(latest)}, more than ${cfg.catchupHours} h ago. Skipped.`);
          data.missed.push({ contact: "me", via: [...CHANNELS], line: `job "${e.job}" did not run (${missedText})` });
        } else {
          e.run = { ...e.run, state: "queued", at: iso(latest), queuedAt: iso(tNow), attempts: 0, nextAt: null };
          result.queued = true;
        }
      } else if (old) {
        for (const contact of e.to) data.missed.push({ contact, via: [...e.via], line: `${e.text} (${missedText})` });
      } else {
        supersede(e);
        const late = tNow - latest > LATE_MS;
        const { out, skipped } = targets(e.to, e.via);
        e.occurrence = {
          at: iso(latest),
          firedAt: iso(tNow),
          late,
          text: e.text,
          deliveries: out.map((p) => newDelivery(p, tNow)),
        };
        const missing = e.to.filter((name) => !out.some((p) => p.contact === name));
        if (missing.length) {
          pushAlert(data, `⚠️ Reminder ${e.id} "${e.text}" did not go to ${joinAnd(missing)}: ${skipped.join(", ")}.`);
        }
        result.fired = { id: e.id, text: e.text, out, late, latest };
      }
      if (!e.due && !busy(e.run)) {
        e.status = "done";
        e.finishedAt = iso(tNow);
      }
    });
    if (result.queued && !jobQueue.includes(id)) jobQueue.push(id);
    const f = result.fired;
    if (f) note(`Reminder ${f.id} "${f.text}" went to ${reach(f.out) || "nobody"}${f.late ? `, late: it was due ${when(f.latest)}` : ""}.`);
  }

  // One summary per contact for the lines in data.missed: the occurrences that
  // came due too long ago. One change makes the summaries and empties the
  // list, so a line goes in one summary only.
  async function makeSummaries(tNow) {
    const sent = [];
    await commit((data) => {
      const byContact = new Map();
      for (const m of data.missed) {
        const s = byContact.get(m.contact) || { lines: [], via: new Set() };
        s.lines.push(m.line);
        for (const v of m.via) s.via.add(v);
        byContact.set(m.contact, s);
      }
      data.missed = [];
      for (const [name, s] of byContact) {
        const { out, skipped } = targets([name], CHANNELS.filter((c) => s.via.has(c)));
        if (!out.length) {
          // As for a reminder in time: the owner hears that it did not go.
          pushAlert(data, `⚠️ The catch-up summary did not go to ${name}: ${skipped.join(", ")}. It listed: ${clip(s.lines.join("; "), 400)}`);
          continue;
        }
        const shown = s.lines.slice(0, SUMMARY_LINES).map((l) => `• ${l}`);
        if (s.lines.length > SUMMARY_LINES) shown.push(`…and ${s.lines.length - SUMMARY_LINES} more`);
        const head =
          name === "me"
            ? "⏰ While I was offline, these came due:"
            : "⏰ Reminders from Alfred. While I was offline, these came due:";
        const taken = new Set(data.digests.map((g) => g.id));
        let id = randomId("s", 6);
        while (taken.has(id)) id = randomId("s", 6);
        data.digests.push({
          id,
          contact: name,
          createdAt: iso(tNow),
          text: [head, ...shown].join("\n"),
          deliveries: out.map((p) => newDelivery(p, tNow)),
        });
        sent.push({ out, lines: s.lines });
      }
    });
    for (const s of sent) note(`A catch-up summary went to ${reach(s.out)}. It listed: ${s.lines.join(", ")}.`);
  }

  // ── Delivery ──────────────────────────────────────────────────────────────

  // The deliveries that need a step now: a pending one whose time came, and an
  // SMS whose report did not come in time.
  function workList(tNow) {
    const needs = (d) =>
      (d.state === "pending" && msOf(d.nextAt) <= tNow) ||
      (d.state === "sent" && msOf(d.sentAt) + cfg.smsConfirmMs <= tNow);
    const refs = [];
    // load() drops a bad record. As a second guard, one record that the code
    // cannot read here does not stop the deliveries of the others.
    const each = (holder, fn) => {
      try {
        fn();
      } catch (err) {
        log(`⚠️  Reminders: skipped the deliveries of ${holder}: ${err.message}`);
      }
    };
    for (const e of store.entries()) {
      if (e.status === "cancelled" || !e.occurrence) continue;
      each(e.id, () => {
        for (const d of e.occurrence.deliveries) {
          if (needs(d)) refs.push({ entry: e.id, at: e.occurrence.at, contact: d.contact, channel: d.channel });
        }
      });
    }
    for (const g of store.data().digests) {
      each(g.id, () => {
        for (const d of g.deliveries) if (needs(d)) refs.push({ digest: g.id, contact: d.contact, channel: d.channel });
      });
    }
    return refs;
  }

  // The delivery that a ref names, with its holder, or null when it is gone.
  function locate(data, ref) {
    const same = (d) => d.contact === ref.contact && d.channel === ref.channel;
    if (ref.digest) {
      const g = data.digests.find((x) => x.id === ref.digest);
      const d = g?.deliveries.find(same);
      return d ? { g, d } : null;
    }
    const e = findIn(data, ref.entry);
    if (!e || e.status === "cancelled" || e.occurrence?.at !== ref.at) return null;
    const d = e.occurrence.deliveries.find(same);
    return d ? { e, d } : null;
  }

  function findByMessageId(data, id) {
    for (const e of data.entries) {
      for (const d of e.occurrence?.deliveries || []) if (d.messageIds?.includes(id)) return { e, d };
    }
    for (const g of data.digests) for (const d of g.deliveries) if (d.messageIds?.includes(id)) return { g, d };
    return null;
  }

  // The words of one send. "Sent late" is decided at the send, so a delivery
  // that waited (Discord down, an SMS sent again) says so too. A job result
  // is never late: an agent job can run for minutes.
  function messageFor(x) {
    if (x.g) return x.g.text;
    const o = x.e.occurrence;
    const lead = x.d.contact === "me" ? "⏰ " : "⏰ Reminder from Alfred: ";
    const late = x.e.kind === "reminder" && t() - msOf(o.at) > LATE_MS;
    return `${lead}${o.text}${late ? ` (due ${when(msOf(o.at))}, sent late)` : ""}`;
  }

  // Mark a delivery failed for good, and tell the owner. Runs inside a commit.
  function giveUp(data, x, reason) {
    x.d.state = "failed";
    x.d.error = scrub(reason);
    x.d.failedAt = iso(t());
    const what = x.g
      ? "The catch-up summary"
      : x.e.kind === "job"
        ? `The result of job "${x.e.job}" (${x.e.id})`
        : `Reminder ${x.e.id} "${x.e.text}"`;
    pushAlert(data, `⚠️ ${what} did not reach ${x.d.contact} by ${LABEL[x.d.channel]}: ${scrub(reason)}.`, {
      logOnly: x.d.contact === "me" && x.d.channel === "discord",
    });
  }

  // A failed attempt, inside a commit: try again, or give up at the cap. A send
  // error waits (1, 2, 5, 10, 30 min). A failed or missing SMS report does not.
  function retryOrGiveUp(data, x, reason, { wait }) {
    const max = x.d.channel === "sms" ? cfg.smsMaxAttempts : cfg.discordMaxAttempts;
    if (x.d.attempts >= max) return giveUp(data, x, reason);
    x.d.state = "pending";
    x.d.error = scrub(reason);
    x.d.nextAt = iso(t() + (wait ? backoff(x.d.attempts) : 0));
  }

  function failedAttempt(ref, reason) {
    return commit((data) => {
      const x = locate(data, ref);
      if (x && !FINAL.has(x.d.state)) retryOrGiveUp(data, x, reason, { wait: true });
    });
  }

  async function deliverAll(tNow) {
    for (const ref of workList(tNow)) {
      try {
        await deliverOne(ref, tNow);
      } catch (err) {
        log(`⚠️  Reminders: a delivery step failed: ${err.message}`);
      }
    }
  }

  async function deliverOne(ref, tNow) {
    const x = locate(store.data(), ref);
    if (!x) return;
    if (x.d.state === "sent") {
      // No report in time. When that makes it pending again, send it now.
      await confirmTimeout(ref, tNow);
      if (locate(store.data(), ref)?.d.state === "pending") return deliverOne(ref, tNow);
      return;
    }
    const address = contacts.get(x.d.contact)?.[x.d.channel];
    const off = x.d.channel === "sms" && !smsEnabled;
    // targets() never makes such a delivery. This holds for a hand-edited list too.
    const barred = x.d.channel === "sms" && !smsAllowed(x.d.contact);
    if (!address || off || barred) {
      const why = off ? "SMS is off on this machine" : barred ? NO_SMS : `${x.d.contact} has no ${LABEL[x.d.channel]} now`;
      return commit((data) => {
        const y = locate(data, ref);
        if (y && !FINAL.has(y.d.state)) giveUp(data, y, why);
      });
    }
    if (x.d.channel === "discord" && !discordReady()) return; // wait: this is not an attempt
    const text = messageFor(x);
    // Count the attempt before it starts, so that a crash cannot hide it.
    const go = await commit((data) => {
      const y = locate(data, ref);
      if (!y || y.d.state !== "pending") return false;
      y.d.attempts += 1;
      y.d.lastAttemptAt = iso(t());
      return true;
    });
    if (!go) return;
    if (x.d.channel === "discord") return attemptDiscord(ref, address, text);
    return attemptSms(ref, address, text);
  }

  async function attemptDiscord(ref, userId, text) {
    try {
      await withTimeout(() => sendDiscord(userId, clip(text, DISCORD_MAX)), cfg.sendTimeoutMs, "Discord send");
    } catch (err) {
      return failedAttempt(ref, `Discord: ${err.message}`);
    }
    await commit((data) => {
      const y = locate(data, ref);
      if (!y || y.d.state !== "pending") return;
      y.d.state = "delivered";
      y.d.deliveredAt = iso(t());
      y.d.error = null;
    });
  }

  async function attemptSms(ref, number, text) {
    let id;
    try {
      id = await withTimeout(() => sendSms(number, text), cfg.sendTimeoutMs, "SMS send");
    } catch (err) {
      if (REFUSED_RE.test(err.message)) {
        // The number sent STOP, or a carrier blocks it: final at once.
        return commit((data) => {
          const y = locate(data, ref);
          if (y && !FINAL.has(y.d.state)) giveUp(data, y, `the number does not take texts (${err.message})`);
        });
      }
      return failedAttempt(ref, err.message);
    }
    await commit((data) => {
      const y = locate(data, ref);
      if (!y || y.d.state !== "pending") return;
      if (!id) {
        // With no message id, no report can match, and a new send cannot help.
        y.d.state = "unconfirmed";
        y.d.error = "Telnyx gave no message id";
        log(`📵 Reminders: an SMS to ${y.d.contact} went, but Telnyx gave no message id. It is not sent again.`);
        return;
      }
      y.d.state = "sent";
      y.d.messageId = id;
      y.d.messageIds = [...(y.d.messageIds || []), id];
      y.d.sentAt = iso(t());
    });
    const early = id && earlyReports.get(id);
    if (early) {
      earlyReports.delete(id);
      await applyReport(id, early.statuses, early.errors);
    }
  }

  // No report within the confirm window: send again, or give up at the cap.
  function confirmTimeout(ref, tNow) {
    return commit((data) => {
      const x = locate(data, ref);
      if (!x || x.d.state !== "sent" || msOf(x.d.sentAt) + cfg.smsConfirmMs > tNow) return;
      retryOrGiveUp(data, x, `no delivery report within ${Math.round(cfg.smsConfirmMs / MIN)} min`, { wait: false });
    });
  }

  /**
   * A Telnyx message.finalized report: { id, statuses, errors } with the
   * status of each recipient and the codes of its errors. bot.js calls this
   * from the messaging webhook.
   */
  async function onSmsReport({ id, statuses, errors } = {}) {
    if (!id) return;
    const list = (Array.isArray(statuses) ? statuses : [statuses]).filter(Boolean).map(String);
    const codes = (Array.isArray(errors) ? errors : []).filter(Boolean).map(String);
    if (!loaded || !findByMessageId(store.data(), id)) {
      park(id, list, codes);
      return;
    }
    await applyReport(id, list, codes);
  }

  // Keep a report that matches no delivery yet. It can come before the send
  // call returns its id, or while the list loads. The map keeps a report 30
  // min at most, and 500 reports at most: every SMS of the bot gets a report.
  function park(id, statuses, errors) {
    const tNow = t();
    for (const [k, r] of earlyReports) if (tNow - r.at > EARLY_REPORT_MS) earlyReports.delete(k);
    earlyReports.delete(id);
    earlyReports.set(id, { statuses, errors, at: tNow });
    while (earlyReports.size > EARLY_REPORT_CAP) earlyReports.delete(earlyReports.keys().next().value);
  }

  async function applyReport(id, statuses, errors = []) {
    const has = (s) => statuses.includes(s);
    const verdict = has("delivered")
      ? "delivered"
      : has("delivery_unconfirmed")
        ? "unconfirmed"
        : has("sending_failed") || has("delivery_failed")
          ? "failed"
          : null;
    if (!verdict) return; // an interim status: wait for the final one
    await commit((data) => {
      const x = findByMessageId(data, id);
      if (!x || FINAL.has(x.d.state)) return;
      if (verdict === "failed") {
        // Only a failure of the latest send counts. The failure of an older
        // send changes nothing while a newer one is out.
        if (x.d.messageId !== id || x.d.state !== "sent") return;
        if (errors.some((code) => REFUSED_CODES.has(code))) {
          // The number sent STOP: final at once, as for a refused send.
          giveUp(data, x, `the number does not take texts (Telnyx error ${errors.join(", ")})`);
          return;
        }
        retryOrGiveUp(data, x, `Telnyx reported ${statuses.join(", ")}`, { wait: false });
        return;
      }
      if (verdict === "delivered") {
        x.d.state = "delivered";
        x.d.deliveredAt = iso(t());
        x.d.error = null;
        return;
      }
      // The carrier gives no confirmation for this number. A new send cannot change that.
      x.d.state = "unconfirmed";
      x.d.error = "the carrier did not confirm delivery";
      log(`📵 Reminders: an SMS to ${x.d.contact} is delivery_unconfirmed. The carrier does not confirm, so it is not sent again.`);
    });
  }

  // Owner alerts go out together in one Discord message, as many as fit.
  async function sendAlerts() {
    const pending = store.data().alerts;
    if (!pending.length || !owner.discord || !discordReady()) return;
    const batch = [];
    let size = 0;
    for (const a of pending) {
      if (batch.length && size + a.text.length + 1 > DISCORD_MAX) break;
      batch.push(a);
      size += a.text.length + 1;
    }
    let error = null;
    try {
      const text = clip(batch.map((a) => a.text).join("\n"), DISCORD_MAX);
      await withTimeout(() => sendDiscord(owner.discord, text), cfg.sendTimeoutMs, "Discord send");
    } catch (err) {
      error = err;
    }
    const ids = new Set(batch.map((a) => a.id));
    await commit((data) => {
      if (!error) {
        data.alerts = data.alerts.filter((a) => !ids.has(a.id));
        return;
      }
      for (const a of data.alerts) if (ids.has(a.id)) a.attempts += 1;
      const dropped = data.alerts.filter((a) => ids.has(a.id) && a.attempts >= ALERT_MAX_ATTEMPTS);
      if (dropped.length) {
        log(`⚠️  Reminders: could not tell the owner (${error.message}). Dropped: ${dropped.map((a) => a.text).join(" | ")}`);
        data.alerts = data.alerts.filter((a) => !dropped.includes(a));
      }
    });
  }

  // ── Jobs ──────────────────────────────────────────────────────────────────

  // A failed run: try again after jobRetryMs, or give up at the cap and tell
  // the owner. Runs inside a commit.
  function jobFailed(data, e, error, tEnd) {
    e.run.lastOk = false;
    e.run.lastError = tail(String(error || "failed"), 500);
    if (e.run.attempts < cfg.jobMaxAttempts) {
      e.run.state = "retry";
      e.run.nextAt = iso(tEnd + cfg.jobRetryMs);
      return;
    }
    e.run.state = "failed";
    e.run.nextAt = null;
    pushAlert(data, `⚠️ Job "${e.job}" (${e.id}) failed ${plural(e.run.attempts, "time")}. The end of the error: ${tail(String(error || "failed"), 300)}`);
  }

  // A run that no code in this process runs: the bot stopped during it, or
  // the save at the end of it failed. It counts as a failed try and runs
  // again at once. Runs inside a commit.
  function endStaleRun(data, e, why, tNow) {
    if (e.status === "cancelled") {
      e.run.state = "cancelled";
      return;
    }
    jobFailed(data, e, why, tNow);
    if (e.run.state === "retry") e.run.nextAt = iso(tNow);
    if (!e.due && !busy(e.run) && e.status === "active") {
      e.status = "done";
      e.finishedAt = iso(tNow);
    }
  }

  // The ids of the queued jobs that are not in jobQueue, oldest first.
  function waitingJobs() {
    return store
      .entries()
      .filter((e) => e.kind === "job" && e.status !== "cancelled" && e.run?.state === "queued")
      .filter((e) => e.id !== jobRunning && !jobQueue.includes(e.id))
      .sort((a, b) => (a.run.queuedAt ? msOf(a.run.queuedAt) : 0) - (b.run.queuedAt ? msOf(b.run.queuedAt) : 0))
      .map((e) => e.id);
  }

  async function jobsDue(tNow) {
    const retry = (e) => e.status !== "cancelled" && e.run?.state === "retry" && msOf(e.run.nextAt) <= tNow;
    const stale = (e) => e.run?.state === "running" && e.id !== jobRunning;
    if (store.entries().some((e) => e.kind === "job" && (retry(e) || stale(e)))) {
      await commit((data) => {
        for (const e of data.entries) {
          if (e.kind !== "job") continue;
          if (stale(e)) endStaleRun(data, e, "the result of the run was not saved", tNow);
          if (retry(e)) Object.assign(e.run, { state: "queued", queuedAt: iso(tNow) });
        }
      });
    }
    // This also returns a job to the queue when the save of its start failed.
    // Its state is still "queued", but pumpJobs removed it from the queue.
    jobQueue.push(...waitingJobs());
    pumpJobs();
  }

  // Start the next queued job when none runs. One job runs at a time, and
  // tick() never waits for one.
  function pumpJobs() {
    if (jobRunning || !jobs) return;
    while (jobQueue.length) {
      const id = jobQueue.shift();
      const e = findIn(store.data(), id);
      if (!e || e.status === "cancelled" || e.run?.state !== "queued") continue;
      jobRunning = id;
      later(async () => {
        try {
          await runJob(id);
        } finally {
          jobRunning = null;
          pumpJobs();
        }
      }, `job ${e.job}`);
      return;
    }
  }

  async function runJob(id) {
    // Save "running" first. After a crash, load() counts it as a failed try.
    const started = await commit((data) => {
      const e = findIn(data, id);
      if (!e || e.status === "cancelled" || e.run?.state !== "queued") return null;
      e.run.state = "running";
      e.run.attempts += 1;
      e.run.startedAt = iso(t());
      return { job: e.job, attempt: e.run.attempts };
    });
    if (!started) return;
    log(`🛠️  Job ${started.job} (${id}) started, try ${started.attempt}`);
    let r;
    try {
      // jobs.run has its own timeout. This one keeps the queue moving if that
      // one fails to end the run.
      r = await withTimeout(() => jobs.run(started.job), cfg.jobTimeoutMs + cfg.jobWatchdogMs, `job ${started.job}`);
    } catch (err) {
      r = { ok: false, output: "", error: err.message };
    }
    r = r || { ok: false, output: "", error: "no result" };
    log(`🛠️  Job ${started.job} (${id}) ${r.ok ? "finished" : `failed: ${tail(String(r.error || ""), 200)}`}`);

    let posted = null;
    await commit((data) => {
      const e = findIn(data, id);
      if (!e?.run) return;
      const tEnd = t();
      e.run.lastRunAt = iso(tEnd);
      e.updatedAt = iso(tEnd);
      if (e.status === "cancelled") {
        e.run.state = "cancelled";
        return;
      }
      if (r.ok) {
        Object.assign(e.run, { state: "idle", attempts: 0, nextAt: null, lastOk: true, lastError: null });
        const text = String(r.output || "").trim();
        // An agent job's result goes out like a reminder. A code job sends nothing.
        if ((r.kind || jobKind(e.job)) === "agent" && text && !silent(text)) {
          supersede(e);
          const { out } = targets(e.to, e.via);
          e.occurrence = {
            at: e.run.at || iso(tEnd),
            firedAt: iso(tEnd),
            late: false,
            text: clip(text, 4000),
            deliveries: out.map((p) => newDelivery(p, tEnd)),
          };
          posted = { job: e.job, out, text };
        }
      } else {
        jobFailed(data, e, r.error, tEnd);
      }
      if (!e.due && !busy(e.run) && e.status === "active") {
        e.status = "done";
        e.finishedAt = iso(tEnd);
      }
    });
    // The note carries the result, so Alfred can answer a reply to it. He does
    // not see the Discord history.
    if (posted) {
      note(`Job ${id} "${posted.job}" ran. Its result went to ${reach(posted.out) || "nobody"}: "${clip(oneLine(posted.text), 1000)}"`);
    }
  }

  // ── Calendar copy ─────────────────────────────────────────────────────────
  // Best effort and never in the way: the entry is saved first, and a failed
  // call leaves calendar: { state: "pending", op } for tick() to try again.

  // What the copy needs now: "create", "update", "remove", or null.
  function calendarOp(e) {
    const c = e.calendar;
    if (!c) return null;
    if (e.status === "cancelled") return c.eventId ? "remove" : null;
    if (!c.eventId) return "create";
    return (c.rev || 0) < (e.rev || 1) ? "update" : null;
  }

  // After a change: record what the copy needs, with fresh retries.
  function markCalendar(e, tNow) {
    const op = calendarOp(e);
    if (!op) {
      e.calendar.state = e.calendar.eventId ? "ok" : "none";
      delete e.calendar.op;
      return;
    }
    Object.assign(e.calendar, { state: "pending", op, attempts: 0, nextAt: iso(tNow), error: null });
  }

  function syncCalendarLater(id) {
    if (calendar) later(() => syncCalendar(id), "the calendar copy");
  }

  async function syncCalendar(id) {
    if (!calendar || calendarBusy.has(id)) return;
    const e = findIn(store.data(), id);
    const op = e && calendarOp(e);
    if (!op || e.calendar.state === "failed") return;
    calendarBusy.add(id);
    let more = false;
    try {
      const snapshot = structuredClone(e);
      let eventId = snapshot.calendar.eventId;
      let error = null;
      try {
        if (op === "create") eventId = await calendar.create(snapshot);
        else if (op === "update") eventId = (await calendar.update(snapshot)) || eventId;
        else await calendar.remove(eventId, snapshot.id);
      } catch (err) {
        error = err;
      }
      await commit((data) => {
        const x = findIn(data, id);
        if (!x?.calendar) return;
        const c = x.calendar;
        if (error) {
          c.attempts = (c.attempts || 0) + 1;
          c.op = op;
          c.error = String(error.message || error).slice(0, 300);
          if (c.attempts >= CALENDAR_MAX_ATTEMPTS) {
            c.state = "failed";
            log(`⚠️  Reminders: the Google Calendar copy of ${id} failed ${c.attempts} times (${c.error}). Stopped.`);
          } else {
            c.state = "pending";
            c.nextAt = iso(t() + backoff(c.attempts));
          }
          return;
        }
        if (op === "remove") c.eventId = null;
        else Object.assign(c, { eventId, rev: snapshot.rev || 1 });
        // A change during the call can leave more to do.
        const next = calendarOp(x);
        if (next) {
          Object.assign(c, { state: "pending", op: next, attempts: 0, nextAt: iso(t()), error: null });
          more = true;
        } else {
          Object.assign(c, { state: op === "remove" ? "removed" : "ok", attempts: 0, error: null });
          delete c.op;
          delete c.nextAt;
        }
      });
    } finally {
      calendarBusy.delete(id);
    }
    if (more) await syncCalendar(id);
  }

  function calendarDue(tNow) {
    if (!calendar) return;
    for (const e of store.entries()) {
      if (e.calendar?.state === "pending" && msOf(e.calendar.nextAt) <= tNow && !calendarBusy.has(e.id)) {
        syncCalendarLater(e.id);
      }
    }
  }

  // ── Upkeep ────────────────────────────────────────────────────────────────

  // Drop finished entries after 30 days, summaries that are done, and old
  // unmatched reports.
  async function prune(tNow) {
    for (const [id, r] of earlyReports) if (tNow - r.at > EARLY_REPORT_MS) earlyReports.delete(id);
    const expired = (e) =>
      e.status !== "active" &&
      e.finishedAt &&
      tNow - msOf(e.finishedAt) > KEEP_FINISHED_MS &&
      !(calendarOp(e) && e.calendar.state !== "failed") &&
      !calendarBusy.has(e.id) &&
      e.run?.state !== "running";
    const spent = (g) => g.deliveries.every((d) => FINAL.has(d.state));
    const data = store.data();
    if (!data.entries.some(expired) && !data.digests.some(spent)) return;
    await commit((d) => {
      d.entries = d.entries.filter((e) => !expired(e));
      d.digests = d.digests.filter((g) => !spent(g));
    });
  }

  /**
   * Read the list. Call once at startup, before the first tick. A job that was
   * running when the bot stopped counts as a failed try and runs again.
   */
  // Drop each record that the code cannot read, with a log line (see the
  // shape checks at the top). Runs inside a commit.
  function dropBad(data) {
    const keep = (list, problemOf, what) =>
      list.filter((x) => {
        const problem = problemOf(x);
        if (problem) log(`⚠️  Reminders: dropped ${what} ${isId(x?.id) ? x.id : "with no id"} from the list: ${problem}`);
        return !problem;
      });
    data.entries = keep(data.entries, entryProblem, "entry");
    data.digests = keep(data.digests, digestProblem, "summary");
    data.alerts = keep(data.alerts, alertProblem, "alert");
    data.missed = keep(data.missed, missedProblem, "summary line");
    for (const a of data.alerts) if (typeof a.attempts !== "number") a.attempts = 0;
  }

  async function load() {
    await store.load();
    const tNow = t();
    await commit((data) => {
      dropBad(data);
      for (const e of data.entries) {
        if (e.kind === "job" && e.run?.state === "running") endStaleRun(data, e, "the bot stopped while the job ran", tNow);
      }
    });
    jobQueue = [];
    jobQueue.push(...waitingJobs());
    loaded = true;
    // A report that came while the list loaded can match a delivery now.
    for (const [id, r] of [...earlyReports]) {
      if (!findByMessageId(store.data(), id)) continue;
      earlyReports.delete(id);
      try {
        await applyReport(id, r.statuses, r.errors);
      } catch (err) {
        log(`⚠️  Reminders: an SMS report did not apply: ${err.message}`);
      }
    }
    const total = store.entries().length;
    const active = store.entries().filter((e) => e.status === "active").length;
    log(`⏰ Reminders: ${active} active of ${total} in the list`);
    return { entries: total, active };
  }

  /**
   * One pass: fire what is due, step the deliveries, tell the owner about
   * failures, start jobs, retry calendar calls, and drop old entries. Resolves
   * false at once when a tick already runs or the list is not loaded. A step
   * that fails is logged. tick() never rejects.
   */
  async function tick() {
    if (!loaded || ticking) return false;
    ticking = true;
    try {
      const tNow = t();
      const steps = [
        ["fire", fireDue],
        ["delivery", deliverAll],
        ["alert", sendAlerts],
        ["job", jobsDue],
        ["calendar", calendarDue],
        ["prune", prune],
      ];
      for (const [name, step] of steps) {
        try {
          await step(tNow);
        } catch (err) {
          log(`⚠️  Reminders: the ${name} step of a tick failed: ${err.message}`);
        }
      }
      return true;
    } finally {
      ticking = false;
    }
  }

  /** Wait for the background work (calendar calls, job runs) to finish. For tests and shutdown. */
  async function settle() {
    while (tasks.size) await Promise.allSettled([...tasks]);
  }

  return { load, tick, onSmsReport, add, list, get, edit, snooze, skip, cancel, contactList, jobList, settle };
}
