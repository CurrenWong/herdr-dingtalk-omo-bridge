// Decide what to do with an inbound DingTalk message.
//
// Pulled out of the bridge's handle() so the rules can be tested without a
// Stream connection: dingtalk-bridge.mjs connects at module top level, so it
// cannot be imported by a test.
//
// The order matters and used to be wrong. The bridge checked for empty text
// before anything else, so a non-text message (an image, a file) got no tag,
// no reply and nothing but a log line — indistinguishable from the bot being
// dead. Unsupported *types* are now answered explicitly.

export const ACTIONS = {
  REJECT: "reject", // not allowed to talk to this bot
  UNSUPPORTED: "unsupported", // allowed, but this kind of message is not handled
  PROCESS: "process", // hand it to the agent
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

  if (allow.length && !allow.includes(staffId)) {
    return { action: ACTIONS.REJECT, msgtype, text, staffId };
  }

  // `text` messages that are empty (whitespace, or a payload we cannot read)
  // fall in here too: from the user's point of view it is still not something
  // we can act on, and silence is the worst answer.
  if (msgtype !== "text" || !text) {
    return { action: ACTIONS.UNSUPPORTED, msgtype, text, staffId };
  }

  return { action: ACTIONS.PROCESS, msgtype, text, staffId };
}
