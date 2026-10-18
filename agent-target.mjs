/**
 * Which Herdr agent should receive a message, and how to ask the user when the
 * answer is not obvious.
 *
 * Herdr names are per-agent-instance and are not remembered across restarts: a
 * fresh OmO pane comes up as `pi` again, so a bridge configured for `dingtalk`
 * suddenly has nowhere to send. That is not worth failing on — but it is worth
 * being careful about, because the failure mode of guessing wrong is typing a
 * stranger's prompt into someone else's session.
 *
 * So: use the named agent when it exists; otherwise adopt the only agent, and
 * only when there is exactly one. With several, ask.
 *
 * Everything here is data in, data out — no user-facing strings. The bridge
 * owns those so it can speak either language.
 */

export function selectAgent(agents, wanted) {
  const list = Array.isArray(agents) ? agents.filter((a) => a?.pane_id) : [];

  // An empty or missing name would match every pane whose `agent` field is
  // absent (`a.agent === undefined`), and the bridge would type the prompt into
  // an unrelated pane while reporting reason "named".
  const want = typeof wanted === "string" ? wanted.trim() : "";
  const named = want ? list.find((a) => a.agent === want || a.name === want) : null;
  if (named) return { agent: named, reason: "named" };

  if (list.length === 1) return { agent: list[0], reason: "single" };
  if (list.length === 0) return { agent: null, reason: "none" };
  return { agent: null, reason: "ambiguous" };
}

/**
 * The candidates, numbered from 1, with enough detail to tell two OmO windows
 * apart. Two panes can share a title and a working directory — the only thing
 * that reliably differs is the pane id, and the only thing the user can see from
 * outside is which one has focus. Offer both.
 */
export function agentChoices(agents) {
  return (Array.isArray(agents) ? agents : [])
    .filter((a) => a?.pane_id)
    .map((a, i) => ({
      n: i + 1,
      pane: a.pane_id,
      label: a.terminal_title_stripped || a.terminal_title || a.name || a.agent || "",
      cwd: a.cwd ?? "",
      status: a.agent_status ?? "",
      focused: a.focused === true,
    }));
}

/**
 * How long a numbered list stays answerable. Long enough to read it and reply,
 * short enough that a stray "1" days later cannot silently rename a pane.
 */
export const CHOICE_TTL_MS = 5 * 60 * 1000;

/**
 * Read a reply to the numbered list.
 *
 * Only a bare number counts — anything else is ordinary chat and must be left
 * alone, because "2026" or "1 号文件" as a prompt is entirely plausible.
 */
export function parseChoice(raw, count) {
  const s = String(raw ?? "").trim();
  if (!/^\d{1,2}$/.test(s)) return { kind: "none" };

  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > count) return { kind: "out-of-range", value: n };
  return { kind: "pick", index: n - 1, value: n };
}
