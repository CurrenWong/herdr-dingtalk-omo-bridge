// Standalone probe for the DingTalk "robot emotion" API that QwenPaw uses to
// tag messages. Run before wiring it into the bridge: it proves the access
// token, the endpoint, the robotCode and the body shape are all correct.
//
// A business-level error (e.g. "message not found" for the dummy msgId) is a
// PASS: it means we got past auth and the API understood the request. Only an
// auth/permission error means the approach is wrong.
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
    // No .env yet is a normal state before registration. The check below names
    // the missing variables; a stack trace here explained nothing.
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

// Fail where the mistake is. Undefined credentials used to go straight into the
// OAuth call, and the only signal was a raw API error that did not name the
// missing variable.
const missing = ["DINGTALK_CLIENT_ID", "DINGTALK_CLIENT_SECRET"].filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`missing ${missing.join(", ")}`);
  console.error(`  looked in ${join(CONFIG_DIR, ".env")} and the environment`);
  console.error("  run the auth action to register the bot, or set them yourself");
  process.exit(2);
}

const CLIENT_ID = process.env.DINGTALK_CLIENT_ID;
const CLIENT_SECRET = process.env.DINGTALK_CLIENT_SECRET;
// QwenPaw: robot_code = DINGTALK_ROBOT_CODE || CLIENT_ID. Say which one is in
// use — a wrong robot code is otherwise invisible until some 4xx.
const ROBOT_CODE = process.env.DINGTALK_ROBOT_CODE || CLIENT_ID;
console.log(
  `robot_code: ${process.env.DINGTALK_ROBOT_CODE ? "DINGTALK_ROBOT_CODE" : "DINGTALK_CLIENT_ID (fallback)"}`,
);

const API = "https://api.dingtalk.com";
const TIMEOUT_MS = 15000;

async function getAccessToken() {
  let r;
  try {
    r = await fetch(`${API}/v1.0/oauth2/accessToken`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appKey: CLIENT_ID, appSecret: CLIENT_SECRET }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.log(`TOKEN FAILED (network) ${err.message}`);
    process.exit(1);
  }
  const body = await r.text();
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    // An HTML or empty body is a failure in itself, and the status and the body
    // are the only things that explain it.
  }
  if (!r.ok || !json?.accessToken) {
    console.log(`TOKEN FAILED HTTP ${r.status} ${body.slice(0, 300)}`);
    process.exit(1);
  }
  return json;
}

const token = await getAccessToken();
console.log("token OK, expireIn =", token.expireIn, "len =", token.accessToken.length);

// The conversation id from a real inbound message the bridge already handled.
const CONV = process.argv[2] ?? "";
const MSG = process.argv[3] ?? "dummy-open-msg-id";

async function emotion(pathname, emoji, recall) {
  const label = recall ? "recall" : "reply  ";
  let r;
  try {
    r = await fetch(`${API}${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-acs-dingtalk-access-token": token.accessToken,
      },
      body: JSON.stringify({
        robotCode: ROBOT_CODE,
        openMsgId: MSG,
        openConversationId: CONV,
        emotionType: 2,
        emotionName: emoji,
        textEmotion: {
          emotionId: "2659900",
          emotionName: emoji,
          text: emoji,
          backgroundId: "im_bg_1",
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Without this the probe died with an unhandled rejection instead of the
    // verdict it exists to print.
    console.log(`${label} FAILED ${err.message}`);
    return { status: 0, json: null, text: "" };
  }
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  console.log(`${label} HTTP ${r.status} ${text.slice(0, 400)}`);
  return { status: r.status, json, text };
}

// A dummy msgId is expected back as a business rejection — that is what proves
// the token, the route and the body shape are right. A 2xx passes too. An auth
// error, an HTML error page or a network failure does not.
//
// The check reads the parsed code/message, not the raw text: the old regex
// matched the word "message", which appears in success bodies and unrelated
// errors alike.
function businessRejection(res) {
  if (!res.json) return false;
  const code = String(res.json.code ?? res.json.errcode ?? "");
  const message = String(res.json.message ?? res.json.errmsg ?? "");
  return /invalid|not.?found|not.?exist|不存在|无效/i.test(`${code} ${message}`);
}

const add = await emotion("/v1.0/robot/emotion/reply", "👌Received", false);
await emotion("/v1.0/robot/emotion/recall", "👌Received", true);

// One boolean decides both the verdict and the exit code, so they cannot
// disagree the way they did when the exit code looked at HTTP 200 alone.
const ok = add.status === 200 || businessRejection(add);
console.log(`\nverdict: ${ok ? "ENDPOINT OK (dummy msgId rejected as expected)" : "CHECK OUTPUT ABOVE"}`);
process.exit(ok ? 0 : 1);
