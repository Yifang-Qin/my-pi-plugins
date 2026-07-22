# tmux-bash

用 tmux 后台化**覆盖 pi 内置 `bash` 工具**：命令始终在 detached 的 tmux 窗口里跑，execute
前台同步等待并「流式转发」输出；未在前台等待窗口（默认 120s）内结束则**自动转后台**（不杀命令），
完成后经 steer 通知模型（若 Agent 正忙，则在当前 assistant 消息的工具全部结束后、下一次 LLM
调用前投递）。另附一个 `bg` 工具管理这些后台任务。

> 进程交给 tmux server 持有：pi 运行期间的 `/reload`、切换会话、意外崩溃都不会中断后台任务
> （也不占 Node 事件循环）。正常退出（quit）时插件会回收本会话的磁盘产物——**后台任务的受管
> 生命周期即到 pi 退出 / reload 为止**（详见「产物权限与回收」）。
> 覆盖内置 bash 时逐条对齐其结果/错误文案/截断等「形状」，权威清单见同目录
> [`BUILTIN-BASH-REFERENCE.md`](./BUILTIN-BASH-REFERENCE.md)。

## 行为一览

| 调用方式 | 行为 |
|---|---|
| `bash { command }`（默认） | 前台流式等待；跑满前台窗口（默认 120s）仍未结束则**自动转后台**（不杀），完成后自动通知 |
| `bash { command, timeout: N }` | 保留内置「硬超时」语义：到点**硬杀**命令，退出码 124，**不转后台** |
| `bash { command, background: true }` | **立即分离**，不等待（dev server / watcher / 长构建等），完成后自动通知 |
| `bg { action, window, lines }` | 管理后台任务：`list` 列出运行中及本 runtime 已完成/已终止任务并显示状态、`logs` 按需读取尾部输出（快照，不阻塞，禁止用作轮询等待）、`kill` 按 `window_id` 终止 |

- 命令完成（无论自动转后台还是 `background:true`）会收到一条 `⏻ background bash` 消息
  （自定义渲染），含退出码、耗时、输出尾部与完整日志路径。
- 工具描述、静态 prompt guideline 与转后台后的返回消息都会明确告诉模型：后台化后**禁止**通过
  `bash sleep`、轮询循环或反复调用 `bg list/logs` 等待完成；只能继续与该任务无关的有效工作，否则应
  立即结束当前 turn。任务完成后，通知会在会话空闲时自动拉起新 turn。
- TUI footer 会显示 `bg: N running`；后台任务自然完成时由 watcher 立即刷新计数，不必等下一次
  `bash` / `bg` 工具调用，也不受完成消息的 steer 投递时机影响。
- `bg action=list` 优先列出活跃任务，并附最近完成/终止状态；内存最多保留 100 条终态历史，单次
  最多输出 50 条任务（命令摘要与总输出均截断），避免任务历史无限撑大上下文和 session。
- 结果末尾附**彩色状态行**（`✓ done · 1.2s` / `✗ exit 1` / `✗ timeout` / `✗ aborted` /
  `⧉ running in background`，合并自原独立扩展 `bash-status-line`）。
- **`bash -n` 语法预检**：建窗口前先对 wrapper 脚本做语法校验，失败立即以 `✗ exit 2`
  返回（报错行号优先相对原始命令，附本机 bash 版本），命令不会启动、无副作用。典型
  诱因：macOS 系统 bash 3.2 的 `$(…)` 扫描器会把 heredoc 正文里的撚号（`don't`）误判为
  未闭合引号——不预检的话窗口会秒死且错误不可见。
- **窗口死亡检测**：前台等待期间约每秒探测一次 tmux 窗口存活；窗口未写退出码哨兵就
  消失（wrapper 崩溃 / 被外部 `kill-window` / tmux server 挂掉）时立即报错返回
  （`details.exitCode: -1`），而不是空等 120s 后把死任务误转后台。

## 为什么这么设计

- **覆盖内置 `bash`（而非另起 `bg_*` 工具）**：让「长命令自动转后台」成为默认路径，模型无需
  学新工具、也不会两套 bash 并存。代价是要严格对齐内置 bash 的结果/错误/截断形状，pi 升级
  后须复核（见 `BUILTIN-BASH-REFERENCE.md` 顶部的版本与复核方法）。
- **进程交给 tmux server 持有**：Node 侧不 hold 子进程，pi 运行期间的 `/reload`、切换会话、意外
  崩溃都不会中断后台任务，也不占 Node 事件循环。这是相对「扩展内 `spawn(detached)` 自管进程」
  最大的优势。注意：正常退出（quit）时插件按会话生命周期回收产物（见「产物权限与回收」），故
  **后台任务的受管生命周期定位为「到 pi 退出 / reload 为止」**——不主动杀 tmux 窗口，但退出后不
  再保证其日志与追踪。
- **哨兵退出码文件 + `.out` 输出文件**：把「是否完成」和「输出内容」都落盘，和进程句柄解耦：
  - 完成检测走 `fs.watch(runDir)` 监听哨兵文件；
  - 日志读取优先读 `.out`，读不到再 `tmux capture-pane` 兜底；
  - 用 `tee -a` + `${PIPESTATUS[0]}` 拿到准确退出码。
- **完成通知走官方 API**：`pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })`。
  Agent 空闲时立即唤醒；Agent 正忙时，通知在当前 assistant 消息的全部工具调用结束后、下一次 LLM
  调用前投递，不会中断正在执行的工具，也不会像 followUp 那样因模型持续 `sleep` / `bg` 轮询而
  长期饥饿。通知内容包一层 `<background-task-notification>` 自描述框（协议在
  `../shared/bg-notify.ts` 的 `makeBgNotifyFramer`，与 afang-subagent 共享；`config.ts` 只定制引言
  文案），防止被降级成 `role:"user"` 后被模型误当成用户新指令；UI 渲染时用
  `stripBgNotifyFrame` 剥掉框。
- **工作目录用 `ctx.cwd`**：不强制在 git 仓库内。
- **tmux 调用全用 `execFileSync` 数组参数**：不拼 shell 字符串，从根上避开引号/空格问题。

## 产物权限与回收

**权限收紧**（wrapper 脚本内联了导出的环境变量，可能含密钥）：

- runDir / scriptDir 目录：`0o700`（仅 owner 可进）。
- wrapper `.sh` 脚本：`0o700`（仅 owner 执行 / `bash -n` 预检读取，不给 group/other）。
- `.out` 输出与退出码哨兵文件：`0o600`。实现上用**子 shell 局部 `umask 077`** 创建这些内部
  文件，**不影响用户命令自己创建的文件**（全局 `umask` 会把用户 `touch` 出来的文件也变 600，
  故意避开）。

**回收**（`session_shutdown` 按 `reason` 分类，前提：后台任务受管生命周期 = pi 进程生命周期）：

| reason | 当前会话 runDir | 说明 |
|---|---|---|
| `quit`（pi 真正退出） | **整个删**（含 `.out`） | 进程一走任务即结束，产物全部回收 |
| `reload` / `new` / `resume` / `fork`（进程仍在） | 只删 scriptDir，**保留 `.out`** | reload 后任务仍在 tmux 里跑、日志仍可 attach 复看；该旧 runDir 会在后续某次 shutdown 作为「本进程遗留的旧 runDir」被回收 |

同时每次 `cleanup` 都会**回收历史会话产物**：扫 `outputDir` 下其它 runDir，按目录名里的创建
`pid` 探活——pid 已死（那个 pi 早退出）或 pid == 本进程（自己遗留的旧 runDir）→ 删；pid 属于
**另一个存活的 pi 实例** → 保留（不误删并存实例）；目录名解析不出 pid → 保守跳过。故意不杀 tmux
窗口/会话（避免粗暴中断），回收的只是插件在磁盘上的临时产物与内存追踪状态。

> 注意：pi 被 `SIGKILL` 强杀不会触发 `session_shutdown`，其残骸留待**下一个** pi 实例启动/退出时
> 由上述历史回收清掉（届时老 pid 已死）。

## 依赖

- 需要 `tmux` 在 `PATH` 中（缺失时 bash / bg 工具直接返回不可用错误；Windows 一般需 WSL）。
- 其余仅用 pi 自带的 `@earendil-works/pi-coding-agent` / `pi-tui` / `typebox`。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PI_TMUX_BASH_TMUX` | `tmux` | tmux 可执行文件 |
| `PI_TMUX_BASH_SESSION` | `pi-bg` | 共享后台会话名（按窗口标签区分 pi 会话归属） |
| `PI_TMUX_BASH_DIR` | `$TMPDIR/pi-tmux-bash` | runDir 根目录（存脚本、`.out`、哨兵文件） |
| `PI_TMUX_BASH_FOREGROUND_TIMEOUT` | `120`（秒） | 前台同步等待窗口；未显式 `timeout` 时跑满此时长仍未结束则自动转后台（不杀） |
| `PI_TMUX_BASH_AUTOCLOSE` | `true` | 命令完成后是否自动关闭 tmux 窗口（`false` 则跑完仍可 attach） |
| `PI_TMUX_BASH_MAX_LINES` | pi 默认（2000） | 读日志保留的最大行数 |
| `PI_TMUX_BASH_MAX_BYTES` | pi 默认（50KB） | 读日志保留的最大字节数 |

## 文件结构

```
tmux-bash/
├── index.ts                    入口：覆盖内置 bash + 注册 bg 工具 + 完成渲染 + session 生命周期
├── runtime.ts                  wrapper 脚本生成、前台同步执行/流式转发/自动转后台、fs.watch 完成监听、日志读取
├── tmux.ts                     tmux 底层封装（execFileSync 数组参数）
├── config.ts                   配置默认值 + 环境变量 + 窗口标签常量 + 通知框引言（协议见 ../shared/bg-notify.ts）
├── test-fixes.ts               功能测试（bash -n 预检 + 窗口死亡检测；bun 运行，用法见文件头）
├── README.md
└── BUILTIN-BASH-REFERENCE.md   覆盖内置 bash 的逐条对齐/偏离清单（pi 升级后须复核）
```

## tmux 后台化怎么实现的（简述）

每个任务写一个一次性 wrapper `.sh`，交给 `tmux new-window -a -d -PF '#{window_id}'` 运行：

```bash
( umask 077; : > "$out_file" )               # 内部文件 0o600（局部 umask，不污染用户命令）
( <用户命令> ) 2>&1 | tee -a "$out_file"   # 输出实时落盘
rc=${PIPESTATUS[0]}                         # 取真实退出码
( umask 077; printf '%s\n' "$rc" > "$exit_file.tmp" )  # 先写 .tmp
mv -f "$exit_file.tmp" "$exit_file"         # 原子出现，fs.watch 才看到完整哨兵
exec "${SHELL:-/bin/bash}" -l               # 命令结束后窗口保活，可 attach
```

- **前台路径**（`runForegroundBash`）：写完脚本先 `bash -n` 预检（语法错误直接返回，不建
  窗口）；建窗口后轮询 `.out`（流式 `onUpdate`）+ 哨兵文件 + 窗口存活（约每秒）；
  完成 → 返回最终结果；窗口未写哨兵就消失 → 立即报错返回；显式 `timeout` 到点 → 杀窗口
  返回退出码 124；跑满前台窗口 → 登记 job 转后台（先登记再复查哨兵，消除切换瞬间完成的
  漏通知竞态）。
- **后台路径**：Node 侧生成脚本 → 建窗口拿到 `@id` → 打窗口标签登记 job →
  `fs.watch(runDir)` 等哨兵文件出现 → 读退出码 + `.out` → 记录 `completed + exitCode` →
  `pi.sendMessage` 以 steer 唤醒模型。完成记录保留在当前 runtime 的 job 表中，因此默认 autoClose
  关闭 tmux 窗口后，`bg action=list` 仍会列出最终状态；`bg action=logs window=@id` 仍可读取日志。

## 已知限制 / TODO

- **跨 `/reload` 不恢复 job 表**：reload 后内存里的 job 映射会清空，reload 前启动的任务完成时
  不会再自动通知（任务本身仍在 tmux 里跑、`.out` 日志仍保留，可用 `bg action=list` / `tmux`
  手动查）。后续可在 `session_start` 扫描 runDir + 窗口标签重建 job 表。
- **转后台的任务不会自动回收**：自动转后台/`background:true` 的命令除非手动 `bg action=kill`
  否则会一直保活占资源（这是相对旧 `bash-default-timeout`「120s 硬杀跑飞命令」的行为反转）。
- **共享会话的占位窗口**：首次会建一个 `pi-bg` 占位 shell 窗口保证会话存活；`bg action=list`
  已按标签过滤掉它。`session_shutdown` 故意不杀窗口/会话（避免粗暴中断在跑的任务），仅回收
  磁盘产物与内存追踪；按定位，后台任务受管生命周期止于 pi 退出 / reload（见「产物权限与回收」）。
- `execFileSync` 同步调用 tmux、`fs.watch` 跨平台可靠性等，量大时可考虑加兜底轮询。

## 本地开发

真身在本仓库 `extensions/tmux-bash/`，通过软链接挂到 `~/.pi/agent/extensions/tmux-bash`，
改完 `/reload` 生效（见仓库根 `AGENTS.md`）。
