// MMS: pictures, files and voice messages over Alfred's number. Two halves.
//
// In: Telnyx puts each part of an inbound MMS in payload.media as a URL. The
// URLs are short-lived, so downloadMedia() saves the parts at once, before the
// turn is queued. The text of an MMS is in payload.text; some carriers also
// send it as a text/plain part, and most add a SMIL layout part. Both are
// skipped.
//
// Out: Telnyx sends an MMS by fetching each file from a public URL. Nothing on
// this box is public except the webhook server behind the tunnel, so
// makeMediaHost() serves a file there under a random, unguessable path for a
// short time (MEDIA_TTL_MS), then forgets it. The path is the only guard, as
// with any presigned link: it is 128 random bits, and it names one file.

import crypto from "crypto";
import path from "path";
import { createReadStream } from "fs";
import { mkdir, stat, writeFile } from "fs/promises";

export const MMS_MAX_FILES = 10; // Telnyx: up to 10 media per MMS
// Per file. 1 MB is the long-code limit at AT&T. With mms_transcoding on the
// messaging profile, Telnyx shrinks a larger photo or video itself, so those
// may be bigger; anything else over 1 MB stays out of the text.
export const MMS_MAX_BYTES = 1024 * 1024;
export const MMS_MAX_TRANSCODE_BYTES = 5 * 1024 * 1024;
export const MEDIA_IN_MAX_BYTES = 10 * 1024 * 1024;
export const MEDIA_ROUTE = "/telnyx/media/";
export const MEDIA_TTL_MS = 60 * 60 * 1000; // Telnyx fetches at once, and retries for a while

const SKIP_TYPES = /^(application\/smil|text\/plain)/i;

const EXT_BY_TYPE = {
  "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/gif": ".gif",
  "image/heic": ".heic", "image/heif": ".heif", "image/webp": ".webp", "image/bmp": ".bmp",
  "video/mp4": ".mp4", "video/3gpp": ".3gp", "video/quicktime": ".mov",
  "audio/amr": ".amr", "audio/amr-wb": ".awb", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a",
  "audio/aac": ".aac", "audio/mpeg": ".mp3", "audio/ogg": ".ogg", "audio/wav": ".wav",
  "audio/x-wav": ".wav", "audio/3gpp": ".3gp", "audio/x-caf": ".caf",
  "application/pdf": ".pdf", "text/vcard": ".vcf", "text/x-vcard": ".vcf",
};
// The first type listed for an extension wins (".jpg" is image/jpeg).
const TYPE_BY_EXT = { ".jpeg": "image/jpeg", ".txt": "text/plain", ".csv": "text/csv" };
for (const [t, e] of Object.entries(EXT_BY_TYPE)) TYPE_BY_EXT[e] ??= t;

// The parts of an inbound MMS worth keeping, with a file name each. The name
// comes from the URL when it has an extension, else from the content type.
export function mediaParts(media = []) {
  return media
    .filter((m) => m?.url && !SKIP_TYPES.test(m.content_type || ""))
    .map((m, i) => {
      const type = String(m.content_type || "").split(";")[0].trim().toLowerCase();
      let base = "";
      try { base = path.basename(new URL(m.url).pathname); } catch {}
      const name = path.extname(base) ? base : `part${i}${EXT_BY_TYPE[type] || ""}`;
      return { url: m.url, contentType: type, name, size: m.size };
    });
}

// Download the kept parts into dir. Returns [{ path, contentType, name }] for
// the ones that arrived; a failed part is logged and left out. nameFor(i, name)
// gives the file name on disk (bot.js passes the dailies naming).
export async function downloadMedia({ media, dir, nameFor, fetchImpl = fetch, maxBytes = MEDIA_IN_MAX_BYTES, log = console.log }) {
  const parts = mediaParts(media);
  if (!parts.length) return [];
  await mkdir(dir, { recursive: true });
  const saved = [];
  for (const [i, part] of parts.entries()) {
    try {
      if (part.size > maxBytes) throw new Error(`${part.size} bytes is over the ${maxBytes}-byte cap`);
      const res = await fetchImpl(part.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error(`${buf.length} bytes is over the ${maxBytes}-byte cap`);
      const dest = path.join(dir, nameFor(i, part.name));
      await writeFile(dest, buf);
      saved.push({ path: dest, contentType: part.contentType, name: part.name });
      log(`📎 Saved MMS part → ${dest} (${buf.length} bytes, ${part.contentType || "no type"})`);
    } catch (err) {
      log(`⚠️  Couldn't download MMS part ${part.name}: ${err.message}`);
    }
  }
  return saved;
}

export function contentTypeFor(file) {
  return TYPE_BY_EXT[path.extname(file).toLowerCase()] || "application/octet-stream";
}

// Which reply files can go in one MMS. Returns { send, skip }, each a list of
// { path, name, contentType, size }. A photo or video may be up to
// MMS_MAX_TRANSCODE_BYTES (Telnyx shrinks it); any other file must fit
// MMS_MAX_BYTES. Past MMS_MAX_FILES the rest are skipped.
export async function pickMmsFiles(files) {
  const send = [];
  const skip = [];
  for (const f of files) {
    let size;
    try { size = (await stat(f.path)).size; } catch { skip.push({ ...f, reason: "missing" }); continue; }
    const contentType = contentTypeFor(f.name || f.path);
    const cap = /^(image|video)\//.test(contentType) && contentType !== "image/gif" ? MMS_MAX_TRANSCODE_BYTES : MMS_MAX_BYTES;
    const item = { ...f, contentType, size };
    if (size > cap || send.length >= MMS_MAX_FILES) skip.push(item);
    else send.push(item);
  }
  return { send, skip };
}

// Serve files for Telnyx to fetch. publish(file) returns the public URL.
// `route` is an httpRoutes handler for the MEDIA_ROUTE prefix.
export function makeMediaHost({ publicUrl, ttlMs = MEDIA_TTL_MS, now = () => Date.now() }) {
  const files = new Map(); // token -> { path, contentType, expires }
  const sweep = () => {
    for (const [token, f] of files) if (f.expires <= now()) files.delete(token);
  };
  return {
    publish({ path: file, name, contentType }) {
      sweep();
      const token = crypto.randomBytes(16).toString("hex");
      files.set(token, { path: file, contentType: contentType || contentTypeFor(name || file), expires: now() + ttlMs });
      const safe = encodeURIComponent(path.basename(name || file).replace(/[^\w.\-]+/g, "_"));
      return `${publicUrl.replace(/\/+$/, "")}${MEDIA_ROUTE}${token}/${safe}`;
    },
    async route(req, res) {
      const token = new URL(req.url, "http://x").pathname.slice(MEDIA_ROUTE.length).split("/")[0];
      const f = files.get(token);
      if (!f || f.expires <= now() || (req.method !== "GET" && req.method !== "HEAD")) {
        return res.writeHead(404).end();
      }
      let size;
      try { size = (await stat(f.path)).size; } catch { return res.writeHead(404).end(); }
      res.writeHead(200, { "Content-Type": f.contentType, "Content-Length": size, "Cache-Control": "no-store" });
      if (req.method === "HEAD") return res.end();
      createReadStream(f.path).pipe(res);
    },
    get size() { sweep(); return files.size; },
  };
}
