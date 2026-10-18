// One-shot startup hook: make sure the DingTalk <-> OmO lab is running, then
// exit. Herdr runs [[startup]] once per server start after the session is
// restored; it is NOT a supervised daemon, so everything long-lived lives in
// Herdr-managed panes instead.
//
// Idempotency matters twice over here:
//   * Herdr may hand over to a new server during live handoff, re-running this;
//   * DingTalk allows only ONE Stream connection per app, so a second bridge
//     process would silently shadow the first one.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HERDR = process.env.HERDR_BIN_PATH ?? "herdr";
const PLUGIN_ID = process.env.HERDR_PLUGIN_ID ?? "dingtalk-omo-bridge";
const ROOT = process.env.HERDR_PLUGIN_ROOT ?? process.cwd();
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR ?? join(ROOT, "state");
const AGENT = process.env.LAB_TARGET_AGENT ?? "dingtalk";
const OMO_ENTRYPOINT = "omo-agent";
const BRIDGE_ENTRYPOINT = "dingtalk-stream";
// Must match the [[panes]] title in herdr-plugin.toml; Herdr exposes it as the
// pane label, which is how we find an existing bridge pane.
const BRIDGE_LABEL = "DingTalk ↔ OmO bridge";

function log(...parts) {
  console.log(`[${new Date().toISOString()}] startup:`, ...parts);
}

function herdr(args, { allowFail = false } = {}) {
  const r = spawnSync(HERDR, args, { encoding: "utf8", timeout: 60000 });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`herdr ${args.join(" ")} failed: ${(r.stderr ?? "").trim() || r.error?.message}`);
  }
  return r.stdout ?? "";
}

function herdrJson(args, opts) {
  const out = herdr(args, opts);
  const start = out.indexOf("{");
  if (start === -1) return {};
  try {
    return JSON.parse(out.slice(start));
  } catch {
    return {};
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function agentByName(name) {
  const json = herdrJson(["agent", "get", name], { allowFail: true });
  return json.result?.agent ?? null;
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// `plugin pane open` response shape is not worth parsing: diffing the pane list
// is both simpler and immune to it.
function paneList() {
  return herdrJson(["pane", "list"], { allowFail: true }).result?.panes ?? [];
}

function paneIds() {
  return paneList().map((p) => p.pane_id);
}

function findBridgePane() {
  return paneList().find((p) => p.label === BRIDGE_LABEL) ?? null;
}

async function openPane(entrypoint, env) {
  const before = new Set(paneIds());
  const args = [
    "plugin", "pane", "open",
    "--plugin", PLUGIN_ID,
    "--entrypoint", entrypoint,
    "--placement", "tab",
    "--cwd", ROOT,
    "--no-focus",
  ];
  for (const [k, v] of Object.entries(env ?? {})) args.push("--env", `${k}=${v}`);
  herdr(args);
  for (let i = 0; i < 20; i += 1) {
    await sleep(500);
    const fresh = paneIds().filter((id) => !before.has(id));
    if (fresh.length) return fresh[0];
  }
  return null;
}

// --- 1. the OmO agent pane --------------------------------------------------

async function ensureAgentPane() {
  const existing = agentByName(AGENT);
  if (existing) {
    log(`agent "${AGENT}" already live in ${existing.pane_id}`);
    return existing;
  }

  log(`opening OmO pane (entrypoint ${OMO_ENTRYPOINT})`);
  const paneId = await openPane(OMO_ENTRYPOINT);
  if (!paneId) {
    log("!! no new pane appeared for the OmO entrypoint, giving up on the agent");
    return null;
  }
  log("new pane", paneId);

  // Herdr detects OmO from its TUI; wait for that before naming it.
  for (let i = 0; i < 40; i += 1) {
    await sleep(1500);
    const info = herdrJson(["agent", "get", paneId], { allowFail: true }).result?.agent;
    if (info) {
      herdr(["agent", "rename", paneId, AGENT], { allowFail: true });
      const named = agentByName(AGENT);
      log(`agent ready in ${paneId}, named "${AGENT}"`);
      return named ?? info;
    }
  }
  log(`!! OmO in ${paneId} was not detected as an agent within 60s`);
  return null;
}

// --- 2. the bridge pane -----------------------------------------------------

async function ensureBridgePane() {
  const statePath = join(STATE_DIR, "dingtalk-bridge.json");
  let recordedPid = null;
  if (existsSync(statePath)) {
    try {
      recordedPid = JSON.parse(readFileSync(statePath, "utf8")).pid ?? null;
    } catch {
      log("unreadable bridge state");
    }
  }
  if (pidAlive(recordedPid)) {
    log(`bridge already running (pid ${recordedPid}), not opening a second connection`);
    return;
  }

  // A dead pid with a live pane means the pane survived but node did not (a
  // crash, or the user stopped it). Restart in place rather than piling up tabs.
  const existing = findBridgePane();
  if (existing) {
    log(`bridge pane ${existing.pane_id} exists but pid ${recordedPid} is dead, restarting in place`);
    herdr(["pane", "send-text", existing.pane_id, "node dingtalk-bridge.mjs"], { allowFail: true });
    await sleep(400);
    herdr(["pane", "send-keys", existing.pane_id, "enter"], { allowFail: true });
    return;
  }

  log(`opening bridge pane (entrypoint ${BRIDGE_ENTRYPOINT})`);
  const paneId = await openPane(BRIDGE_ENTRYPOINT, { LAB_TARGET_AGENT: AGENT });
  log("bridge pane", paneId ?? "!! not detected");
}

const agent = await ensureAgentPane();
await ensureBridgePane();
log("done", JSON.stringify({ agent: agent?.pane_id ?? null, cwd: agent?.cwd ?? null }));
