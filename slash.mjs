/**
 * Slash commands: which ones the bridge can carry over DingTalk, and which it
 * must not.
 *
 * These are TUI commands — they never reach the model, so OmO writes no session
 * row, and the bridge's answer reader (which watches the session log) would wait
 * out its full timeout and then report "no answer". So they cannot simply be
 * forwarded as prompts.
 *
 * They split three ways:
 *
 *   supported   runs, prints something, returns to the editor. Sent to the pane
 *               and the newly drawn lines are read back off the screen.
 *   interactive opens a picker that needs arrow keys. Unusable from a phone, and
 *               worse than useless: while it is open, the next DingTalk message
 *               is typed into the picker's filter instead of the agent.
 *   dangerous   kills the agent, touches credentials, or moves files. Refused.
 *
 * An unknown command — `/skill:name`, a prompt template, an extension command —
 * is left alone and sent through as text, because those DO reach the model and
 * behave like any other prompt.
 */

export const SLASH = {
  NONE: "none",
  SUPPORTED: "supported",
  NEEDS_ARG: "needs-arg",
  INTERACTIVE: "interactive",
  DANGEROUS: "dangerous",
};

// Run it and read the screen. None of these need a choice.
const SUPPORTED = new Set(["session", "help", "hotkeys", "changelog", "reload", "compact", "new", "rename"]);

// Useful only with an argument (`/model <id>`); bare, they open a picker.
const NEEDS_ARG = new Set(["model", "thinking", "reasoning", "efforts", "fast"]);

// Open a picker or a full-screen UI and wait for keys.
const INTERACTIVE = new Set([
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
]);

// Refused outright. /quit and /exit end the agent the bridge is talking to, and
// the pane closes with it; the rest touch credentials or the filesystem.
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
  if (NEEDS_ARG.has(command)) {
    return { kind: arg ? SLASH.SUPPORTED : SLASH.NEEDS_ARG, command, arg };
  }
  if (SUPPORTED.has(command)) return { kind: SLASH.SUPPORTED, command, arg };
  if (INTERACTIVE.has(command)) return { kind: SLASH.INTERACTIVE, command, arg };

  return { kind: SLASH.NONE, command, arg };
}

/**
 * The lines a command actually drew, given the screen before and after.
 *
 * Content-based diffing does not work here, and the way it fails is instructive:
 * run `/session` twice without sending a message and both blocks are word for
 * word identical. Matching by text then finds nothing new and falls back to the
 * whole screen, which ships the previous output along with the current one.
 *
 * Position is the reliable signal. The TUI keeps a fixed block of chrome at the
 * bottom (rule, editor, rule, status bar) and inserts output above it, scrolling
 * older lines off the top. So: strip the chrome from both screens, then find how
 * much of the old scrollback is still visible as the head of the new one. What
 * follows that overlap is what the command just printed.
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

// Drop the chrome that sits at the bottom of every frame. Rules are dropped
// wherever they appear, not just at the end: one sits between the old output and
// the new block, so leaving it in makes the overlap test miss by a line.
function scrollback(lines) {
  const kept = lines.filter((l) => !isRule(l));
  let end = kept.length;
  while (end > 0 && isChrome(kept[end - 1])) end -= 1;
  return kept.slice(0, end);
}

function isRule(line) {
  return /^[─═━╌┄┈]{3,}$/.test(line);
}

// Where the new screen picks up the old one.
//
// Output is appended to a scrollback that the viewport shows the tail of, so the
// old screen is not a prefix of the new one — it is shifted left as lines are
// pushed off the top: `after` begins at `before[d:]`. Find the smallest d that
// makes that true; everything after `before.length - d` lines is new.
//
// Returns -1 when the screens do not align at all (a modal replaced the view),
// in which case the caller shows what is there.
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

// Everything the TUI draws around the content: rules, the editor prompt, and the
// status line with its path/branch/model/memory segments.
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
