# BUILTIN-BASH-REFERENCE — 覆盖内置 bash 的逐条对齐/偏离清单

本文件是 `tmux-bash` **覆盖 pi 内置 `bash` 工具**时的权威参考：逐条列出内置工具的
参数 / 结果 / 错误文案 / 截断等「形状」，并标注本插件是「已对齐」「近似」还是「故意偏离」。
`index.ts` 的注释按章节号引用本文件（如「见 §2/§7」）。

> **来源与版本**：内容基于 pi `@earendil-works/pi-coding-agent@0.80.10` 的
> `dist/core/tools/bash.js` 与 `dist/core/tools/truncate.js`。**pi 升级后须复核本文件**——
> 内置 bash 的错误文案 / 截断 footer 一旦改动，本插件的「对齐」承诺就会回归（这也是 README
> 「为什么覆盖内置 bash 有耦合成本」那段的具体所指）。
>
> 复核方法：
> ```bash
> PI=$(node -e "console.log(require.resolve('@earendil-works/pi-coding-agent'))" 2>/dev/null \
>   || echo /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js)
> less "$(dirname "$PI")/core/tools/bash.js"
> ```

图例：✅ 已对齐（含文案逐字）· ≈ 近似（语义一致、文案不逐字）· ✏️ 故意偏离（tmux 后台化带来的差异）

---

## §1 工具身份

| 项 | 内置 bash | 本插件 |
|---|---|---|
| `name` | `bash` | `bash`（同名 `registerTool` 完全替换） |
| `label` | `bash` | `bash` ✅ |
| `description` | 见下 | 重写，强调「自动转后台」语义 ✏️ |

内置 description（`DEFAULT_MAX_LINES=2000`、`DEFAULT_MAX_BYTES=50*1024` 代入后）：

> Execute a bash command in the current working directory. Returns stdout and stderr.
> Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated,
> full output is saved to a temp file. Optionally provide a timeout in seconds.

本插件 description 额外说明：输出流式转发；未在前台等待窗口（默认 120s）内结束则自动转后台
并在完成时投递通知；`timeout` 改为「到点硬杀」；`background:true` 立即分离。见 §7。

---

## §2 参数 schema —— `index.ts` 引用点

内置（`bashSchema`）：

```ts
Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
})
```

本插件（`BashParams`）：

| 参数 | 内置 | 本插件 | 状态 |
|---|---|---|---|
| `command` | `string`，必填 | 同 | ✅ |
| `timeout`（秒） | 可选；到点**杀死**进程 | 可选；到点**硬杀，退出码 124，不转后台** | ✏️ 语义见 §6/§7 |
| `background` | —（无此参数） | 可选 `boolean`；立即后台、不等待 | ✏️ 新增，见 §7 |

`command` / `timeout` 的字段名、类型、可选性保持不变（模型看到的 schema 兼容），仅**新增**
`background` 开关——这正是 `index.ts` 注释「形状保持不变（§2），仅新增 background 开关（§7）」的含义。

---

## §3 执行后端与流式（`onUpdate`）

内置：`spawn` 一个 shell 子进程（`detached`，非 win32），`stdout`+`stderr` **合并**走 `onData`；
经 `OutputAccumulator` 累积，`onUpdate` 以 `BASH_UPDATE_THROTTLE_MS = 100ms` 节流推送。
执行开始时先发一次空 update：`onUpdate({ content: [], details: undefined })`。

本插件：命令**不由 Node 持有**，而是在 detached tmux 窗口里由 wrapper 脚本运行，输出经
`tee -a` 落盘到 `.out`；前台 `runForegroundBash` **轮询 `.out`（约 150ms）**并在内容变化时
`onUpdate`。同样在开始时先发一次空 update。

| 项 | 内置 | 本插件 | 状态 |
|---|---|---|---|
| stdout/stderr 合并 | ✅ | ✅（wrapper 内 `2>&1`） | ✅ |
| 开始时空 update | ✅ | ✅ | ✅ |
| 流式节流 | 100ms（事件驱动） | ~150ms（轮询 `.out`） | ≈ |
| 进程归属 | Node 子进程，随 pi 退出而终止 | tmux server 持有，pi 退出/`/reload` 不影响 | ✏️ 核心卖点 |

---

## §4 结果形状（`content` / `details` / `isError`）

内置 bash 是 `ToolDefinition`，`execute` **成功返回、失败抛错**，由 `wrapToolDefinition` 把抛出的
`Error` 转成 `isError` 结果。本插件完全自管 `execute`，**改为直接 `return` 一个 `isError:true`
结果**（仅把 tmux 建窗口失败等「基础设施异常」抛给 `index.ts` 的 catch 兜底）。最终交给模型的
`content` 文案仍力求与内置一致。

内置成功结果：

```ts
{ content: [{ type: "text", text: outputText }],
  details: truncated ? { truncation, fullOutputPath } : undefined }
```

- `outputText = snapshot.content || "(no output)"`；截断时追加 footer（见 §5）。
- pi 的 `AgentToolResult<T>` 要求 `details` 字段**必须存在**（可为 `undefined`）——本插件所有返回
  路径均带 `details`（见 `runtime.ts` 的 `ToolTextResult`，`details` 为必填）。

本插件结果 `details` 形状（自定义，非逐字复刻内置的 `truncation` 对象）：

```ts
{ exitCode, outputFile, truncated, durationMs }        // 前台完成 / 错误
{ jobId, windowId, outputFile, backgrounded: true }    // 自动转后台 / background:true
```

| 项 | 内置 | 本插件 | 状态 |
|---|---|---|---|
| 空输出占位 | `"(no output)"` | `"(no output)"` | ✅ |
| 成功 `content` 为纯输出 | ✅ | ✅ | ✅ |
| `details` 结构 | `{ truncation, fullOutputPath }` | `{ exitCode, outputFile, truncated, durationMs }` 等 | ✏️ |
| 失败经由 | 抛错→`wrapToolDefinition` | 直接 `return isError` | ✏️ 文案对齐、机制不同 |

---

## §5 截断（truncation）

内置：走 `OutputAccumulator` + `truncateTail`（尾部截断，保留最后 2000 行 / 50KB）。截断时按
`TruncationResult` 生成 footer，三种文案逐字如下（`{path}` = 落盘的完整输出临时文件）：

- `lastLinePartial`：
  `\n\n[Showing last {size} of line {endLine} (line is {lastLineSize}). Full output: {path}]`
- `truncatedBy === "lines"`：
  `\n\n[Showing lines {startLine}-{endLine} of {totalLines}. Full output: {path}]`
- `truncatedBy === "bytes"`：
  `\n\n[Showing lines {startLine}-{endLine} of {totalLines} ({50KB} limit). Full output: {path}]`

本插件：同样用 `truncateTail(raw, { maxLines, maxBytes })`（默认沿用 pi 的 2000/50KB，可用
`PI_TMUX_BASH_MAX_LINES/MAX_BYTES` 覆盖），但 footer 用**简化文案**：

```
\n\n[output truncated; full log: {outputFile}]
```

| 项 | 内置 | 本插件 | 状态 |
|---|---|---|---|
| 截断算法 | `truncateTail`（尾部，2000 行/50KB） | 同 | ✅ |
| 完整输出落盘 | 临时文件 | 任务 `.out` 文件（更持久，可 attach 复看） | ✏️ |
| footer 文案 | 三态、逐字（见上） | 单一简化文案 | ≈ **未逐字对齐（见 §8 TODO）** |

---

## §6 错误文案

内置用 `appendStatus(text, status) = \`${text ? text+"\n\n" : ""}${status}\`` 拼接输出与状态行，
然后**抛出** `new Error(...)`。三类：

| 场景 | 内置状态行（逐字） | 内置退出码语义 |
|---|---|---|
| 非零退出 | `Command exited with code {N}` | 子进程真实退出码 |
| 用户中断（abort） | `Command aborted` | 抛 `aborted` |
| 超时 | `Command timed out after {timeout} seconds` | 到点 `killProcessTree`，抛 `timeout:{timeout}` |

`timeout` 参数校验（`resolveTimeoutMs`）：非有限或 `<=0` → `Invalid timeout: must be a finite
number of seconds`；超过 `2^31-1` 毫秒 → `Invalid timeout: maximum is {N} seconds`。

本插件（`runtime.ts` `buildFinalResult` + `runForegroundBash`）——文案对齐，但**返回**而非抛出，
且退出码用哨兵约定值：

| 场景 | 本插件 `content` 末尾状态行 | `details.exitCode` | 状态 |
|---|---|---|---|
| 非零退出 | `Command exited with code {N}` | 真实退出码 | ✅ 文案逐字 |
| 用户中断 | `Command aborted` | `130` | ✅ 文案逐字（退出码为约定值） |
| 显式 timeout | `Command timed out after {timeout} seconds` | `124` | ✅ 文案逐字（内置不固定 124，本插件固定 124） |

差异说明：
- 内置超时直接杀进程（退出码由信号决定）；本插件超时是「硬杀 tmux 窗口 + 固定退出码 124」，
  并**不转后台**（保留内置「显式 timeout=硬边界」的直觉）。
- `timeout` 的边界校验本插件目前**未复刻**（非法值会被 `Number.isFinite/>0` 判断静默当作
  「未设置」处理，即退回前台等待+自动转后台），见 §8 TODO。

---

## §7 本插件的偏离与扩展点 —— `index.ts` 引用点

这是相对内置 bash **有意为之**的行为差异，也是本插件存在的理由：

1. **`background:true`（新增参数）**：立即在后台 tmux 窗口启动、立刻返回 `windowId`，不等待；
   完成时经 `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })` 自动通知模型。
   适合 dev server / watcher / 长构建。
2. **未设 `timeout` = 前台等待 + 自动转后台**：前台同步等 `PI_TMUX_BASH_FOREGROUND_TIMEOUT`
   秒（默认 120s，`config.ts` 的 `foregroundTimeoutMs`）。命令在此窗口内结束 → 返回最终结果
   （形状对齐内置，见 §4/§5/§6）；超过等待窗口仍未结束 → **不杀**，登记为后台 job 交给
   `fs.watch` 监听，返回一条「moved to background」提示，完成后 followUp 通知。**模型无需轮询。**
3. **设 `timeout` = 硬杀，退出码 124，不转后台**（见 §6）。
4. **`bg` 管理工具（新增）**：`action=list/logs/kill` 管理「自动转后台 / `background:true`」的任务
   （合并了早期 skeleton 的 `bg_start/bg_logs/bg_list/bg_kill`）。
5. **进程生命周期**：命令交给 tmux server 持有，`session_shutdown` 故意不杀窗口/会话——后台任务
   在 pi 退出/`/reload` 后继续存活（`cleanup` 只关 watcher、清内存 job 表）。
6. **`bash -n` 语法预检（新增，有意偏离）**：内置 bash 直接把命令交给 bash 运行，语法错误由
   bash 自己报（stderr + 退出码 2）；本插件的命令嵌在 wrapper 脚本里跑，若不预检，解析失败会
   表现为「窗口秒死 + 错误不可见 + 哨兵永不出现」。预检失败时文案对齐内置（stderr 正文 +
   `Command exited with code 2`），并附加「命令未启动、无副作用」与本机 bash 版本注记；
   `details` 多一个 `syntaxCheckFailed: true`。背景：macOS 系统 bash 3.2 的 $(…) 扫描器会把
   heredoc 正文里的撚号误判为未闭合引号。
7. **窗口死亡检测（新增）**：前台等待循环约每秒探测一次窗口存活（`windowExists`）；窗口未写
   哨兵就消失时（wrapper 崩溃 / 外部 kill / tmux server 挂掉）立即以 isError 返回，状态行为
   `Command's tmux window … disappeared without recording an exit code …`，`details.exitCode: -1`
   （约定值，区别于 124/130）；检测到死亡后先留 200ms 复查哨兵，消除「刚写完哨兵就关窗」的
   竞态。内置 bash 无对应场景（Node 自持子进程，进程死亡即 close 事件）。

竞态处理：自动转后台的切换点先 `state.jobs.set(...)` 登记再复查哨兵文件，消除「恰在切换瞬间
完成」导致 `fs.watch` 漏发通知的窗口（见 `runForegroundBash`）。

---

## §8 尚未对齐 / 待办（TODO）

- [ ] **截断 footer 未逐字对齐**（§5）：内置有三态 `[Showing lines X-Y of Z ...]` 文案，本插件
      只用 `[output truncated; full log: ...]`。可基于 `truncateTail` 返回的 `TruncationResult`
      （`totalLines/outputLines/truncatedBy/lastLinePartial`）复刻三态文案。
- [ ] **`timeout` 边界校验未复刻**（§6）：内置对非法/超大 `timeout` 抛明确错误，本插件目前静默
      当作未设置。可加 `resolveTimeoutMs` 等价校验并返回对应 isError 文案。
- [ ] **`details` 结构与内置不同**（§4）：内置暴露 `{ truncation, fullOutputPath }`，本插件用
      `{ exitCode, outputFile, truncated, durationMs }`。若有下游依赖内置 details 形状，需再对齐。
- [ ] **跨 `/reload` 不恢复 job 表**：reload 前启动的任务完成时不再自动通知（任务仍在 tmux 里跑，
      可 `bg action=list` 或 tmux 手动查）。可在 `session_start` 扫描 runDir + 窗口标签重建 job 表。
- [ ] **后台 job 的窗口死亡检测**：前台循环已检测（§7.7），但转后台/`background:true` 后只靠
      哨兵文件——被外部 `kill-window` 的后台任务不会发完成通知，job 表残留计数（经本插件
      `bg action=kill` 的会正确标记 done）。可在 watcher 侧加周期性存活巡检。
- [ ] **流式为轮询而非事件驱动**（§3）：`.out` 每 ~150ms 轮询一次；量大/低延迟场景可评估用
      `tail -f` 或 `capture-pane` 事件化。

> 维护提醒：本文件的「✅ 逐字对齐」条目直接依赖 pi 内置 bash 的实现细节。每次升级 pi 后，按
> 顶部「复核方法」比对 `bash.js`，同步更新本清单与 `runtime.ts` 的对应文案。
