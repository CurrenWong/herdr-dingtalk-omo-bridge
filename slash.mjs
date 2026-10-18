/**
 * Slash commands: which ones the bridge can carry over DingTalk, and which it
 * must not.
 *
 * These are TUI commands — they never reach the model, so OmO writes no session
 * row, and the bridge's answer reader (which watches the session log) would wait
 * out its full timeout and then report "no answer". So they cannot simply be
 * forwarded as prompts.
 *
 * What each one does is not something to infer from documentation. `/model <id>`
 * is documented as switching the model; measured against this build, it opens
 * the picker and types the argument into its filter. `/help` is documented as an
 * overlay and is one. So the lists below only contain what was actually run and
 * watched:
 *
 *   inline      ran, printed, returned to the editor.
 *   modal       left a full-screen overlay open.
 *   unattempted never tested, so treated as unsafe.
 *
 * An unknown command — `/skill:name`, a prompt template, an extension command —
 * is left alone and sent through as text, because those DO reach the model and
 * behave like any other prompt.
 */

export const SLASH = {
  NONE: "none",
  SUPPORTED: "supported",
  BRIDGE: "bridge",
  MODEL: "model",
  SESSIONS: "sessions",
  INTERACTIVE: "interactive",
  DANGEROUS: "dangerous",
};

/**
 * Commands the bridge answers itself instead of typing at the agent.
 *
 * Neither name appears in OmO's command table, so nothing is shadowed. They exist
 * because the two things a phone user most needs — stop what is running, and see
 * what the bridge is doing — have no TUI equivalent to forward to.
 */
const BRIDGE = new Set(["abort", "status"]);

// Commands that must not wait behind a running turn, or they would be exactly
// useless: `/abort` to stop that turn, `/status` to find out why it will not stop.
export const BRIDGE_URGENT = /^\/(abort|status)\b/i;

// Verified: prints inline and returns to the editor.
// `/new` measured: no confirmation and no overlay, it prints
// `✓ New session started` and resets the context counter to 0/1M immediately.
const SUPPORTED = new Set(["session", "hotkeys", "changelog", "reload", "new"]);

/**
 * Verified inline, but too slow for the bridge's short wait.
 *
 * `/compact` makes a model call to summarise the history, so on a real session it
 * runs for tens of seconds. The short poll used for the other inline commands
 * would return a spinner frame and report a truncated answer, so this one gets a
 * settle-based wait instead. Its optional argument is the summarisation
 * instruction and is passed through.
 */
const SLOW = new Set(["compact"]);

// Needs its picker driven rather than typed at; see parsePickerRows.
const MODEL = new Set(["model"]);

// `/sessions` is an alias of `/resume`; both open the same picker.
const SESSIONS = new Set(["sessions", "resume"]);

// Either verified as a modal, or never tested. Both are refused: an overlay left
// open swallows every following message into its filter, and the bot looks like
// it is working while receiving nothing.
const INTERACTIVE = new Set([
  "help", // measured: full-screen help overlay
  "settings",
  "tree",
  "fork",
  "clone",
  "scoped-models",
  "keybindings",
  "llama",
  "copy",
  "export",
  // never attempted — do not guess
  "thinking",
  "reasoning",
  "efforts",
  "fast",
  "new",
  "rename",
]);

// Refused outright. /quit and /exit end the agent the bridge talks to, and the
// pane closes with it; the rest touch credentials or the filesystem.
const DANGEROUS = new Set(["quit", "exit", "login", "logout", "import", "trust"]);

/**
 * @returns {{kind: string, command: string, arg: string, slow?: boolean}}
 */
export function classifySlash(text) {
  const raw = String(text ?? "").trim();
  if (!raw.startsWith("/")) return { kind: SLASH.NONE, command: "", arg: "" };

  const body = raw.slice(1);
  const space = body.search(/\s/);
  const command = (space === -1 ? body : body.slice(0, space)).toLowerCase();
  const arg = space === -1 ? "" : body.slice(space + 1).trim();

  // `/skill:name` and `/templatename` are prompts, not TUI commands. The colon
  // is the giveaway for skills; templates are simply unknown commands, which
  // also fall through.
  if (command.includes(":")) return { kind: SLASH.NONE, command, arg };

  if (DANGEROUS.has(command)) return { kind: SLASH.DANGEROUS, command, arg };
  if (BRIDGE.has(command)) return { kind: SLASH.BRIDGE, command, arg };
  if (MODEL.has(command)) return { kind: SLASH.MODEL, command, arg };
  if (SESSIONS.has(command)) return { kind: SLASH.SESSIONS, command, arg };
  if (SUPPORTED.has(command) || SLOW.has(command)) {
    return { kind: SLASH.SUPPORTED, command, arg, slow: SLOW.has(command) };
  }
  if (INTERACTIVE.has(command)) return { kind: SLASH.INTERACTIVE, command, arg };

  return { kind: SLASH.NONE, command, arg };
}

/**
 * The failure line `/compact` prints, measured:
 *
 *      Error: Compaction failed: Nothing to compact (session too small)
 *
 * Returns the reason, or null when the run did not fail this way — including the
 * case of a successful compaction, whose report shape is not verified here.
 */
export function parseCompactOutcome(out) {
  const m = String(out ?? "").match(/^[^\S\n]*Error:[^\S\n]*Compaction failed:[^\S\n]*(.+?)[^\S\n]*$/m);
  return m ? { ok: false, reason: m[1] } : null;
}

/**
 * Rows of the model picker, as drawn:
 *
 *     →   deepseek-flash [deepseek] ✓
 *         deepseek-v4-pro [deepseek]
 *
 * The arrow marks the highlighted row and the tick marks the model in use. The
 * filter matches model ids, not display names — `deepseek-v4-flash` finds
 * nothing because the id is `deepseek-flash`, which is worth knowing before
 * typing a term at it.
 */
export function parsePickerRows(screen) {
  const rows = [];
  for (const raw of String(screen ?? "").replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    const m = line.match(/^(→)?\s*([^\s[]+)\s+\[([^\]]+)\]\s*(✓)?$/);
    if (!m) continue;
    rows.push({
      id: m[2],
      provider: m[3].trim(),
      highlighted: Boolean(m[1]),
      active: Boolean(m[4]),
    });
  }
  return rows;
}

/**
 * The `/session` report, parsed into fields.
 *
 * Dumping the raw screen back is unreadable on a phone: the TUI prints a label
 * on one line and its value on the next, and a long path gets wrapped mid-name
 * by the terminal. Both are rendering artefacts of a 120-column screen, not
 * information, so they are undone here and the caller renders something a person
 * can scan.
 *
 * Returns null when the text does not look like the report, so a surprising
 * output falls back to raw rather than being mangled.
 */
export function parseSessionReport(text) {
  const rows = String(text ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!rows.length) return null;

  const report = {
    name: "",
    file: "",
    id: "",
    messages: { total: "", user: "", assistant: "", tools: "" },
    tokens: { input: "", cached: "", cachedPct: "", uncached: "", output: "", total: "" },
    cost: { total: "", rebilled: "" },
  };

  // "Messages" / "Tokens" / "Cost" start blocks, and `Total:` appears in two of
  // them, so the meaning of a bare number depends on where it sits.
  let section = "";
  let inFile = false;

  for (const row of rows) {
    if (/^(session info|session)$/i.test(row)) {
      section = "info";
      inFile = false;
      continue;
    }
    if (/^messages$/i.test(row)) {
      section = "messages";
      inFile = false;
      continue;
    }
    if (/^tokens$/i.test(row)) {
      section = "tokens";
      inFile = false;
      continue;
    }
    if (/^cost$/i.test(row)) {
      section = "cost";
      inFile = false;
      continue;
    }

    // The path is printed across as many lines as the terminal needs.
    if (inFile) {
      if (/^(id|messages|tokens|cost)\b/i.test(row)) inFile = false;
      else {
        report.file += row;
        continue;
      }
    }

    let m;
    if ((m = row.match(/^name:\s*(.+)$/i))) {
      report.name = m[1];
      continue;
    }
    if (/^file:\s*$/i.test(row)) {
      inFile = true;
      continue;
    }
    if ((m = row.match(/^file:\s*(.+)$/i))) {
      report.file = m[1];
      continue;
    }
    if ((m = row.match(/^id:\s*(\S+)/i))) {
      report.id = m[1];
      continue;
    }
    if ((m = row.match(/^total:\s*([\d,]+)\s*\(\s*([\d.]+)%\s*\)/i))) {
      // "Cache Re-billed: $0.000 (1,330 tokens, 1 miss)" — different shape.
      continue;
    }
    if ((m = row.match(/^user:\s*([\d,]+)/i))) {
      report.messages.user = m[1];
      continue;
    }
    if ((m = row.match(/^assistant:\s*([\d,]+)/i))) {
      report.messages.assistant = m[1];
      continue;
    }
    if ((m = row.match(/^tools:\s*([\d,]+)\s*calls?,\s*([\d,]+)\s*results?/i))) {
      report.messages.tools = m[1];
      continue;
    }
    if ((m = row.match(/^total:\s*([\d,]+)$/i))) {
      if (section === "messages") report.messages.total = m[1];
      else if (section === "tokens") report.tokens.total = m[1];
      continue;
    }
    if ((m = row.match(/^input:\s*([\d,]+)/i))) {
      report.tokens.input = m[1];
      continue;
    }
    if ((m = row.match(/^cached:\s*([\d,]+)\s*\(\s*([\d.]+)%\s*\)/i))) {
      report.tokens.cached = m[1];
      report.tokens.cachedPct = m[2];
      continue;
    }
    if ((m = row.match(/^uncached:\s*([\d,]+)/i))) {
      report.tokens.uncached = m[1];
      continue;
    }
    if ((m = row.match(/^output:\s*([\d,]+)/i))) {
      report.tokens.output = m[1];
      continue;
    }
    if ((m = row.match(/^total:\s*(\$[\d.]+)/i))) {
      if (section === "cost") report.cost.total = m[1];
      continue;
    }
    if ((m = row.match(/^cache re-billed:\s*(\$[\d.]+)/i))) {
      report.cost.rebilled = m[1];
      continue;
    }
  }

  // Without an id or any token figures this was not the report at all.
  if (!report.id && !report.tokens.input && !report.messages.total) return null;
  return report;
}


/**
 * A short excerpt of whatever the agent is blocked on.
 *
 * "Go and look in Herdr" is useless to someone holding a phone: it does not say
 * whether the pending question is worth interrupting anything for. When OmO stops
 * on an approval, what matters is the question itself — especially when the tool
 * behind it is destructive — so the visible frame is excerpted rather than
 * summarised.
 *
 * The status bar carries `•` separators and the footer is parenthesised; neither
 * is ever the question, and both would otherwise eat the excerpt.
 */
export function describeBlocked(screen, limit = 700) {
  const lines = String(screen ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.includes("•") && !/^[（(].*[)）]$/.test(l) && !l.startsWith("─"));

  const picked = lines.slice(-14);
  let out = picked.join("\n");
  if (out.length > limit) out = `${out.slice(0, limit)}…`;
  return out.trim();
}

/**
 * Rows of the `/resume` picker, as drawn:
 *
 *     › 模型列表交互功能咨询      12  20m
 *       models                    61   1h
 *
 * and, when the path column is on (Ctrl+P, or the All scope),
 *
 *     › 模型列表交互功能咨询   ~\...\herdr-bridge-lab   12  18m
 *
 * So the count and age are read from the right and a path column is optional.
 * Rows are validated by shape — numeric count, an age like `18m` — which is what
 * keeps header lines and the page indicator out.
 */
export function parseSessionRows(screen) {
  const rows = [];

  for (const raw of String(screen ?? "").replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\(\d+\/\d+\)$/.test(line)) continue; // page indicator
    if (!/^[›>]?\s*\S/.test(line)) continue;

    const highlighted = /^[›>]\s*/.test(line);
    const body = line.replace(/^[›>]\s*/, "");

    // Count and age sit at the right, separated from each other by a single
    // space and from the name by a run of spaces — so anchor on the end rather
    // than splitting, which would merge "12 21m" into one column.
    const tail = body.match(/^(.*?)\s{2,}(\d+)\s+(\d+\s*[a-z]+)$/i);
    if (!tail) continue;

    const count = tail[2];
    const age = tail[3];
    let left = tail[1].trim();
    let path = "";

    // The path column only appears with Ctrl+P (or in the All scope).
    const withPath = left.match(/^(.*?)\s{2,}(\S*[\\/~]\S*)$/);
    if (withPath) {
      left = withPath[1].trim();
      path = withPath[2].trim();
    }

    if (!left) continue;
    rows.push({ name: left, path, count, age, highlighted });
  }

  return rows;
}

const isRule = (line) => /^[─═━╌┄┈]{3,}$/.test(line);

const CHROME = [
  /^❯\s*$/,
  /^>\s*$/,
  /\bmem:\S+\s+\d+\s*[smhd]\s+ago\b/i,
  /\bshift\+tab\b/i,
  /•\s*CH\d/i,
];

function isChrome(line) {
  return CHROME.some((re) => re.test(line));
}

// Drop the chrome that sits at the bottom of every frame. Rules are dropped
// wherever they appear, not just at the end: one sits between the old output and
// the new block, so leaving it in makes the overlap test miss by a line.
function scrollback(lines) {
  const kept = lines.filter((l) => !isRule(l));
  let end = kept.length;
  while (end > 0 && isChrome(kept[end - 1])) end -= 1;
  return kept.slice(0, end);
}

/**
 * The lines a command actually drew, given the screen before and after.
 *
 * Content-based diffing does not work here, and the way it fails is instructive:
 * run `/session` twice without sending a message and both blocks are word for
 * word identical. Matching by text then finds nothing new and falls back to the
 * whole screen, which ships the previous output along with the current one.
 *
 * Position is the reliable signal: output is appended to a scrollback whose tail
 * the viewport shows, so the old screen is not a prefix of the new one — it is
 * shifted left as lines are pushed off the top. `after` begins at `before[d:]`,
 * and everything after the overlap is new.
 */
export function pickNewLines(beforeText, afterText, { keep = 30 } = {}) {
  const before = scrollback(splitLines(beforeText));
  const after = scrollback(splitLines(afterText));
  if (!after.length) return "";

  const dropped = scrollOffset(before, after);
  const fresh = dropped === -1 ? after : after.slice(Math.max(0, before.length - dropped));
  const chosen = fresh.length ? fresh : after.slice(-keep);
  return chosen.slice(-keep).join("\n").trim();
}

function splitLines(text) {
  return String(text ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

// Where the new screen picks up the old one. Returns -1 when the screens do not
// align at all (a modal replaced the view).
function scrollOffset(before, after) {
  for (let d = 0; d <= before.length; d += 1) {
    const rest = before.slice(d);
    if (rest.length === 0) return d;
    if (rest.length > after.length) continue;

    let same = true;
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] !== after[i]) {
        same = false;
        break;
      }
    }
    if (same) return d;
  }
  return -1;
}
