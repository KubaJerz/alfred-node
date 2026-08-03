#!/usr/bin/env node
// One-time Google consent. Run: npm run google:auth
//
// Uses the loopback redirect flow: we start a throwaway HTTP server on a free
// localhost port and hand Google that as the redirect URI. This is why the
// OAuth client has to be created as a **Desktop app** — desktop clients are
// allowed to redirect to any localhost port, so no public URL or domain
// verification is needed. Google's old copy-paste "out of band" flow was shut
// off in 2022; this replaced it.

import http from "http";
import { spawn } from "child_process";
import { google } from "googleapis";
import { loadClientSecrets, saveToken, SCOPES, TOKEN_FILE } from "./auth.js";

// This is a setup script run by a human following instructions, so a missing
// file should read as the next instruction — not a stack trace.
process.on("uncaughtException", (err) => {
  console.error(`\n❌ ${err.message}\n`);
  process.exit(1);
});

const creds = await loadClientSecrets();

const server = http.createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const redirectUri = `http://localhost:${server.address().port}`;

const auth = new google.auth.OAuth2(
  creds.client_id,
  creds.client_secret,
  redirectUri
);

const url = auth.generateAuthUrl({
  // Without offline we'd get an access token that dies in an hour and no way
  // to renew it unattended — which defeats the point for a long-running bot.
  access_type: "offline",
  scope: SCOPES,
  // Google returns a refresh token only on *first* consent for a client. If
  // you've authorized before, re-running without this yields a token file with
  // no refresh_token, which fails an hour later. Forcing the prompt makes
  // re-auth reliable.
  prompt: "consent",
});

console.log("\nOpen this URL and grant access:\n");
console.log(url + "\n");
console.log("You'll see \"Google hasn't verified this app\" — that's expected for a");
console.log("personal project. Click Advanced, then \"Go to ... (unsafe)\".\n");

// Best effort; the printed URL is the real interface.
spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();

const code = await new Promise((resolve, reject) => {
  server.on("request", (req, res) => {
    const params = new URL(req.url, redirectUri).searchParams;
    const err = params.get("error");
    const got = params.get("code");
    if (!err && !got) return; // favicon and friends
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      err
        ? `<h1>Denied</h1><p>${err}</p><p>Nothing was saved.</p>`
        : "<h1>Alfred is authorized</h1><p>You can close this tab.</p>"
    );
    err ? reject(new Error(`Consent denied: ${err}`)) : resolve(got);
  });
  setTimeout(() => reject(new Error("Timed out after 5 minutes")), 5 * 60_000);
});

server.close();

const { tokens } = await auth.getToken(code);
if (!tokens.refresh_token) {
  throw new Error(
    "Google returned no refresh_token. Revoke this app at " +
      "https://myaccount.google.com/permissions and run this again."
  );
}
await saveToken(tokens);

console.log(`✅ Saved to ${TOKEN_FILE}`);
console.log(`   Scopes: ${SCOPES.join(", ")}`);
console.log(
  "\nIf the OAuth consent screen is still in Testing, this token dies in 7 days."
);
console.log("Set publishing status to \"In production\" to stop that.\n");
