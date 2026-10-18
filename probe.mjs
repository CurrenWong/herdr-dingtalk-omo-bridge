// One-shot probe: what does Herdr actually hand a plugin command?
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ENV_KEYS = [
  "HERDR_ENV",
  "HERDR_BIN_PATH",
  "HERDR_SOCKET_PATH",
  "HERDR_PLUGIN_ID",
  "HERDR_PLUGIN_ROOT",
  "HERDR_PLUGIN_ACTION_ID",
  "HERDR_PLUGIN_ENTRYPOINT_ID",
  "HERDR_PLUGIN_EVENT",
  "HERDR_PLUGIN_CONFIG_DIR",
  "HERDR_PLUGIN_STATE_DIR",
  "HERDR_WORKSPACE_ID",
  "HERDR_TAB_ID",
  "HERDR_PANE_ID",
];

const env = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k] ?? null]));

function parseJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const context = parseJson(process.env.HERDR_PLUGIN_CONTEXT_JSON);
const herdr = process.env.HERDR_BIN_PATH ?? "herdr";

const calls = {};
for (const [name, args] of Object.entries({
  version: ["--version"],
  status: ["status"],
  agents: ["agent", "list"],
  panes: ["pane", "list"],
  snapshot: ["api", "snapshot"],
})) {
  const r = spawnSync(herdr, args, { encoding: "utf8", timeout: 20000 });
  calls[name] = {
    status: r.status,
    error: r.error?.message ?? null,
    stderr: (r.stderr ?? "").trim().slice(0, 500) || null,
    stdout: (r.stdout ?? "").trim().slice(0, 4000) || null,
  };
}

const report = {
  at: new Date().toISOString(),
  cwd: process.cwd(),
  node: process.version,
  argv: process.argv,
  env,
  context,
  calls,
};

const outDir = process.env.HERDR_PLUGIN_STATE_DIR ?? join(process.cwd(), "state");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `probe-${Date.now()}.json`);
writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");

console.log(JSON.stringify({ ok: true, outFile, env, context }, null, 2));
