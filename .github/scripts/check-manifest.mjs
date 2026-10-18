// Sanity-check herdr-plugin.toml.
//
// Catches the one drift that is easy to make and annoying to debug: the
// manifest's top-level `id` diverging from DEFAULT_PLUGIN_ID in
// herdr-paths.mjs, which would make the bridge read and write its state in a
// different directory than the one Herdr hands it.
//
// Written as a script rather than inline grep/awk because the manifest has an
// `id` key inside every [[actions]] / [[panes]] table too — only the top-level
// one counts, and getting that wrong is how this check failed the first time.
//
// Usage: node .github/scripts/check-manifest.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PLUGIN_ID } from "../../herdr-paths.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = readFileSync(join(root, "herdr-plugin.toml"), "utf8");

// Only the key/value block before the first table header is top-level.
const topLevel = manifest.split(/\n(?=\[)/)[0];

function topLevelValue(key) {
  const m = topLevel.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"));
  return m ? m[1] : null;
}

const problems = [];
const require = (key) => {
  const v = topLevelValue(key);
  if (v === null) problems.push(`herdr-plugin.toml is missing a top-level ${key}`);
  return v;
};

const id = require("id");
require("name");
require("version");
require("min_herdr_version");
const platforms = topLevel.match(/^platforms\s*=\s*\[([^\]]*)\]/m);

console.log(`manifest id:        ${id}`);
console.log(`code default id:    ${DEFAULT_PLUGIN_ID}`);
console.log(`platforms:          ${platforms ? platforms[1].trim() : "(none)"}`);
console.log(`min_herdr_version:  ${topLevelValue("min_herdr_version")}`);

if (id !== DEFAULT_PLUGIN_ID) {
  problems.push(
    `plugin id mismatch: herdr-plugin.toml says "${id}" but herdr-paths.mjs defaults to "${DEFAULT_PLUGIN_ID}"`,
  );
}

if (!platforms) {
  problems.push("herdr-plugin.toml declares no platforms (linking warns without it)");
} else {
  const declared = platforms[1].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
  const known = ["linux", "macos", "windows"];
  for (const p of declared) {
    if (!known.includes(p)) problems.push(`unknown platform "${p}"`);
  }
}

// The entrypoints referenced by the startup hook must exist.
const entrypoints = [...manifest.matchAll(/^\[\[panes\]\][\s\S]*?^id\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
const required = ["omo-agent", "dingtalk-stream"];
for (const r of required) {
  if (!entrypoints.includes(r)) problems.push(`missing required [[panes]] entrypoint "${r}"`);
}
console.log(`pane entrypoints:   ${entrypoints.join(", ") || "(none)"}`);

console.log("");
if (problems.length) {
  console.error("FAIL:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("PASS — manifest is consistent with the code defaults");
