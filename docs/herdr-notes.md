# Herdr notes

Findings that shaped this plugin's design. Each one is either quoted from the
official docs or was established empirically on Herdr 0.9.3 / Windows 11; the
source is marked so you can tell which is which.

Most of these are the kind of thing that costs an afternoon to rediscover.

---

## 1. A plugin pane is reclaimed when its command exits

> **Documented.** Plugin panes close "when the command exits"; there is no
> restart, respawn or keep-alive policy. `[[startup]]` hooks are explicitly
> "one-shot initialization commands rather than supervised daemons".

Consequence: a long-lived process that crashes leaves nothing running until the
next server start. `supervise.mjs` exists for exactly this — it keeps the pane
alive and relaunches the real command with capped exponential backoff (1 s →
30 s, reset once a run lasts 60 s).

Verified: killing the bridge's child process produced a new child in ~1.5 s
with the **same pane id**.

## 2. `pane send-text` addresses the pane's own child process

> **Empirical, and expensive.** This is the single most important constraint
> here.

`pane send-text` does not write to a PTY that every descendant can read. It
addresses the process Herdr considers the pane's child. When `omo` ran as a
grandchild (behind `supervise.mjs`), every character the bridge typed was
discarded.

The failure mode is nasty because nothing errors:

- the bridge receives the DingTalk message and logs it;
- it snapshots the OmO session file and logs that;
- the prompt never reaches OmO;
- OmO's session file never grows by a single byte;
- the bridge waits out its full timeout.

**Corollary:** a full-screen TUI must always be a pane's direct child. The OmO
pane in `herdr-plugin.toml` is therefore *not* supervised, even though that
leaves it unable to self-heal. The bridge reports a missing agent instead of
hanging.

## 3. The supervisor must not write to the pane's stdout

A plugin pane's stdout is its terminal. When `omo` was supervised, the
supervisor's `child exited (code=…) restart #1 in 1000ms` line rendered in the
middle of OmO's UI. `supervise.mjs` now writes only to `supervise.log`.

## 4. DingTalk permits exactly one Stream connection per app

> **Empirical, hit as a real bug.**

The bridge originally wrote its pid to the state file on a 15 s heartbeat. A
startup hook firing inside that window read the *previous* process's dead pid,
concluded no bridge was running, and opened a second connection — which
silently shadowed the first.

Fix: write the pid immediately at startup, before `client.connect()`, and add a
pane-label check as a second signal.

## 5. `herdr agent prompt` does not work against OmO

> **Empirical.** It fails with *agent is no longer the pane foreground process*.

OmO's launcher spawns node/bun children, which changes what Herdr believes the
foreground process is. Input has to go in the old way:

```bash
herdr pane send-text <pane> <text>
herdr pane send-keys <pane> enter
```

Note that a literal newline inside `send-text` submits a half-finished prompt,
so the bridge flattens newlines before sending.

## 6. A full-screen TUI must not be scraped for its answer

OmO repaints over its own output. The reliable channel is the session log it
writes to `~/.omo/agent/sessions/<cwd-slug>/*.jsonl`, read by byte offset from
a snapshot taken before the prompt was submitted.

Generalising the diagnostic: **if a message gets no reply, check whether the
session file grew.** Unchanged size means the prompt never arrived; changed
size with no reply means an extraction or timeout problem. That one check splits
the two failure modes that otherwise look identical.

## 7. OmO's Herdr kind is `pi`, but there is no `pi`

> **Empirical.** `herdr agent start --kind pi` fails because nothing named `pi`
> is on `PATH`; the real binary is bun's `omo.exe`.

Run `omo` as the pane command and let Herdr recognise it from the TUI. The
startup hook then waits for detection and applies `herdr agent rename` — that
name is how the bridge finds its target later.

## 8. `plugin pane open`'s response is not worth parsing

> **Empirical.** The pane id is not where you would expect in the JSON.

`startup.mjs` snapshots the pane list, issues the open, and diffs. Simpler, and
immune to the response shape.

## 9. The Stream SDK's `registered` flag stays `false`

> **Empirical.** `client.registered` never flips even while callbacks are
> arriving normally.

The bridge wraps `onDownStream` and logs every frame instead. A steady stream of
`{"type":"CALLBACK"}` frame lines is the only trustworthy liveness signal.

## 10. Windows named pipes need the `\\.\pipe\` prefix

> **Empirical** (from the original prototype).

`HERDR_SOCKET_PATH` reports something like `C:\Users\…\herdr.sock`, but
connecting to that path directly fails with `ENOTSOCK`; the real pipe is
`\\.\pipe\C:\Users\…\herdr.sock`. Only matters if you write a socket client
yourself — shelling out to the `herdr` CLI is unaffected.

## 11. Plugin build commands only run for GitHub installs

> **Documented.** "Build commands run during GitHub `plugin install` after
> confirmation and before Herdr registers the plugin… `plugin link` does not run
> build commands."

Hence the `[[build]] npm ci --omit=dev` in the manifest, and hence the README
telling local developers to run `npm install` themselves.

## 12. Publishing to the marketplace

> **Documented.** Add the GitHub topic `herdr-plugin` and keep the manifest at
> the repo root (or a subdirectory) of the default branch. Plugins stay ordinary
> GitHub repositories; there is no separate registry.

---

## Fetching the source documentation

These notes were derived from Herdr's published docs, which are not vendored
here:

- <https://herdr.dev/llms.txt>
- `docs/next/website/src/content/docs/plugins.mdx` in the `herdrdev/herdr`
  repository
- `herdr --skill`, which prints a condensed reference

`herdr --help`, `herdr <group> --help` and `herdr plugin install --help` are
always available locally and are the most current source.
