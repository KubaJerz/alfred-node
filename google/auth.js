// Shared Google credential handling.
//
// Two different credentials live here, for two different jobs:
//
//   oauth-client.json + token.json  -> the mailbox. Gmail on a personal
//     @gmail.com account can only be reached as *you*, via OAuth. A service
//     account can't: it would need domain-wide delegation, which is a Google
//     Workspace admin feature and doesn't exist for personal accounts.
//
//   pubsub-sa.json                  -> the Pub/Sub subscription. That's our own
//     cloud resource rather than personal data, so a service account is exactly
//     right there.
//
// Both live under STATE_DIR (agent/var/), which is gitignored wholesale — these
// are personal secrets, so they belong in the state layer, not next to the code.

import { google } from "googleapis";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const REPO_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const AGENT_DIR = process.env.AGENT_DIR || path.join(REPO_DIR, "agent");
const STATE_DIR = process.env.STATE_DIR || path.join(AGENT_DIR, "var");

export const GOOGLE_DIR = path.join(STATE_DIR, "google");
export const CLIENT_FILE = path.join(GOOGLE_DIR, "oauth-client.json");
export const TOKEN_FILE = path.join(GOOGLE_DIR, "token.json");
export const PUBSUB_KEY_FILE = path.join(GOOGLE_DIR, "pubsub-sa.json");

// Mail and calendar share one OAuth client, so both scopes are requested in a
// single consent. Adding one later means another browser round trip, since a
// token only carries the scopes it was granted.
//
// Each entry is the narrowest scope that does the job. What we deliberately do
// *not* request is the real security boundary here — it's enforced by Google
// rather than by our own code, so it holds even if the code is wrong:
//
//   gmail.modify        read, search, label, archive, draft. Explicitly "does
//                       not allow immediate, permanent deletion of threads and
//                       messages, bypassing the trash" — only
//                       https://mail.google.com/ can hard-delete, and we never
//                       ask for it. That's what makes "Alfred can never delete
//                       my mail" structural.
//
//   calendar.events     read and write events. Excludes creating or deleting
//                       whole calendars and changing sharing/ACLs, which full
//                       `calendar` would allow.
//
// Caveat worth keeping in view: gmail.modify *can* send. It is one of four
// scopes authorizing users.messages.send, and no Gmail scope permits drafting
// while forbidding sending. Send is therefore restricted above this layer, not
// by the grant.
export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
];

export async function loadClientSecrets() {
  if (!existsSync(CLIENT_FILE)) {
    throw new Error(
      `No OAuth client at ${CLIENT_FILE}\n` +
        `Download it from Google Cloud Console > Credentials > OAuth client ID\n` +
        `(Application type must be "Desktop app"), then save it there.`
    );
  }
  const raw = JSON.parse(await readFile(CLIENT_FILE, "utf8"));
  // Desktop clients nest under "installed"; web clients under "web".
  const creds = raw.installed || raw.web;
  if (!creds?.client_id || !creds?.client_secret) {
    throw new Error(
      `${CLIENT_FILE} doesn't look like an OAuth client file ` +
        `(no installed.client_id). Did you download a service account key by mistake?`
    );
  }
  return creds;
}

export async function saveToken(tokens) {
  await mkdir(GOOGLE_DIR, { recursive: true });
  // 0600: same-user processes can still read it, but this keeps it out of
  // reach of anything running as another account on the box.
  await writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

// An authorized OAuth2 client, or a clear error naming the setup step that's
// missing. googleapis refreshes the access token on demand from the refresh
// token, so this stays valid without us tracking expiry.
async function authorizedClient() {
  const creds = await loadClientSecrets();

  if (!existsSync(TOKEN_FILE)) {
    throw new Error(
      `Not authorized yet — no ${TOKEN_FILE}\nRun: npm run google:auth`
    );
  }
  const tokens = JSON.parse(await readFile(TOKEN_FILE, "utf8"));
  if (!tokens.refresh_token) {
    throw new Error(
      `${TOKEN_FILE} has no refresh_token, so access can't be renewed.\n` +
        `Re-run: npm run google:auth`
    );
  }

  // A token carries only the scopes it was granted. Reusing an OAuth client
  // that was previously authorized for something narrower (say a calendar-only
  // project that later added mail) yields a valid token that 403s on the new
  // API — which reads like a broken integration rather than a stale grant.
  // Name it up front instead.
  const granted = new Set((tokens.scope || "").split(" ").filter(Boolean));
  const missing = SCOPES.filter((s) => !granted.has(s));
  if (missing.length) {
    throw new Error(
      `${TOKEN_FILE} wasn't granted:\n  ${missing.join("\n  ")}\n` +
        `The token predates these scopes. Re-run: npm run google:auth`
    );
  }

  const auth = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    creds.redirect_uris?.[0] || "http://localhost"
  );
  auth.setCredentials(tokens);

  // Google issues a new access token on refresh but returns the refresh token
  // only on first consent, so persist the merged set rather than the event's.
  auth.on("tokens", (fresh) => {
    saveToken({ ...tokens, ...fresh }).catch((err) =>
      console.error(`⚠️  Couldn't persist refreshed token: ${err.message}`)
    );
  });

  return auth;
}

export async function gmailClient() {
  return google.gmail({ version: "v1", auth: await authorizedClient() });
}

export async function calendarClient() {
  return google.calendar({ version: "v3", auth: await authorizedClient() });
}
