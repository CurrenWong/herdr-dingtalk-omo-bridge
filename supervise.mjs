// Keep a plugin pane's command alive.
//
// Why this exists: Herdr reclaims a plugin pane the moment its command exits,
// and it has no restart/respawn policy — `[[startup]]` is a one-shot hook, not
// a supervisor. So a bridge process that crashes at 3am leaves the pane gone
// until the next server start, and the DingTalk bot goes silent. Running the
// real command under this wrapper keeps the pane (and its Herdr-managed
// terminal) alive across crashes.
//
// Usage: node supervise.mjs <command> [args...]
// The child inherits stdio, env and cwd, so a supervised command behaves
// exactly like a bare one — the pane still shows its output, and env vars
// passed via `plugin pane open --env` still reach it.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PLUGIN_ID, defaultStateDir } from "./herdr-paths.mjs";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: node supervise.mjs <command> [args...]");
  process.exit(2);
}

const STATE_DIR =
  process.env.HERDR_PLUGIN_STATE_DIR ??
  defaultStateDir(process.env.HERDR_PLUGIN_ID ?? DEFAULT_PLUGIN_ID);
const LOG = join(STATE_DIR, "supervise.log");
const LABEL = args.length ? `${command} ${args.join(" ")}` : command;

// A child that ran for at least this long counts as healthy, so a process that
// crashes hours later gets a fast retry instead of inheriting yesterday's
// backoff.
const HEALTHY_MS = 60000;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

try {
  mkdirSync(STATE_DIR, { recursive: true });
} catch {}

function log(...parts) {
  const line = `[${new Date().toISOString()}] [${LABEL}] ${parts.join(" ")}`;
  // Deliberately NOT console.log: stdout of a plugin pane is the pane's
  // terminal. When the supervised command is a full-screen TUI, a stray log
  // line lands in the middle of its rendering. The bridge logs its own file, so
  // silence here costs nothing.
  try {
    appendFileSync(LOG, line + "\n", "utf8");
  } catch {}
}

let stopping = false;
let child = null;
let startedAt = 0;
let failures = 0;

function start() {
  startedAt = Date.now();
  child = spawn(command, args, { stdio: "inherit", env: process.env, cwd: process.cwd() });

  child.on("error", (err) => {
    // Spawn itself failed (command not found, EACCES...). Back off as usual so
    // a bad PATH can't turn into a hot loop.
    log(`!! spawn failed: ${err.message}`);
    schedule();
  });

  child.on("exit", (code, signal) => {
    const uptime = Date.now() - startedAt;
    if (stopping) {
      log(`child gone (code=${code} signal=${signal}); supervisor stopping`);
      process.exit(code ?? 0);
    }
    if (uptime >= HEALTHY_MS) {
      log(`child ran ${Math.round(uptime / 1000)}s — resetting backoff`);
      failures = 0;
    }
    failures += 1;
    log(
      `child exited (code=${code} signal=${signal} after ${Math.round(uptime / 1000)}s); ` +
        `restart #${failures} in ${delayFor(failures)}ms`,
    );
    schedule();
  });
}

function delayFor(failures) {
  return Math.min(BASE_DELAY_MS * 2 ** (failures - 1), MAX_DELAY_MS);
}

function schedule() {
  const delay = delayFor(Math.max(failures, 1));
  setTimeout(() => {
    if (!stopping) start();
  }, delay);
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`received ${signal}, stopping child`);
  if (child) {
    try {
      child.kill();
    } catch {}
  }
  // Give the child a moment to die with us instead of orphaning it on Windows.
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log(`supervising pid ${process.pid}`);
start();
