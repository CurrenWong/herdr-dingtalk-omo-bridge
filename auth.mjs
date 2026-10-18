// DingTalk bot registration via Device Flow — ported from QwenPaw's
// DingtalkQRCodeAuthHandler (app/channels/qrcode_auth_handler.py).
//
//   POST https://oapi.dingtalk.com/app/registration/init   -> nonce
//   POST https://oapi.dingtalk.com/app/registration/begin  -> device_code + scan url
//   POST https://oapi.dingtalk.com/app/registration/poll   -> client_id + client_secret
//
// Runs until it succeeds, fails, or the device code expires. Artifacts land in
// ./state/auth/ and the credentials are written to the plugin config dir as .env
// so the bridge picks them up on its next start.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const API = "https://oapi.dingtalk.com";
const SOURCE = process.env.DT_SOURCE ?? "HERDR";
const stateDir = join(process.cwd(), "state", "auth");
mkdirSync(stateDir, { recursive: true });

const logFile = join(stateDir, "auth.log");

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
  console.log(line);
  try {
    writeFileSync(logFile, line + "\n", { encoding: "utf8", flag: "a" });
  } catch {}
}

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
}

function writeStatus(state, extra = {}) {
  writeFileSync(
    join(stateDir, "status.json"),
    JSON.stringify({ at: new Date().toISOString(), state, ...extra }, null, 2),
    "utf8",
  );
}

// Prefer a real PNG via segno; fall back to printing the URL so a human can
// render it. The PNG is a convenience, never a hard requirement, so an
// interpreter we cannot find just downgrades the output.
function findPython() {
  const candidates = [process.env.PYTHON_PATH, "python", "python3", "py"].filter(Boolean);
  for (const exe of candidates) {
    const r = spawnSync(exe, ["-c", "import segno"], { encoding: "utf8", timeout: 20000 });
    if (r.status === 0) return exe;
  }
  return null;
}

function renderQrPng(scanUrl) {
  const exe = findPython();
  if (!exe) {
    log("no python with segno found — printing the scan URL instead");
    return false;
  }
  const out = join(stateDir, "qrcode.png");
  const r = spawnSync(
    exe,
    [
      "-c",
      "import segno,sys;segno.make(sys.argv[1], error='M').save(sys.argv[2], kind='png', scale=6, border=2);print('ok')",
      scanUrl,
      out,
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  if (r.status === 0 && existsSync(out)) {
    log("qr png:", out);
    return true;
  }
  log("qr render failed:", r.stderr?.trim() ?? r.error?.message);
  return false;
}

function resolveConfigDir() {
  // Action commands get HERDR_PLUGIN_CONFIG_DIR, but a plugin pane process
  // does not — ask Herdr instead of guessing the platform's location.
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) {
    return process.env.HERDR_PLUGIN_CONFIG_DIR;
  }
  const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
  const id = process.env.HERDR_PLUGIN_ID ?? "lab.dingtalk-bridge";
  const r = spawnSync(herdr, ["plugin", "config-dir", id], { encoding: "utf8", timeout: 15000 });
  const dir = (r.stdout ?? "").trim();
  if (r.status === 0 && dir) return dir;
  return join(process.env.LOCALAPPDATA ?? "", "herdr", "plugins", "config", id);
}

function writeEnv(clientId, clientSecret) {
  const dir = resolveConfigDir();
  mkdirSync(dir, { recursive: true });
  const envPath = join(dir, ".env");
  const body = [
    "# written by auth.mjs — DingTalk bot registration (device flow)",
    `DINGTALK_CLIENT_ID=${clientId}`,
    `DINGTALK_CLIENT_SECRET=${clientSecret}`,
    "",
  ].join("\n");
  writeFileSync(envPath, body, "utf8");
  log("credentials written to", envPath);
  return envPath;
}

async function main() {
  log("starting DingTalk device-flow registration, source =", SOURCE);

  const init = await post("/app/registration/init", { source: SOURCE });
  if (init.errcode !== 0 || !init.nonce) throw new Error(`init failed: ${init.errmsg}`);
  log("init ok, nonce ttl", init.expires_in, "s");

  const begin = await post("/app/registration/begin", { nonce: init.nonce });
  if (begin.errcode !== 0) throw new Error(`begin failed: ${begin.errmsg}`);

  const deviceCode = begin.device_code;
  const scanUrl = begin.verification_uri_complete;
  writeFileSync(join(stateDir, "device_code.txt"), deviceCode, "utf8");
  writeFileSync(join(stateDir, "qrcode.url.txt"), scanUrl, "utf8");
  renderQrPng(scanUrl);
  writeStatus("waiting_for_scan", { user_code: begin.user_code, expires_in: begin.expires_in });

  console.log("");
  console.log(`  scan url : ${scanUrl}`);
  console.log(`  user code: ${begin.user_code}`);
  console.log(`  expires  : ${Math.round((begin.expires_in ?? 7200) / 60)} min`);
  console.log("");

  const intervalMs = Math.max(2000, (begin.interval ?? 2) * 1000);
  const deadline = Date.now() + (begin.expires_in ?? 7200) * 1000;
  const seen = [];

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));

    let data;
    try {
      data = await post("/app/registration/poll", { device_code: deviceCode });
    } catch (err) {
      log("poll error:", err.message, "(retrying)");
      continue;
    }

    const status = String(data.status ?? "").toUpperCase();
    const clientId = typeof data.client_id === "string" ? data.client_id.trim() : "";
    const clientSecret = typeof data.client_secret === "string" ? data.client_secret.trim() : "";

    if (status && status !== seen[seen.length - 1]) {
      seen.push(status);
      log("status:", status);
    }

    if (clientId && clientSecret) {
      const envPath = writeEnv(clientId, clientSecret);
      writeFileSync(
        join(stateDir, "credentials.json"),
        JSON.stringify(
          { at: new Date().toISOString(), client_id: clientId, client_secret: clientSecret },
          null,
          2,
        ),
        "utf8",
      );
      writeStatus("success", { client_id: clientId, env_path: envPath });
      log("SUCCESS — credentials issued and stored");
      return;
    }

    if (status === "FAIL" || status === "EXPIRED") {
      writeStatus(status === "EXPIRED" ? "expired" : "fail", {
        fail_reason: data.fail_reason ?? data.errmsg ?? null,
      });
      log("FAILED:", status, data.fail_reason ?? data.errmsg ?? "");
      return;
    }

    writeStatus(status ? status.toLowerCase() : "waiting", { user_code: begin.user_code });
  }

  writeStatus("expired", { fail_reason: "device code expired" });
  log("expired before credentials were issued");
}

main().catch((err) => {
  log("ERROR", err.message);
  writeStatus("error", { fail_reason: err.message });
  process.exitCode = 1;
});
