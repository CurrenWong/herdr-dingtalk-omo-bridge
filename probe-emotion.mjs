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

const CONFIG_DIR =
  process.env.HERDR_PLUGIN_CONFIG_DIR ??
  join(
    process.env.APPDATA ?? "",
    "herdr",
    "plugins",
    "config",
    process.env.HERDR_PLUGIN_ID ?? "lab.dingtalk-bridge",
  );

function loadDotEnv(path) {
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
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

const CLIENT_ID = process.env.DINGTALK_CLIENT_ID;
const CLIENT_SECRET = process.env.DINGTALK_CLIENT_SECRET;
const ROBOT_CODE = process.env.DINGTALK_ROBOT_CODE || CLIENT_ID; // QwenPaw: robot_code = DINGTALK_ROBOT_CODE || CLIENT_ID

async function getAccessToken() {
  const r = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appKey: CLIENT_ID, appSecret: CLIENT_SECRET }),
  });
  const j = await r.json();
  return j;
}

const token = await getAccessToken();
if (!token.accessToken) {
  console.log("TOKEN FAILED", JSON.stringify(token));
  process.exit(1);
}
console.log("token OK, expireIn =", token.expireIn, "len =", token.accessToken.length);

// The conversation id from a real inbound message the bridge already handled.
const CONV = process.argv[2] ?? "";
const MSG = process.argv[3] ?? "dummy-open-msg-id";

async function emotion(pathname, emoji, recall) {
  const r = await fetch(`https://api.dingtalk.com${pathname}`, {
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
  });
  const text = await r.text();
  console.log(`${recall ? "recall" : "reply  "} HTTP ${r.status} ${text.slice(0, 400)}`);
  return { status: r.status, text };
}

const add = await emotion("/v1.0/robot/emotion/reply", "👌Received", false);
const del = await emotion("/v1.0/robot/emotion/recall", "👌Received", true);

const businessish = (s) => /not found|不存在|invalid|not exist|message/i.test(s);
console.log("\nverdict:", add.status === 200 && businessish(add.text) ? "ENDPOINT OK (dummy msgId rejected as expected)" : "CHECK OUTPUT ABOVE");
process.exit(add.status === 200 ? 0 : 1);
