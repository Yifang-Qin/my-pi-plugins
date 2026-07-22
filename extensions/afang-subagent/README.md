# afang-subagent

**我们自己维护的 pi 官方 subagent extension fork。** 以官方示例
[`examples/extensions/subagent`](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent)
为起点独立演进，更多扩展功能待开发（见下方路线图）。

## 路线图（待开发）

- [x] 后台 / 异步执行（`background: true` fire-and-forget，主 agent 不阻塞；完成时
      `sendMessage + triggerTurn + steer` 通知，防抖合并；结果落盘 `~/.pi/agent/subagent-results/`）
- [x] 递归深度护栏（`PI_SUBAGENT_DEPTH`，默认只允许主会话委派一层，见下方「与官方版的差异」）
- [ ] 子 agent session 持久化与恢复（多轮追问同一子 agent）
- [ ] 运行中 steering（中途向子 agent 追加指令）
- [ ] workflow 的代码侧编排（DAG / 状态机，不依赖 prompt 模板）
- [x] artifacts 落盘管理（后台任务结果自动写 `<任务cwd>/.pi/subagent-results/<时间戳>-<task-id>.md`，
      写不进去时回退全局 `~/.pi/agent/subagent-results/`；建议在项目 .gitignore 里忽略该目录）

## 后台模式设计要点

- `subagent` 工具新增 `background: true`（仅 single 模式）：立即返回 `task-N`，子进程异步运行
- 完成通知：custom message（`afang-subagent-notify`），只放 ~2KB preview + 结果文件路径，
  400ms 防抖窗口合并多任务完成，避免通知风暴；通过 `deliverAs: "steer"` 在当前 assistant 消息的
  工具批次结束后、下一次 LLM 调用前投递（空闲时立即唤醒），避免 `followUp` 因主 agent 持续调用
  工具而长期饥饿。工具的静态 prompt guideline 与后台启动返回都会明确告诉模型：可以正常结束当前
  turn，无需等待或轮询；若任务在会话仍活动、Agent 已空闲时完成，通知会自动拉起新 turn
- 结果落盘：报告属于项目知识 → 优先写**任务工作目录**下的 `.pi/subagent-results/`，文件名带时间戳
  防跨会话 task id 冲突，主 agent 后续用相对路径即可 read
- 文件名含语义 slug：`<agent名>-<topic>` 拼接（topic 可选），
  如 `20260720-133045-task-1-scout-tree-nav调研.md`，跨 session 翻历史报告一目了然；
  `topic` 同时显示在 list / status / 完成通知 / 报告头里
- `subagent_tasks` 管理工具：`list / status / result / cancel`
- 上限 4 个并发后台任务，超出显式拒绝（不排队）
- 生命周期：`session_shutdown` / `session_before_switch` / `session_before_fork` 杀全部子进程；
  `/reload` 通过 globalThis PID 注册表清理上一实例遗留的子进程；Esc 中断主 run 不影响后台任务

## 与官方版的差异

- **递归深度护栏（`PI_SUBAGENT_DEPTH`）**：spawn 子 pi 时注入 `PI_SUBAGENT_DEPTH = 当前深度 + 1`
  （主 session 深度 0）；达到上限（默认 1，可用 `PI_SUBAGENT_MAX_DEPTH` 覆盖）的子进程**不再注册**
  `subagent` / `subagent_tasks` 工具，模型看不见工具即无法继续嵌套。默认效果：主 session →
  subagent（深度 1，无 subagent 工具），因此 subagent 不可再派下一层。主 session 的工具描述会附加
  提示，告知模型其子 agent 无法继续委派，避免写出依赖嵌套委派的任务。此前唯一的闸门是 `--tools`
  白名单（worker 未限制工具，可无限递归）。
- agent 未指定 `model` 时继承主会话当前模型（官方版不指定则回退 pi 默认模型）
- **内建 agent 注册进工具描述（system prompt 常驻可见）**：注册时扫描扩展自带 `agents/*.md`，
  把名字 + description 写入 `subagent` 工具描述，模型冷启动即可"看菜下单"；描述随 `/reload`
  重建，不会过期。user/project 定制仍为运行时动态发现，描述里只提示存放位置与查看方法
- **无 mode 调用 = 列出可用 agent（一等公民行为，非报错）**：`subagent {}` 返回当前 scope 下
  全部 agent（含 source 与 description）；`subagent {agentScope:"both"}` 连 project 层一起列出

## 安装

见仓库根目录 `AGENTS.md`（逐文件软链接约定）。以下官方 README 内容保留作原始设计参考，
其中安装路径说明已不适用。

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
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

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

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
tools: read, grep, find, ls
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
| `scout` | Fast codebase recon | (继承主模型) | read, grep, find, ls, bash |
| `planner` | Implementation plans | (继承主模型) | read, grep, find, ls |
| `reviewer` | Code review | (继承主模型) | read, grep, find, ls, bash |
| `worker` | General-purpose | (继承主模型) | (all default) |

> **本 fork 的改动**：agent 定义中不指定 `model` 时，自动继承主会话当前模型
> （`ctx.model`，含 `/model` 切换后的）；在 frontmatter 里显式写 `model:` 仍可覆盖。

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Parallel model-visible output is capped at 50 KB per task; full results remain in tool details
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
