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
`_2026.pdf`.

Files over 20 MB are refused rather than pulled into the workspace.

### Slash commands

OmO's slash commands are handled by the TUI, not the model, so **nothing is
written to the session log** — the bridge would otherwise wait out its full
timeout for an answer that cannot arrive. They are decided before anything is
typed, and the lists below contain only what was actually run and watched, not
what the docs claim:

| | Commands | What the bridge does |
|---|---|---|
| Verified inline | `/session` `/hotkeys` `/changelog` `/reload` | Runs it, reads the new lines off the screen, replies with them |
| Driven picker | `/model`, `/model <term>`, `/sessions`, `/sessions <term>` | See below |
| Refused — overlay | `/help` (measured: full-screen help), plus `/settings` `/tree` `/fork` `/clone` `/scoped-models` `/keybindings` `/llama` `/copy` `/export` | Refused. A picker left open swallows every following message into its filter |
| Refused — untested | `/thinking` `/reasoning` `/efforts` `/fast` `/compact` `/new` `/rename` | Refused until someone watches what they actually do |
| Refused — destructive | `/quit` `/exit` `/login` `/logout` `/import` `/trust` | Refused. These close the agent or touch credentials and files |
| Passed through | `/skill:name`, prompt templates, extension commands | Sent as an ordinary prompt — those *do* reach the model |

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
- **The OmO pane does not self-heal.** A supervised TUI breaks message
  delivery, so if OmO exits the agent stays down until the next Herdr restart.
  The bridge detects this and says so rather than hanging.
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
- **One turn at a time.** A message that arrives mid-turn gets "still working on
  the previous one" instead of queueing.
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
| 实测可跑 | `/session` `/hotkeys` `/changelog` `/reload` | 发过去，把屏幕新增内容读回来 |
| 驱动选择器 | `/model`、`/model <关键词>`、`/sessions`、`/sessions <关键词>` | 见下 |
| 拒绝·会弹框 | `/help`（实测是全屏帮助），以及 `/settings` `/tree` `/fork` `/clone` `/scoped-models` `/keybindings` `/llama` `/copy` `/export` | 拒绝。留着选择器，之后每条消息都会被输入进它的搜索框 |
| 拒绝·未验证 | `/thinking` `/reasoning` `/efforts` `/fast` `/compact` `/new` `/rename` | 在有人看过它真实行为之前一律拒绝 |
| 拒绝·危险 | `/quit` `/exit` `/login` `/logout` `/import` `/trust` | 拒绝。会关掉 agent，或动到凭据和文件 |
| 放行 | `/skill:name`、prompt 模板、扩展注册的命令 | 当普通提示词发过去——这些**确实**会到模型 |

**`/model` 不是切换命令。** 文档说是，实测不是：`/model 任何东西` 都是打开选择器并把
参数当成过滤词。所以桥改成显式驱动——打开、用关键词收窄、**只有剩下一行时**才按回车，
按完再确认选择器已关闭。其它情况一律 Escape 退出并说明，因为猜“你想切哪个模型”是对
别人的会话动手。

用之前要知道两件事：

- 过滤匹配的是**模型 id**，不是显示名。`deepseek-v4-flash` 搜不到，因为 id 是 `deepseek-flash`。
- 选择器只列**当前 provider** 的模型，所以 `/model` 看到的是这个 provider 的那几个，不是
  目录里全部 43 个。切换 provider 桥不做。

读屏还有个坑：TUI 是重绘而不是追加，同一条命令跑两次输出一模一样，按文本比对分不出
新旧。所以桥读的是回滚缓冲（`--source recent`）而不是视口，旧屏才是新屏的真前缀。

**`/sessions`** 打开的是 `/resume` 选择器。不带参数时把屏幕上的会话列出来并编号；带关键词
时过滤，**只剩一条才回车**。它刻意只用选择器默认的 **当前目录** 范围：别的目录的会话会
开自己的会话文件，而桥是从「agent 工作目录对应的那个文件」读回答的，恢复外来会话会让之后
每条回复都读不到。要跨目录，在 Herdr 里按 Tab 切到 All——这一步留给人。


**图片和文件会被取回来。** 图片消息本身不含图片，只有一个 `downloadCode`；桥拿它
去换临时下载地址、把字节存进 OmO 自己的工作目录，然后把**绝对路径**告诉 OmO（字节
不进 prompt，避免把上下文和模型都不支持的二进制塞进去）。超过 20 MB 会直接拒绝。
语音、群里的富文本这类既没有文本也没有 `downloadCode` 的消息，才会明确回一句
「只支持文本消息」——静默跟机器人挂了是分不清的。

**过程也会推给你。** 一轮任务可能要装包、试错、绕坑，过去这段时间是完全静默的。
现在 OmO 边做边说的内容会以 `⏳` 前缀实时推送，最后再把真正的答案发出来。判别靠
**结构**：带 `toolCall` 的消息是行动预告，纯文本才是结论——所以预告不会被当成
结果。进度按字节偏移去重，每轮最多 10 条（`LAB_PROGRESS_LIMIT` 可调），因为钉钉
机器人约 20 条/分钟限流。

同一时间只处理一轮，中途再发会收到「上一条还在处理中」。

**⚠️ 默认没有白名单。** `DINGTALK_ALLOW_STAFF` 不设的话，任何能给这个机器人
发消息的人都能驱动你本机的 OmO 读写文件、跑命令。正式用请务必设置。

**已知限制**：仅 Windows；OmO pane 不会自愈（原因见上，只能等下次 Herdr 重启，
但桥会明确告诉你而不是干等）；单个 OmO 实例服务所有会话，并发消息排队；回答
提取绑死在 OmO 的会话日志格式上，换 agent 需要另写适配器。

---

## License

MIT — see [LICENSE](LICENSE).
