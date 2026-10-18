// Reading OmO's session log by byte offset.
//
// Lives in its own module because getting this wrong is invisible: the bridge
// polls right after typing a prompt, so a reader that mistakes byte offsets for
// string indices returns the *previous* turn's answer, reports success, and
// looks fast while doing it. That happened once already.
import { readFileSync } from "node:fs";

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
  if (!file) return null;
  // existsSync is a point-in-time answer and this runs inside a poll loop: OmO
  // rotates its logs, and Windows can lock a file mid-write. A throw here used
  // to take down the whole answer wait instead of being retried on the next poll.
  let buf;
  try {
    buf = readFileSync(file.path);
  } catch {
    return null;
  }
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
 * Every assistant message appended since `fromByte`, in order.
 *
 * Each entry carries `offset` (a stable identity for dedup across polls) and
 * `final`, which is true only for a message made purely of text.
 *
 * `final === false` means the agent is narrating what it is about to do — those
 * messages arrive bundled with the toolCall they announce. They are useful as
 * progress reports and misleading as answers, so the caller can do both:
 * forward them while waiting, and never end the turn on one.
 */
export function assistantMessagesSince(file, fromByte) {
  const rows = rowsAppendedSince(file, fromByte);
  if (!rows?.length) return [];

  const out = [];
  let offset = fromByte;
  const buf = readFileSync(file.path);
  const tail = buf.subarray(fromByte).toString("utf8");

  for (const line of tail.split("\n")) {
    const start = offset;
    offset += Buffer.byteLength(line, "utf8") + 1;
    if (!line.trim()) continue;

    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type !== "message" || row.message?.role !== "assistant") continue;

    const content = row.message.content;
    if (typeof content === "string") {
      const text = content.trim();
      if (text) out.push({ offset: start, text, final: true });
      continue;
    }
    if (!Array.isArray(content)) continue;

    const stillActing = content.some((c) => typeof c !== "string" && (c?.type ?? "") !== "text");
    const text = content
      // A null element in the array survives the check above; dereferencing it
      // here threw and took the poll down with it.
      .map((c) => (typeof c === "string" ? c : c?.text))
      .filter((t) => typeof t === "string" && t.trim())
      .map((t) => t.trim())
      .join("\n\n");
    if (text) out.push({ offset: start, text, final: !stillActing });
  }
  return out;
}

/**
 * The assistant's answer among the rows appended since `fromByte`, or null if
 * the turn has not produced one yet.
 *
 * Two guards, each for a failure that actually happened:
 *
 *  * the user row must be present, or a poll that outraces the agent can match a
 *    leftover assistant row and call the turn finished;
 *  * an assistant row that carries anything other than text is *not* an answer.
 *    OmO narrates before it acts — "I need to extract text from the PDF, I'll
 *    use Python" arrives as an assistant message bundled with the toolCall that
 *    follows it. Accepting that reported the plan as the result, 70 seconds
 *    before the real answer existed.
 */
export function lastAssistantText(file, fromByte) {
  const rows = rowsAppendedSince(file, fromByte);
  if (!rows?.length) return null;

  const sawUser = rows.some((r) => r.type === "message" && r.message?.role === "user");
  if (!sawUser) return null;

  const candidates = assistantMessagesSince(file, fromByte).filter((m) => m.final);
  return candidates.length ? candidates[candidates.length - 1].text : null;
}
