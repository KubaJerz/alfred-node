// What Ronnie does with a ToS email after triage: run the check
// (policy-check.js), move the email up when the change is a big deal, and check
// every one again 48 hours later.
//
// handleMessage files the email first, exactly as Haiku said (Records/Policies
// as a rule), and hands it here without waiting: an Opus run with web research
// takes minutes, and the queue must keep moving. Runs are serialized, so at
// most one research run is alive at a time.
//
// State lives in one small file (ronnie-policy.json): runs per day (the cap),
// the last day each company was researched (the cooldown), and the re-check
// queue — message ids and due times only, never content. The bot's 60-second
// Ronnie sweep calls drainRechecks(); a re-check fetches the message again by
// id, so nothing from the email is stored here.
//
// Escalating means: add Priority and INBOX, remove the Records labels, and ping
// with what changed. The undo handle in the ping files it back as General.

import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { checkPolicy as defaultCheck } from "./policy-check.js";
import { mailEmbed } from "./notify.js";
import { dmarcPass } from "./sender-auth.js";
import { brandOf, easternDay } from "./ledger.js";

const REPO_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const AGENT_DIR = process.env.AGENT_DIR || path.join(REPO_DIR, "agent");
const STATE_DIR = process.env.STATE_DIR || path.join(AGENT_DIR, "var");
const POLICY_FILE = path.join(STATE_DIR, "ronnie-policy.json");

export const DAILY_CAP = Number(process.env.RONNIE_POLICY_DAILY_CAP) || 10;
export const COOLDOWN_DAYS = 3;
export const RECHECK_MS = 48 * 3600_000;
const MAX_ATTEMPTS = 3;

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/**
 * @param {{
 *   broker: Function, notify: Function, labels: object,
 *   enrichOne?: (id: string) => Promise<object|null>,
 *   check?: Function, file?: string, now?: () => number, log?: Function,
 * }} deps
 */
export function makePolicy({
  broker,
  notify,
  labels = {},
  enrichOne,
  check = defaultCheck,
  file = POLICY_FILE,
  now = () => Date.now(),
  log = () => {},
}) {
  let state = null;
  let chain = Promise.resolve();
  // One research run at a time, whatever starts it.
  const serial = (fn) => (chain = chain.then(fn, fn));

  async function load() {
    if (state) return state;
    try {
      state = JSON.parse(await readFile(file, "utf8"));
    } catch {
      state = {};
    }
    state.calls = state.calls || {};
    state.companies = state.companies || {};
    state.rechecks = state.rechecks || [];
    return state;
  }

  async function save() {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(state, null, 1));
  }

  const today = () => easternDay(now());
  const overCap = () => (state.calls[today()] || 0) >= DAILY_CAP;
  const noteRun = () => {
    const d = today();
    // Keep only today's count; older days are no longer needed.
    state.calls = { [d]: (state.calls[d] || 0) + 1 };
  };

  async function escalate(msg, v, company) {
    const records = [labels.records, labels.topics?.records?.policies];
    const body = {
      id: msg.id,
      addLabels: [labels.priority, "INBOX"].filter(Boolean),
      removeLabels: records.filter(Boolean),
    };
    await broker("POST /mail/label", body);
    const summary = [v.why, v.changed ? `What changed: ${v.changed}` : ""].filter(Boolean).join(" ");
    await notify([mailEmbed({ ...msg, category: "priority", topic: "policies", summary })]);
    log(`📜 ToS change is a big deal — ${company}: ${v.why}`);
  }

  function report(company, v) {
    if (v.error) return log(`📜 ToS check for ${company} did not finish (${v.error}); left as filed`);
    const denied = v.denied?.length ? `; refused fetches: ${v.denied.join(", ")}` : "";
    log(`📜 ToS check ${company}: ${v.bigDeal ? "BIG DEAL" : "not a big deal"} (${v.confidence})${denied}`);
  }

  /**
   * A ToS email was just filed. Start its check in the background. Returns the
   * promise (tests await it; handleMessage doesn't).
   */
  function onPolicyMail(msg, { tier } = {}) {
    return serial(async () => {
      await load();
      const company = brandOf(msg.from || "");
      if (!msg.id || !company) return;
      if (tier === "priority") return; // already in front of you
      if (!dmarcPass(msg)) return log(`📜 ToS check skipped — ${company} failed DMARC`);
      const last = state.companies[company];
      if (last && daysBetween(last, today()) < COOLDOWN_DAYS) {
        return log(`📜 ToS check skipped — ${company} was researched on ${last}`);
      }
      if (overCap()) return log(`📜 ToS check skipped — daily cap of ${DAILY_CAP} reached`);
      noteRun();
      state.companies[company] = today();
      await save();

      const v = await check(msg, { dmarc: true });
      report(company, v);
      if (v.bigDeal) await escalate(msg, v, company);
      // Every ToS email gets a second look, unless it is already Priority.
      if (!v.bigDeal) {
        state.rechecks.push({ id: msg.id, company, dueAt: now() + RECHECK_MS, attempts: 0 });
      }
      await save();
    });
  }

  /** Run the re-checks that are due. Called from the Ronnie sweep. */
  function drainRechecks() {
    return serial(async () => {
      await load();
      if (!enrichOne) return;
      const due = state.rechecks.filter((r) => r.dueAt <= now());
      for (const r of due) {
        if (overCap()) {
          log(`📜 ToS re-checks held — daily cap of ${DAILY_CAP} reached`);
          break;
        }
        const msg = await enrichOne(r.id).catch(() => null);
        if (!msg) {
          state.rechecks = state.rechecks.filter((x) => x !== r);
          await save();
          continue;
        }
        noteRun();
        const v = await check(msg, { dmarc: dmarcPass(msg) });
        report(`${r.company} (48h re-check)`, v);
        if (v.error && ++r.attempts < MAX_ATTEMPTS) {
          r.dueAt = now() + 3600_000; // try again in an hour
        } else {
          state.rechecks = state.rechecks.filter((x) => x !== r);
          if (v.bigDeal) await escalate(msg, v, r.company);
        }
        await save();
      }
    });
  }

  return { onPolicyMail, drainRechecks, _state: async () => (await load(), state) };
}

export { POLICY_FILE };
