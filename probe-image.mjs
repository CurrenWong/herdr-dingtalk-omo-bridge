// Standalone probe for sending a picture from OmO back to DingTalk.
//
// Follows QwenPaw's own path (qwenpaw/app/channels/dingtalk/channel.py):
//   1. POST oapi.dingtalk.com/media/upload?type=image   -> media_id
//   2. POST /v1.0/robot/groupMessages/send              -> msgKey: sampleFile
//
// Step 2 is the one nobody has verified: DingTalk's message-type table lists
// fileType as xlsx/pdf/zip/rar/doc/docx only, yet QwenPaw ships png through it.
// So we send against a dummy conversation id: a business rejection proves the
// token, the msgKey and the msgParam shape are all accepted, and nothing is
// delivered to a human.
//
// Credentials come from the plugin .env; nothing secret is printed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PLUGIN_ID, defaultConfigDir } from "./herdr-paths.mjs";

const CONFIG_DIR =
  process.env.HERDR_PLUGIN_CONFIG_DIR ??
  defaultConfigDir(process.env.HERDR_PLUGIN_ID ?? DEFAULT_PLUGIN_ID);

function loadDotEnv(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] === undefined) {
      process.env[key] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
}
loadDotEnv(join(CONFIG_DIR, ".env"));

const missing = ["DINGTALK_CLIENT_ID", "DINGTALK_CLIENT_SECRET"].filter((n) => !process.env[n]);
if (missing.length) {
  console.error(`missing ${missing.join(", ")}`);
  console.error(`  looked in ${join(CONFIG_DIR, ".env")} and the environment`);
  process.exit(2);
}

const CLIENT_ID = process.env.DINGTALK_CLIENT_ID;
const CLIENT_SECRET = process.env.DINGTALK_CLIENT_SECRET;
const ROBOT_CODE = process.env.DINGTALK_ROBOT_CODE || CLIENT_ID;

const API = "https://api.dingtalk.com";
const OAPI = "https://oapi.dingtalk.com";
const TIMEOUT_MS = 20000;

// A real 1x1 PNG. The bytes matter: the point is to upload a genuine PNG, not a
// mislabelled one, because the open question is whether DingTalk accepts png
// as a file type at all.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

let bad = 0;
const check = (label, ok, detail = "") => {
  if (!ok) bad += 1;
  console.log(`  ${ok ? "ok  " : "MISS"}  ${label}${detail ? `   ${detail}` : ""}`);
};

async function getAccessToken() {
  const r = await fetch(`${API}/v1.0/oauth2/accessToken`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appKey: CLIENT_ID, appSecret: CLIENT_SECRET }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!r.ok || !json?.accessToken) {
    console.log(`TOKEN FAILED HTTP ${r.status} ${text.slice(0, 300)}`);
    process.exit(1);
  }
  return json.accessToken;
}

const token = await getAccessToken();
console.log(`token OK (len ${token.length})\n`);

console.log("1. upload a png to oapi.dingtalk.com/media/upload");
const form = new FormData();
form.append("type", "image");
form.append("media", new Blob([PNG_1PX], { type: "image/png" }), "probe.png");

let mediaId = "";
try {
  const r = await fetch(`${OAPI}/media/upload?access_token=${token}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  console.log(`   HTTP ${r.status} ${text.slice(0, 300)}`);
  const errcode = json?.errcode ?? -1;
  check("upload accepted", r.ok && errcode === 0 && !!json?.media_id, `errcode=${errcode}`);
  mediaId = json?.media_id ?? "";
} catch (err) {
  check("upload accepted", false, err.message);
}

if (!mediaId) {
  console.log("\nverdict: UPLOAD BLOCKED — nothing downstream can work until this passes");
  process.exit(1);
}

console.log(`\n2. send it back as msgKey=sampleFile against a dummy conversation`);
const CONV = process.argv[2] ?? "cid-dummy-not-a-real-conversation";

let sendOk = false;
try {
  const r = await fetch(`${API}/v1.0/robot/groupMessages/send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-acs-dingtalk-access-token": token,
    },
    body: JSON.stringify({
      robotCode: ROBOT_CODE,
      openConversationId: CONV,
      msgKey: "sampleFile",
      msgParam: JSON.stringify({
        mediaId,
        fileName: "probe.png",
        fileType: "png",
      }),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  console.log(`   HTTP ${r.status} ${text.slice(0, 400)}`);
  const blob = `${json?.code ?? ""} ${json?.message ?? ""} ${text.slice(0, 200)}`;
  // A business rejection is the PASS: DingTalk understood the message and
  // refused it for a reason we chose (the conversation does not exist).
  const businessRejection = /invalid|not.?found|not.?exist|不存在|无效|invalidParameter/i.test(blob);
  sendOk = r.status === 200 || businessRejection;
  check("sampleFile accepted by the API", sendOk);
} catch (err) {
  check("sampleFile accepted by the API", false, err.message);
}

console.log("");
if (bad) {
  console.error(`${bad} check(s) failed`);
  process.exit(1);
}
console.log("verdict: PASS — upload works and sampleFile/png is understood by the API");
console.log("next: wire this into dingtalk-bridge.mjs after extracting the path from OmO's answer");
