#!/usr/bin/env node
// CLI entry point for `npx herdr-dingtalk-omo-bridge` and `npx`-style bun runs.
//
// Handles --help / --version itself and delegates everything else, so that a
// typo prints a usage message instead of a stack trace.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const USAGE = `herdr-dingtalk-omo-bridge ${pkg.version} — install the DingTalk ↔ OmO bridge for Herdr

Usage:
  npx herdr-dingtalk-omo-bridge install [--dry-run] [--no-link] [--dir PATH]
  npx herdr-dingtalk-omo-bridge status
  npx herdr-dingtalk-omo-bridge uninstall [--dry-run] [--dir PATH]
  npx herdr-dingtalk-omo-bridge --help
  npx herdr-dingtalk-omo-bridge --version

Commands:
  install     Copy the plugin to a stable directory, install its dependencies,
              and register it with Herdr via \`herdr plugin link\`.
  status      Show what is installed and where Herdr thinks it is linked.
  uninstall   Unregister from Herdr and delete the installed files.

Options:
  --dry-run   Print the plan as JSON and change nothing.
  --no-link   Stop after the files and dependencies are in place, so you can
              inspect before registering anything with Herdr.
  --dir PATH  Install somewhere other than the default data directory.

Prerequisites: node >= 20, npm (or bun), Herdr >= 0.9.3, and \`omo\` on PATH.
After installing, register the DingTalk bot:
  herdr plugin action invoke dingtalk-omo-bridge.auth
`;

const argv = process.argv.slice(2);

if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
if (argv.length === 1 && ["--version", "-v"].includes(argv[0])) {
  console.log(pkg.version);
  process.exit(0);
}

try {
  const { run } = await import("../installer.mjs");
  process.exit(run(argv));
} catch (error) {
  console.error(`herdr-dingtalk-omo-bridge: ${error.message}`);
  process.exit(1);
}
