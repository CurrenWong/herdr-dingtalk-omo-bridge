/**
 * Which Herdr agent should receive a message.
 *
 * Herdr names are per-agent-instance and are not remembered across restarts: a
 * fresh OmO pane comes up as `pi` again, so a bridge configured for `dingtalk`
 * suddenly has nowhere to send. That is not an error worth failing on — but it
 * is worth being careful about, because the failure mode of guessing wrong is
 * typing a stranger's prompt into someone else's session.
 *
 * So: use the named agent when it exists; otherwise adopt the only agent, and
 * only when there is exactly one. With two or more there is no safe guess.
 */

export function selectAgent(agents, wanted) {
  const list = Array.isArray(agents) ? agents.filter((a) => a?.pane_id) : [];

  const named = list.find((a) => a.agent === wanted || a.name === wanted);
  if (named) return { agent: named, reason: "named" };

  if (list.length === 1) return { agent: list[0], reason: "single" };
  if (list.length === 0) return { agent: null, reason: "none" };
  return { agent: null, reason: "ambiguous" };
}

/**
 * A line for the log or the chat, explaining what happened and what to do.
 * Deliberately names the fix: the rename is not something a user discovers by
 * staring at "agent not found".
 */
export function describeMiss(reason, wanted, agents) {
  const names = (Array.isArray(agents) ? agents : [])
    .map((a) => `${a.agent}${a.name ? `/${a.name}` : ""}`)
    .filter(Boolean);

  if (reason === "ambiguous") {
    return `找到 ${names.length} 个 agent（${names.join(", ")}），没有叫「${wanted}」的，无法确定投给谁。` +
      `请运行 herdr agent rename <pane_id> ${wanted}，或把 LAB_TARGET_AGENT 设成其中一个名字。`;
  }
  if (reason === "none") {
    return "Herdr 里没有任何 agent。先在一个 pane 里启动 omo，再发消息。";
  }
  return `找不到 Herdr agent「${wanted}」。`;
}
