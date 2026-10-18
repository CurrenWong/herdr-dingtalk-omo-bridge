# herdr-dingtalk-omo-bridge

A [Herdr](https://herdr.dev) plugin that makes an **OmO** coding agent reachable
from DingTalk — and tells you, on the message itself, what state it is in.

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
- [How it works](#how-it-works)
- [Operations](#operations)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)
- [Known limitations](#known-limitations)
- [中文说明](#中文说明)

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
| Herdr | ≥ 0.9.0 (developed against 0.9.3) |
| OS | Windows (declared `platforms = ["windows"]` in the manifest) |
| Node | ≥ 20 (developed against 24) |
| OmO | the `omo` CLI on `PATH` |
| DingTalk | a robot app with **Stream mode** enabled |
| build | `npm` — the manifest runs `npm ci --omit=dev` at install |

## Install

### 1. Create the DingTalk app

In the [DingTalk developer console](https://open-dev.dingtalk.com/):

- create an app and add a **robot** capability;
- enable **Stream mode** (no callback URL needed);
- copy the **Client ID (AppKey)** and **Client Secret (AppSecret)**.

The bundled `auth` action performs the device-code login that turns those
credentials into a usable bot. You do not need to hand-edit any file.

### 2. Install the plugin

```bash
# from GitHub
herdr plugin install <owner>/<repo>

# or, while developing
herdr plugin link /path/to/this/repo
npm install          # `plugin link` does not run build commands
```

### 3. Register the bot

```bash
herdr plugin action invoke dingtalk-omo-bridge.auth
```

It writes a QR code to `state/auth/qrcode.png` (or prints a scan URL if no
Python with `segno` is available) and blocks until you scan it. On success the
credentials land in the plugin's config directory as `.env`.

### 4. Start it

Restart Herdr, or:

```bash
herdr server reload-config
```

The startup hook opens the two panes and the bot goes live. Check with
`herdr pane list` — you should see an **OmO (DingTalk)** tab and a
**DingTalk ↔ OmO bridge** tab.

To get it listed in the Herdr plugin marketplace, add the GitHub topic
`herdr-plugin` to the repository.

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
| `LAB_TARGET_AGENT` | `dingtalk` | Name of the Herdr agent the bridge types into. |
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

Logs live in the plugin state directory
(`%LOCALAPPDATA%\herdr\plugins\<id>\` on Windows):

| File | Contents |
|---|---|
| `dingtalk-bridge.log` | every inbound, every tag call, every webhook push |
| `supervise.log` | bridge restarts and their backoff |
| `dingtalk-bridge.json` | live state: pid, connection, counts, last push |

Useful commands:

```bash
herdr pane list                                   # are both panes up?
herdr pane read w2:pK --source recent-unwrapped --lines 40
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
| `agent get dingtalk` → `agent_not_found` | The OmO pane is gone. Re-run `startup.mjs`. |
| `⚠️ OmO 卡在一个需要确认的界面上` | OmO is blocked on a prompt it needs you to answer. Look at the pane. |
| Bridge never connects | Another Stream client is already using this app. DingTalk permits exactly one connection per app — check for a second `dingtalk-bridge.mjs`. |
| Tags never appear | Run `node probe-emotion.mjs <conv-id>`, and confirm the app has the robot capability that allows emotions. |
| `msg.dec.err` on every tag | The message id was not accepted. Usually a stale or non-robot message. |

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

## Known limitations

- **Windows only.** The manifest declares `platforms = ["windows"]`, and the
  Herdr CLI paths are Windows-flavoured.
- **The OmO pane does not self-heal.** A supervised TUI breaks message
  delivery, so if OmO exits the agent stays down until the next Herdr restart.
  The bridge detects this and says so rather than hanging.
- **The agent pane is the whole session.** One OmO instance serves every
  conversation; concurrent senders queue rather than run in parallel.
- **Tied to OmO's session-log format.** Another agent would need its own
  reply-extraction adapter (`sessionFileForCwd` / `lastAssistantText`).

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

**⚠️ 默认没有白名单。** `DINGTALK_ALLOW_STAFF` 不设的话，任何能给这个机器人
发消息的人都能驱动你本机的 OmO 读写文件、跑命令。正式用请务必设置。

**已知限制**：仅 Windows；OmO pane 不会自愈（原因见上，只能等下次 Herdr 重启，
但桥会明确告诉你而不是干等）；单个 OmO 实例服务所有会话，并发消息排队；回答
提取绑死在 OmO 的会话日志格式上，换 agent 需要另写适配器。

---

## License

MIT — see [LICENSE](LICENSE).
