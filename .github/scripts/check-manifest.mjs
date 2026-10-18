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
import { existsSync, readFileSync } from "node:fs";
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

// The lockfile must agree with package.json. The install runs `npm ci
// --omit=dev`, and a lockfile left behind by a rename makes it unclear whether
// that will succeed at install time — which is not a thing you want to discover
// on someone else's machine.
//
// It is named npm-shrinkwrap.json rather than package-lock.json because npm
// refuses to publish a root package-lock, and the `npx ... install` channel
// needs the lock to travel with the package.
const LOCKFILE = existsSync(join(root, "npm-shrinkwrap.json"))
  ? "npm-shrinkwrap.json"
  : "package-lock.json";
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, LOCKFILE), "utf8"));
const lockRoot = lock.packages?.[""] ?? {};

if (LOCKFILE !== "npm-shrinkwrap.json") {
  problems.push(
    "npm-shrinkwrap.json is missing — npm cannot publish package-lock.json, so the npx install would have no lockfile",
  );
}

console.log(`package.json:       ${pkg.name}@${pkg.version}`);
console.log(`${LOCKFILE}:  ${lock.name}@${lock.version}`);

if (lock.name !== pkg.name) {
  problems.push(`${LOCKFILE} name "${lock.name}" != package.json name "${pkg.name}" — run: npm install --package-lock-only`);
}
if (lock.version !== pkg.version) {
  problems.push(`${LOCKFILE} version "${lock.version}" != package.json version "${pkg.version}" — run: npm install --package-lock-only`);
}
if (lockRoot.name && lockRoot.name !== pkg.name) {
  problems.push(`${LOCKFILE} root package name "${lockRoot.name}" is stale`);
}

// The manifest's build step must match what CI verifies, or CI is testing a
// different install path than users get.
const buildCmd = manifest.match(/^\[\[build\]\][\s\S]*?^command\s*=\s*\[([^\]]*)\]/m);
const buildParts = buildCmd
  ? buildCmd[1].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean)
  : [];
console.log(`build command:      ${buildParts.join(" ") || "(none)"}`);
if (!buildParts.join(" ").includes("npm ci")) {
  problems.push("manifest [[build]] should run `npm ci --omit=dev`, matching CI");
}

// A lockfile can parse and still not reproduce: an entry without `resolved` or
// `integrity` reinstalls from whatever the registry serves that day. Worse,
// npm ci aborts on a malformed lock, and the manifest runs exactly that — so
// the failure would land on a user mid-install with no obvious cause.
const lockEntries = Object.entries(lock.packages ?? {}).filter(([k]) => k !== "");
let missingPinned = 0;

if (lock.lockfileVersion !== 3) {
  problems.push(`package-lock.json lockfileVersion is ${lock.lockfileVersion}, expected 3 (npm 9+)`);
}
if (lockRoot.license && lockRoot.license !== pkg.license) {
  problems.push(`lockfile license "${lockRoot.license}" != package.json "${pkg.license}"`);
}

for (const [path, meta] of lockEntries) {
  if (meta.link) continue;
  if (!meta.resolved) problems.push(`${path}: no resolved URL in lockfile`);
  if (!meta.integrity) problems.push(`${path}: no integrity hash in lockfile`);
  if (!/^sha(1|256|512)-/.test(meta.integrity ?? "")) {
    problems.push(`${path}: integrity is not a sha digest (${meta.integrity})`);
  }
  if (!meta.resolved || !meta.integrity) missingPinned += 1;
}

for (const dep of Object.keys(pkg.dependencies ?? {})) {
  const present = lockEntries.some(([k, m]) => m.name === dep || k.endsWith(`node_modules/${dep}`));
  if (!present) problems.push(`declared dependency "${dep}" has no lockfile entry`);
}

console.log(`lockfile entries:   ${lockEntries.length} (${lockEntries.length - missingPinned} fully pinned)`);

// Every locally-imported module must be in `files`.
//
// `files` is an explicit allowlist, so splitting logic into a new .mjs file and
// forgetting to list it produces a package that installs cleanly and then dies
// with MODULE_NOT_FOUND on first use — after publishing, on someone's machine.
// Nothing else in this repo would notice: the source tree has the file, so both
// CI and local runs pass.
const importers = [
  "dingtalk-bridge.mjs",
  "installer.mjs",
  "startup.mjs",
  "check-reply.mjs",
  "supervise.mjs",
  "attachments.mjs",
  "inbound.mjs",
  "session-log.mjs",
  "agent-target.mjs",
  "bin/herdr-dingtalk-omo-bridge.mjs",
].filter((f) => existsSync(join(root, f)));

const shippable = new Set(
  (pkg.files ?? []).flatMap((entry) =>
    entry.endsWith("/")
      ? [] // directory entries need a listing; checked below instead
      : [entry],
  ),
);
const shippableDirs = (pkg.files ?? []).filter((e) => e.endsWith("/"));

const localImports = new Set();
for (const file of importers) {
  const src = readFileSync(join(root, file), "utf8");
  for (const m of src.matchAll(/^import[^;]*?from\s+["'](\.\/[^"']+|\.\.\/[^"']+)["']/gm)) {
    localImports.add(m[1].replace(/^\.\//, ""));
  }
}

const unshipped = [];
for (const spec of localImports) {
  if (shippable.has(spec)) continue;
  if (shippableDirs.some((d) => spec.startsWith(d))) continue;
  unshipped.push(spec);
}

console.log(`local imports:      ${localImports.size} checked, ${unshipped.length} missing from files`);
if (unshipped.length) {
  for (const u of unshipped) {
    problems.push(`"${u}" is imported but not listed in package.json "files" — the published package would fail with MODULE_NOT_FOUND`);
  }
}

console.log("");
if (problems.length) {
  console.error("FAIL:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("PASS — manifest, package metadata and lockfile are consistent");
