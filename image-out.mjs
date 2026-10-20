// Send pictures back to DingTalk.
//
// The direction is the easy one; the hard part is deciding *what* to send.
//
// DingTalk will not render an image from a session webhook at all (its own
// message-type table marks Image as API-only), and the image template
// `sampleImageMsg` takes a `photoURL` — a URL anyone can fetch. This bridge
// runs on the user's own machine, where OmO writes its output. The only way to
// put those bytes somewhere DingTalk can reach is to upload them and send the
// result as a file, which is exactly what QwenPaw does
// (qwenpaw/app/channels/dingtalk/channel.py, `_send_media_part_via_open_api`):
//
//   POST oapi.dingtalk.com/media/upload?type=image  -> media_id
//   POST api.dingtalk.com/v1.0/robot/groupMessages/send -> msgKey: sampleFile
//
// `fileType: "png"` is not in DingTalk's documented list (xlsx/pdf/zip/rar/doc/
// docx), but probe-image.mjs verified the API accepts it: the only complaint
// comes back about the conversation id, never the msgKey or the msgParam.
//
// Picking candidates is deliberately conservative. OmO's answers mention
// *every* path they touch, including ones the user pasted, paths quoted from a
// log, and WSL paths that do not exist on this host. Sending any of those back
// would be worse than sending nothing. Three gates, in order:
//
//   1. the path must exist on this host and end in an image extension
//   2. it must have been written during this turn (mtime >= the turn's start)
//   3. it must not live somewhere secrets do
//
// The mtime gate is what makes rule 2 cheap: a picture the agent just produced
// is new by definition, while every path the user quoted is older than the
// prompt that mentioned it.
//
// Rule 2 has exactly one exception, and it is the user's own words: "send that
// one again" names a picture from an earlier turn, and nothing is written
// during such a turn, so a strict gate would refuse precisely the files that
// were just asked for. `wantsResend` moves the boundary back RESEND_WINDOW_MS
// for that turn and no other. The other two gates never move.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";

export const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_PER_TURN = 3;
export const TIMEOUT_MS = 20000;

// How far back "send that one again" may reach. A resend is about a picture
// from the conversation at hand, not about whatever happens to be newest in the
// repository, so the relaxed gate is still a window and not an open door.
export const RESEND_WINDOW_MS = 24 * 60 * 60 * 1000;

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

// Directories that must never leave the machine, whatever an answer says.
const NEVER_SEND = [
  /[\\/]state[\\/]auth[\\/]/i, // credentials.json holds the client_secret
  /[\\/]\.git[\\/]/i,
  /[\\/]node_modules[\\/]/i,
];

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

// How a path *ends* is the same question in all three patterns below, so the
// shape is written out rather than factored: an extension of one to six
// alphanumerics, followed by a character that cannot continue a filename.
// That trailing guard is what stops `figure.png 118056 bytes` from swallowing
// the byte count, and what stops `figure.pngx` from passing as `figure.png`.
// Every pattern needs /g for matchAll; case is ignored because Windows is.

// An absolute path on this host, `C:\out\figure.png`. Two guards keep it a path
// and not a URL: the lookbehind refuses a drive letter that is really the tail
// of a scheme, so the `s://` in `https://example.com/a.png` never becomes
// "drive s", and the lookahead refuses `C://`, which is not a path either.
const WIN_STRICT =
  /(?<![\w\\/])([A-Za-z]:[\\/](?![\\/])[^\s"'`<>|]*?\.[A-Za-z0-9][A-Za-z0-9_-]{0,5})(?![A-Za-z0-9_-])/gi;

// The same, tolerating spaces inside the path — `C:\out\my chart final.png` is
// real on Windows and OmO's cwd sits under a user directory. A space only
// counts as part of the path when an ASCII path character follows it, which is
// what keeps prose out: in `D:\docs\a.txt 不存在，图在 b.png` the space after
// `a.txt` is followed by a CJK character, so the sentence is not absorbed into
// a path and the next anchor gets its turn instead.
const WIN_SPACED =
  /(?<![\w\\/])([A-Za-z]:[\\/](?![\\/])(?:[^\s"'`<>|]|[ ](?=[A-Za-z0-9_\-.~#$%&+=@^(){}\[\]]))*?\.[A-Za-z0-9][A-Za-z0-9_-]{0,5})(?![A-Za-z0-9_-])/gi;

// A path relative to the agent's cwd — `figs\outputs\figure_a.png`. It has to
// contain a separator, or every bare `report.png` in prose is a candidate, and
// the preceding-character guard is what keeps URLs (`//host/a.png`) and WSL
// paths (`user@host:/mnt/c/a.png`) out: in both, a slash or a colon sits right
// where a relative match would have to start.
const RELATIVE =
  /(?<![\w\\/.:-])((?:[A-Za-z0-9_\-. ]+[\\/])+[A-Za-z0-9_\-. ]+\.[A-Za-z0-9][A-Za-z0-9_-]{0,5})(?![A-Za-z0-9_-])/g;

// A path inside WSL, e.g. `curre@Bin-Redmi-16:/mnt/c/x.png`. Recognised only
// so it can be logged instead of silently ignored — converting it needs a
// `wslpath` round trip, and guessing produced the wrong file once already.
const WSL_PATH = /[\w.-]+@[\w.-]+:(\/[^\s"'`<>|]*?\.(?:png|jpe?g|gif|webp|bmp))/gi;

/**
 * Every file path an answer mentions, in the order the answer mentions them:
 * `{ path, ext }`, deduplicated case-insensitively because Windows compares
 * paths that way. Touches nothing on disk, and deliberately does not filter by
 * extension — the refusal of a `notes.txt` is a decision worth logging, so it
 * has to be visible here. `extractImagePaths` is the image-only view.
 */
function scanPaths(text, cwd) {
  if (typeof text !== "string" || !text) return [];

  const hits = [];
  for (const re of [WIN_STRICT, WIN_SPACED, RELATIVE]) {
    for (const m of text.matchAll(re)) {
      hits.push({ raw: m[1], at: m.index, end: m.index + m[0].length });
    }
  }
  // Three patterns over one string, so the answer's own reading order decides
  // which picture wins a slot when the per-turn cap bites.
  hits.sort((a, b) => a.at - b.at);

  const out = [];
  const seen = new Set();
  for (const { raw: hit, end } of hits) {
    // `C:\Users\curre\.agents\skills\` used to yield `C:\Users\curre\.agents`:
    // `.agents` looks exactly like an extension, so the path pattern stopped
    // there. A candidate that is immediately followed by a separator is a
    // directory, whatever its tail looks like.
    const next = text[end];
    if (next === "\\" || next === "/") continue;
    // `见 figs\rel.png` — the relative pattern tolerates spaces inside a
    // segment, so it can start on the space in front of the path.
    const raw = hit.trim();
    if (!raw) continue;
    const path = isAbsolute(raw) ? raw : cwd ? resolve(join(cwd, raw)) : resolve(raw);
    const key = path.replace(/\//g, "\\").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, ext: extname(path).slice(1) });
  }
  return out;
}

/**
 * Every image path an answer mentions, normalised, deduplicated, in the order
 * they appear. Does not touch the filesystem — see `collectFreshImages`.
 */
export function extractImagePaths(text, { cwd = "" } = {}) {
  return scanPaths(text, cwd)
    .filter((p) => IMAGE_EXTS.has(`.${p.ext.toLowerCase()}`))
    .map((p) => p.path);
}

/** WSL paths an answer quotes. Logged, never followed. */
export function wslPathsIn(text) {
  if (typeof text !== "string") return [];
  return [...text.matchAll(WSL_PATH)].map((m) => m[0]);
}

// "Hand me that picture again" — the one case where the mtime gate has to be
// told otherwise, because nothing gets written during such a turn: OmO answers
// by naming the paths it made earlier, and a strict gate refuses exactly the
// pictures the user just asked for. Measured, not imagined: a real turn
// ("再发一次两张图") named both figures and sent neither.
//
// The list is deliberately short and the default is false. This is the only
// thing that relaxes the gate, so a false positive here re-opens the
// accidental-send hole the gate exists to close.
const RESEND_PATTERNS = [
  /再发|重发|重新发|再传|再给我|再来一次/u,
  /\b(?:again|resend|re-send)\b/iu,
];

/** Does the user's own message ask for pictures they already have? */
export function wantsResend(text) {
  if (typeof text !== "string" || !text) return false;
  return RESEND_PATTERNS.some((re) => re.test(text));
}

// A wider question: is this turn about getting a picture delivered at all?
// "把图片发给我" and "发送图片" are not resends, but they fail in exactly the
// same way when the agent answers with a directory and no file name — the
// bridge has nothing to open. So the hint goes out on any delivery request,
// while only the narrow repeat wording above moves the mtime gate.
//
// Two words, not one: a picture word on its own ("这个图表的配色") is usually a
// question, and a delivery verb on its own ("把这段代码给我") has nothing to send.
const PICTURE_WORD = /图|截图|画|image|picture|chart|figure|plot|diagram|screenshot/iu;
const DELIVER_WORD = /发|传|给|要|send|share|give|show/iu;

/** Is the user asking to be given a picture this turn? */
export function wantsPictures(text) {
  if (typeof text !== "string" || !text) return false;
  return PICTURE_WORD.test(text) && DELIVER_WORD.test(text);
}

/**
 * Paths that survive every gate, with the reason the others did not.
 *
 * `since` is the moment the turn started, in epoch ms. Returns
 * `{ picked, skipped }` so the caller can log what it decided not to send —
 * silence there is indistinguishable from a bug.
 */
export function collectFreshImages(text, { cwd = "", since = 0, maxPerTurn = MAX_PER_TURN } = {}) {
  const picked = [];
  const skipped = [];

  for (const { path, ext } of scanPaths(text, cwd)) {
    if (!IMAGE_EXTS.has(`.${ext.toLowerCase()}`)) {
      skipped.push({ path, reason: "not-an-image-extension" });
      continue;
    }
    // Counted against pictures only. A long answer mentions more files than
    // anyone wants in a chat, and three is already generous.
    if (picked.length >= maxPerTurn) {
      skipped.push({ path, reason: "over-per-turn-limit" });
      continue;
    }
    if (NEVER_SEND.some((re) => re.test(path))) {
      skipped.push({ path, reason: "blocked-path" });
      continue;
    }
    let st;
    try {
      if (!existsSync(path)) {
        skipped.push({ path, reason: "missing" });
        continue;
      }
      st = statSync(path);
    } catch (err) {
      skipped.push({ path, reason: `stat-failed: ${err.code ?? err.message}` });
      continue;
    }
    if (!st.isFile()) {
      skipped.push({ path, reason: "not-a-file" });
      continue;
    }
    if (st.size === 0) {
      skipped.push({ path, reason: "empty" });
      continue;
    }
    if (st.size > MAX_BYTES) {
      skipped.push({ path, reason: `too-large: ${Math.round(st.size / 1048576)}MB` });
      continue;
    }
    // The gate that does the real work. A file older than the prompt was not
    // produced by this turn, however confidently the answer presents it.
    if (since && st.mtimeMs < since) {
      skipped.push({ path, reason: "older-than-turn" });
      continue;
    }
    picked.push({ path, bytes: st.size, name: basename(path), ext: ext.toLowerCase() });
  }
  return { picked, skipped };
}

/** Upload bytes to DingTalk and return the media_id. */
export async function uploadImage({ bytes, name, accessToken }) {
  const form = new FormData();
  form.append("type", "image");
  form.append(
    "media",
    new Blob([bytes], { type: MIME[extname(name).toLowerCase()] ?? "application/octet-stream" }),
    basename(name),
  );

  const res = await fetch(
    `https://oapi.dingtalk.com/media/upload?access_token=${accessToken}`,
    { method: "POST", body: form, signal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // An HTML error page from the edge is itself the finding.
  }
  if (!res.ok || (json?.errcode ?? 0) !== 0 || !json?.media_id) {
    throw new Error(`upload failed HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return json.media_id;
}

/**
 * Send an already-uploaded media_id to wherever this conversation lives.
 *
 * DingTalk has two endpoints here and they are not interchangeable. A group is
 * addressed by conversation id (`groupMessages/send`); a one-to-one is
 * addressed by the recipient's staff id (`oToMessages/batchSend`). Posting a
 * one-to-one to the group endpoint fails with
 * `{"code":"resource.not.found","message":"robot 不存在"}` — measured against the
 * real API, not read off a doc — and that message names the robot rather than
 * the mistake, so it reads exactly like a credential problem and sent this
 * chasing robotCode for a whole round. The robotCode was fine throughout.
 */
export async function sendImageFile({
  mediaId,
  name,
  ext,
  accessToken,
  robotCode,
  conversationId,
  conversationType,
  staffId,
}) {
  const oneToOne = String(conversationType ?? "") === "1";
  if (oneToOne && !staffId) {
    throw new Error("one-to-one send needs senderStaffId");
  }

  const url = oneToOne
    ? "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend"
    : "https://api.dingtalk.com/v1.0/robot/groupMessages/send";
  const address = oneToOne
    ? { robotCode, userIds: [staffId] }
    : { robotCode, openConversationId: conversationId };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-acs-dingtalk-access-token": accessToken,
    },
    body: JSON.stringify({
      ...address,
      msgKey: "sampleFile",
      msgParam: JSON.stringify({ mediaId, fileName: name, fileType: ext }),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    throw new Error(`send failed HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  // DingTalk answers 200 and then quietly drops the message for anyone it could
  // not deliver to. Without this the log says the picture was sent and the chat
  // says otherwise.
  const refused = [...(json?.invalidStaffIdList ?? []), ...(json?.filteredStaffIdList ?? [])];
  if (refused.length) {
    throw new Error(`send returned 200 but refused ${refused.length} recipient(s): ${refused.join(",")}`);
  }
  return json;
}

/**
 * The bridge's entry point: the whole inbound payload goes in.
 *
 * Assembling the addresses by hand at the call site is how the one-to-one route
 * got lost in the first place — `conversationType` and `senderStaffId` both have
 * to be read from the payload, and reading the wrong one fails at the API with a
 * message about the robot. Handing the payload over whole keeps the routing next
 * to the routing, and makes the bridge's part a single call that can be tested
 * against the real payload shape.
 */
export async function sendImagesForTurn({
  msg,
  text,
  cwd,
  since,
  accessToken,
  maxPerTurn = MAX_PER_TURN,
  onDecision = () => {},
}) {
  return sendImagesForAnswer({
    text,
    cwd,
    since,
    accessToken,
    robotCode: msg?.robotCode,
    conversationId: msg?.conversationId,
    conversationType: msg?.conversationType,
    staffId: msg?.senderStaffId,
    maxPerTurn,
    onDecision,
  });
}

/**
 * The whole path: answer text in, pictures in the chat out.
 *
 * Never throws. A failed picture is a footnote to an answer that was already
 * delivered, and turning it into an error tag would tell the user their turn
 * failed when the text arrived fine.
 */
export async function sendImagesForAnswer({
  text,
  cwd,
  since,
  accessToken,
  robotCode,
  conversationId,
  conversationType,
  staffId,
  maxPerTurn = MAX_PER_TURN,
  onDecision = () => {},
}) {
  const summary = { picked: [], sent: [], skipped: [], wsl: [], error: null };
  try {
    summary.wsl = wslPathsIn(text);
    const { picked, skipped } = collectFreshImages(text, { cwd, since, maxPerTurn });
    summary.picked = picked.map((p) => p.path);
    summary.skipped = skipped;

    if (!picked.length) return summary;

    const token = typeof accessToken === "function" ? await accessToken() : accessToken;
    for (const file of picked) {
      try {
        const bytes = readFileSync(file.path);
        const mediaId = await uploadImage({ bytes, name: file.name, accessToken: token });
        await sendImageFile({
          mediaId,
          name: file.name,
          ext: file.ext,
          accessToken: token,
          robotCode,
          conversationId,
          conversationType,
          staffId,
        });
        summary.sent.push({ path: file.path, mediaId });
        onDecision({ event: "sent", ...file });
      } catch (err) {
        summary.error = err.message;
        summary.skipped.push({ path: file.path, reason: `send-failed: ${err.message}` });
        onDecision({ event: "send-failed", path: file.path, error: err.message });
      }
    }
  } catch (err) {
    summary.error = err.message;
  }
  return summary;
}
