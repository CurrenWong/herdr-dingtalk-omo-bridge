// Syntax-check every module the package ships.
//
// This used to be a hand-written `node --check a && node --check b` chain in
// package.json, and it had already drifted: agent-target.mjs and slash.mjs are
// listed in `files` and imported by the bridge, but were never checked — a
// syntax error in either would have passed CI and only surfaced after publish,
// as a runtime crash for whoever installed it.
//
// The list is derived from `files` now, so it cannot drift again.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const modules = [];
for (const entry of pkg.files ?? []) {
  const path = join(root, entry);
  if (!existsSync(path)) continue;
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path)) {
      if (name.endsWith(".mjs")) modules.push(join(path, name));
    }
  } else if (entry.endsWith(".mjs")) {
    modules.push(path);
  }
}

if (!modules.length) {
  console.error("check: no modules found in package.json#files");
  process.exit(1);
}

let failed = 0;
for (const file of modules.sort()) {
  const rel = relative(root, file).split(sep).join("/");
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (r.status === 0) {
    console.log(`  ok   ${rel}`);
    continue;
  }
  failed += 1;
  console.error(`  FAIL ${rel}`);
  console.error((r.stderr ?? r.error?.message ?? "").trim());
}

console.log(failed ? `FAIL — ${failed} of ${modules.length} did not parse` : `PASS — ${modules.length} modules parse`);
process.exit(failed ? 1 : 0);
