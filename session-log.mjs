// Reading OmO's session log by byte offset.
//
// Lives in its own module because getting this wrong is invisible: the bridge
// polls right after typing a prompt, so a reader that mistakes byte offsets for
// string indices returns the *previous* turn's answer, reports success, and
// looks fast while doing it. That happened once already.
import { existsSync, readFileSync } from "node:fs";

/**
 * Rows appended after `fromByte`.
 *
 * `fromByte` is a byte count (statSync().size). The file is read as a Buffer and
 * sliced as bytes — reading it as a string and slicing by index compares bytes
 * against UTF-16 code units, which diverge as soon as the content is not ASCII.
 *
 * Returns null when nothing new has been written.
 */
export function rowsAppendedSince(file, fromByte) {
  if (!file || !existsSync(file.path)) return null;
  const buf = readFileSync(file.path);
  if (buf.length <= fromByte) return null;

  const rows = [];
  for (const line of buf.subarray(fromByte).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A partially written tail line; the next poll will see it whole.
    }
  }
  return rows;
}

/**
 * The assistant's answer among the rows appended since `fromByte`, or null if
 * the turn has not produced one yet.
 *
 * Requires the user row to be present first: without that guard, a poll that
 * runs before the agent has recorded the prompt can match a leftover assistant
 * row and declare the turn finished.
 */
export function lastAssistantText(file, fromByte) {
  const rows = rowsAppendedSince(file, fromByte);
  if (!rows?.length) return null;

  const sawUser = rows.some((r) => r.type === "message" && r.message?.role === "user");
  if (!sawUser) return null;

  let answer = null;
  for (const row of rows) {
    if (row.type !== "message" || row.message?.role !== "assistant") continue;
    const parts = (row.message.content ?? [])
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text.trim());
    if (parts.length) answer = parts.join("\n\n");
  }
  return answer;
}
