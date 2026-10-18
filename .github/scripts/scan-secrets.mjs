// Committed secret scanner for CI.
//
// IMPORTANT: this is pattern-based on purpose. A scanner that pins the actual
// AppKey/AppSecret values as probes would itself be a secret leak the moment
// the repository is public. Patterns find unknown leaks; literals only find
// one known leak.
//
// Usage: node .github/scripts/scan-secrets.mjs [dir]
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.argv[2] ?? process.cwd();

const SKIP_DIRS = new Set([".git", "node_modules", "state", ".github/workflows"]);
const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".json", ".toml", ".md", ".yml", ".yaml", ".txt", ".sh"]);
// Dotfiles and config files that carry no extension but must always be scanned.
const ALWAYS_TEXT = new Set([".npmrc", ".env", ".gitignore", ".gitattributes", ".yarnrc"]);

const PATTERNS = [
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}/g],
  // npm access tokens. The repo ships a .npmrc that authenticates from
  // ${NPM_TOKEN}; a literal token pasted on that line would get committed.
  ["npm access token", /\bnpm_[A-Za-z0-9]{30,}/g],
  ["npmrc literal token", /_authToken\s*=\s*(?!\$\{)[A-Za-z0-9_-]{10,}/g],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ["assigned secret literal", /\b(?:client_secret|appSecret|api_key|apiKey|password|passwd)\s*[:=]\s*["'][^"'\s]{12,}["']/gi],
  ["env assignment with value", /^\s*DINGTALK_CLIENT_SECRET\s*=\s*\S+/gm],
  ["slack / stripe style keys", /\b(?:xox[abprs]-[A-Za-z0-9-]{10,}|sk_live_[A-Za-z0-9]{20,})\b/g],
];

// Files that must never be committed at all.
const FORBIDDEN = [/^state\//, /(^|\/)\.env(\.|$)/, /(^|\/)node_modules\//, /\.pem$/, /id_rsa/];

// Whether a forbidden path is only a problem on disk (no git to ask) or only a
// problem once git carries it. Set before the walk; see trackedForbidden().
let checkForbiddenOnDisk = true;

const findings = [];

// The report is printed into CI logs, which outlive the run and are readable by
// anyone with access to the build. Quoting the match would republish the exact
// value this script exists to keep out of the repository — so report its shape
// only. The rule name already says what kind it is, and the length is enough to
// tell which value leaked without being enough to use it.
function mask(value) {
  const s = String(value);
  return s.length <= 6 ? `(${s.length} chars)` : `${s.slice(0, 3)}…(${s.length} chars)`;
}

function scanFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const rel = relative(root, path).split(sep).join("/");

  if (checkForbiddenOnDisk) {
    for (const re of FORBIDDEN) {
      if (re.test(rel)) findings.push({ rel, rule: "forbidden path", snippet: rel });
    }
  }
  // Decide by basename, not just extension. `.npmrc` has no extension at all
  // and is exactly where an npm token would be pasted, so an extension-only
  // allowlist silently skips the file most likely to leak.
  const base = rel.split("/").pop();
  const ext = /\.[^./]+$/.exec(base)?.[0] ?? "";
  const isText = TEXT_EXT.has(ext) || ALWAYS_TEXT.has(base) || (ext === "" && text.length < 1024 * 1024);
  if (!isText) return;

  for (const [name, re] of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const line = text.slice(0, m.index).split("\n").length;
      findings.push({ rel, rule: name, line, snippet: mask(m[0]) });
      if (findings.length > 50) return;
    }
  }
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p);
    else if (st.isFile()) scanFile(p);
  }
}

// A forbidden path is a leak once git carries it. `state/` and `node_modules/`
// exist in every working checkout and are gitignored — the walker skips them,
// which also made their FORBIDDEN rules unreachable: a credential committed
// under `state/` was never reported. Ask git what is tracked instead of
// inferring it from what happens to be on disk.
function trackedForbidden() {
  const r = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", timeout: 60000 });
  if (r.status !== 0) return null;
  return r.stdout.split("\0").filter(Boolean).filter((rel) => FORBIDDEN.some((re) => re.test(rel)));
}

const tracked = trackedForbidden();
// Without git there is nothing better than presence on disk; with it, a file
// sitting untracked in a working copy is not a commit.
checkForbiddenOnDisk = tracked === null;

walk(root);

if (tracked) {
  for (const rel of tracked) findings.push({ rel, rule: "forbidden path", snippet: rel });
}

if (!findings.length) {
  console.log("PASS — no secrets and no forbidden paths found");
  process.exit(0);
}
console.error("FAIL — findings:\n");
for (const f of findings) {
  console.error(`  ${f.rel}${f.line ? `:${f.line}` : ""}  [${f.rule}]  ${f.snippet}`);
}
process.exit(1);
