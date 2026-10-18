// Test the platform branches in herdr-paths.mjs.
//
// The plugin is only end-to-end verified on Windows, and node:path's separator
// plus os.homedir() are both pinned to the host OS — so the darwin/linux
// branches cannot be reached from a Windows runner by faking process.platform.
// resolveRoots() takes platform/env/home as arguments precisely so every branch
// is checkable on every runner.
//
// Usage: node .github/scripts/check-paths.mjs
import { isAbsolute, sep } from "node:path";
import { homedir } from "node:os";
import {
  DEFAULT_PLUGIN_ID,
  configDirFor,
  defaultConfigDir,
  defaultStateDir,
  resolveRoots,
  stateDirFor,
} from "../../herdr-paths.mjs";

const problems = [];
const fail = (msg) => problems.push(msg);

// --- 1. every branch of resolveRoots composes the right segments -----------

const BRANCHES = [
  {
    platform: "win32",
    home: "HOME",
    env: { APPDATA: "ENV_APPDATA", LOCALAPPDATA: "ENV_LOCALAPPDATA" },
    expectConfig: "ENV_APPDATA",
    expectState: "ENV_LOCALAPPDATA",
  },
  {
    platform: "win32",
    home: "HOME",
    env: {}, // fall back to <home>\AppData\...
    expectConfig: ["HOME", "AppData", "Roaming"],
    expectState: ["HOME", "AppData", "Local"],
  },
  { platform: "darwin", home: "HOME", env: {}, expectConfig: ["HOME", "Library", "Application Support"], expectState: ["HOME", "Library", "Application Support"] },
  { platform: "linux", home: "HOME", env: {}, expectConfig: ["HOME", ".config"], expectState: ["HOME", ".local", "share"] },
  {
    platform: "linux",
    home: "HOME",
    env: { XDG_CONFIG_HOME: "XDG_CFG", XDG_DATA_HOME: "XDG_DATA" },
    expectConfig: "XDG_CFG",
    expectState: "XDG_DATA",
  },
  { platform: "freebsd", home: "HOME", env: {}, expectConfig: ["HOME", ".config"], expectState: ["HOME", ".local", "share"] }, // unknown -> POSIX
];

console.log("resolveRoots() branches");
for (const b of BRANCHES) {
  // A path-shaped home is required for join() to behave; use a POSIX-style
  // string, which path.join handles on any host.
  const roots = resolveRoots({ platform: b.platform, env: b.env, home: b.home });
  const label = `${b.platform}${Object.keys(b.env).length ? " (env set)" : ""}`;

  const expect = (got, want, which) => {
    if (Array.isArray(want)) {
      const joined = want.join(sep);
      if (got !== joined) fail(`${label} ${which}: expected ${joined}, got ${got}`);
    } else if (got !== want) {
      fail(`${label} ${which}: expected ${want}, got ${got}`);
    }
  };

  expect(roots.config, b.expectConfig, "config");
  expect(roots.state, b.expectState, "state");
  console.log(`  ${label.padEnd(22)} config=${roots.config}  state=${roots.state}`);
}

// --- 2. the bound helpers produce absolute, home-rooted, id-bearing paths --

console.log("");
console.log(`bound defaults on this runner (${process.platform})`);
const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
for (const [label, value] of [
  ["defaultConfigDir()", defaultConfigDir()],
  ["defaultConfigDir('other')", defaultConfigDir("other")],
  ["defaultStateDir()", defaultStateDir()],
  ["defaultStateDir('other')", defaultStateDir("other")],
]) {
  console.log(`  ${label.padEnd(28)} ${value}`);
  if (!isAbsolute(value)) fail(`${label} is not absolute: ${value}`);
  if (home && !value.startsWith(home)) fail(`${label} is not under ${home}: ${value}`);
  if (value.includes(sep + sep)) fail(`${label} contains an empty segment: ${value}`);
}

// --- 3. the plugin id must survive into the path --------------------------

console.log("");
const roots = resolveRoots({ platform: process.platform, env: process.env, home });
for (const [label, value, id] of [
  ["configDirFor()", configDirFor(roots), DEFAULT_PLUGIN_ID],
  ["stateDirFor('x')", stateDirFor(roots, "x"), "x"],
]) {
  if (!value.endsWith(id)) fail(`${label} lost the plugin id: ${value}`);
}
console.log(`plugin id carried into: ${configDirFor(roots, "probe")}`);

console.log("");
if (problems.length) {
  console.error("FAIL:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("PASS — win32 / darwin / linux (default, env and XDG) all resolve correctly");
