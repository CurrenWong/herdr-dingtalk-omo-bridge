// Decide what to do with an inbound DingTalk message.
//
// Pulled out of the bridge's handle() so the rules can be tested without a
// Stream connection: dingtalk-bridge.mjs connects at module level and cannot be
// imported by a test.
//
// Order matters and used to be wrong. The bridge checked for empty text before
// anything else, so a non-text message got no tag, no reply and nothing but a
// log line — indistinguishable from the bot being dead. Now:
//
//   REJECT       not allowed to talk to this bot
//   ATTACHMENT   allowed, and carries a downloadCode we can redeem
//   UNSUPPORTED  allowed, but there is nothing we can act on
//   PROCESS      hand the text to the agent

export const ACTIONS = {
  REJECT: "reject",
  ATTACHMENT: "attachment",
  UNSUPPORTED: "unsupported",
  PROCESS: "process",
};

/**
 * @param {object} msg   raw DingTalk callback payload
 * @param {object} opts
 * @param {string[]} opts.allow  permitted staff ids; empty means allow everyone
 */
export function classifyInbound(msg, { allow = [] } = {}) {
  const msgtype = msg?.msgtype ?? "text";
  const text = String(msg?.text?.content ?? "").trim();
  const staffId = msg?.senderStaffId;
  const content = msg?.content ?? {};
  const downloadCode = String(content.downloadCode ?? content.pictureDownloadCode ?? "").trim();

  if (allow.length && !allow.includes(staffId)) {
    return { action: ACTIONS.REJECT, msgtype, text, staffId };
  }

  // A non-text message with a downloadCode is something we can actually fetch:
  // images, files, voice notes. Text messages never carry one.
  if (msgtype !== "text" && downloadCode) {
    return { action: ACTIONS.ATTACHMENT, msgtype, text, staffId, downloadCode };
  }

  if (msgtype !== "text" || !text) {
    return { action: ACTIONS.UNSUPPORTED, msgtype, text, staffId };
  }

  return { action: ACTIONS.PROCESS, msgtype, text, staffId };
}
