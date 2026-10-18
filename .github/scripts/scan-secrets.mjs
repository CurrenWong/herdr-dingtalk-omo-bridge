// Committed secret scanner for CI.
//
// IMPORTANT: this is pattern-based on purpose. A scanner that pins the actual
// AppKey/AppSecret values as probes would itself be a secret leak the moment
// the repository is public. Patterns find unknown leaks; literals only find
// one known leak.
//
// Usage: node .github/scripts/scan-secrets.mjs [dir]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.argv[2] ?? process.cwd();

const SKIP_DIRS = new Set([".git", "node_modules", "state", ".github/workflows"]);
const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".json", ".toml", ".md", ".yml", ".yaml", ".txt", ".sh"]);

const PATTERNS = [
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}/g],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ["assigned secret literal", /\b(?:client_secret|appSecret|api_key|apiKey|password|passwd)\s*[:=]\s*["'][^"'\s]{12,}["']/gi],
  ["env assignment with value", /^\s*DINGTALK_CLIENT_SECRET\s*=\s*\S+/gm],
  ["slack / stripe style keys", /\b(?:xox[abprs]-[A-Za-z0-9-]{10,}|sk_live_[A-Za-z0-9]{20,})\b/g],
];

// Files that must never be committed at all.
const FORBIDDEN = [/^state\//, /(^|\/)\.env(\.|$)/, /(^|\/)node_modules\//, /\.pem$/, /id_rsa/];

const findings = [];

function scanFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const rel = relative(root, path).split(sep).join("/");

  for (const re of FORBIDDEN) {
    if (re.test(rel)) findings.push({ rel, rule: "forbidden path", snippet: rel });
  }
  // Match only the basename's extension; allow dotfiles like .gitignore.
  const ext = /\.[^./]+$/.exec(rel)?.[0] ?? "";
  if (!TEXT_EXT.has(ext)) return;

  for (const [name, re] of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const line = text.slice(0, m.index).split("\n").length;
      findings.push({ rel, rule: name, line, snippet: m[0].slice(0, 70) });
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

walk(root);

if (!findings.length) {
  console.log("PASS — no secrets and no forbidden paths found");
  process.exit(0);
}
console.error("FAIL — findings:\n");
for (const f of findings) {
  console.error(`  ${f.rel}${f.line ? `:${f.line}` : ""}  [${f.rule}]  ${f.snippet}`);
}
process.exit(1);
