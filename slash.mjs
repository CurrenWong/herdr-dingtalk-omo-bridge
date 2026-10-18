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
  MODEL: "model",
  INTERACTIVE: "interactive",
  DANGEROUS: "dangerous",
};

// Verified: prints inline and returns to the editor.
const SUPPORTED = new Set(["session", "hotkeys", "changelog", "reload"]);

// Needs its picker driven rather than typed at; see parsePickerRows.
const MODEL = new Set(["model"]);

// Either verified as a modal, or never tested. Both are refused: an overlay left
// open swallows every following message into its filter, and the bot looks like
// it is working while receiving nothing.
const INTERACTIVE = new Set([
  "help", // measured: full-screen help overlay
  "sessions",
  "resume",
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
  "compact",
  "new",
  "rename",
]);

// Refused outright. /quit and /exit end the agent the bridge talks to, and the
// pane closes with it; the rest touch credentials or the filesystem.
const DANGEROUS = new Set(["quit", "exit", "login", "logout", "import", "trust"]);

/**
 * @returns {{kind: string, command: string, arg: string}}
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
  if (MODEL.has(command)) return { kind: SLASH.MODEL, command, arg };
  if (SUPPORTED.has(command)) return { kind: SLASH.SUPPORTED, command, arg };
  if (INTERACTIVE.has(command)) return { kind: SLASH.INTERACTIVE, command, arg };

  return { kind: SLASH.NONE, command, arg };
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
