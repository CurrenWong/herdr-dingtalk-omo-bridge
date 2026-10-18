// DingTalk <-> Herdr OmO bridge.
//
// A Stream-mode WebSocket client that lives in a Herdr plugin pane. Inbound
// DingTalk text is typed into an OmO agent session running in another pane; the
// answer is read from that agent's session log and pushed back via
// sessionWebhook.
//
// Reply channel: OmO persists every session to
// ~/.omo/agent/sessions/<slug>/<timestamp>_<uuid>.jsonl, with the final answer as
// a {type:"message", message:{role:"assistant", content:[{type:"text"}]}} row.
// Scraping the TUI is unreliable (OmO repaints over the response); tailing the
// session log is exact. We snapshot (file, byte length) before submitting and
// read everything appended after the agent produces its next assistant message.
//
// Input channel: `herdr agent prompt` cannot be used here — OmO's launcher
// spawns node/bun children, so Herdr sees "agent is no longer the pane
// foreground process". Raw pane input plus a lifecycle poll works.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";
import { saveAttachment } from "./attachments.mjs";
import { ACTIONS, classifyInbound } from "./inbound.mjs";
import { lastAssistantText } from "./session-log.mjs";
import { DEFAULT_PLUGIN_ID, defaultConfigDir, defaultStateDir } from "./herdr-paths.mjs";

const HERDR = process.env.HERDR_BIN_PATH ?? "herdr";
const PLUGIN_ID = process.env.HERDR_PLUGIN_ID ?? DEFAULT_PLUGIN_ID;
// Herdr injects these; the fallbacks just keep the file runnable by hand.
const CONFIG_DIR = process.env.HERDR_PLUGIN_CONFIG_DIR ?? defaultConfigDir(PLUGIN_ID);
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR ?? defaultStateDir(PLUGIN_ID);

// The Herdr agent name hosting the OmO session (set with `herdr agent rename`).
const AGENT = process.env.LAB_TARGET_AGENT ?? "dingtalk";
// Legacy: fall back to typing into a bare pane when no agent name resolves.
const TARGET = process.env.LAB_TARGET_PANE ?? "";
const ANSWER_TIMEOUT_MS = Number(process.env.LAB_AGENT_TIMEOUT_MS ?? 300000);
const READ_LINES = 60;
const OMO_SESSIONS = join(homedir(), ".omo", "agent", "sessions");
// Attachments are written into the agent's working directory, not the plugin's
// state dir: the agent opens them by path, and a relative path in its own
// workspace is the least surprising thing to hand it.
const ATTACHMENT_DIR = process.env.LAB_ATTACHMENT_DIR ?? ".dingtalk-inbox";

// Every string the bot says to the user lives here so the plugin is not welded
// to one language. Set LAB_LANG=en for English; anything else falls back to the
// Chinese original.
const LANG = (process.env.LAB_LANG ?? "zh").toLowerCase().startsWith("en") ? "en" : "zh";
const TEXT = {
  zh: {
    fallbackTitle: "回复",
    blocked: "⚠️ OmO 卡在一个需要确认的界面上（blocked），请在 Herdr 里看一眼。",
    timeout: (s) => `⏱ OmO 在 ${s} 秒内没有给出回答。`,
    unauthorized: (id) => `未授权的发送者：${id}`,
    noAgent: (name) => `找不到 Herdr agent「${name}」，桥不知道该把消息投到哪里。`,
    busy: "上一条还在处理中，稍等。",
    handleFailed: (msg) => `桥接出错：${msg}`,
    unsupported: (type) => `只支持文本消息，收到的是 ${type}。图片和文件没法交给 OmO。`,
    attachmentPrompt: ({ type, path, size }) =>
      `用户通过钉钉发来一个 ${type} 附件，已保存到本地：\n${path}\n（${size}）\n\n请查看这个文件并回应。如果无法直接读取其中的内容，请说明原因，不要猜测。`,
    attachmentFailed: (err) => `附件下载失败：${err}`,
  },
  en: {
    fallbackTitle: "Reply",
    blocked: "⚠️ OmO is blocked on a confirmation prompt — take a look in Herdr.",
    timeout: (s) => `⏱ OmO did not answer within ${s}s.`,
    unauthorized: (id) => `Unauthorized sender: ${id}`,
    noAgent: (name) => `Herdr agent "${name}" not found — the bridge has nowhere to send this.`,
    busy: "Still working on the previous message.",
    handleFailed: (msg) => `Bridge error: ${msg}`,
    unsupported: (type) => `Text messages only — this one was "${type}". Images and files cannot be handed to OmO.`,
    attachmentPrompt: ({ type, path, size }) =>
      `The user sent a ${type} attachment through DingTalk. It is saved locally at:\n${path}\n(${size})\n\nPlease look at it and respond. If you cannot actually read its contents, say so rather than guessing.`,
    attachmentFailed: (err) => `Could not download the attachment: ${err}`,
  },
};
const t = (key, ...args) => TEXT[LANG][key](...args);

mkdirSync(STATE_DIR, { recursive: true });
const logFile = join(STATE_DIR, "dingtalk-bridge.log");

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
  console.log(line);
  try {
    appendFileSync(logFile, line + "\n", "utf8");
  } catch {}
}

function loadDotEnv(path) {
  if (!existsSync(path)) throw new Error(`missing credentials file: ${path}`);
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

const envPath = join(CONFIG_DIR, ".env");
loadDotEnv(envPath);
const CLIENT_ID = process.env.DINGTALK_CLIENT_ID;
const CLIENT_SECRET = process.env.DINGTALK_CLIENT_SECRET;
const ALLOW = (process.env.DINGTALK_ALLOW_STAFF ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function herdr(args) {
  const r = spawnSync(HERDR, args, { encoding: "utf8", timeout: 120000 });
  if (r.status !== 0) {
    throw new Error(`herdr ${args.join(" ")} failed: ${(r.stderr ?? "").trim() || r.error?.message}`);
  }
  return r.stdout ?? "";
}

function herdrJson(args) {
  const out = herdr(args);
  const start = out.indexOf("{");
  return start === -1 ? {} : JSON.parse(out.slice(start));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Herdr agent plumbing ---------------------------------------------------

function agentInfo() {
  try {
    return herdrJson(["agent", "get", AGENT]).result?.agent ?? null;
  } catch (err) {
    log("!! agent get failed", err.message);
    return null;
  }
}

function agentPaneId() {
  return agentInfo()?.pane_id ?? TARGET ?? null;
}

// OmO's session directory name is a slug of the cwd; rather than reproduce the
// slug rule, read each session's first JSONL row (it carries `cwd`) and match.
function sessionFileForCwd(cwd) {
  if (!existsSync(OMO_SESSIONS)) return null;
  const want = resolvePath(cwd ?? "").toLowerCase();
  let best = null;
  for (const dir of readdirSync(OMO_SESSIONS, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const name of readdirSync(join(OMO_SESSIONS, dir.name))) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(OMO_SESSIONS, dir.name, name);
      let first;
      try {
        first = JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]);
      } catch {
        continue;
      }
      if (!first?.cwd) continue;
      if (resolvePath(first.cwd).toLowerCase() !== want) continue;
      const st = statSync(file);
      if (!best || st.mtimeMs > best.mtimeMs) best = { path: file, size: st.size, mtimeMs: st.mtimeMs };
    }
  }
  return best;
}


function stripAnsi(text) {
  return text
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "");
}

function readPane(paneId) {
  return herdr(["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(READ_LINES)]);
}

// Bare-pane fallback: diff the terminal. Only used when no agent name resolves.
function newOutputSince(before, after) {
  const clean = stripAnsi(after).replace(/\r/g, "");
  const anchor = stripAnsi(before)
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  let slice = clean;
  if (anchor) {
    const idx = clean.lastIndexOf(anchor);
    if (idx !== -1) slice = clean.slice(idx + anchor.length);
  }
  const lines = slice.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) lines.shift();
  return lines.join("\n").trim();
}

// --- DingTalk push ----------------------------------------------------------

const pendingPath = join(STATE_DIR, "pending-push.json");

function savePending(webhook, text) {
  try {
    writeFileSync(
      pendingPath,
      JSON.stringify({ at: new Date().toISOString(), webhook, text }, null, 2),
      "utf8",
    );
  } catch {}
}

// DingTalk markdown messages require a title — omitting it fails with
// 400402 "miss param : markdown->title", and the webhook still answers HTTP 200.
async function push(webhook, text) {
  if (!webhook) return;
  state.last_push = { at: new Date().toISOString(), text: text.slice(0, 200) };
  const title = text.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 40) ?? t("fallbackTitle");
  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown", markdown: { title, text } }),
    });
    const body = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = body;
    }
    if (parsed?.errcode) {
      log("!! webhook rejected", JSON.stringify(parsed));
      savePending(webhook, text);
    } else {
      log("webhook ok", JSON.stringify(parsed).slice(0, 200));
    }
    state.last_push.ok = !parsed?.errcode;
  } catch (err) {
    log("!! webhook failed", err.message);
    savePending(webhook, text);
  }
}

// --- Message emotion tags ---------------------------------------------------
//
// Same mechanism QwenPaw uses (app/channels/dingtalk/channel.py::_send_emotion):
// tag the user's message while the bot works on it, then swap the tag when the
// answer is out. These are plain REST calls needing an app access token — the
// long-lived Stream connection cannot make them.
//
//   POST /v1.0/robot/emotion/reply    add a tag
//   POST /v1.0/robot/emotion/recall   remove a tag
//
// robotCode = DINGTALK_ROBOT_CODE or the client id, same fallback QwenPaw uses.

const TAG_RECEIVED = "👌Received";
const TAG_DONE = "🥳Done";
const TAG_ERROR = "☹️Error";
const EMOTIONS_ENABLED = process.env.LAB_EMOTIONS !== "0";

let tokenCache = { value: null, expiresAt: 0 };

async function accessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.value;
  const res = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appKey: CLIENT_ID, appSecret: CLIENT_SECRET }),
  });
  const json = await res.json();
  if (!json?.accessToken) {
    throw new Error(`accessToken failed: ${JSON.stringify(json).slice(0, 200)}`);
  }
  tokenCache = {
    value: json.accessToken,
    expiresAt: Date.now() + Number(json.expireIn ?? 7200) * 1000,
  };
  return tokenCache.value;
}

// Best-effort: a failed tag must never cost the user their actual reply, so
// every error path here is logged and swallowed.
async function tag(msgId, convId, emoji, { recall = false } = {}) {
  if (!EMOTIONS_ENABLED) return;
  if (!msgId || !convId) {
    log("!! tag skipped (no msgId/convId)", JSON.stringify({ msgId, convId }));
    return;
  }
  const verb = recall ? "recall" : "reply";
  try {
    const token = await accessToken();
    const res = await fetch(`https://api.dingtalk.com/v1.0/robot/emotion/${verb}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-acs-dingtalk-access-token": token },
      body: JSON.stringify({
        robotCode: process.env.DINGTALK_ROBOT_CODE || CLIENT_ID,
        openMsgId: String(msgId),
        openConversationId: String(convId),
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
    const body = await res.text();
    if (res.status === 200) {
      log(`tag ${verb} ${emoji}`, body.slice(0, 160));
    } else {
      log(`!! tag ${verb} ${emoji} failed`, `HTTP ${res.status}`, body.slice(0, 200));
    }
  } catch (err) {
    log(`!! tag ${verb} ${emoji} threw`, err.message);
  }
}

// --- Turn handling ----------------------------------------------------------

let busy = false;
const state = { started_at: new Date().toISOString(), seen: 0, last_push: null };

// Returns {text, ok} so the caller knows whether to tag the turn Done or
// Error — a timeout or a blocked prompt is not a successful answer.
async function askAgent(paneId, text, cwd) {
  const snap = sessionFileForCwd(cwd);
  log("session snapshot", JSON.stringify({ file: snap?.path ?? null, size: snap?.size ?? 0 }));
  const paneBefore = TARGET ? readPane(paneId) : "";

  // A literal newline in send-text would submit a half prompt, so flatten.
  const payload = text.replace(/\r?\n/g, " ⏎ ");
  herdr(["pane", "send-text", paneId, payload]);
  await sleep(400);
  herdr(["pane", "send-keys", paneId, "enter"]);

  const deadline = Date.now() + ANSWER_TIMEOUT_MS;
  let sawWorking = false;
  while (Date.now() < deadline) {
    await sleep(900);
    const info = agentInfo();
    if (info?.agent_status === "working") sawWorking = true;
    if (snap) {
      const fresh = sessionFileForCwd(cwd);
      const file = fresh && fresh.path !== snap.path ? fresh : snap;
      const answer = lastAssistantText(file, snap.path === file.path ? snap.size : 0);
      if (answer) {
        log("answer from session log", JSON.stringify(answer.slice(0, 300)));
        return { text: answer, ok: true };
      }
    } else if (TARGET) {
      const answer = newOutputSince(paneBefore, readPane(paneId));
      if (answer) return { text: answer, ok: true };
    }
    if (info?.agent_status === "blocked") {
      return {
        text: t("blocked"),
        ok: false,
      };
    }
  }
  log("!! timeout after", ANSWER_TIMEOUT_MS, "ms (sawWorking=" + sawWorking + ")");
  return {
    text: t("timeout", Math.round(ANSWER_TIMEOUT_MS / 1000)),
    ok: false,
  };
}

async function handle(msg) {
  state.seen += 1;
  state.last_webhook = msg.sessionWebhook;
  const who = `${msg.senderNick ?? "?"} (${msg.senderStaffId ?? "?"})`;
  // DingTalk names it msgId; the aliases are just belt-and-braces in case the
  // payload shape ever differs.
  const msgId = msg.msgId ?? msg.messageId ?? msg.message_id ?? "";
  const convId = msg.conversationId ?? "";

  const verdict = classifyInbound(msg, { allow: ALLOW });
  log(
    "inbound",
    JSON.stringify({ from: who, conv: convId, msgId, msgtype: verdict.msgtype, text: verdict.text, verdict: verdict.action }),
  );
  log("inbound keys", JSON.stringify(Object.keys(msg)));

  if (verdict.action === ACTIONS.REJECT) {
    log("!! rejected sender", verdict.staffId);
    await push(msg.sessionWebhook, t("unauthorized", verdict.staffId));
    return;
  }

  // Answer unsupported types instead of going silent. Silence is
  // indistinguishable from the bot being down, and the bridge used to do
  // exactly that for images and files.
  if (verdict.action === ACTIONS.UNSUPPORTED) {
    log("!! unsupported message", JSON.stringify({ msgtype: verdict.msgtype, msgId }));
    await tag(msgId, convId, TAG_ERROR);
    await push(msg.sessionWebhook, t("unsupported", verdict.msgtype));
    return;
  }

  // Acknowledge before doing anything slow — this is the whole point of the
  // tag: the user sees "received" instantly, not 30s later when we reply.
  await tag(msgId, convId, TAG_RECEIVED);

  const finish = async (ok) => {
    await tag(msgId, convId, TAG_RECEIVED, { recall: true });
    await tag(msgId, convId, ok ? TAG_DONE : TAG_ERROR);
  };

  const info = agentInfo();
  const paneId = info?.pane_id ?? agentPaneId();
  if (!paneId) {
    await push(msg.sessionWebhook, t("noAgent", AGENT));
    await finish(false);
    return;
  }
  log("-> agent", JSON.stringify({ agent: AGENT, pane: paneId, cwd: info?.cwd, status: info?.agent_status }));

  // Attachments are redeemed into the agent's working directory so the agent
  // can open them with its normal tools. DingTalk never sends the bytes in the
  // callback, and the download URL it hands back is short-lived, so this has to
  // happen now rather than being queued.
  let promptText = verdict.text;
  if (verdict.action === ACTIONS.ATTACHMENT) {
    const dir = join(info?.cwd ?? process.cwd(), ATTACHMENT_DIR);
    try {
      const saved = await saveAttachment({
        msg,
        robotCode: msg.robotCode ?? msg.chatbotCorpId ?? CLIENT_ID,
        accessToken,
        dir,
      });
      log("attachment saved", JSON.stringify({ path: saved.path, bytes: saved.bytes, type: saved.contentType }));
      promptText = t("attachmentPrompt", {
        type: verdict.msgtype,
        path: saved.path,
        size: `${Math.max(1, Math.round(saved.bytes / 1024))} KB`,
      });
    } catch (err) {
      log("!! attachment failed", err.message);
      await push(msg.sessionWebhook, t("attachmentFailed", err.message));
      await finish(false);
      return;
    }
  }

  const answer = await askAgent(paneId, promptText, info?.cwd);
  await push(msg.sessionWebhook, answer.text.slice(0, 4000));
  await finish(answer.ok);
}

// --- Stream client ----------------------------------------------------------

const client = new DWClient({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  keepAlive: true,
  debug: false,
});

client.registerCallbackListener(TOPIC_ROBOT, (res) => {
  // ACK immediately: DingTalk re-pushes after 60s without a response, and our
  // answer can take minutes.
  try {
    client.send(res.headers.messageId, {
      code: 0,
      status: "SUCCESS",
      headers: { contentType: "application/json" },
      body: "{}",
      message: "OK",
    });
  } catch (err) {
    log("!! ack failed", err.message);
  }

  let msg;
  try {
    msg = JSON.parse(res.data);
  } catch (err) {
    log("!! bad payload", err.message);
    return;
  }

  void (async () => {
    const msgId = msg.msgId ?? msg.messageId ?? msg.message_id ?? "";
    const convId = msg.conversationId ?? "";
    if (busy) {
      await push(msg.sessionWebhook, t("busy"));
      await tag(msgId, convId, TAG_ERROR);
      return;
    }
    busy = true;
    try {
      await handle(msg);
    } catch (err) {
      log("!! handle failed", err.message);
      await push(msg.sessionWebhook, t("handleFailed", err.message));
      await tag(msgId, convId, TAG_ERROR);
    } finally {
      busy = false;
    }
  })();
});

// The SDK swallows SYSTEM frames apart from REGISTERED, so wrap onSystem to
// make the handshake visible.
const sdkOnSystem = client.onSystem.bind(client);
client.onSystem = (downstream) => {
  log("system", JSON.stringify({ topic: downstream?.headers?.topic }));
  return sdkOnSystem(downstream);
};

// Raw frames: the SDK's `registered` flag stays false even while callbacks
// arrive, so frame log is the only trustworthy liveness signal.
const sdkOnDownStream = client.onDownStream.bind(client);
client.onDownStream = (raw) => {
  try {
    const frame = JSON.parse(raw.toString());
    log("frame", JSON.stringify({ type: frame.type, topic: frame.headers?.topic, code: frame.code }));
  } catch {
    log("frame", "<unparseable>", String(raw).slice(0, 120));
  }
  return sdkOnDownStream(raw);
};

// The pid in this file is what startup.mjs uses to avoid opening a second
// Stream connection, so it must be written the moment we start — waiting for
// the first heartbeat left a 15s window where startup saw a stale, dead pid and
// opened a duplicate connection.
function writeState() {
  try {
    writeFileSync(
      join(STATE_DIR, "dingtalk-bridge.json"),
      JSON.stringify(
        {
          started_at: state.started_at,
          pid: process.pid,
          agent: AGENT,
          client_id: CLIENT_ID,
          connected: client.connected,
          seen: state.seen,
          last_push: state.last_push,
          updated_at: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (err) {
    log("!! state write failed", err.message);
  }
}

const heartbeat = setInterval(() => {
  log("state", JSON.stringify({ connected: client.connected, registered: client.registered }));
  writeState();
}, 15000);

process.on("SIGINT", () => {
  clearInterval(heartbeat);
  client.disconnect();
  process.exit(0);
});

log("starting bridge", JSON.stringify({ agent: AGENT, target_pane: TARGET, allow: ALLOW.length || "any" }));
writeState();
await client.connect();
log("connected");
