// Offline check of the reply channel: run the same session-log extraction the
// bridge uses, without touching DingTalk. `node check-reply.mjs <fromByte>`
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

const OMO_SESSIONS = join(homedir(), ".omo", "agent", "sessions");
// Default to wherever you run it from — usually the agent pane's cwd.
const CWD = process.argv[3] ?? process.cwd();
const fromByte = Number(process.argv[2] ?? 0);

function sessionFileForCwd(cwd) {
  // OmO may not be installed, or may never have run in this directory. Say so
  // plainly: this is the diagnostic a user reaches for precisely when things
  // are already confusing, and a raw ENOENT stack helps nobody.
  if (!existsSync(OMO_SESSIONS)) {
    console.log(`no OmO sessions directory at ${OMO_SESSIONS}`);
    console.log("  -> OmO (omo-ai) is probably not installed, or has not run yet.");
    console.log("  -> The bridge reads its answers from these files, so there is nothing to check.");
    process.exit(2);
  }

  const want = resolvePath(cwd).toLowerCase();
  let best = null;
  for (const dir of readdirSync(OMO_SESSIONS, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const name of readdirSync(join(OMO_SESSIONS, dir.name))) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(OMO_SESSIONS, dir.name, name);
      let first;
      try {
        first = JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]);
      } catch {
        continue;
      }
      if (!first?.cwd || resolvePath(first.cwd).toLowerCase() !== want) continue;
      const st = statSync(file);
      if (!best || st.mtimeMs > best.mtimeMs) best = { path: file, size: st.size, mtimeMs: st.mtimeMs };
    }
  }
  return best;
}

function lastAssistantText(file, from) {
  const fd = readFileSync(file.path, "utf8");
  const slice = from > 0 && from <= fd.length ? fd.slice(from) : fd;
  let answer = null;
  for (const line of slice.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type !== "message" || row.message?.role !== "assistant") continue;
    const parts = (row.message.content ?? []).filter((c) => c.type === "text" && c.text).map((c) => c.text.trim());
    if (parts.length) answer = parts.join("\n\n");
  }
  return answer;
}

const f = sessionFileForCwd(CWD);
if (!f) {
  console.log(`no OmO session found for cwd: ${CWD}`);
  console.log(`  searched: ${OMO_SESSIONS}`);
  console.log("  -> OmO keys its sessions by working directory. Either it has never");
  console.log("     run in this directory, or you are checking the wrong one.");
  console.log(`  -> pass a directory explicitly: node check-reply.mjs 0 "<cwd>"`);
  process.exit(2);
}

console.log("session:", f.path, "size", f.size);
const answer = lastAssistantText(f, fromByte);
console.log("--- answer ---");
console.log(answer ?? "(none)");
console.log("--- end ---", answer ? "OK" : "FAIL");
process.exit(answer ? 0 : 1);
