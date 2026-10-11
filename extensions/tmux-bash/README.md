# tmux-bash

**English** | [简体中文](README-CN.md)

Overrides pi's built-in `bash` tool with tmux-backed execution: commands always run in a detached
tmux window. `execute` waits in the foreground and streams the output; if the command doesn't finish
within the foreground window (default 120s), it is **automatically moved to the background** (the
command is not killed), and the model is notified via steer on completion (if the agent is busy, the
notification is delivered after all tools of the current assistant message have finished and before
the next LLM call). A companion `bg` tool manages these background tasks.

> The process is owned by the tmux server: `/reload`, switching sessions, or an unexpected crash while
> pi is running will not interrupt background tasks (and they don't occupy the Node event loop).
> **But a task's lifetime never exceeds the pi process**: each pi process owns exactly one tmux
> session `pi-bg-<pid>`; when pi exits (quit), that session is torn down entirely and its on-disk
> artifacts are reclaimed (see "Session lifecycle").
> When overriding the built-in bash, its result / error text / truncation "shapes" are aligned
> one-to-one.

## Behavior overview

| Call | Behavior |
|---|---|
| `bash { command }` (default) | Waits in the foreground and streams output; if still running when the foreground window (default 120s) is used up, it is **automatically moved to the background** (not killed) and you are notified on completion |
| `bash { command, timeout: N }` | Keeps the built-in "hard timeout" semantics: the command is **hard-killed** at the deadline with exit code 124, and **is not moved to the background** |
| `bash { command, background: true }` | **Detaches immediately** without waiting (dev server / watcher / long build, etc.); you are notified on completion |
| `bg { action, window, lines }` | Manages background tasks: `list` shows running tasks plus completed/terminated tasks of this runtime with their status, `logs` reads the output tail on demand (a snapshot; non-blocking; must not be used as a polling wait), `kill` terminates by `window_id` |
| `/bg` (slash command) | An interactive overlay panel **for the user**: lists this session's background tasks; `↑↓` select, `Enter` view output (scrollable / follows the tail), `x` kill (inline `y/n` confirmation), `Esc` exit; refreshes itself every second (see "User-side interactive panel" below) |

- When a command finishes (whether it was auto-moved to the background or started with
  `background:true`), you receive a `⏻ background bash` message (custom-rendered) containing the exit
  code, duration, output tail, and the full log path. **In the TUI this message is collapsed** (header
  status line + latest output tail + `… +N lines`) so large outputs don't flood the screen; select the
  message to **expand** it and see the full text. Collapsing only affects TUI display. The `content`
  sent to the LLM has its own **size cap**: the output tail is tightened to
  `PI_TMUX_BASH_NOTIFY_MAX_BYTES` (default 12KB), and when truncated it is followed by
  `[output truncated; showing the tail only. Full log: <.out>]`. Rationale: the notification is a
  custom message that **stays in the transcript permanently and is billed again on every later
  request**; the old 2000 lines / 50KB limit could cost ~12k tokens for a single message. The
  foreground tool result (the built-in bash contract) and `bg action=logs` (the model looking on its
  own initiative) are unaffected and still follow `maxLines/maxBytes`.
- **Auto-backgrounding attaches an output preview**: the result returned to the model starts with a
  short **tail** of the output as of the moment it was moved to the background (≤20 lines / 2KB; when
  truncated it is labeled `Output so far (last lines only; full log: …)`; if there is no output it
  says `No output so far.`), followed by the usual "moved to background, do not poll" explanation.
  While waiting in the foreground the model can't see streamed output (onUpdate only feeds the TUI),
  so without a preview it could only use `bg logs` to check progress — which is exactly where polling
  starts. In the collapsed TUI state the preview shows only the last 5 lines while the explanation
  stays fully visible; expand to see everything. `background:true` (immediate detach) has no preview.
- The tool description, the static prompt guidelines, and the message returned after backgrounding all
  tell the model explicitly: once backgrounded, it **must not** wait for completion via `bash sleep`,
  polling loops, or repeated `bg list/logs` calls; it may only continue with useful work unrelated to
  that task, otherwise it should end the current turn immediately. When the task completes, the
  notification automatically starts a new turn if the session is idle.
- The TUI footer shows `bg: N running`; when a background task finishes naturally, the watcher
  refreshes the count immediately — no need to wait for the next `bash` / `bg` tool call, and it is
  independent of when the completion message's steer is delivered. The count is based on
  `listJobsForSession` (tmux is the source of truth), consistent with the `/bg` panel: it **includes
  background tasks recovered from tmux labels after a reload** (the old count only looked at the
  in-memory table `state.jobs` and missed them after a reload); it **does not count a foreground
  command that is still executing** — no tmux label is applied while a foreground window is running,
  only when it times out into the background (otherwise `/bg` would list it, the footer would
  over-count, and the user could accidentally kill a running foreground command). While the `/bg`
  panel is open, the count is refreshed every second and updates immediately after a task is killed.
- `bg action=list` lists active tasks first, followed by recently completed/terminated ones; at most
  100 terminal-state history entries are kept in memory, and a single call outputs at most 50 tasks
  (command summaries and total output are both truncated), so task history can't grow the context
  and session without bound.
- A **colored status line** is appended to the result (`✓ done · 1.2s` / `✗ exit 1` / `✗ timeout` /
  `✗ aborted` / `⧉ running in background`; merged from the former standalone extension
  `bash-status-line`).
- The foreground tool row shows the currently applicable run limit in real time: an explicit `timeout`
  is shown as `Running · 7s · hard timeout 30s · 23s left`; without an explicit timeout it is shown as
  `Running · 37s · auto-bg after 120s · 83s left`. This is a rendering-layer enhancement only; it does
  not change the runtime semantics of "explicit timeout hard-kills / no timeout auto-backgrounds".
  `background:true` does not show a timeout, because that parameter is currently ignored by the
  immediate-detach path.
- **`bash -n` syntax pre-check**: before creating the window, the wrapper script is syntax-checked;
  on failure it returns immediately as `✗ exit 2` (the reported line number is relative to the
  original command where possible, with the local bash version attached), and the command is not
  started, so there are no side effects. Typical trigger: the `$(…)` scanner of macOS's system bash
  3.2 misreads an apostrophe (`don't`) inside a heredoc body as an unclosed quote — without the
  pre-check the window would die instantly with an invisible error.
- **Window-death detection**: during the foreground wait, tmux window liveness is probed about once a
  second; if the window disappears without writing the exit-code sentinel (wrapper crash / external
  `kill-window` / tmux server died), it returns an error immediately (`details.exitCode: -1`) instead
  of idling for 120s and then wrongly moving a dead task to the background.

## User-side interactive panel: `/bg`

The `bg` **tool** above is for the model; the `/bg` **slash command** is an interactive panel for the
**user**, to be used and dismissed (a transient overlay component, not a persistent floating window).
Both share the same runtime helpers (`listJobsForSession` / `readJobLogs` /
`killWindow`+`markJobKilled` / `reconcileCompletedJobs`) and behave like the `bg` tool; the panel just
adds keyboard interaction and drawing on top (component implementation in `bg-panel.ts`, shared
formatting helpers in `format.ts`).

Interaction (custom-drawn overlay, `ctx.ui.custom`):

1. `/bg` → pops up the **task list**, one row per task: `window-id  ● running   3m   $ command`
   (running tasks first; the icon is colored by status: `● running` / `✓ completed` (exit 0 green /
   non-zero red) / `✗ killed` / `⚠ missing`).
2. **List view** keys:
   - `↑` / `↓`: move the selection;
   - `Enter`: view the selected task's output (enter the output view);
   - `x`: request to kill the selected task → an inline `y/n` confirmation appears at the bottom;
     `y` confirms, `n`/`Esc` cancels;
   - `Esc` / `q`: exit the panel.
3. **Output view** keys:
   - `↑` / `↓` / `PgUp` / `PgDn` / `Home` / `End`: scroll (**follows the tail** by default; scrolling
     up detaches from following, `End` resumes following);
   - `x`: kill the task **currently being viewed** (same inline `y/n` confirmation);
   - `Esc` / `q`: back to the list.
4. The panel **refreshes itself every second**: the elapsed time of running tasks keeps growing, the
   status `running→completed` updates automatically, and the output view follows the tail.
   Refreshing is display-only and side-effect-free (`listJobsForSession` is read-only; completion
   notifications are still sent independently by the runtime's `fs.watch` watcher); only user actions
   such as `x` kill perform `reconcile` + state changes.

> Available in the TUI only (`ctx.hasUI`); without tmux it shows a `notify` message. When the current
> session has no background tasks, the list shows the placeholder "(no background jobs in this
> session)". Kill uses an inline `y/n` confirmation to avoid accidents; a finished task can only have
> its output viewed, and `x` tells you there is nothing to kill.

### Two kinds of kill notifications

After the user kills a task in the `/bg` panel, there are **two layers** of notification:

1. **TUI notification**: instant feedback in the panel's title row (`Killed @xxx`), plus a
   `ctx.ui.notify` (a persistent toast that **stays visible after the panel is closed**). The message
   follows the `killWindow` result and handles races: success → `Killed @xxx`; the task happened to
   finish naturally just before the kill → `Job @xxx already completed (exit N); nothing to kill`;
   window doesn't exist → `Window @xxx no longer exists (it may have already finished)`.
2. **Message to the assistant**: since this is a **manual user** kill (the assistant doesn't know about
   it), the panel injects a notification to the assistant via `notifyUserKilled` (reusing the
   completion notification's `⏻ background bash` rendering). **The body states explicitly
   "TERMINATED BY THE USER"** and includes the command and the output tail from before the kill. It
   goes through the same self-managed delivery queue as completion notifications (see the self-managed
   delivery queue under "Why this design" below), enqueued with `wake: false`:
   - **assistant is mid-turn (streaming)** → merged with other pending notifications at `turn_end` into
     a single steer, injected after all tool calls of the current assistant message have run and
     before the next LLM call, without interrupting in-flight tools;
   - **already a user turn (idle)** → not sent; it is carried along via `before_agent_start` on the
     next user prompt (= the old `nextTurn` semantics), and **never actively interrupts / wakes the
     assistant**;
   - **never wakes the assistant on its own** — kill is a user-intent action, and UI cleanup shouldn't
     make the assistant suddenly start talking (by contrast, natural completion is enqueued with
     `wake: true`, because that is a result the assistant may be waiting for);
   - **dedup**: sent only when a running task was actually killed; if the task had just finished
     naturally, `handleCompletion` has already sent the completion notification and kill doesn't
     repeat it.

> A kill by the `bg` **tool** (called by the assistant itself) does **not** send this message — the
> assistant already knows the result from the tool's return value, and sending it again would be
> redundant. Only a user kill from the `/bg` **panel** notifies the assistant.

## Why this design

- **Override the built-in `bash` (instead of adding separate `bg_*` tools)**: makes "long commands
  auto-background" the default path, so the model doesn't need to learn a new tool and there aren't
  two bashes side by side. The cost is that the built-in bash's result / error / truncation shapes
  must be matched strictly, and re-verified after each pi upgrade.
- **The process is owned by the tmux server**: the Node side doesn't hold the child process, so
  `/reload`, switching sessions, or an unexpected crash while pi is running won't interrupt background
  tasks, and they don't occupy the Node event loop. This is the biggest advantage over having the
  extension manage processes itself with `spawn(detached)`. **But tasks are not allowed to outlive the
  pi process**: sessions are per-pid and torn down entirely on exit (see "Session lifecycle").
- **Sentinel exit-code file + `.out` output file**: both "has it finished" and "what did it print" are
  persisted to disk, decoupled from process handles:
  - completion detection watches the sentinel file via `fs.watch(runDir)`;
  - log reading prefers `.out` and falls back to `tmux capture-pane` if it can't be read;
  - `tee -a` + `${PIPESTATUS[0]}` gives the exact exit code.
- **Completion notifications go through a self-managed delivery queue** (`../shared/notify-queue.ts`,
  shared with afang-subagent). Calling `pi.sendMessage(steer + triggerTurn)` directly has two problems
  (verified against the pi 1.1.0 source): ① pi's default `steeringMode: "one-at-a-time"` takes only
  one message per turn boundary — if N tasks finish during one long foreground call, that takes N−1
  extra turns, and when the model sees the first one it doesn't know the second has long since
  arrived; ② on Esc pi calls `clearAllQueues()`, and custom messages the extension enqueued have no
  backup, so **completion notifications are silently dropped**. What the queue does:
  - While the agent is running: accumulate, and in the `turn_end` handler **merge all pending
    notifications into one** steer. pi awaits the extension's turn_end inside `finishTurn` and only
    then takes the steering queue, so the delivery timing is exactly the same as steering one by one
    (after all tools of the current assistant message finish, before the next LLM call) — just merged;
  - Agent idle: accumulate for 300ms (to absorb tasks that finish almost simultaneously), then merge,
    send, and `triggerTurn` to wake it;
  - **Dequeue only after confirmed delivery**: a batch is deleted only after seeing a `message_end`
    carrying the same `batchId`; a batch still unconfirmed when the run ends (`agent_settled`) is
    treated as cleared and returned for resending. On `aborted` (Esc) it doesn't wake, and is instead
    carried along with the next user input via `before_agent_start`;
  - Size: multiple entries are ordered by completion time; the whole body has a budget of
    2×`PI_TMUX_BASH_NOTIFY_MAX_BYTES` (default 24KB) split evenly, with the budget saved by short
    entries given to the truncated ones; if each entry would get less than 1KB after the split, only
    the first few are inlined and the rest are downgraded to one-line index entries (including the
    `.out` path); an index longer than 40 lines is further written to `runDir/notify/<batchId>.md`.
    The queue itself is not persisted: entries are only metadata, and the output is already in `.out`;
  - TUI: notifications are rendered as **cards with a background** (`../shared/notice-card.ts`, shared
    with afang-subagent; the background color is `toolSuccessBg` / `toolErrorBg` by result, or
    `toolPendingBg` when everything was a user kill, with padding following `outputPad`). When an
    extension provides a renderer, pi no longer applies the default customMessageBg background, so we
    draw it ourselves. In the collapsed state a multi-task notification shows one row per task
    (✓ / ✗ / ⊘ user kill · duration · command); expand to see each task's output. **Click to expand a
    single entry**: in fullscreen mode a left click on a card toggles just that one (same MouseRegion
    approach as pi's built-in tool rows / compaction); `Ctrl+O` remains the global expand / collapse
    and overrides each entry's individual state.
  - Known edge: on a non-interactive abort (RPC `abort` doesn't `clear_queue`), a batch that was
    returned for resending may be duplicated once by an old message that pi delivers later (better a
    duplicate than a loss); `/reload` loses entries not yet delivered (same as "the job table is not
    restored after reload").

  The notification content is wrapped in a self-describing frame
  `<background-task-notification-<random suffix>>` (the protocol is `makeBgNotifyFramer` in
  `../shared/bg-notify.ts`, shared with afang-subagent; `config.ts` only customizes the preamble text)
  to keep the model from mistaking it for a new user instruction when it gets downgraded to
  `role:"user"`; when rendering in the UI, `stripBgNotifyFrame` strips the frame (compatible with the
  old fixed-tag format in older sessions).
  - **Random boundary against premature closing**: each notification gets a 12-hex-digit suffix on both
    the opening and closing tags, and the preamble declares "only a closing tag with the same suffix
    ends this block". A bare `</background-task-notification>` appearing in the payload (e.g. running
    `rg` for that tag in this repo) can't close the frame early; and the payload is **not modified by
    a single byte** (we don't follow omp's `&lt;` escaping — it would make the model silently write
    `&lt;` into files when it copies the output verbatim). See the header comment of `bg-notify.ts`
    for the design trade-offs.
- **Working directory uses `ctx.cwd`**: no requirement to be inside a git repository.
- **All tmux calls use `execFileSync` with array arguments**: no shell string concatenation, which
  eliminates quoting/whitespace problems at the root.

## Session lifecycle (Plan A: task lifetime never exceeds the pi process)

**One pi process ↔ one tmux session**, named `pi-bg-<pid>` (change the prefix with
`PI_TMUX_BASH_SESSION_PREFIX`).

Why not a shared session with a fixed name (early versions used a bare `pi-bg`): a fixed name plus a
placeholder window keeps the session alive forever, so the tmux server **outlives the pi process that
created it, and even the terminal program**; all later pi sessions reuse it and inherit **the process
context at the moment it was born**. Real incident (macOS, 2026-10): the server was created by a pi
that ran, 5 days earlier, in a terminal where "Documents access was denied" → afterwards the bash of
every session got `Operation not permitted` on `~/Documents`, while pi's own `read` tool worked fine
(TCC attributes by responsible process, and the ACL in `ls -lde` was completely normal, so it is very
easy to misdiagnose as a pi bug). Related risks: after a `tmux` upgrade, a client/server
`protocol version mismatch` makes every command fail while `tmux -V` still succeeds; windows leaking
across instances; tests and everyday sessions interfering with each other. With per-pid naming, the
server is necessarily a descendant of the current pi.

**Teardown** (`session_shutdown` branches on `reason`):

| reason | tmux side | Current session's runDir |
|---|---|---|
| `quit` (pi process exits) | **kill the whole session**, including all commands still running | **delete entirely** (including `.out`) |
| `new` / `resume` / `fork` (switching pi sessions within the same process) | kill only the task windows carrying the departing `@pi_bg_session` label (after the switch they would never be listed again); the session is left for the next pi session | **delete entirely** |
| `reload` (`/reload` hot reload) | **leave everything alone**: windows, processes, and `.out` are all kept; after the reload the task table is recovered from window labels | delete only scriptDir (the wrapper has already exec'd; on POSIX, unlink doesn't affect already-open fds) |

> The old semantics, "deliberately don't kill the windows so background tasks outlive pi's exit", are
> abandoned: they didn't hold up — autoClose reclamation, completion notifications, and `.out` reading
> all depend on the watcher inside the pi process, so once pi is gone the windows become zombies that
> nobody reclaims or observes (a new session filters by its own `piSessionId` and can't see them at
> all), and the old code also deleted their `.out` on quit, so the two rationales contradicted each
> other.

**Reclaiming crash leftovers**: `kill -9`/OOM doesn't fire `session_shutdown`; leftover sessions are
reclaimed on the next startup by `gcStaleSessions()` based on pid liveness — it kills only sessions
whose name strictly matches `<prefix>-<digits only>` and whose pid is dead; it never touches a session
whose pid is still alive (another pi instance), has a non-numeric suffix (`pi-bg-notes`), or when the
session name was pinned with `PI_TMUX_BASH_SESSION`. **A bare `pi-bg` session left over from older
versions is outside the namespace**; clear it once manually with `tmux kill-session -t pi-bg`.

## Non-interactive execution and stdin

A program has four **independent** channels for deciding "can I interact with a human", and each is
handled separately:

| Channel | How it's probed | Treatment |
|---|---|---|
| ① `isatty(fd)` | syscall; env can't change it | stdout/stderr are naturally not a tty because of the `\| tee` pipe; stdin is controlled by the `stdin` parameter below |
| ② `TERM` | reads an environment variable | hardened to `TERM=dumb`, so curses/fullscreen UIs degrade or refuse to draw |
| ③ the program's own non-interactive knobs | read environment variables | injected by hardening (pager/editor/credentials/package manager; the table is `NON_INTERACTIVE_ENV` in `config.ts`) |
| ④ `open("/dev/tty")` | looks for the **controlling terminal** directly, bypassing fd redirection | **deliberately not addressed** (see below) |

### stdin (the `stdin` parameter)

| Value | Behavior |
|---|---|
| `"null"` (default) | `< /dev/null`. **Aligned with pi's built-in bash** `stdio: ["ignore", …]`: `cat` (no args), `python`/`node` entering a REPL, `npm init`, and `read` get EOF immediately |
| `"tty"` | Inherits the tmux pane's PTY, for "a human `tmux attach`es and types on the keyboard"; **also skips the env hardening** (if you ask for a tty you intend to interact; aligned with omp's PTY path, which doesn't harden) |

Why this was changed: the wrapper's `( … ) 2>&1 \| tee` only redirected 1/2, and **stdin used to be
inherited straight from the pane's PTY** (`[ -t 0 ]` was true). Commands that read stdin therefore
never got EOF and **hung waiting on a keyboard nobody was typing on** → used up the full 120s
foreground window → auto-moved to the background → and the model had been explicitly told "don't poll
background tasks" → **silent stall**. That was a behavioral deviation from the built-in bash, and it
has been fixed.

### Hardening layering

The hardening exports come **after** the ambient `process.env`, and take effect **only inside the
command subshell**:

```bash
export PAGER=less            # ← ambient (inherited from the user's shell)
export TERM=xterm-256color
(
export PAGER='cat'           # ← hardening: overrides ambient
export TERM='dumb'
<command>                    # ← the command runs last: `PAGER=less cmd` still wins
) < /dev/null 2>&1 | tee -a "$out"
```

Three design rationales:

- **Layered above ambient**: otherwise a `PAGER=less` in the user's shell would defeat the hardening
  and make it pointless (consistent with the layering of omp's `buildNonInteractiveEnv()`: hardening
  above ambient, below explicit caller env).
- **The user-intent channel = the command text itself**: the command executes last, so `VAR=x cmd` and
  an `export` inside the command still take effect.
- **Scoped to the subshell**: it doesn't pollute the `exec $SHELL -l` at the end of the wrapper that
  keeps the window alive; otherwise, with `autoClose=false`, attaching would drop you into a crippled
  `TERM=dumb` shell.

The global switch `PI_TMUX_BASH_HARDEN_ENV=0` turns the hardening off (it doesn't affect the stdin
redirection; the two are independent); `CI=true` has its own escape hatch `PI_BASH_NO_CI` (same name
and meaning as in omp).

### Deliberately not addressed: `/dev/tty`

Prompts that **directly `open("/dev/tty")`** — `sudo` asking for a password, `ssh`'s first-connection
host-key confirmation — can't be stopped by env or fd redirection; the only fix is to give the process
**no controlling terminal** (setsid; the built-in bash's `detached: true` does exactly that). But that
would **kill this extension's core advantage of being attachable**, so we don't do it. Mitigation:
`SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force` makes ssh fail fast instead of hanging; `sudo` will still
hang (use `sudo -n`, or set up passwordless sudo beforehand).

## Artifact permissions and cleanup

**Tightened permissions** (the wrapper script inlines exported environment variables, which may
contain secrets):

- runDir / scriptDir directories: `0o700` (only the owner can enter).
- wrapper `.sh` script: `0o700` (only the owner can execute / read for the `bash -n` pre-check; nothing
  for group/other).
- `.out` output and exit-code sentinel files: `0o600`. In the implementation these internal files are
  created under a **subshell-local `umask 077`**, which **doesn't affect files the user's command
  creates itself** (a global `umask` would also make the user's `touch`ed files 600, which is
  deliberately avoided).

**Disk reclamation** (in sync with the table above; every `cleanup` additionally **reclaims artifacts
of historical sessions**): scans the other runDirs under `outputDir` and probes the creator `pid` in
the directory name — if the pid is dead (that pi exited long ago) or pid == this process (a stale
runDir of its own) → delete; if the pid belongs to **another live pi instance** → keep (don't delete
coexisting instances by mistake); if no pid can be parsed from the directory name → skip
conservatively.

> Note: a pi killed with `SIGKILL` doesn't fire `session_shutdown`; its remains are left for the
> historical reclamation above to clear when the **next** pi instance starts/exits (by then the old
> pid is dead).

## Requirements

- `tmux` must be on `PATH` (when missing, the bash / bg tools return an "unavailable" error directly;
  Windows generally needs WSL).
- Everything else uses only what pi ships: `@earendil-works/pi-coding-agent` / `pi-tui` / `typebox`.

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `PI_TMUX_BASH_TMUX` | `tmux` | tmux executable |
| `PI_TMUX_BASH_SESSION` | *(unset)* | **Pins** the background session name; if set it is used as is (multiple instances may share one session, at their own risk of "inheriting an old process's context"), and the per-pid leftover-session reclamation is turned off |
| `PI_TMUX_BASH_SESSION_PREFIX` | `pi-bg` | Session name prefix; the actual session name is `<prefix>-<pid>` (one per pi process) |
| `PI_TMUX_BASH_DIR` | `$TMPDIR/pi-tmux-bash` | Root of runDir (stores scripts, `.out`, sentinel files) |
| `PI_TMUX_BASH_FOREGROUND_TIMEOUT` | `120` (seconds) | Foreground synchronous wait window; with no explicit `timeout`, a command still running after this long is auto-moved to the background (not killed). The durations in the tool description and prompt guidelines are generated dynamically from it (fixed when the extension loads), so what the model believes matches reality |
| `PI_TMUX_BASH_HARDEN_ENV` | `true` | Whether to inject env hardening into non-interactive commands (pager / `TERM=dumb` / editor / credential-prompt switches); see "Non-interactive execution and stdin" |
| `PI_TMUX_BASH_AUTOCLOSE` | `true` | Whether to close the tmux window automatically after the command finishes (`false` keeps it attachable after it ends) |
| `PI_TMUX_BASH_MAX_LINES` | pi default (2000) | Maximum number of lines kept when reading logs |
| `PI_TMUX_BASH_MAX_BYTES` | pi default (50KB) | Maximum number of bytes kept when reading logs |
| `PI_TMUX_BASH_NOTIFY_MAX_BYTES` | `12288` (12KB) | Byte cap for the body of background-completion / user-kill notifications (keeps the tail; when exceeded, the full log path is attached) |

## File layout

```
tmux-bash/
├── index.ts                    Entry: overrides built-in bash + registers the bg tool + completion rendering + session lifecycle
├── runtime.ts                  Wrapper script generation, foreground sync execution / streaming / auto-backgrounding, fs.watch completion watching, log reading
├── tmux.ts                     Low-level tmux wrapper (execFileSync with array arguments)
├── config.ts                   Config defaults + environment variables + window label constants + notification preamble (protocol in ../shared/bg-notify.ts)
├── test-fixes.ts               Functional tests (test case list and usage in the file header; run with bun)
(shared: ../shared/bg-notify.ts notification frame protocol, ../shared/notify-queue.ts notification delivery queue + test-notify-queue.ts, ../shared/notice-card.ts notification card rendering)
├── README.md
└── README-CN.md                Chinese README
```

## How the tmux backgrounding works (overview)

Each task writes a one-off wrapper `.sh` and hands it to `tmux new-window -a -d -PF '#{window_id}'`:

```bash
( umask 077; : > "$out_file" )               # internal files are 0o600 (local umask, doesn't affect user commands)
( <user command> ) 2>&1 | tee -a "$out_file"   # output is persisted live
rc=${PIPESTATUS[0]}                         # take the real exit code
( umask 077; printf '%s\n' "$rc" > "$exit_file.tmp" )  # write .tmp first
mv -f "$exit_file.tmp" "$exit_file"         # appears atomically, so fs.watch only sees a complete sentinel
exec "${SHELL:-/bin/bash}" -l               # keep the window alive after the command ends, so it can be attached
```

- **Foreground path** (`runForegroundBash`): after writing the script, it first pre-checks with
  `bash -n` (a syntax error returns directly, without creating a window); after creating the window it
  polls `.out` (streaming `onUpdate`) + the sentinel file + window liveness (about once a second);
  finished → return the final result; window gone without a sentinel → return an error immediately;
  explicit `timeout` reached → kill the window and return exit code 124; foreground window used up →
  register a job and move to the background (register first, then re-check the sentinel, which
  eliminates the race where a task finishes at the instant of the switch and its notification is
  missed).
- **Background path**: the Node side generates the script → creates the window and gets its `@id` →
  labels the window and registers the job → `fs.watch(runDir)` waits for the sentinel file to appear →
  reads the exit code + `.out` → records `completed + exitCode` → `pi.sendMessage` wakes the model as
  a steer. Completion records stay in the current runtime's job table, so even after the default
  autoClose closes the tmux window, `bg action=list` still lists the final state, and
  `bg action=logs window=@id` can still read the log.

## Compatibility with pi-powerline-footer

### Current status: track the latest release (verified with pi 1.0 + powerline 0.19, 2026-10)

The install docs in the repo simply track powerline's latest:

```bash
pi install npm:pi-powerline-footer
```

- **powerline no longer has its own fixed-editor**: since 0.9.0, the "Native fixed input cutover"
  removed the extension-managed fixed editor and chat-area scrolling, which pi now handles natively
  (pi 1.0 defaults to `tuiMode: "fullscreen"`). So the content below in "How the ghosting happened"
  and "Re-verification path after upstream changes" that involves `powerline.fixedEditor`, the DECSTBM
  compositor, and `/powerline fixed-editor` only matters for **powerline < 0.9** and is now kept as
  historical reference.
- **peer range**: the current 0.19.0 `package.json` declares `@earendil-works/* >=0.81.0`, with no
  upper bound, which pi 1.0.0 satisfies (the old note "peer upper bound `<0.84.0`" is outdated and has
  been removed).
- Historically, `pi-powerline-footer@0.7.0` was pinned to avoid the scrolling ghosting of `0.8.0`'s
  fixed-editor under tmux; that pin was lifted long ago — the old peer range was `>=0.74.0 <0.81.0`,
  which would stop pi from opening on 0.84+.

### How the ghosting happened (historical background, powerline < 0.9 only)

What follows records why the old (`0.8.0`) fixed-editor ghosted under tmux, kept as a reference for
troubleshooting similar problems later:

```text
tmux-bash long output / streaming updates
  → tool results trigger frequent repaints of the chat viewport (a trigger, not the root cause)
  → powerline fixed-editor takes over pi-tui's render / doRender / terminal.write / terminal.rows
  → powerline 0.8.0 scrolls incrementally using a DECSTBM scroll region + SU/SD line moves + a cached transcript
  → tmux's screen state and the extension's cache occasionally diverge
  → old pixels that were moved are not fully overwritten, producing ghosting
```

powerline 0.7.0 also takes over the viewport and uses DECSTBM, but on scroll it clears and redraws
the entire viewport; the SU/SD line moves and reuse of on-screen old pixels added in 0.8.0 are the key
difference between the two versions. Another state-leak path awaiting upstream confirmation is that
`buildFixedClusterPaint()` returns early when `cluster.lines.length === 0`, which may skip the
`resetScrollRegion()` below it.

This is a separate problem from the control-sequence leakage tmux-bash used to have. tmux-bash now
normalizes data before it enters the renderer:

- `normalizeForegroundOutput()` in `runtime.ts`: first collapses CR/EL, then strips ANSI, and only
  then truncates and feeds `onUpdate` / the final result;
- `renderCall()` in `index.ts`: cleans the command echo with `collapseCarriageReturns()`;
- `shared/terminal-text.ts`: drops CSI sequences that move the cursor across lines, maintaining the
  constraint "one render string = one physical row".

So if ghosting later still appears only with the `fixedEditor` switch, look at powerline's compositor
first; don't revert the output normalization above first.

### Re-verification path after upstream changes (historical, powerline < 0.9 only)

> powerline 0.9+ no longer has a fixed-editor, so the `fixed-editor` A/B in the steps below no longer
> applies; if ghosting appears under pi's native fullscreen, use `tuiMode: "regular"` as the control
> baseline, with the same approach as below.

If ghosting reappears after a future powerline or pi upgrade, re-verify as follows:

1. Record the candidate environment versions: `pi --version`, `tmux -V`,
   `npm view pi-powerline-footer version`, and confirm the powerline version actually installed.
2. Keeping the same session and output, run `/powerline fixed-editor off` as the ghosting-free
   baseline; then turn fixed-editor on for an A/B, so tmux-bash output problems and fixed-editor
   problems don't get mixed together.
3. Cover these scenarios in tmux: long static output, progress output with `\r` / `ESC[K`, streaming
   tool results, `Ctrl+O` expand/collapse, continuous scrolling up/down.
4. Inspect the candidate powerline version's `fixed-editor/terminal-split.ts`:
   - whether SU/SD incremental line moves are disabled under tmux, or a full-viewport-repaint switch
     is provided;
   - whether every branch resets the DECSTBM scroll region;
   - whether it still monkey-patches `tui.doRender`, `terminal.write`, and `terminal.rows`, thereby
     bypassing pi's own fixes.
5. Consider the version safe only if it no longer reproduces with fixed-editor on, and behavior doesn't
   regress with it off.

Start comparing from these upstream locations:

- [pi-powerline-footer v0.8.0 CHANGELOG](https://github.com/nicobailon/pi-powerline-footer/blob/v0.8.0/CHANGELOG.md)
- [powerline fixed-editor compositor](https://github.com/nicobailon/pi-powerline-footer/blob/v0.8.0/fixed-editor/terminal-split.ts)
- [powerline PR #118: smooth fixed-editor scrolling](https://github.com/nicobailon/pi-powerline-footer/pull/118)
- [pi v0.82.1...v0.83.0](https://github.com/earendil-works/pi/compare/v0.82.1...v0.83.0)

## Known limitations / TODO

- **The job table and notification queue are not restored across `/reload`** (**TODO, highest payoff**
  — this is currently the only path that can still lose a notification):
  - after a reload the in-memory job map is cleared, so tasks started before the reload no longer
    notify automatically on completion (the tasks themselves keep running in tmux and the `.out` logs
    are kept; check manually with `bg action=list` / `tmux`);
  - entries in the self-managed notification queue (`../shared/notify-queue.ts`) that have **not yet
    been delivered** are also lost when the extension instance is rebuilt;
  - idea: have `session_start` scan runDir + window labels to rebuild the job table and re-watch the
    old runDir's sentinels; persist the queue's pending/inflight to runDir (or hand them over across
    instances via `globalThis`) and redeliver after the reload. omp's epoch idea can be used to tell
    "drop when switching sessions" from "keep on reload".
- **Tasks moved to the background are not reclaimed automatically while pi is alive**: commands that
  were auto-backgrounded / started with `background:true` stay alive and hold resources until you
  manually `bg action=kill` them (a behavior reversal relative to the old `bash-default-timeout`,
  which hard-killed runaway commands after 120s). The upper bound is the pi process: on `quit` the
  whole session is torn down, so nothing leaks beyond pi (see "Session lifecycle").
- **Placeholder window**: on first use a `pi-bg` placeholder shell window is created so the session
  stays alive after all task windows are closed; `bg action=list` already filters it out by label.
  Note that its **name no longer equals the session name** (the session name has a pid suffix), which
  incidentally weakens the `new-window` target ambiguity, but the trailing-colon `-t <session>:` form
  in `tmux.ts` is still required.
- **Prompts that go straight to `/dev/tty` still hang**: `sudo` passwords and `ssh` first-connection
  host-key confirmation bypass env and fd redirection; only setsid can block them, and that would kill
  attach takeover, so it is deliberately not done (see "Non-interactive execution and stdin").
- Synchronous tmux calls via `execFileSync`, the cross-platform reliability of `fs.watch`, etc.; with
  large volumes, consider adding fallback polling.
- **A duplicate notification may be delivered once after abort in RPC mode**: a non-interactive abort
  (RPC `abort` isn't followed by `clear_queue`) doesn't clear pi's steering queue, so a batch we return
  for resending may be duplicated by an old message pi delivers later. "Better a duplicate than a
  loss" is a deliberate choice; a real fix would need a signal that distinguishes "pi's queue was
  cleared" from "merely interrupted".
- **(To evaluate) Trim the anti-polling wording**: "do not poll" is currently repeated in the
  description, the 5 guidelines, `bg`'s snippet/guideline, and the backgrounded result; this was added
  deliberately to suppress polling. Before trimming, write a script that scans local session jsonl
  files and counts how often the model calls `sleep`/`wait` and `bg list/logs` "after backgrounding
  and before the completion notification arrives" as a baseline; afterwards compare any change with
  the same script to see whether polling creeps back. Leaning: merge only literal duplicates within
  the same layer (e.g. bash guideline #5 and bg guideline #1), and leave the paragraph in the
  backgrounded result (closest to the decision point) alone.
- **(To investigate) Move to the background early when the user interjects**: omp's foreground wait
  also races a `steeringSignal`, so when the user interjects during a long command, it moves to the
  background immediately and lets the message be injected sooner. First confirm whether pi's extension
  API exposes a steering-arrival signal (or whether it can be approximated by polling
  `hasPendingMessages()`).
- **Theme colors**: notification cards use `toolSuccessBg` / `toolErrorBg` / `toolPendingBg` by
  result, but in the gruvbox-dark theme all three are `dark0Soft`, so success / failure backgrounds
  are indistinguishable and only the colors of the leading ✓ / ✗ tell them apart. Changing the theme
  fixes it; no code is involved.

## Local development

The source lives in `extensions/tmux-bash/` of this repo. For local development it can be symlinked
into `~/.pi/agent/extensions/tmux-bash`; `/reload` applies your edits.
