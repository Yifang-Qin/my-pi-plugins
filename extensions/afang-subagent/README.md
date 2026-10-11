# afang-subagent

**English** | [简体中文](README-CN.md)

**Our own maintained fork of pi's official subagent extension.** It starts from the official example
[`examples/extensions/subagent`](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent)
and evolves independently; more features are still to be developed (see the roadmap below).

Delegate tasks to specialized subagents with isolated context windows.

## Roadmap

- [x] Background / async execution (`background: true`, fire-and-forget, the main agent isn't blocked; on completion,
      notifications are merged and delivered through the shared self-managed notification queue (an item leaves the queue only after delivery is confirmed, so Esc never loses one); results are written to `~/.pi/agent/subagent-results/`)
- [x] Recursion depth guard (`PI_SUBAGENT_DEPTH`; by default only the main session may delegate, one level deep; see "Differences from the official version" below)
- [ ] Subagent session persistence and resume (multi-turn follow-ups to the same subagent)
- [ ] Mid-run steering (appending instructions to a subagent while it runs)
- [ ] Code-level workflow orchestration (DAG / state machine, independent of prompt templates)
- [x] Artifact persistence (background task results are written to `<task cwd>/.pi/subagent-results/<timestamp>-<task-id>.md`,
      falling back to the global `~/.pi/agent/subagent-results/` if that isn't writable; ignoring this directory in the project's .gitignore is recommended)
- [x] Runtime monitoring and per-task kill for foreground parallel/chain/single tasks (the `/subagent` panel + a per-child AbortController; see the dedicated section below)

## Background mode design notes

- The `subagent` tool gains `background: true` (single mode only): it returns `task-N` immediately and the child process runs asynchronously.
- Completion notification: a custom message (`afang-subagent-notify`) that carries only a ~2KB preview + the result file path per task.
  It is sent through the **self-managed delivery queue** in `../shared/notify-queue.ts` (shared with tmux-bash): tasks that finish while the main agent is running
  are held and merged into **one** message at `turn_end` (a steer, delivered at the same turn boundary); when idle, they are held for 300ms and then merged, sent, and
  wake the agent. An item leaves the queue only once pi's `message_end` confirms it entered the transcript, so pressing Esc (which makes pi clear its steering queue) doesn't
  lose it either — it is returned to the queue and re-delivered with the next input, without waking the agent proactively. Multiple tasks are ordered by completion time, the whole body has a 24KB budget, and tasks beyond it are demoted to
  a one-line index (with the `subagent_tasks result` hint and the result file path). This replaces the old "400ms debounce + direct steer", which under
  `steeringMode: one-at-a-time` (pi's default) was still split into one message per turn, and silently dropped the notification on Esc. The tool's static prompt guidelines and the background-start return value both tell the model explicitly: it can end the current
  turn normally, with no need to wait or poll; if a task finishes while the session is still active and the agent is idle, the notification automatically starts a new turn.
- Result persistence: the report is project knowledge → it is written first to `.pi/subagent-results/` under the **task's working directory**, with a timestamp in the filename
  to avoid task id collisions across sessions, so the main agent can later `read` it by relative path.
- Filenames carry a semantic slug: `<agent name>-<topic>` (topic optional),
  e.g. `20260720-133045-task-1-scout-tree-nav-research.md`, so browsing historical reports across sessions is easy;
  `topic` is also shown in list / status / the completion notification / the report header.
- The `subagent_tasks` management tool: `list / status / result / cancel`.
- At most 4 concurrent background tasks; extra requests are explicitly rejected (no queueing).
- Lifecycle: `session_shutdown` / `session_before_switch` / `session_before_fork` kill all child processes;
  `/reload` cleans up child processes left by the previous instance through a globalThis PID registry; interrupting the main run with Esc doesn't affect background tasks.

## Foreground task monitoring and per-task kill (the `/subagent` panel)

The three foreground modes (parallel / chain / single) run **synchronously** inside a single tool call. In the past the only handle was a whole-run interrupt with Esc
(killing every subagent in the batch at once); there was no way to see each subagent's own completion trajectory, or to "kill just one of them".
This is now covered (Plan A: keep the synchronous semantics + a shared registry + a panel):

- **A module-level registry** (`liveTasks`): every foreground subagent is registered at spawn time, with its own `task-N` id,
  its status, and a live reference to the child process's streaming result — so it can be "seen" outside `execute()` too.
- **A per-child AbortController** (`runTrackedAgent`): each subagent holds its own abort switch, and the parent (tool)
  signal is linked to all of them (so Esc = kill all is preserved); killing a single one aborts only that one while the rest of the batch keeps running. The parallel worker
  converts "aborted" into a `cancelled` result that is returned rather than thrown, so a single kill doesn't take down the whole `Promise.all`.
- **The `/subagent` panel (alias `/sa`)**: an interactive overlay, isomorphic to tmux-bash's `/bg` panel —
  - List view: ↑↓ select, Enter shows a subagent's **completion trajectory** (tool-call timeline + text + usage),
    `x` kills a single task (inline y/n confirmation), Esc/q quits; it refreshes itself every second, and elapsed time / turns grow live for running tasks.
  - Trajectory view: ↑↓/PgUp/PgDn/Home/End scroll (following the tail by default), `x` kills the task being viewed, Esc/q goes back.
  - A **unified view** of live foreground tasks and background tasks (the `kind` column tells parallel/chain/single/bg apart).
  - Because extension commands can be triggered immediately even while streaming, **you can open the panel and pick one to kill while a parallel run is still executing synchronously**.
- **The `subagent_tasks` tool is expanded to match**: `list / status / result / cancel` now cover both live foreground tasks
  and background tasks, so the model itself can also check status and cancel an individual parallel subtask.

Killing a foreground task **sends no extra notification** to the assistant: its aggregated result shows up as
`aborted` in the tool output that is being awaited, which the model sees naturally (unlike a background task kill, which needs a separate notification). The registry clears
finished entries before each new tool call and is emptied on session switch/exit, so it doesn't grow without bound.

> **The `/reload` double-instance pitfall (must be followed)**: pi's `/reload` re-imports the extension entry with a cache-busting query
> (`index.ts?v=<timestamp>`), so `index.ts` ends up as "instance A with a query". If the panel then
> does `import ... from "./index.ts"` (without a query), the runtime resolves "instance B without a query", and the two instances each have
> their own independent `liveTasks`/`bgTasks` — the tool registers into A while the panel reads B's empty table, which shows up as "the panel always shows no running
> subagent". Therefore: **the panel must never import `index.ts`**. Stateless pure functions/types live in `render-helpers.ts`
> (only imported by relative path and holding no mutable state, so a double instance is harmless); the stateful `snapshot`/`kill` are passed by `index.ts`'s command
> handler as closures into `openSubagentPanel` through **dependency injection**, so the panel always reads the instance that pi loaded as the entry.

## Differences from the official version

- **Recursion depth guard (`PI_SUBAGENT_DEPTH`)**: when spawning a child pi, `PI_SUBAGENT_DEPTH = current depth + 1` is injected
  (the main session is depth 0); a child that reaches the limit (default 1, overridable with `PI_SUBAGENT_MAX_DEPTH`) **no longer registers**
  the `subagent` / `subagent_tasks` tools, and a model that can't see the tool can't nest further. The default effect: main session →
  subagent (depth 1, no subagent tool), so a subagent cannot dispatch another level. The main session's tool description gets an extra
  hint telling the model that its subagents cannot delegate further, to avoid tasks that depend on nested delegation. Before this, the only gate was the `--tools`
  allowlist (and `worker` has no tool restrictions, so it could recurse without bound).
- When an agent doesn't specify `model`, it inherits the main session's current model **and thinking level** (`ctx.model` / `ctx.thinkingLevel`;
  the official example has done the same since 0.84.2); an agent that explicitly sets `model:` uses that model's default thinking level.
- **Built-in agents are registered into the tool description (permanently visible in the system prompt)**: at registration time the extension scans its own `agents/*.md`
  and writes each name + description into the `subagent` tool description, so the model can "order from the menu" from a cold start; the description is rebuilt on `/reload`
  and never goes stale. User/project customizations are still discovered dynamically at runtime, and the description only hints at where to put them and how to inspect them.
- **A call with no mode = list the available agents (first-class behavior, not an error)**: `subagent {}` returns all agents in the current scope
  (with source and description); `subagent {agentScope:"both"}` lists the project layer as well.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Harness observability**: Captures child pi compaction, agent retry, and summarization-retry events; shows them in expanded tool results, `/subagent` trajectories, `subagent_tasks`, and background result files
- **Abort support**: Ctrl+C propagates to kill subagent processes
- **Live monitoring & per-child kill**: `/subagent` (`/sa`) overlay panel to watch each foreground
  child's trajectory and kill individuals without aborting the whole batch (see "Foreground task monitoring and per-task kill")

## Structure

```
subagent/
├── README.md            # This file
├── README-CN.md         # Chinese version
├── index.ts             # The extension (entry point)
├── child-events.ts      # Child pi JSON event normalization: message/tool + compaction/retry observability
├── test-child-events.ts # Regression test for child JSON event ingestion (run directly with bun)
├── subagent-panel.ts    # /subagent (/sa) user panel: list → trajectory → per-task kill
├── render-helpers.ts    # Stateless pure helpers/types (shared by the panel and index, avoiding the /reload double instance; see above)
├── agents.ts            # Agent discovery logic
├── agents/              # Built-in agent definitions (auto-discovered, self-contained)
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   └── worker.md        # General-purpose (full capabilities)
└── prompts/             # Workflow presets (prompt templates, auto-registered via resources_discover)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Installation

The extension is **self-contained**: built-in agents (`agents/*.md`) are discovered from the
extension's own directory, and workflow prompts (`prompts/*.md`) are registered via the
`resources_discover` event. No files need to be copied or symlinked into `~/.pi/agent/agents/`
or `~/.pi/agent/prompts/`.

Install the whole repo as a pi package (recommended):

```bash
pi install https://github.com/Yifang-Qin/my-pi-plugins
```

Or, for local development, symlink just the extension directory (must keep `../shared/` as a sibling):

```bash
ln -s "$(pwd)/extensions/afang-subagent" ~/.pi/agent/extensions/afang-subagent
ln -s "$(pwd)/extensions/shared" ~/.pi/agent/extensions/shared
```

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Loads **built-in agents** (bundled in the extension's `agents/` directory) plus **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents, unless the
repository is already trusted via `/trust` (`ctx.isProjectTrusted()`, pi 0.84.3+). Set `confirmProjectAgents: false` to disable.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| List | `{}` (no mode params) | Lists available agents for the scope (name, source, description) |
| Single | `{ agent, task }` | One agent, one task; waits synchronously for the result |
| Background | `{ agent, task, background: true, topic? }` | Asynchronous single-agent run; returns `task-N` immediately and sends a steer completion notification |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

## Output Display

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status
- Returns each completed task's final output to the parent model, capped at 50 KB per task
- Returns failure diagnostics from stderr/error messages when a child exits before producing output

**Tool call formatting** (mimics built-in tools):
- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls   # a comma-separated string or a YAML array [read, grep] both work
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

**Locations:**
- `<extension>/agents/*.md` - Built-in (bundled with the extension, always loaded, **listed in the tool description / system prompt**)
- `~/.pi/agent/agents/*.md` - User-level (always loaded)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Same-name overrides: builtin < user < project (project requires `agentScope: "both"`).
To see what is actually available at runtime (including overrides), call `subagent {}` — or
`subagent {agentScope:"both"}` to include project agents.

## Sample Agents

Built-in agents (bundled in `agents/`, overridable by same-name user/project agents):

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | (inherits the main model) | read, grep, find, ls, bash |
| `planner` | Implementation plans | (inherits the main model) | read, grep, find, ls |
| `reviewer` | Code review | (inherits the main model) | read, grep, find, ls, bash |
| `worker` | General-purpose | (inherits the main model) | (all default) |

> **Change in this fork**: when an agent definition doesn't specify `model`, it automatically inherits the main session's current model
> (`ctx.model`, including after a `/model` switch) and thinking level (`ctx.thinkingLevel`); writing an
> explicit `model:` in the frontmatter still overrides it (in which case the thinking level is not inherited).

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Child harness activity**: `compaction_start/end`, agent retry, and summarization-retry events are retained in tool details and shown in expanded results, `/subagent`, `subagent_tasks`, and background reports. A failed compaction is appended to the model-visible failure diagnostic instead of being silently dropped
- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: the child process is interrupted; single/chain report an error directly, while parallel converts it into a cancelled result for that subtask
  (without affecting the rest of the batch). It can come from an Esc kill-all, or from a single kill via the `/subagent` panel / `subagent_tasks cancel`
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Parallel model-visible output is capped at 50 KB per task; full results remain in tool details
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
