// Every message the bridge can send must exist in every language it claims.
//
// `t(key)` throws `missing message: <key> (lang=<lang>)` rather than returning
// undefined, deliberately: a half-translated message used to reach users as a
// bridge error instead of a reply. The cost of that choice is that a key added
// to one block and forgotten in the other takes out a whole turn at runtime,
// mid-conversation — and nothing so far noticed until a user hit it.
//
// Two failures, both checked:
//   1. a `t("key")` call site with no entry in one of the blocks
//   2. an entry in one block with no counterpart in the other
//
// Parsed with a brace counter rather than a regex over the whole file: the
// blocks contain Chinese text, backticks and nested braces inside template
// literals, so "the next line that looks like a key" is not a safe rule.
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
// An argument exists so the checker can itself be tested against a broken copy.
// A checker that can only ever say PASS is indistinguishable from one that
// parses nothing.
const file = resolve(process.argv[2] ?? resolve(root, "dingtalk-bridge.mjs"));
const source = readFileSync(file, "utf8");

/** Index of the `}` that closes the `{` at `open`, ignoring strings and comments. */
function closeOf(text, open) {
  let depth = 0;
  let quote = null;
  let inLineComment = false;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && next === "/") {
      inLineComment = true;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Top-level keys of the object literal whose `{` is at `open`. */
function keysOf(text, open) {
  const close = closeOf(text, open);
  if (close === -1) return null;
  const body = text.slice(open + 1, close);
  const keys = [];
  let depth = 0;
  let quote = null;
  let atLineStart = true;
  let start = 0;
  // Only keys at depth 0 count: nested objects (textEmotion-style payloads)
  // are data, not messages.
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") depth += 1;
    else if (c === "}" || c === "]" || c === ")") depth -= 1;
    if (depth === 0 && atLineStart && /[A-Za-z_$]/.test(c)) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(body.slice(i, i + 80));
      if (m) {
        keys.push(m[1]);
        start = i;
      }
      atLineStart = false;
      continue;
    }
    if (c === "\n") atLineStart = true;
    else if (c !== " " && c !== "\t" && c !== "\r") atLineStart = false;
  }
  void start;
  return keys;
}

const textDecl = /const TEXT\s*=\s*\{/.exec(source);
if (!textDecl) {
  console.error("check-messages: no `const TEXT = {` found in dingtalk-bridge.mjs");
  process.exit(1);
}
const textOpen = textDecl.index + textDecl[0].length - 1;

const blocks = {};
for (const lang of ["zh", "en"]) {
  const re = new RegExp(`(?:^|[\\s{])${lang}\\s*:\\s*\\{`, "m");
  const m = re.exec(source.slice(textOpen));
  if (!m) continue;
  const open = textOpen + m.index + m[0].length - 1;
  blocks[lang] = keysOf(source, open);
}

const langs = Object.keys(blocks);
if (langs.length < 2) {
  console.error(`check-messages: found ${langs.length} language block(s), expected 2 (zh, en)`);
  process.exit(1);
}

const callSites = [...source.matchAll(/\bt\(\s*["']([\w$]+)["']/g)].map((m) => m[1]);
const used = [...new Set(callSites)].sort();

let bad = 0;
for (const lang of langs) {
  const have = new Set(blocks[lang]);
  const missing = used.filter((k) => !have.has(k));
  if (missing.length) {
    bad += missing.length;
    console.error(`  MISSING in ${lang}: ${missing.join(", ")}`);
  }
}

const [first, ...rest] = langs;
for (const other of rest) {
  const a = new Set(blocks[first]);
  const b = new Set(blocks[other]);
  const onlyFirst = [...a].filter((k) => !b.has(k));
  const onlyOther = [...b].filter((k) => !a.has(k));
  if (onlyFirst.length) {
    bad += onlyFirst.length;
    console.error(`  only in ${first}: ${onlyFirst.join(", ")}`);
  }
  if (onlyOther.length) {
    bad += onlyOther.length;
    console.error(`  only in ${other}: ${onlyOther.join(", ")}`);
  }
}

const rel = relative(root, file).split(sep).join("/");
for (const lang of langs) console.log(`  ${rel}  ${lang}: ${blocks[lang].length} messages`);
console.log(
  bad
    ? `FAIL — ${bad} message problem(s)`
    : `PASS — ${used.length} call sites, ${langs.length} languages, all present in both`,
);
process.exit(bad ? 1 : 0);
