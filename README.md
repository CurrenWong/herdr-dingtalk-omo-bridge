# herdr-dingtalk-omo-bridge

[![npm version](https://img.shields.io/npm/v/herdr-dingtalk-omo-bridge)](https://www.npmjs.com/package/herdr-dingtalk-omo-bridge)
[![npm downloads](https://img.shields.io/npm/dw/herdr-dingtalk-omo-bridge)](https://www.npmjs.com/package/herdr-dingtalk-omo-bridge)
[![CI](https://github.com/CurrenWong/herdr-dingtalk-omo-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/CurrenWong/herdr-dingtalk-omo-bridge/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/CurrenWong/herdr-dingtalk-omo-bridge)](LICENSE)

A [Herdr](https://herdr.dev) plugin that makes an **OmO** coding agent reachable
from DingTalk — and tells you, on the message itself, what state it is in.

```bash
npx herdr-dingtalk-omo-bridge@latest install
# or
herdr plugin install CurrenWong/herdr-dingtalk-omo-bridge
```

Send a message in DingTalk:

1. the message gets tagged 👌**Received** within a few hundred milliseconds;
2. the text is typed into an OmO session running in a Herdr pane;
3. the answer comes back to the same DingTalk conversation;
4. the tag is swapped to 🥳**Done** (or ☹️**Error** if it failed).

Because the whole thing lives in Herdr panes, it survives a crash, comes back
when Herdr restarts, and leaves you a TUI you can watch while it works.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Install](#install)
- [Configuration](#configuration)
- [Platform support](#platform-support)
- [How it works](#how-it-works)
- [Operations](#operations)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)
- [Known limitations](#known-limitations)
- [Publishing](#publishing)
- [中文说明](#中文说明)

---

## Publishing

Two channels, both driven by manual GitHub Actions workflows:

| Workflow | Registry | Package name |
|---|---|---|
| `publish.yml` | npmjs.org | `herdr-dingtalk-omo-bridge` |
| `publish-github-packages.yml` | npm.pkg.github.com | `@currenwong/herdr-dingtalk-omo-bridge` |

The npmjs one stages the tarball and then waits for a 2FA approval, because this
account has 2FA and npm no longer accepts tokens that bypass it. The GitHub
Packages one authenticates with the job's own `GITHUB_TOKEN`, so it needs no
secret — the workflow rewrites the package name in the runner, since GitHub
namespaces everything under the account and the npmjs package is unscoped.

Bump `version` in `package.json` and tag the commit before releasing. A release,
an npm version and a git tag that disagree about what `vX.Y.Z` means is the
kind of thing that is only noticed months later.

## Contributing

```bash
npm ci
npm run check            # syntax-check every shipped script
npm run check-paths      # platform-correct config/state resolution
npm run check-manifest   # manifest agrees with the code defaults
npm run scan-secrets     # pattern-based leak scan (runs in CI too)
```

CI runs on Linux, macOS and Windows. Keep it green on all three — that is what
stops a Windows-shaped assumption from creeping back in.

The secret scanner is deliberately **pattern-based**. Pinning known credential
values into it would leak them into the public repository the moment it ran.

---

## Why this exists

Herdr is a terminal host: it keeps panes alive, restarts the session, and
already knows how to detect and drive terminal agents. What it does not have is
a chat front-end. This plugin is the missing half — it lets you talk to a coding
agent from your phone, on the same machine that runs the code.

Two design constraints shaped most of the code, and both are documented in
[`docs/herdr-notes.md`](docs/herdr-notes.md):

- **A plugin pane dies with its command.** Herdr has no restart policy, so the
  bridge runs under `supervise.mjs` and gets relaunched with backoff. The OmO
  pane deliberately does *not* — see below.
- **A full-screen TUI must stay a pane's direct child.** Herdr's
  `pane send-text` addresses that child. Wrapping `omo` in a supervisor demoted
  it to a grandchild and every message was silently dropped. This one cost a
  real debugging session; the symptom is a bridge that receives, logs, and then
  waits forever with no error anywhere.

## Architecture

```
 DingTalk                    Herdr
 ────────                    ─────
    │                          │
    │  Stream WebSocket        │   ┌──────────────────────────────┐
    │◄────────────────────────►│   │ pane: OmO (DingTalk)         │
    │                          │   │   command: omo               │  ← direct child
    │                          │   │   named agent "dingtalk"     │    (never
    │                          │   └──────────────┬───────────────┘     supervised)
    │                          │                  │ pane send-text
    │                          │   ┌──────────────▼───────────────┐
    │                          │   │ pane: DingTalk ↔ OmO bridge │
    │                          │   │   supervise.mjs              │
    │                          │   │     └─ dingtalk-bridge.mjs   │
    │                          │   └──────────────┬───────────────┘
    │                          │                  │ reads
    │                          │      ~/.omo/agent/sessions/<cwd>/*.jsonl
    │                          │                  │
    │   👌Received             │◄─────────────────┘
    │  ...answer...            │  sessionWebhook POST
    │   🥳Done                 │
```

`startup.mjs` runs once per Herdr server start and is responsible for making
both panes exist, naming the OmO agent, and — critically — **not** opening a
second Stream connection when one is already live.

## Requirements

| | |
|---|---|
| Herdr | ≥ 0.9.3 (the version this was built and verified against) |
| OS | **Verified on Windows 11.** See [Platform support](#platform-support). |
| Node | ≥ 20 (developed against 24) |
| OmO | the `omo` CLI on `PATH` |
| DingTalk | a robot app with **Stream mode** enabled |
| build | `npm` on `PATH` — the manifest runs `npm ci --omit=dev`, and a failed build **aborts the install** |

See [Prerequisites](#prerequisites) for how to check each one.

## Install

### Prerequisites

Check these first — every one of them fails in a confusing way if missing.

```bash
node --version   # >= 20
npm --version    # the install runs `npm ci`; without it the install ABORTS
omo --version    # the agent pane's command is literally `omo`
herdr --version  # >= 0.9.0
```

`omo` matters more than it looks: Herdr runs pane commands without a shell, so
the binary has to be on `PATH` or the pane exits instantly and gets reclaimed.
The startup hook will report `no new pane appeared for the OmO entrypoint`.

### 1. Create the DingTalk app

In the [DingTalk developer console](https://open-dev.dingtalk.com/):

- create an app and add a **robot** capability;
- enable **Stream mode** (there is no callback URL to configure — the bridge
  holds an outbound WebSocket).

That is all. **Do not copy the AppKey/AppSecret anywhere** — the next step
obtains them for you.

### 2. Install the plugin

Two channels, same result. Pick whichever fits your toolchain.

**A — from GitHub** (needs `git`):

```bash
herdr plugin install CurrenWong/herdr-dingtalk-omo-bridge
```

Herdr shows a preview of the source and the commands it will run. Confirm, and
it clones, runs `npm ci --omit=dev`, and registers the plugin. Use `--yes` to
skip the preview, `--ref <ref>` to pin a revision.

**B — from npm** (needs `npx`, no `git`):

```bash
npx herdr-dingtalk-omo-bridge@latest install --dry-run   # see the plan first
npx herdr-dingtalk-omo-bridge@latest install
```

or with bun:

```bash
bunx herdr-dingtalk-omo-bridge@latest install
```

This unpacks the package into a versioned directory under your user data area
(`%LOCALAPPDATA%\herdr\plugin-packages\dingtalk-omo-bridge\<version>` on
Windows, `~/.local/share/...` on Linux, `~/Library/Application Support/...` on
macOS), installs its dependencies, and calls `herdr plugin link` on the result.

Useful flags and commands:

| | |
|---|---|
| `--dry-run` | Print the plan as JSON, change nothing |
| `--no-link` | Stop after the files are in place, so you can inspect before registering |
| `--dir PATH` | Install somewhere other than the default |
| `status` | What is installed, and where Herdr thinks it is linked |
| `uninstall` | Unregister and delete the installed files |

It refuses to write into a directory it did not create, so pointing it at an
existing git checkout will error instead of overwriting your work.

Either way, confirm it landed:

```bash
herdr plugin list        # expect: dingtalk-omo-bridge (DingTalk ↔ OmO Bridge) enabled
```

> **Which registry?** Install from npmjs (`npx herdr-dingtalk-omo-bridge@latest`)
> or straight from this repo. A copy is also mirrored to GitHub Packages as
> `@currenwong/herdr-dingtalk-omo-bridge` so it shows under the repository's
> Packages panel, but that one needs a GitHub token to install, so it is not the
> recommended path. See [Publishing](#publishing) if you fork this.

### 3. Register the bot

```bash
herdr plugin action invoke dingtalk-omo-bridge.auth
```

This runs DingTalk's device flow: it prints a scan URL and user code, writes a
QR code to `state/auth/qrcode.png` (needs Python with `segno`; without it you
get the URL instead), and then **blocks while you scan**. Scanning it in the
DingTalk app is what yields the AppKey and AppSecret — they are written to the
plugin's config directory as `.env` and never need to be handled by hand.

The code is good for a couple of hours; re-run the action if it expires.

### 4. Start it

Restart Herdr, or:

```bash
herdr server reload-config
```

The startup hook opens both panes and the bot goes live. Verify:

```bash
herdr pane list    # expect an "OmO (DingTalk)" tab and a "DingTalk ↔ OmO bridge" tab
herdr agent list   # expect an agent named "dingtalk"
```

Then send the bot a message in DingTalk. It should be tagged 👌**Received**
almost immediately, and 🥳**Done** a few seconds later.

### Upgrading

```bash
herdr plugin update CurrenWong/herdr-dingtalk-omo-bridge
```

Existing processes are not restarted, so run `herdr server reload-config`
afterwards (or restart Herdr) to pick up new code.

### Uninstalling

```bash
herdr plugin uninstall dingtalk-omo-bridge
```

Your credentials and logs in the Herdr config/state directories are left alone;
delete them by hand if you want a clean slate.

### Developing locally

```bash
herdr plugin link /path/to/herdr-dingtalk-omo-bridge
npm install        # `plugin link` does NOT run build commands
```

`plugin link` registers a working directory instead of a clone, so edits take
effect on the next pane start. Note that installing over a linked plugin is
refused — `herdr plugin unlink` first.

---

*Publishing note: this repository carries the GitHub topic `herdr-plugin`, which
is what makes Herdr's plugin marketplace index it.*

## Configuration

Everything is environment-driven. Herdr injects the plugin env vars; you
normally only touch the `DINGTALK_*` and `LAB_*` ones, which can live in the
`.env` that `auth` writes, or be passed to a pane with
`herdr plugin pane open --env KEY=VALUE`.

| Variable | Default | Meaning |
|---|---|---|
| `DINGTALK_CLIENT_ID` | — | AppKey. Written by the `auth` action. |
| `DINGTALK_CLIENT_SECRET` | — | AppSecret. Written by the `auth` action. |
| `DINGTALK_ROBOT_CODE` | = `DINGTALK_CLIENT_ID` | Sent as `robotCode` by the emotion API. |
| `DINGTALK_ALLOW_STAFF` | *(empty)* | Comma-separated staff IDs. **Empty means no allowlist** — see [Security notes](#security-notes). |
| `LAB_TARGET_AGENT` | `dingtalk` | Name of the Herdr agent the bridge types into. Herdr forgets names across restarts, so if no agent carries this name the bridge falls back to the only agent and logs `!! agent not named …`. |
| `LAB_TARGET_PANE` | *(empty)* | Legacy: a bare pane id, used only if the agent cannot be resolved. |
| `LAB_AGENT_TIMEOUT_MS` | `300000` | How long to wait for an answer before giving up. |
| `LAB_EMOTIONS` | `1` | Set to `0` to disable the 👌/🥳/☹️ message tags. |
| `LAB_LANG` | `zh` | `en` or anything else for Chinese. Controls the bot's own messages. |
| `PYTHON_PATH` | auto | Interpreter used only to render the login QR code as PNG. |

## How it works

### Getting the answer out of the agent

A full-screen TUI repaints over its own output, so scraping the pane for the
answer is unreliable. OmO persists every session to disk instead:

```
%USERPROFILE%\.omo\agent\sessions\<cwd-slug>\<timestamp>_<uuid>.jsonl
```

Each turn appends a row shaped like:

```json
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"…"}]}}
```

The bridge snapshots `(file, byte length)` before submitting a prompt and then
reads only what was appended. Because the session file is keyed by working
directory, a conversation also survives an OmO restart.

You can test that channel without touching DingTalk at all:

```bash
node check-reply.mjs 0
```

### Getting the text in

`herdr agent prompt` does not work against OmO — its launcher spawns
node/bun children, so Herdr reports *agent is no longer the pane foreground
process*. The bridge types instead:

```
herdr pane send-text <pane> <text>
herdr pane send-keys <pane> enter
```

### Attachments

A picture message never carries the image. DingTalk sends a `downloadCode`, and
the file has to be redeemed in two steps:

```
POST https://api.dingtalk.com/v1.0/robot/messageFiles/download   { downloadCode, robotCode }
  -> { downloadUrl }            (short-lived)
GET  <downloadUrl>              -> bytes
```

The bridge saves the result into `<agent cwd>/.dingtalk-inbox/` (override with
`LAB_ATTACHMENT_DIR`) and sends the agent a prompt naming that path, so it can
open the file with its usual tools. Names are sanitised but keep their script:
`账单 2026.pdf` survives as `账单_2026.pdf` rather than being reduced to
`_2026.pdf`. A name that already exists gets `-2`, `-3`: the name is derived from
the sender's filename or the message id, so a second `IMG_0001.jpg` used to
overwrite the first while the agent was handed the same path.

Files over 20 MB are refused — while downloading, not afterwards. The body is
read in chunks and abandoned the moment the running total passes the limit,
because a `content-length` check only protects against a response that tells the
truth about its size. Bytes go to a temp name and are renamed into place, so an
interrupted write cannot leave a truncated file under the real name.

### Pictures the agent produces

The other direction. OmO never emits an image block — measured across 20 real
sessions, every `image` block belongs to a `toolResult` row (the agent echoing
a picture it read), never to an assistant conclusion. What the model produces
is a **path inside its answer text**:

```
C:\...\figs\outputs\figure_a_dose_response.png 118056 bytes
```

DingTalk will not render an image from a session webhook at all (its own
message-type table marks `Image` as API-only), and `sampleImageMsg` wants a
`photoURL` — a URL anyone can fetch. The bridge runs on the machine where those
bytes live, so the only route is to upload them and send the result as a file,
which is what QwenPaw does:

```
POST https://oapi.dingtalk.com/media/upload?type=image        -> media_id
POST https://api.dingtalk.com/v1.0/robot/groupMessages/send  msgKey: sampleFile
```

`fileType: "png"` is not in DingTalk's documented list (xlsx/pdf/zip/rar/doc/docx),
but `probe-image.mjs` verified the API accepts it: against a dummy conversation
the only complaint that comes back is about the conversation id, never about the
msgKey or the msgParam.

**The two send routes are the trap in that call.** DingTalk addresses a group by
conversation id (`groupMessages/send`) and a one-to-one by the recipient's staff
id (`oToMessages/batchSend`). They are not interchangeable: posting a one-to-one
conversation to the group endpoint fails with
`{"code":"resource.not.found","message":"robot 不存在"}`, for every `msgKey`
including a plain `sampleText`. That message names the robot rather than the
mistake, so it reads exactly like a credential problem — and it cost a whole
debugging round chasing `robotCode`, which turned out to be correct throughout
(the payload's `robotCode` is the appKey for this bot, and
`/v1.0/robot/emotion/reply` accepts the appKey without complaint, which is why
the 👌/🥳 tags kept working while no file was ever sent). The bridge logs both
values on every inbound (`inbound route`) so the next person does not have to
rediscover them.

`batchSend` can also answer `200` and quietly drop the message for a recipient it
could not reach, so an empty `invalidStaffIdList` / `filteredStaffIdList` is
treated as a failure rather than a success.

**The agent has to name the file.** A path in the answer is the only channel —
there is nothing else for the bridge to read, and "the figures are in
`figs/outputs/`" is a directory, not a picture. The agent also has no idea it
failed: a real answer said "两张图已发送" while naming only the directory, and
the user reasonably concluded the bridge was broken. `AGENTS.md` in this
repository tells the agent to list full relative paths and never to claim it has
sent anything, because it cannot.

Which pictures to send is the real question, because an answer mentions *every*
path it touched — the ones the user pasted, paths quoted out of a log, and WSL
paths that do not exist on this host at all. Three gates, in order: the path must
exist here and end in an image extension, it must have been **written during this
turn** (mtime >= the moment the prompt went in), and it must not live under
`state/auth/`, `.git/` or `node_modules/`. At most 3 per turn; everything refused
is logged with its reason, because silence there is indistinguishable from a bug.

Group chats and one-to-one alike: a group is addressed by its conversation id,
a one-to-one by `senderStaffId`. Both come out of the same inbound payload, so
neither address is guessed.

**Asking for a picture is the one exception to the mtime gate**, and it has to
be: such a turn names pictures that already exist and writes nothing new, so a
strict gate refuses precisely the files the user just asked for. Measured the
hard way — a real turn answering "再发一次两张图" named both figures and sent
neither.

Two separate tests, because they carry different risk:

| | When | What it does |
|---|---|---|
| `wantsPictures` | a picture word **and** a delivery verb — 「把图片发给我」「发送图片」「send me the chart」 | opens the window to 24h **and** appends the generic hint to the prompt |
| `wantsResend` | repeat wording only — 再发 / 重发 / 重新发 / 再传 / 再给我 / 再来一次 / again / resend | same, plus a hint that says *do not redraw* |

Nothing else moves the boundary, and every other gate still applies: the file
must exist, be an image, sit outside the secrets paths, and fit the per-turn cap.

### Slash commands

OmO's slash commands are handled by the TUI, not the model, so **nothing is
written to the session log** — the bridge would otherwise wait out its full
timeout for an answer that cannot arrive. They are decided before anything is
typed, and the lists below contain only what was actually run and watched, not
what the docs claim:

| | Commands | What the bridge does |
|---|---|---|
| Verified inline | `/session` `/hotkeys` `/changelog` `/reload` `/compact [instructions]` `/new` | Runs it, reads the new lines off the screen, replies with them. `/compact` gets a settle-based wait instead of the short poll, since it makes a model call |
| Answered by the bridge | `/abort`, `/status` | Neither exists in OmO's command table, so nothing is shadowed. See below |
| Driven picker | `/model`, `/model <term>`, `/sessions`, `/sessions <term>` | See below |
| Refused — overlay | `/help` (measured: full-screen help), plus `/settings` `/tree` `/fork` `/clone` `/scoped-models` `/keybindings` `/llama` `/copy` `/export` | Refused. A picker left open swallows every following message into its filter |
| Refused — untested | `/thinking` `/reasoning` `/efforts` `/fast` `/rename` | Refused until someone watches what they actually do |
| Refused — destructive | `/quit` `/exit` `/login` `/logout` `/import` `/trust` | Refused. These close the agent or touch credentials and files |
| Passed through | `/skill:name`, prompt templates, extension commands | Sent as an ordinary prompt — those *do* reach the model |

**`/abort` and `/status` are the bridge's own commands.** Neither name appears in
OmO's command table, so nothing is shadowed, and neither has a TUI equivalent to
forward to. `/abort` sends Esc — what the TUI itself uses to interrupt a turn —
drops that conversation's queued messages, and bumps its abort epoch. The epoch
is not bookkeeping: an interrupted turn never produces a final assistant message,
so without it the answer loop would sit there until the five-minute timeout and
every message behind it would wait too. All three are scoped to the conversation
that owns the running turn: with more than one allowed sender, an `/abort` from
one chat used to stop another chat's turn and throw away its queue. `/status` answers from what the bridge already knows:
uptime, which pane the agent resolved to, its `agent_status`, the working
directory, the session file being read, queue depth, and when the last message
arrived.

**Messages that arrive mid-turn queue instead of vanishing.** The old answer was
`稍等` and the text was dropped, which is the wrong trade on a phone — a follow-up
thought is exactly what gets lost. Up to `LAB_QUEUE_LIMIT` (default 3) are kept
and run in order; a full queue says so rather than silently discarding. A message
that is merely next in line gets no reply at all — the 👌 tag already says it
arrived, and a headcount of zero is noise; the queue depth is announced only when
something is ahead of it. The two urgent commands jump the queue, since waiting
behind a turn to stop that turn is useless.

**While busy, the two commands that must not wait are recognised before queuing**,
which is also why they are matched against the trimmed text at the call site: in
the TUI `" /foo"` is a prompt, not a command.

**When the agent is blocked, the question is sent along with the notice.** "Go and
look in Herdr" does not tell someone holding a phone whether the pending question
is worth interrupting anything for — and when the tool behind it is destructive,
that difference is a safety problem. The visible frame is excerpted instead
(status bar and footer stripped, capped at 700 characters), so an approval request
arrives as the question, the command, and the options.

**A dead agent pane is started again.** If no agent resolves, the bridge runs
`pane run <pane> omo` and waits for the editor prompt, with a cooldown so a pane
that keeps dying does not become a restart loop. `herdr agent start --kind pi`
cannot be used: this machine has `omo` and no `pi`.

**`/new` was measured before it was allowed.** It prints `✓ New session started`
inline, asks for no confirmation, opens no overlay, and resets the context
counter to `0/1M` immediately.

**`/model` is not a switch command.** Documented as one; measured otherwise:
`/model anything` opens the picker and types the argument into its filter. So the
bridge drives the picker explicitly — open it, narrow with the term, and press
Enter only when the filter has left exactly one row, then confirm the picker
closed. Any other outcome escapes out and says so, because guessing which model
someone meant is not something to do to their session.

Two things worth knowing before using it:

- The filter matches **model ids**, not display names. `deepseek-v4-flash` finds
  nothing because the id is `deepseek-flash`.
- The picker is scoped to the **current provider**, so `/model` alone lists that
  provider's models rather than all 43 in the catalog. Switching provider is not
  something the bridge does.

**`/compact`** is inline, with no picker and no confirmation — but expect it to
refuse most of the time here. Compaction triggers on context size near the
model's ceiling, not on message count, so it answered `Nothing to compact
(session too small)` on both a 2-message and a 12-message / 30K-token session in
a 1M-token window. It fails instantly without a model call. The success report
has not been observed, so anything that is not the failure line is passed
through as raw screen text.

**Why not `herdr agent prompt`.** Herdr has exactly the right command for this and
the bridge does not use it. `herdr agent prompt` submits text and Enter as one
bracketed-paste unit and refuses outright with `agent_blocked` when the agent is
sitting on a dialog — but it answers `agent_not_ready` ("no longer the pane
foreground process") for every OmO pane, because these were started by a human at
a shell prompt rather than by `herdr agent start`, and Herdr's `pi.toml` has no
readiness rule at all: both of its rules only match the working spinner, so an
idle OmO reports `rule: none` under `herdr agent explain`. `agent attach
--takeover` is likewise unavailable — "direct terminal attach is not supported on
Windows yet".

So the bridge keeps typing at the pane and reimplements the two guarantees it
would have bought, against `herdr agent get`:

- **Never type into a blocked pane.** If `agent_status` is `blocked` before the
  send, the text would land in whichever field the dialog has focused and be lost,
  so the message is answered instead.
- **Confirm the turn actually started.** `agent prompt --wait` watches for activity
  within five seconds and reports `agent_prompt_stalled`; a submission that never
  took is otherwise indistinguishable from a slow turn and burns the whole answer
  timeout. Measured against a throwaway agent: `idle → working` at 1.6s and
  `done → working` at 1.1s, so the 8s gate (`LAB_SUBMIT_STALL_MS`) has headroom.
  It is skipped when no agent resolves, since there is then no signal to wait on.

Reading the screen back needs care, because a TUI repaints rather than appends
and the same command run twice produces identical output. The bridge reads the
scrollback buffer (`--source recent`) rather than the viewport, so the old screen
stays a genuine prefix of the new one and the split is exact.

**`/sessions`** opens the `/resume` picker. Bare, it lists what is on screen with
numbers; with a term it filters and presses Enter only when one session is left.
It is deliberately confined to the picker's default **Current Folder** scope: a
session from another directory starts its own session file, and the bridge reads
answers from the file belonging to the agent's working directory, so resuming a
foreign session would leave every later reply unreadable. Pressing Tab there
switches the picker to All — left to a human in Herdr.

### The message tags

These are plain REST calls against the DingTalk emotion API, which needs an app
access token — the long-lived Stream connection cannot make them:

```
POST https://api.dingtalk.com/v1.0/robot/emotion/reply     # add a tag
POST https://api.dingtalk.com/v1.0/robot/emotion/recall    # remove a tag
Header: x-acs-dingtalk-access-token: <token>

{ "robotCode": …, "openMsgId": …, "openConversationId": …,
  "emotionType": 2, "emotionName": "🥳Done",
  "textEmotion": { "emotionId": "2659900", "emotionName": …,
                   "text": …, "backgroundId": "im_bg_1" } }
```

Tokens come from `POST /v1.0/oauth2/accessToken` and are cached for their
7200 s lifetime. Tagging is strictly best-effort: every failure is logged and
swallowed so a cosmetic tag can never cost you the actual reply.

Probe the API without waiting for a real message:

```bash
node probe-emotion.mjs <openConversationId>
```

A `500 msg.dec.err` response there is the *expected* result — it means auth,
`robotCode` and the body shape are all correct and only the dummy message id
was rejected.

## Operations

### Plugin actions

Two one-shot actions ship with the plugin. List them with
`herdr plugin action list --plugin dingtalk-omo-bridge`.

| Action | What it does |
|---|---|
| `dingtalk-omo-bridge.auth` | DingTalk device-flow registration. Prints a scan URL and blocks until you scan it, then writes the credentials to the plugin config dir. Walked through in [Install](#install). |
| `dingtalk-omo-bridge.probe` | Prints the environment Herdr injects into the plugin (paths, ids, socket) and the result of a few CLI calls. Use it when something is behaving as if an env var were missing. |

```bash
herdr plugin action invoke dingtalk-omo-bridge.probe
```

### Logs

Logs live in the plugin state directory
(`%LOCALAPPDATA%\herdr\plugins\<id>\` on Windows):

| File | Contents |
|---|---|
| `dingtalk-bridge.log` | every inbound (with its classified verdict), every tag call, every webhook push |
| `supervise.log` | bridge restarts and their backoff |
| `dingtalk-bridge.json` | live state: pid, connection, counts, last push |

Useful commands:

```bash
herdr pane list                                   # are both panes up?
herdr pane read <pane-id> --source recent-unwrapped --lines 40
herdr agent list                                  # is the agent named "dingtalk"?
herdr plugin log list --plugin dingtalk-omo-bridge
```

**Restart the bridge** — kill the child and the supervisor relaunches it in
about a second, which also clears any turn that is stuck waiting:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'dingtalk-bridge.mjs' -and $_.CommandLine -notmatch 'supervise' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

**Recreate the OmO pane** after installing or upgrading OmO itself:

```bash
herdr pane close <old-pane>
node startup.mjs     # with the HERDR_* plugin env vars set
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| Message gets no reply, bridge log stops after `session snapshot` | The prompt never reached OmO. Check the byte size of the newest session JSONL in `~/.omo/agent/sessions/<cwd>/` — if it did not grow, it is an input-delivery problem, not an answer-extraction one. |
| `agent get dingtalk` → `agent_not_found` | The OmO pane is gone, **or it came back under a different name**. Herdr does not remember an agent's name across restarts, so a fresh OmO pane is `pi` again. The bridge adopts the only agent automatically; with several agents it refuses to guess and tells you which ones exist. Fix with `herdr agent rename <pane_id> dingtalk`, or set `LAB_TARGET_AGENT` to the name you actually have. |
| `⚠️ OmO 卡在一个需要确认的界面上` | OmO is blocked on a prompt it needs you to answer. Look at the pane. |
| Bridge never connects | Another Stream client is already using this app. DingTalk permits exactly one connection per app — check for a second `dingtalk-bridge.mjs`. |
| Tags never appear | Run `node probe-emotion.mjs <conv-id>`, and confirm the app has the robot capability that allows emotions. |
| `msg.dec.err` on every tag | The message id was not accepted. Usually a stale or non-robot message. |
| Reply says "只支持文本消息" / "Text messages only" | The message carried neither text nor a `downloadCode`. Voice notes and rich-text in group chats are the usual cases. |
| Reply says "附件下载失败" / "Could not download the attachment" | The `downloadCode` was rejected or the download URL expired. `downloadCode`s are single-use and short-lived; check the log line `!! attachment failed`. |
| `check-reply.mjs` prints "no OmO sessions directory" | OmO is not installed, or has never run on this machine. The bridge reads answers from OmO's session logs, so there is nothing to read yet. |

## Security notes

**There is no allowlist by default.** `DINGTALK_ALLOW_STAFF` is unset out of
the box, which means *anyone who can message this bot can drive OmO on your
machine* — and OmO can read files and run commands. For anything beyond a
personal experiment, set `DINGTALK_ALLOW_STAFF` to a comma-separated list of
staff IDs. Unauthorised senders are refused before the message ever reaches the
agent.

Credentials live in two places, neither of which belongs in git:

- `%APPDATA%\herdr\plugins\config\<id>\.env` — the working copy;
- `state/auth/credentials.json` — written during registration, plaintext.

`state/` is gitignored for exactly this reason. If you ever commit it by
hand, **rotate the AppSecret in the DingTalk console immediately.**

## Platform support

The manifest declares `platforms = ["windows"]`, and that is a statement about
what has actually been **tested end to end**, not about what the code needs.
Here is the honest breakdown:

| Piece | Status |
|---|---|
| Herdr itself | Runs on Linux, macOS and Windows — its own docs use `platforms = ["linux", "macos", "windows"]` |
| OmO (`omo-ai`) | No `os`/`cpu` constraint in its manifest; the entry point is a Node script. Its installer ships a POSIX `curl \| sh` path |
| `dingtalk-stream` | Pure JavaScript WebSocket client |
| This plugin's code | No Windows-only dependency. Config/state paths resolve per platform (`AppData` on Windows, `~/Library/Application Support` on macOS, XDG on Linux) |

**What has not been verified:** the actual DingTalk round trip — a Stream
connection, a tagged reply — has only ever run on Windows 11, because that is
the only machine with OmO, a DingTalk app, and Herdr set up. A Linux or macOS
user may well find it works; the plugin just does not promise that.

CI runs on all three operating systems (Node 20 and 24) and enforces the parts
that can be checked without credentials: dependency install, syntax, path
resolution across platforms, and a committed-pattern secret scan. See
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).

If you get it running elsewhere, widening the manifest to
`["linux", "macos", "windows"]` is a one-line change — please open a PR.

## Known limitations

- **Only verified on Windows**, for the reason above. The manifest is
  deliberately conservative rather than claiming untested support.
- **The OmO process heals, its pane does not.** If `omo` exits but the pane is
  still there, the bridge restarts it in place. If Herdr has reclaimed the pane
  itself, there is nothing to type into and the agent stays down until the next
  Herdr restart — the bridge says so rather than hanging.
- **The agent pane is the whole session.** One OmO instance serves every
  conversation; concurrent senders queue rather than run in parallel.
- **Tied to OmO's session-log format.** Another agent would need its own
  reply-extraction adapter (`sessionFileForCwd` / `lastAssistantText`).
- **Attachments are fetched, not inlined.** Images and files arrive as a
  `downloadCode`; the bridge redeems it and writes the bytes into the agent's
  working directory (`.dingtalk-inbox/`), then asks the agent to open that path.
  Whether the agent can *interpret* the contents depends on its model — a
  non-multimodal model will say it cannot read an image, which is the agent's
  answer to give, not the bridge's.
- **Pictures out are path-driven.** The bridge sends back files the answer
  *names*, not image blocks — OmO produces no image blocks at all. A picture is
  only sent if it was written during the turn that mentions it, so a chart saved
  in an earlier turn stays in the repository. Paths are resolved against the
  agent's working directory, which is where OmO's relative paths point.
- **One turn at a time.** A message that arrives mid-turn is queued behind it
  (up to `LAB_QUEUE_LIMIT`, default 3), not run in parallel — the agent is a
  single interactive session, so two prompts at once would interleave.
- **No allowlist by default**, which on a shared bot is a real exposure. See
  [Security notes](#security-notes).

## 中文说明

这是一个 Herdr 插件，把 **OmO coding agent** 接到钉钉上，并在消息本身告诉你
它进行到哪一步了。

在钉钉里发一条消息：

1. 几百毫秒内，消息被打上 👌**Received** 标签；
2. 文本被输入到 Herdr pane 里运行的 OmO 会话；
3. 回答回到同一个钉钉会话；
4. 标签换成 🥳**Done**（失败则是 ☹️**Error**）。

**为什么这样设计**（两条 Herdr 的硬约束，细节见
[`docs/herdr-notes.md`](docs/herdr-notes.md)）：

- **Herdr 的 pane 随命令退出而被回收，且没有重启策略。** 所以桥跑在
  `supervise.mjs` 下面，崩溃后按退避自动重拉。
- **全屏 TUI 必须是 pane 的直接子进程。** Herdr 的 `pane send-text` 只投递给
  直接子进程；一旦把 `omo` 包进 supervisor，它变成孙进程，消息会被**静默丢弃**
  ——桥收到、记日志、然后永远等下去，任何地方都不报错。这个坑很费时间，所以
  OmO 那个 pane 特意**不**套 supervisor。

**回答是从磁盘读的，不是刮屏幕。** 全屏 TUI 会重绘覆盖自己的输出。OmO 每次
会话都落盘到 `~/.omo/agent/sessions/<cwd>/*.jsonl`，桥在提交前快照
`(文件, 字节长度)`，之后只读新增部分。`node check-reply.mjs 0` 可以脱离钉钉
单独验证这条通道。

**标签是独立的 REST 调用**，需要 app accessToken（Stream 长连接本身拿不到），
所以任何失败都只记日志、绝不吞掉正文回复。`LAB_EMOTIONS=0` 可整体关闭。

**魔法命令（斜杠命令）需要单独处理。** OmO 的 `/session` 这类命令由界面自己处理，
**不写会话日志**；桥如果按普通消息发过去，会白等满整个超时。下面这些分类只包含**实际跑过
并看过结果**的命令，不是照文档推断的：

| | 命令 | 桥的做法 |
|---|---|---|
| 实测可跑 | `/session` `/hotkeys` `/changelog` `/reload` `/compact [摘要要求]` `/new` | 发过去，把屏幕新增内容读回来。`/compact` 要调一次模型，所以用「等屏幕稳定」的等法而不是短轮询 |
| 桥自己回答 | `/abort`、`/status` | 两个名字都不在 OmO 的命令表里，不会撞名。见下 |
| 驱动选择器 | `/model`、`/model <关键词>`、`/sessions`、`/sessions <关键词>` | 见下 |
| 拒绝·会弹框 | `/help`（实测是全屏帮助），以及 `/settings` `/tree` `/fork` `/clone` `/scoped-models` `/keybindings` `/llama` `/copy` `/export` | 拒绝。留着选择器，之后每条消息都会被输入进它的搜索框 |
| 拒绝·未验证 | `/thinking` `/reasoning` `/efforts` `/fast` `/rename` | 在有人看过它真实行为之前一律拒绝 |
| 拒绝·危险 | `/quit` `/exit` `/login` `/logout` `/import` `/trust` | 拒绝。会关掉 agent，或动到凭据和文件 |
| 放行 | `/skill:name`、prompt 模板、扩展注册的命令 | 当普通提示词发过去——这些**确实**会到模型 |

**`/abort` 和 `/status` 是桥自己的命令。** 两个名字都不在 OmO 的命令表里，不会撞名，
而且在 TUI 里也没有可转发的东西。`/abort` 发 Esc（TUI 自己就是这么打断的）、丢掉**本会话**
排队的消息、再抬一次**本会话**的 abort epoch。epoch 不是记账：被打断的一轮不会产出最终
回复，没有它，等答案的循环会一直坐到五分钟超时，后面排队的消息全都跟着等。这三件事都按
会话隔离——一旦允许多个发送者，一个会话的 `/abort` 曾经会打断另一个会话的轮次、并清空
它的队列。`/status` 只答桥已经知道的事：运行多久、agent 落在哪个 pane、`agent_status`、
工作目录、正在读的会话文件、队列深度、上一条消息什么时候到的。

**跑到一半收到的消息会排队，而不是消失。** 以前是回一句「稍等」然后把正文丢掉，这在
手机上是笔亏的买卖——补一句「顺便看第 3 页」正是最容易丢的东西。默认最多留
`LAB_QUEUE_LIMIT`（3）条并按序执行；队列满了会明说，不会悄悄吞掉。只是排在队首、前面
没有别的消息时**不回复**——👌 标签已经表示收到了，"前面还有 0 条"是噪音，只有真积压时
才报数量。两个紧急命令可以插队，因为排在某一轮后面去中止那一轮，没有任何意义。

**被 blocked 时，把「它在问什么」一起发过来。** 「去 Herdr 里看一眼」没法让拿着手机的
人判断这个待确认值不值得打断手上的事；当背后那个工具是危险命令时，这个差别是安全问题。
所以截的是可见屏里的对话框本体（去掉状态栏和页脚，上限 700 字符），一条审批请求发过来
就是问题、命令、选项。

**agent pane 死了会被拉起来。** 解析不到 agent 时走 `pane run <pane> omo`，等到编辑器
提示符出现为止，带冷却，免得一个反复挂掉的 pane 变成重启循环。不能用
`herdr agent start --kind pi`：这台机器上只有 `omo`，没有 `pi`。

**`/new` 是先实测再放行的。** 它内联打印 `✓ New session started`，不要确认、不留弹框，
上下文计数器立刻从 `32K/1M` 回到 `0/1M`。

**`/model` 不是切换命令。** 文档说是，实测不是：`/model 任何东西` 都是打开选择器并把
参数当成过滤词。所以桥改成显式驱动——打开、用关键词收窄、**只有剩下一行时**才按回车，
按完再确认选择器已关闭。其它情况一律 Escape 退出并说明，因为猜“你想切哪个模型”是对
别人的会话动手。

用之前要知道两件事：

- 过滤匹配的是**模型 id**，不是显示名。`deepseek-v4-flash` 搜不到，因为 id 是 `deepseek-flash`。
- 选择器只列**当前 provider** 的模型，所以 `/model` 看到的是这个 provider 的那几个，不是
  目录里全部 43 个。切换 provider 桥不做。

**`/compact`** 是内联的，没有选择器也没有确认——但别指望它经常成功。压缩是按「上下文接近模型上限」
触发的，不是按消息条数，所以在 1M 窗口里，2 条消息的会话和 12 条消息 / 30K token 的会话都实测回
`Nothing to compact (session too small)`，且是秒回、不调模型。成功时的报告长什么样没有观测到，
所以只要不是那条失败行，就按屏幕原文透传。

**为什么不用 `herdr agent prompt`**。Herdr 明明有正合适的命令，桥却没用。`herdr agent prompt`
把文本和回车作为一次 bracketed-paste 有序写入，agent 卡在对话框上时还会直接以 `agent_blocked`
拒发——但它对每个 OmO pane 都回 `agent_not_ready`（"no longer the pane foreground process"）：
这些 OmO 是人在 shell 里手敲起来的，不是 `herdr agent start` 起的；而且 Herdr 的 `pi.toml`
压根没有 readiness 规则，两条规则都只匹配 working 的转圈，所以 idle 的 OmO 在
`herdr agent explain` 下是 `rule: none`。`agent attach --takeover` 同样用不了——"direct
terminal attach is not supported on Windows yet"。

所以桥继续往 pane 里敲字，但用 `herdr agent get` 把 `agent prompt` 本来能给的两条保证自己补上：

- **绝不往 blocked 的 pane 里打字**。发送前若 `agent_status` 是 `blocked`，文本会落进对话框当前
  聚焦的输入框然后丢失，所以改成直接回消息。
- **确认这一轮真的开始了**。`agent prompt --wait` 会在五秒内观察活动并报 `agent_prompt_stalled`；
  否则一次没送出去的提交和一轮慢的回合长得一模一样，会白白烧完整轮超时。拿一次性 agent 实测：
  `idle → working` 1.6 秒、`done → working` 1.1 秒，所以 8 秒门限（`LAB_SUBMIT_STALL_MS`）
  余量充足。没有 agent 可解析时跳过这道门——那时根本没有信号可等。

读屏还有个坑：TUI 是重绘而不是追加，同一条命令跑两次输出一模一样，按文本比对分不出
新旧。所以桥读的是回滚缓冲（`--source recent`）而不是视口，旧屏才是新屏的真前缀。

**`/sessions`** 打开的是 `/resume` 选择器。不带参数时把屏幕上的会话列出来并编号；带关键词
时过滤，**只剩一条才回车**。它刻意只用选择器默认的 **当前目录** 范围：别的目录的会话会
开自己的会话文件，而桥是从「agent 工作目录对应的那个文件」读回答的，恢复外来会话会让之后
每条回复都读不到。要跨目录，在 Herdr 里按 Tab 切到 All——这一步留给人。


**图片和文件会被取回来。** 图片消息本身不含图片，只有一个 `downloadCode`；桥拿它
去换临时下载地址、把字节存进 OmO 自己的工作目录，然后把**绝对路径**告诉 OmO（字节
不进 prompt，避免把上下文和模型都不支持的二进制塞进去）。超过 20 MB 在**下载途中**就
拒掉，不是下完再查：`content-length` 只能防住一个说实话的响应，块传输根本没有这个头。
字节先写临时文件名再改名，写到一半被杀也不会留下一个名叫真名、内容是截断的文件。
同名附件不会覆盖，会依次变成 `-2`、`-3`（名字来自发件人文件名或消息 id，两个不同的文件
很容易撞名，而交出去的是同一个路径）。语音、群里的富文本这类既没有文本也没有 `downloadCode` 的消息，才会明确回一句
「只支持文本消息」——静默跟机器人挂了是分不清的。

**OmO 画出来的图会自己回来。** 反方向是不通的：OmO 从不产生 image block（实测 20 个
真实会话，image block 全在 `toolResult` 行里，是它把读进来的图回传，不是结论），交付
图片的唯一形态就是**回答文本里的本地路径**：

```
C:\...\figs\outputs\figure_a_dose_response.png 118056 bytes
```

钉钉的 session webhook 发不了图片（它自己的消息类型表就把 Image 标成仅 API），而
`sampleImageMsg` 要的是一个谁都能拉取的 `photoURL`——图在你自己机器上，只能上传后按文件
发出去，跟 QwenPaw 走同一条路：`media/upload?type=image` 拿 `media_id`，再以
`msgKey: sampleFile` 发出。`fileType: "png"` 不在钉钉文档列的清单里（xlsx/pdf/zip/rar/
doc/docx），但 `probe-image.mjs` 实测钉钉收：用假 conversationId 打过去，回来的抱怨只有
会话号无效，从头到尾没挑 msgKey 的毛病。

**OmO 必须在回答里写出文件名。** 路径是唯一的渠道——桥没有别的办法知道你要发哪张图，而
「文件位于 `figs/outputs/`」是个目录，不是图。更要命的是 OmO 不知道自己失败了：真实回答里
写着「两张图已发送」，却只点名了目录，用户当然合理地认为桥坏了。仓库根的 `AGENTS.md` 因此
明确要求它列出完整相对路径，并且**不许声称已发送**——它发不了。

**两条发送路线才是这个调用里的坑。** 钉钉对群按会话 id 发（`groupMessages/send`），对单聊
按收件人的 staff id 发（`oToMessages/batchSend`），两者不能互换：把单聊丢给群聊端点会回
`{"code":"resource.not.found","message":"robot 不存在"}`，而且**换任何 msgKey 都一样**，连不带
文件的 `sampleText` 也照报。这句话指着机器人、不指错误，所以读起来完全像凭据问题——为此白查了
一整轮 `robotCode`，而它从头到尾都是对的（这个机器人的 payload `robotCode` 就是 appKey，而
`/v1.0/robot/emotion/reply` 又照单全收 appKey，于是 👌/🥳 标签一直好用、图却一张没发出去）。
现在桥每次入站都把 `conversationType` 和 `robotCode` 一起记进日志（`inbound route`），下一个人
不用再重新发现一遍。

`batchSend` 还有一种阴招：回 `200` 但把消息悄悄丢掉（`invalidStaffIdList` /
`filteredStaffIdList` 非空），所以这两个列表非空一律算失败，不算成功。

**发哪几张才是真问题**，因为回答里会提到它碰过的**每一个**路径：你贴进来的、日志里引用的、
以及根本不在本机的 WSL 路径。所以设了三道门，按顺序：路径必须在本机存在且是图片扩展名；
必须**在本轮期间写出**（mtime ≥ prompt 发进去的那一刻）；不能在 `state/auth/`、`.git/`、
`node_modules/` 下面。每轮最多 3 张，被拒的每一个都带原因写进日志——那里一片沉默和坏了
分不清。群聊按会话 id 发、单聊按 `senderStaffId` 发，两个地址都取自同一份入站 payload，
所以没有一个是猜的。

**「再发一次」是 mtime 门禁唯一的例外**，而且必须是：重发指的是上一轮的图，这种轮次里
什么都不会被写出来，严格的边界会精准地拒掉用户刚要的那两个文件。这是被真实轮次教育的——
一句「再发一次两张图」，OmO 点名了两张图，桥一张没发。所以当**用户自己的消息**里出现
再发 / 重发 / 重新发 / 再传 / 再给我 / 再来一次 / again / resend 时，边界后退 24 小时
（`RESEND_WINDOW_MS`）。别的都不动它，其余门禁照旧：文件必须存在、必须是图片、不能在
secrets 路径下、不超每轮上限。

**过程也会推给你。** 一轮任务可能要装包、试错、绕坑，过去这段时间是完全静默的。
现在 OmO 边做边说的内容会以 `⏳` 前缀实时推送，最后再把真正的答案发出来。判别靠
**结构**：带 `toolCall` 的消息是行动预告，纯文本才是结论——所以预告不会被当成
结果。进度按字节偏移去重，每轮最多 10 条（`LAB_PROGRESS_LIMIT` 可调），因为钉钉
机器人约 20 条/分钟限流。

同一时间只处理一轮，中途再发会收到「上一条还在处理中」。

**⚠️ 默认没有白名单。** `DINGTALK_ALLOW_STAFF` 不设的话，任何能给这个机器人
发消息的人都能驱动你本机的 OmO 读写文件、跑命令。正式用请务必设置。

**已知限制**：仅 Windows；`omo` 进程挂了会在原 pane 里被拉起来，但**pane 本身**被 Herdr
回收之后就没东西可敲了，只能等下次 Herdr 重启（桥会明确告诉你而不是干等）；单个 OmO 实例
服务所有会话，并发消息排队（默认上限 3 条）；回答提取绑死在 OmO 的会话日志格式上，换 agent
需要另写适配器。

---

## License

MIT — see [LICENSE](LICENSE).
