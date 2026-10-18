// Installer behind `npx herdr-dingtalk-omo-bridge install`.
//
// Why this exists: `herdr plugin install` clones from GitHub, which needs git.
// npm/bun users expect `npx <pkg> install`. This unpacks the package into a
// stable directory and asks Herdr to link it — `plugin link <PATH>` is the only
// Herdr primitive that accepts a local directory.
//
// Design notes, most of them learned the hard way elsewhere:
//   * Install into a versioned directory, never in place. Upgrading while a
//     bridge pane is running would otherwise try to overwrite open files.
//   * Refuse to touch a directory we did not create. `.installed-by` is the
//     marker; without it the target might be someone's git checkout.
//   * `--dry-run` prints the whole plan and changes nothing.
//   * `--no-link` stops after the files are in place, for inspecting first.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "installed by herdr-dingtalk-omo-bridge";
const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(SOURCE, "package.json"), "utf8"));
const PLUGIN_ID = "dingtalk-omo-bridge";

// --- target location ------------------------------------------------------

function dataRoot() {
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support");
  }
  return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
}

function defaultInstallRoot() {
  // Deliberately not Herdr's state directory: that holds the bridge's logs and
  // pid file, and mixing code into it makes both harder to reason about.
  return join(dataRoot(), "herdr", "plugin-packages", PLUGIN_ID);
}

// --- herdr CLI ------------------------------------------------------------

function herdrBin() {
  return process.env.HERDR_BIN_PATH ?? "herdr";
}

function herdr(args) {
  const r = spawnSync(herdrBin(), args, { encoding: "utf8", timeout: 60000 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

function linkedPaths() {
  const r = herdr(["plugin", "list"]);
  if (!r.ok) return [];
  return [...r.out.matchAll(/local:([^\]]+)\]/g)].map((m) => resolve(m[1]));
}

// --- payload --------------------------------------------------------------

// Everything the plugin needs at runtime. `files` in package.json is what npm
// ships; this is the subset the installer copies. package.json and
// npm-shrinkwrap.json travel along so `npm ci` can run in the target.
//
// npm refuses to publish a root package-lock.json, so the lockfile lives as
// npm-shrinkwrap.json — the mechanism npm provides for exactly this case. It
// is published automatically and `npm ci` honours it.
function payloadFiles() {
  const shipped = pkg.files ?? [];
  const extra = ["package.json", "npm-shrinkwrap.json", "README.md", "LICENSE"];
  return [...new Set([...shipped, ...extra])].filter((f) => existsSync(join(SOURCE, f)));
}

function copyPayload(target) {
  let copied = 0;
  for (const rel of payloadFiles()) {
    cpSync(join(SOURCE, rel), join(target, rel), { recursive: true });
    copied += 1;
  }
  return copied;
}

// --- dependency install ---------------------------------------------------

function installDeps(target) {
  const attempts = [
    ["npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"]],
    // Only reached if npm is absent; Herdr runs the plugin with `node`, so a
    // node install without npm is unusual but not impossible (bun-only setups).
    ["bun", ["install", "--production"]],
  ];
  for (const [cmd, args] of attempts) {
    const r = spawnSync(cmd, args, { cwd: target, encoding: "utf8", timeout: 600000, shell: process.platform === "win32" });
    if (r.error?.code === "ENOENT") continue;
    if (r.status === 0) return { ok: true, runner: `${cmd} ${args.join(" ")}` };
    return { ok: false, runner: `${cmd} ${args.join(" ")}`, error: (r.stderr ?? "").trim().split("\n").slice(-5).join("\n") };
  }
  return { ok: false, runner: "none", error: "neither npm nor bun is on PATH" };
}

// --- commands -------------------------------------------------------------

function install(opts) {
  const root = opts.dir ? resolve(opts.dir) : defaultInstallRoot();
  const target = join(root, pkg.version);
  const markerPath = join(target, ".installed-by");

  if (existsSync(target) && !existsSync(markerPath)) {
    throw new Error(
      `${target} already exists and was not created by this installer.\n` +
        `  Move it aside, or pass --dir to install somewhere else.`,
    );
  }

  const linked = linkedPaths();
  const plan = {
    plugin: PLUGIN_ID,
    version: pkg.version,
    source: SOURCE,
    target,
    files: payloadFiles(),
    dependencies: "npm ci --omit=dev  (falls back to bun install --production)",
    alreadyInstalled: existsSync(target),
    currentlyLinkedAt: linked.length ? linked : null,
    linkCommand: `${herdrBin()} plugin link "${target}"`,
    notes: [
      linked.some((p) => p === target)
        ? "already linked at this path"
        : "Herdr allows one registration per plugin id; if it is linked elsewhere, unlink first",
    ],
  };

  if (opts.dryRun) {
    console.log(JSON.stringify({ dryRun: true, ...plan }, null, 2));
    return 0;
  }

  console.log(`installing ${PLUGIN_ID}@${pkg.version}`);
  console.log(`  target: ${target}`);
  mkdirSync(target, { recursive: true });
  const count = copyPayload(target);
  writeFileSync(markerPath, `${MARKER}\nversion=${pkg.version}\n`, "utf8");
  console.log(`  copied: ${count} entries`);

  console.log("  installing dependencies…");
  const deps = installDeps(target);
  if (!deps.ok) {
    console.error(`  dependency install FAILED (${deps.runner})`);
    if (deps.error) console.error(deps.error.replace(/^/gm, "    "));
    console.error(`\n  Run it by hand to see the full output:\n    cd "${target}" && ${deps.runner}`);
    return 1;
  }
  console.log(`  dependencies: ok (${deps.runner})`);

  if (opts.noLink) {
    console.log(`\n  --no-link given, so nothing was registered with Herdr. To finish:`);
    console.log(`    ${plan.linkCommand}`);
    return 0;
  }

  const others = linked.filter((p) => p !== target);
  if (others.length) {
    console.log(`\n  note: ${PLUGIN_ID} is already linked at ${others.join(", ")}`);
    console.log(`        Herdr keys plugins by id, so linking here replaces it:`);
    console.log(`          ${herdrBin()} plugin unlink ${PLUGIN_ID}`);
  }

  const link = herdr(["plugin", "link", target]);
  if (!link.ok) {
    console.error(`\n  ${herdrBin()} plugin link failed:`);
    if (link.err) console.error(link.err.replace(/^/gm, "    "));
    console.error(`\n  The files are in place. Register them with:\n    ${plan.linkCommand}`);
    return 1;
  }
  console.log(`  linked with Herdr`);

  console.log(`\ndone. Next:`);
  console.log(`  ${herdrBin()} plugin action invoke ${PLUGIN_ID}.auth     # register the bot (scan the QR)`);
  console.log(`  ${herdrBin()} server reload-config                      # or just restart Herdr`);
  return 0;
}

// A marker that merely exists is not proof: `--dir` can point anywhere, and any
// directory holding a file of that name would then be recursively force-deleted.
// Check what the file says before treating the directory as ours.
function isOurs(dir) {
  try {
    return readFileSync(join(dir, ".installed-by"), "utf8").startsWith(MARKER);
  } catch {
    return false;
  }
}

function uninstall(opts) {
  const root = resolve(opts.dir ?? defaultInstallRoot());
  const removed = [];

  if (existsSync(root)) {
    for (const name of readdirSync(root)) {
      const dir = join(root, name);
      if (!isOurs(dir)) continue;
      removed.push(dir);
    }
  }

  // A path-component boundary, not a string prefix: `<root>-backup` shares the
  // prefix but is a different directory, and unlinking on that match only made
  // noise.
  const linked = linkedPaths().filter((p) => p === root || p.startsWith(root + sep));
  const plan = {
    root,
    directories: removed,
    linkedPaths: linked,
    herdrCommand: `${herdrBin()} plugin unlink ${PLUGIN_ID}`,
  };

  if (opts.dryRun) {
    console.log(JSON.stringify({ dryRun: true, wouldRemove: plan }, null, 2));
    return 0;
  }

  if (!removed.length && !linked.length) {
    console.log(`nothing installed at ${root}`);
    return 0;
  }

  // Unregister before deleting, so Herdr never points at a missing directory.
  // The old order deleted during the scan above and then printed this comment.
  for (const p of linked) {
    const r = herdr(["plugin", "unlink", PLUGIN_ID]);
    if (!r.ok && r.err) console.log(`  herdr unlink: ${r.err}`);
  }
  for (const d of removed) {
    rmSync(d, { recursive: true, force: true });
    console.log(`  removed ${d}`);
  }

  // Leave no empty root behind, but never delete a directory that still holds
  // something we did not put there.
  if (!opts.dryRun && existsSync(root)) {
    try {
      if (readdirSync(root).length === 0) rmSync(root, { recursive: false });
    } catch {}
  }

  // The config dir holds the DingTalk credentials. Say so rather than
  // silently leaving a secret behind or silently destroying it.
  console.log(`\n  credentials and logs were left in Herdr's config/state directories;`);
  console.log(`  delete them yourself if you want a clean slate.`);
  return 0;
}

function status(opts) {
  const root = opts.dir ? resolve(opts.dir) : defaultInstallRoot();
  const installed = existsSync(root) ? readdirSync(root).filter((n) => existsSync(join(root, n, ".installed-by"))) : [];
  const linked = linkedPaths();
  console.log(
    JSON.stringify(
      {
        plugin: PLUGIN_ID,
        packageVersion: pkg.version,
        installRoot: root,
        installed,
        linkedWithHerdr: linked,
        // Which of the installed copies Herdr is actually pointing at.
        active: installed.filter((n) => linked.includes(join(root, n))),
      },
      null,
      2,
    ),
  );
  return 0;
}

// --- argument parsing -----------------------------------------------------

export function run(argv) {
  const [command, ...rest] = argv;
  const opts = {
    dryRun: rest.includes("--dry-run"),
    noLink: rest.includes("--no-link"),
    dir: rest.includes("--dir") ? rest[rest.indexOf("--dir") + 1] : undefined,
  };

  if (rest.includes("--dir") && (!opts.dir || opts.dir.startsWith("-"))) {
    throw new Error("--dir requires a path");
  }
  for (const a of rest) {
    if (a.startsWith("--") && !["--dry-run", "--no-link", "--dir"].includes(a)) {
      throw new Error(`unknown option: ${a}`);
    }
  }

  switch (command) {
    case "install":
      return install(opts);
    case "uninstall":
      return uninstall(opts);
    case "status":
      return status(opts);
    default:
      throw new Error(`unknown command: ${command ?? "(none)"} — try --help`);
  }
}

export { MARKER, defaultInstallRoot, payloadFiles };
