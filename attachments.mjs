// Fetch an attachment the user sent to the bot, and decide where it lands.
//
// DingTalk never puts the bytes in the callback. A picture message arrives as
//   { msgtype: "picture", content: { downloadCode, pictureDownloadCode } }
// and the file itself has to be redeemed in two steps:
//
//   POST /v1.0/robot/messageFiles/download   { downloadCode, robotCode }
//     -> { downloadUrl }
//   GET  <downloadUrl>                        -> bytes
//
// The URL is short-lived and unauthenticated, which is why this runs immediately
// rather than queueing the download for later.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

// Cap what we are willing to pull into the agent's working directory.
export const MAX_BYTES = 20 * 1024 * 1024;

const EXT_BY_TYPE = new Map([
  ["image/jpeg", ".jpg"],
  ["image/jpg", ".jpg"],
  ["image/png", ".png"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/bmp", ".bmp"],
  ["audio/amr", ".amr"],
  ["audio/mpeg", ".mp3"],
  ["audio/wav", ".wav"],
  ["video/mp4", ".mp4"],
  ["application/pdf", ".pdf"],
]);

/** The download code inside a non-text message, or "" when there is none. */
export function downloadCodeOf(msg) {
  const c = msg?.content ?? {};
  return String(c.downloadCode ?? c.pictureDownloadCode ?? "").trim();
}

/**
 * A path that does not overwrite anything already in `dir`.
 *
 * The name is deterministic — the sender's filename, else the message id — so
 * two attachments can resolve to the same path: a second photo called
 * `IMG_0001.jpg`, or two messages with no msgId. The first file was silently
 * replaced, and the caller still handed the agent the same path, now holding a
 * different picture.
 */
export function availablePath(dir, name) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate = join(dir, name);
  for (let n = 2; existsSync(candidate); n += 1) {
    candidate = join(dir, `${stem}-${n}${ext}`);
  }
  return candidate;
}

/**
 * A safe, stable filename for a saved attachment.
 *
 * Prefers the name the sender used (file messages carry `fileName`), because a
 * human will recognise it; falls back to the message id. Whatever we end up with
 * is stripped of path separators — this string becomes a filesystem path.
 */
export function attachmentName(msg, contentType = "") {
  const hint = String(msg?.content?.fileName ?? "").trim();
  // Keep letters from any script: \w alone would reduce "账单 2026.pdf" to
  // "_2026.pdf", which is useless to the person who sent it.
  const safeHint = basename(hint)
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  const id = String(msg?.msgId ?? "attachment").replace(/[^\w-]+/g, "_").slice(0, 40);

  const fromType = EXT_BY_TYPE.get(String(contentType).split(";")[0].trim().toLowerCase()) ?? "";
  const fromHint = extname(safeHint).toLowerCase();
  const ext = fromType || fromHint || ".bin";

  if (safeHint) {
    // Keep the sender's stem when we know it, unless it already ends in the
    // extension we resolved from the content type.
    const stem = fromHint ? safeHint.slice(0, -fromHint.length) : safeHint;
    return `${stem || id}${ext}`;
  }
  return `${id}${ext}`;
}

/**
 * Turn the access token into bytes on disk.
 * Returns { path, bytes, contentType } or throws with a usable message.
 */
export async function saveAttachment({ msg, robotCode, accessToken, dir }) {
  const downloadCode = downloadCodeOf(msg);
  if (!downloadCode) throw new Error("message carries no downloadCode");

  const token = await accessToken();

  const res = await fetch("https://api.dingtalk.com/v1.0/robot/messageFiles/download", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-acs-dingtalk-access-token": token,
    },
    body: JSON.stringify({ downloadCode, robotCode }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`downloadCode rejected: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const url = JSON.parse(body)?.downloadUrl;
  if (!url) throw new Error(`no downloadUrl in response: ${body.slice(0, 200)}`);

  const file = await fetch(url);
  if (!file.ok) throw new Error(`downloadUrl fetch failed: HTTP ${file.status}`);

  // The header is a hint, not a promise: a chunked response has none at all, and
  // a bogus one is just a number. The body is read in chunks and abandoned the
  // moment the running total passes the limit, so an oversized (or lying)
  // response cannot fill the heap before anyone looks at its size.
  const declared = Number(file.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) {
    throw new Error(`attachment is ${Math.round(declared / 1048576)}MB, limit is ${MAX_BYTES / 1048576}MB`);
  }

  const buf = await readCapped(file, MAX_BYTES);

  const contentType = file.headers.get("content-type") ?? "";
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = availablePath(dir, attachmentName(msg, contentType));
  // Write beside the target and rename: a full disk or a kill mid-write used to
  // leave a truncated file under the real name, which the agent would then read.
  const temp = `${path}.${process.pid}.part`;
  writeFileSync(temp, buf);
  renameSync(temp, path);

  return { path, bytes: buf.length, contentType };
}

/**
 * Read a response body, giving up as soon as it exceeds `limit`.
 *
 * `arrayBuffer()` is the obvious call and the wrong one: it has already buffered
 * the whole body by the time its length can be checked.
 */
export async function readCapped(res, limit) {
  const tooBig = () => new Error(`attachment is larger than the ${limit / 1048576}MB limit`);

  const reader = res.body?.getReader();
  if (!reader) {
    const whole = Buffer.from(await res.arrayBuffer());
    if (whole.length > limit) throw tooBig();
    return whole;
  }

  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try {
        await reader.cancel();
      } catch {}
      throw tooBig();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
