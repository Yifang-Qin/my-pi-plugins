# tmux-bash

用 tmux 后台化**覆盖 pi 内置 `bash` 工具**：命令始终在 detached 的 tmux 窗口里跑，execute
前台同步等待并「流式转发」输出；未在前台等待窗口（默认 120s）内结束则**自动转后台**（不杀命令），
完成后经 followUp 通知模型。另附一个 `bg` 工具管理这些后台任务。

> 进程交给 tmux server 持有，pi 的 `/reload`、切换会话、崩溃、退出都不影响后台任务。
> 覆盖内置 bash 时逐条对齐其结果/错误文案/截断等「形状」，权威清单见同目录
> [`BUILTIN-BASH-REFERENCE.md`](./BUILTIN-BASH-REFERENCE.md)。

## 行为一览

| 调用方式 | 行为 |
|---|---|
| `bash { command }`（默认） | 前台流式等待；跑满前台窗口（默认 120s）仍未结束则**自动转后台**（不杀），完成后自动通知 |
| `bash { command, timeout: N }` | 保留内置「硬超时」语义：到点**硬杀**命令，退出码 124，**不转后台** |
| `bash { command, background: true }` | **立即分离**，不等待（dev server / watcher / 长构建等），完成后自动通知 |
| `bg { action, window, lines }` | 管理后台任务：`list` 列出、`logs` 读尾部输出（快照，不阻塞）、`kill` 按 `window_id` 终止 |

- 命令完成（无论自动转后台还是 `background:true`）会收到一条 `⏻ background bash` 消息
  （自定义渲染），含退出码、耗时、输出尾部与完整日志路径。
- 结果末尾附**彩色状态行**（`✓ done · 1.2s` / `✗ exit 1` / `✗ timeout` / `✗ aborted` /
  `⧉ running in background`，合并自原独立扩展 `bash-status-line`）。

## 为什么这么设计

- **覆盖内置 `bash`（而非另起 `bg_*` 工具）**：让「长命令自动转后台」成为默认路径，模型无需
  学新工具、也不会两套 bash 并存。代价是要严格对齐内置 bash 的结果/错误/截断形状，pi 升级
  后须复核（见 `BUILTIN-BASH-REFERENCE.md` 顶部的版本与复核方法）。
- **进程交给 tmux server 持有**：Node 侧不 hold 子进程，`/reload`、切换会话、崩溃、退出都不
  影响后台任务。这是相对「扩展内 `spawn(detached)` 自管进程」最大的优势。
- **哨兵退出码文件 + `.out` 输出文件**：把「是否完成」和「输出内容」都落盘，和进程句柄解耦：
  - 完成检测走 `fs.watch(runDir)` 监听哨兵文件；
  - 日志读取优先读 `.out`，读不到再 `tmux capture-pane` 兜底；
  - 用 `tee -a` + `${PIPESTATUS[0]}` 拿到准确退出码。
- **完成通知走官方 API**：`pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`，
  等 Agent 空闲再投递并唤醒，无需模型轮询。通知内容包一层 `<background-task-notification>`
  自描述框（协议在 `../shared/bg-notify.ts` 的 `makeBgNotifyFramer`，与 afang-subagent 共享；
  `config.ts` 只定制引言文案），防止被降级成 `role:"user"` 后被模型误当成用户新指令；UI 渲染时
  用 `stripBgNotifyFrame` 剥掉框。
- **工作目录用 `ctx.cwd`**：不强制在 git 仓库内。
- **tmux 调用全用 `execFileSync` 数组参数**：不拼 shell 字符串，从根上避开引号/空格问题。

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
├── README.md
└── BUILTIN-BASH-REFERENCE.md   覆盖内置 bash 的逐条对齐/偏离清单（pi 升级后须复核）
```

## tmux 后台化怎么实现的（简述）

每个任务写一个一次性 wrapper `.sh`，交给 `tmux new-window -a -d -PF '#{window_id}'` 运行：

```bash
( <用户命令> ) 2>&1 | tee -a "$out_file"   # 输出实时落盘
rc=${PIPESTATUS[0]}                         # 取真实退出码
printf '%s\n' "$rc" > "$exit_file.tmp"      # 先写 .tmp
mv -f "$exit_file.tmp" "$exit_file"         # 原子出现，fs.watch 才看到完整哨兵
exec "${SHELL:-/bin/bash}" -l               # 命令结束后窗口保活，可 attach
```

- **前台路径**（`runForegroundBash`）：建窗口后轮询 `.out`（流式 `onUpdate`）+ 哨兵文件；
  完成 → 返回最终结果；显式 `timeout` 到点 → 杀窗口返回退出码 124；跑满前台窗口 → 登记 job
  转后台（先登记再复查哨兵，消除切换瞬间完成的漏通知竞态）。
- **后台路径**：Node 侧生成脚本 → 建窗口拿到 `@id` → 打窗口标签登记 job →
  `fs.watch(runDir)` 等哨兵文件出现 → 读退出码 + `.out` → `pi.sendMessage` 唤醒模型。

## 已知限制 / TODO

- **跨 `/reload` 不恢复 job 表**：reload 后内存里的 job 映射会清空，reload 前启动的任务完成时
  不会再自动通知（任务本身仍在 tmux 里跑，可用 `bg action=list` / `tmux` 手动查）。后续可在
  `session_start` 扫描 runDir + 窗口标签重建 job 表。
- **转后台的任务不会自动回收**：自动转后台/`background:true` 的命令除非手动 `bg action=kill`
  否则会一直保活占资源（这是相对旧 `bash-default-timeout`「120s 硬杀跑飞命令」的行为反转）。
- **共享会话的占位窗口**：首次会建一个 `pi-bg` 占位 shell 窗口保证会话存活；`bg action=list`
  已按标签过滤掉它。`session_shutdown` 故意不杀窗口/会话（任务要能在 pi 退出后继续）。
- `execFileSync` 同步调用 tmux、`fs.watch` 跨平台可靠性等，量大时可考虑加兜底轮询。

## 本地开发

真身在本仓库 `extensions/tmux-bash/`，通过软链接挂到 `~/.pi/agent/extensions/tmux-bash`，
改完 `/reload` 生效（见仓库根 `AGENTS.md`）。
