# my-pi-plugins

个人 [pi](https://pi.dev) coding-agent 配置，做成一个原生 pi package，用 `pi install` / `pi remove` 直接安装卸载。

## 📦 包含内容

| 名称 | 类型 | 一句话定位 | 关键能力 |
|---|---|---|---|
| 🧩 `tmux-bash` | Extension | 用 tmux 后台化覆盖内置 bash，长命令不再卡 | 子目录扩展 · 三种使用模式 · 配套 `bg` 工具 · 彩色状态行 |
| 📂 `fuzzy-file-finder` | Extension | 接管 `@` 的全部交互：目录树浏览 + 全库模糊补全 | 原地弹窗 · 目录/文件统一匹配 · 已吸收 `fuzzy-at-files.ts` · `fd` 加速 |
| 🌳 `tree-nav` | Extension | lazygit 风格会话树导航，user 轮次分支一目了然 | `/nav` 弹大 overlay · enter 跳转 · 打字搜索 · 跳前可选 summarize |
| 🤖 `afang-subagent` | Extension | 把任务委派给独立 pi 子进程（上下文隔离） | single/parallel/chain · `background:true` 异步 · `subagent_tasks` 工具 · 自包含 agent+prompt |
| ✅ `todo` | Extension | phase → task 分层计划 + editor 上方常驻进度 widget | 批量初始化/追加 · 五态任务 · 自动推进 · 分支恢复 · 复选框树形渲染 · `/todos` 全量查看 |
| 🎨 `gruvbox-dark` | Theme | gruvbox 经典深色暖色调主题 | 高对比 · 长会话不疲劳 · 搭配 powerline 状态栏效果最佳 |

`package.json` 里的 `pi` manifest 声明了上述资源，pi 安装本包时自动加载。

## 详细介绍

### 🧩 tmux-bash

覆盖 pi 内置 bash：把长命令丢到 detached tmux 窗口跑，**前台流式转发输出**，不再被内置 bash 的同步等待卡住。

- **三种使用模式**：不设 `timeout` 时前台等 ~120s（`PI_TMUX_BASH_FOREGROUND_TIMEOUT` 可覆盖）未结束**自动转后台**（**不杀命令**），完成后自动通知；显式 `timeout` 到点硬杀（退出码 **124**，不转后台）；`background:true` 立即分离
- 配套 `bg` 工具（`list` / `logs` / `kill`）管理后台任务；结果末尾附彩色状态行 `✓ done · 1.2s` / `✗ exit 1`
- 进程交给 tmux server 持有，pi 重启 / `/reload` / 退出都不影响后台任务
- **依赖系统安装 `tmux`**（缺了 bash 工具会直接报不可用）

### 📂 fuzzy-file-finder

fzf / telescope 风格的文件选择器，**接管编辑器里 `@` 的全部交互**。

- **词首裸 `@`**：在光标位置就地打开选择器（**不用 overlay 模式**，避免与 pi-powerline-footer fixed editor 冲突导致全屏重印）；也可走 `/find-file` 命令
- **空搜索框=目录树浏览**（`→` / `←` 展开折叠、`tab` 选目录）；**打字=全库模糊列表**（目录带 `/` 后缀一起匹配）；选中插入 `@path`，目录插入 `@dir/`
- **`@query`（已打字）** 走 codex 风格子序列模糊内联下拉：例如 `@patf` 命中 `path/to/file`（已吸收原独立扩展 `fuzzy-at-files.ts`）
- 索引全量（`--no-ignore`），但写死排除 `node_modules` / `.git` / `.env` 等不会手动引用的路径；加速可装 `fd`（缺了会回退 `git ls-files`）

### 🌳 tree-nav

lazygit 风格会话树导航器：**以 user 轮次为一等公民、左侧分支泳道**展示整个会话结构，方便跳回任意历史分支。

- `/nav` 弹大 overlay，enter 跳转到任意历史 user 轮次（**跳前可选 summarize 被放弃分支**，把岔路压成一段摘要）
- 中间 assistant / tool 节点默认折叠，可展开查看
- 在 user 轮次里打字即搜索

### 🤖 afang-subagent

fork 自 pi 官方 subagent 示例、自维护演进。注册 `subagent` 工具把任务委派给**独立 pi 子进程**（**上下文隔离**，主会话上下文不被污染），配套 `subagent_tasks` 工具（`list` / `status` / `result` / `cancel`）。

- **三种模式**：`single`（单 agent）/ `parallel`（并发多 agent）/ `chain`（前一个结果喂下一个）
- **`background:true` 后台异步**：完成时 followUp 通知（防抖合并），结果落盘 `<任务cwd>/.pi/subagent-results/<时间戳>-task-N-<agent>-<topic>.md`
- agent 未指定 model 时**继承主会话当前模型**
- **自包含 agent + prompt**：内建 agent 定义（`scout` / `planner` / `reviewer` / `worker`，扩展从自身 `agents/` 目录发现）与 workflow prompt（`/implement` / `/scout-and-plan` / `/implement-and-review`，`prompts/` 目录经 `resources_discover` 自动注册）都随扩展自包含加载，`pi install` 后开箱即用，无需拷贝或软链接任何文件
- 想覆盖内建 agent 行为，在 `~/.pi/agent/agents/` 或项目 `.pi/agents/`（配 `agentScope: "both"`）放同名 `.md` 即可（**优先级 builtin < user < project**）；详见 `extensions/afang-subagent/README.md`

### ✅ todo

fork 自 pi 官方 todo 示例、自维护演进。任务按 **phase → task 两层**组织，phase 的进度由子任务推导；editor 上方常驻 widget 展示当前计划。

- **批量规划**：`init` 一次替换整份计划；单 phase 计划也可以扁平写成 `items: [...]`（可选带 `phase` 指定名字，缺失时为 `Tasks`）—— 模型常见写法，自动合成而不逼它重试。`append` 批量追加到某个 phase，缺失时创建该 phase。
- **五种状态**：`○ pending` / `◼ in_progress` / `✓ completed` / `− abandoned` / `! blocked`。阻塞可以记录 `reason`；已完成或放弃的任务不会被 phase 级 `block` 重新打开。
- **自动推进**：成功修改后，全清单最多一项 `in_progress`；没有进行中项时，按 phase/task 顺序启动首个 pending，跳过 blocked。`done` 后一般无需再调用 `start`。
- **稳定 ID 和原子操作**：用回执里的数字 ID 定位任务，或用 phase 名定位整组；当前分支内 `init` / `clear` / `rm` 都不复用 ID。一次操作校验失败就整体丢弃，ID 也不会消耗。任务文本在同一 phase 内不能重复。
- **恢复与兼容**：完整快照保存在工具结果 `details.phases`，加载会话和切换分支时恢复。旧 `details.todos`（包括 `done` 布尔格式）恢复为默认 `Tasks` phase；旧错误结果不会覆盖有效状态。`view` 只读，不推进指针。
- **渲染（向 omp 对齐）**：任务行用 **ASCII 复选框** `[x]` / `[ ]`，状态靠**颜色 + 删除线**区分—— completed 是 success 色打勾 + 删除线，abandoned 是 error 色空框 + 删除线，in_progress 是 accent 色空框（**不换符号**，所以纵向扫视时方框列对齐），blocked 是 warning 色空框 + `(blocked: 理由)`，pending 变暗。任务按**树形连接线** `├─` / `└─` 挂在 phase 下，「还有 N 条」就是最后那个 `└─` 行。phase 头是「编号 + 名称 + ` · closed/total`」，活跃阶段加粗 accent、其余 muted，**不放状态图标**；**单 phase 时不显示 phase 头**（扁平 init 产生的 `Tasks` 不再多一行废话）。保留与 omp 不同的两点：用阿拉伯数字而非罗马数字（中文语境更直观、宽度稳定），以及**显示任务 ID** `#4`（omp 按原文定位所以没 ID，我们有，显示出来便于对话里指代）。
- **折叠预览的「行走窗口」**：末尾的已关闭任务领头（额外加、不占未完成配额），从当前任务往后铺至 8 条，`… N more tasks` 只数没装下的**未完成**项。这样即使乱序完成，也总有一行打勾行可见。与 omp 的唯一偏离：窗口没铺满时（当前任务靠末尾）向前多拉几条已关闭任务填满，比留空白有信息量。
- **显示层次**：widget 和折叠回执展开当前 phase、最近操作涉及的 phase（以及无活跃任务但有 blocked 的 phase）；其余 phase 只留一行头。`completed + abandoned` 计为 closed，blocked 单独统计。`/todos` 支持方向键、PgUp/PgDn 滚动查看完整清单，展开工具结果也可查看全部任务。三处渲染（widget / 工具结果 / `/todos`）**共用同一套 `taskLine` 与 `treeLines`**，不会出现两边对不上的情况。
- **模型上下文（三处注入，全部只是告知，不干预控制流）**：工具结果**始终全展开**分层快照（总体进度 + 当前任务 + 完整 phase 树），它是状态的**唯一权威载体**。
  - `before_agent_start`：静态 `todo_guide` + 紧凑的 `todo_state`（一行计数 + 当前任务，约 30 token，详情让模型自己 `view`）。轮开头一定看得见未完成计划，但不把全量清单每轮重述。每个 user prompt 触发一次（跟工具调用次数无关）。
  - **eager prelude**：清单为空且是会话**首条** user 消息时，注入一条隐藏建议（先用一次 `init` 铺好分阶段计划）。以 `?` / `？` / `!` / `！` 结尾的 prompt 是提问而非派活，不推；已有清单改走 `todo_state`，两者天然互斥、不重复施压。只对齐 omp 的 `preferred` 档位（建议、不强制）—— pi 没有强制 `tool_choice` 的接口，而且 pi 把 handler 消息放在 user 消息**之后**（omp 是之前）。
  - `session_compact`：压缩会把**承载计划的工具结果**摘要掉，而 `before_agent_start` 只在 user prompt 时触发、补不上自动续跑那个窗口。所以当场补一条：有计划补状态摘要，没计划重申 eager。同样用 `triggerTurn: false`，不自己拉起一轮。
  - `turn_end`：**mid-run nudge**，按「修改类工具」（`bash`/`edit`/`write` 等，失败不计）调用次数 ≥ 12 触发，每个 user prompt 最多 2 次，任何 `todo` 调用清零计数。内容只有一句「还有 N 项未完成」约 30 token，**不带清单**。读文件/搜索再多也不触发；本轮没调工具（模型正在收工）也跳过。**只追加 `entries`、永不返回 `continue`**。
  - 调用失败时：补一条隐藏提醒（计划未变、用户看不到进度、修正参数后重试）。用 `triggerTurn: false` 而非 `deliverAs: "nextTurn"` —— 后者在 pi 里要等到下个 user prompt 才投递，对 mid-run 失败太晩。
- **刻意不做控制流干预**：不因「还有 todo 未完成」而拦住收工，何时结束完全由模型自己定。曾按 omp 的 `checkCompletion` 做过 `agent_before_settle` 拦截 + 自动续跑（带 blocked 豁免、次数上限、子 agent 禁用等六个出口），实测后**整体撑销**：它必须先判断「模型是不是在等用户回答」，而这只能靠关键词/正则启发式；漏判的后果是强行续跑、让模型替用户做决定——错在危险方向。实测反例：「要麻烦你确认一下…」不带「请」也不以问号结尾，就被漏判。自然语言里「我在等你」的说法无穷，补正则是打地鼠，**不要再尝试**。

模型可见参数为 `action` 加可选 `phases` / `items` / `id` / `phase` / `reason`，不再声明旧的 `add` / `set` / `list` 操作；历史调用仍可恢复、渲染。

| action | 参数 | 作用 |
|---|---|---|
| `init` | `phases: [{name, items: string[]}]`，或扁平 `items` (+可选 `phase`) | 替换计划；`phases: []` 清空 | 
| `append` | `phase`, `items: string[]` | 追加一批任务 |
| `start` | `id` | 指定当前任务，原进行中项回到 pending；也可重新打开已关闭任务 |
| `done` / `drop` | `id` 或 `phase`，都不传则作用于全部 | 完成 / 放弃 |
| `block` / `unblock` | 必须传 `id` 或 `phase`；`block` 可带 `reason` | 阻塞 / 解除阻塞（随后照常自动推进） |
| `rm` | `id` 或 `phase`，都不传则删除全部 | 删除目标任务及空 phase |
| `view` / `clear` | 无 | 查看完整计划 / 清空整份计划 |

**参数宽容度**：不适用于当前 action 的字段一律忽略（如 `done` 带 `reason`、`view` 带 `items`），只有三类「目标歧义」会报错：`done`/`drop`/`block`/`unblock`/`rm` 同时传 `id` 和 `phase`；`clear` 带了目标（会提示改用 `rm`，避免误清整份计划）；`start` 没有 `id`（`phase` 对 `start` 无效，不会静默命中整组任务）。任务/phase 名和 blocker 会清理 ANSI、折叠空白为单行。

```json
{"action":"init","phases":[{"name":"调研","items":["核对接口","确认边界"]},{"name":"实现","items":["完成改动","验证行为"]}]}
```

新会话中上述任务分配 `#1`–`#4`，`#1` 自动开始；`{"action":"done","id":1}` 会推进到 `#2`。实际操作以最新回执中的 ID 为准。复用旧会话或重新规划时 ID 会继续增长。

状态与集成测试：`bun test tests/todo.test.ts`（需要本机 pi 类型/运行时包可解析）。

- **与 `pi-powerline-footer` 的层叠顺序**：`aboveEditor` widget 的上下顺序由「首次 `setWidget` 的插入顺序」决定（同 key 重复 `setWidget` 会被挪到最下面）。本扩展只在 `session_start` 注册一次、之后靠 `requestRender` 刷新内容，因此稳定停在 powerline 状态栏**之上**。
  前提是本扩展比 `pi-powerline-footer` **先收到 `session_start`**，而事件派发顺序 = 扩展加载顺序 = pi 的发现顺序：
  ① 项目级 `.pi/extensions/` → ② 全局 `~/.pi/agent/extensions/` → ③ `settings.json` 的 `packages`（按数组顺序）。
  所以放在 `~/.pi/agent/extensions/`（本仓库的软链接装法）天然早于所有 `packages`，无需额外配置；
  若改用 `pi install` 走 `packages`，则需让 `my-pi-plugins` 排在 `npm:pi-powerline-footer` **之前**。

### 🎨 gruvbox-dark

gruvbox 经典深色 retro 暖色调主题。

- `bg` 深棕、accent 用柔和饱和的 `red` / `yellow` / `green` / `blue` 等
- 高对比、长会话不易疲劳
- 配合 `pi-powerline-footer` 状态栏视觉效果最佳

## 安装

```bash
pi install https://github.com/Yifang-Qin/my-pi-plugins
```

安装后：

- **扩展自动生效**：tmux 后台化 bash、`@` 模糊文件补全等扩展安装后立即起作用，无需其它操作。
- **主题需选一次**：安装只是让 `gruvbox-dark` 出现在可选列表里，激活运行一次
  `/theme gruvbox-dark`（或在 `~/.pi/agent/settings.json` 里设 `"theme": "gruvbox-dark"`）。
  这是 pi 的机制——package 不能替用户强行选主题。

## 新机器 Step by Step（只配插件与个性化，不含模型/key）

1. **装 pi 本体**（见[官方文档](https://pi.dev)），可选外部依赖按需装：
   `tmux`（tmux-bash 后台化必需，缺了 bash 工具会直接报不可用）、
   `fd`（fuzzy-file-finder 加速，缺了会回退 `git ls-files`）、
   `ffmpeg` + `yt-dlp`（pi-web-access 视频抽帧）。
   macOS 用 `brew install tmux fd ffmpeg yt-dlp`，Linux 用对应包管理器（如 `apt install tmux fd-find`）。
2. **装本配置包**

   ```bash
   pi install https://github.com/Yifang-Qin/my-pi-plugins
   ```

3. **装配套 npm 包**

   ```bash
   pi install npm:pi-powerline-footer
   pi install npm:pi-web-access
   ```

   `pi-powerline-footer` 跟随 latest 安装即可（当前 0.19.1，peer `>=0.81.0` 无上界，已在 pi 1.1.0 上验证）。
   旧版曾固定 `pi-powerline-footer@0.7.0` 规避 0.8.0 fixed-editor 在 tmux 下的滚动拖影；该 pin 已解除——它在 pi
   0.84+ 上会因 peer 不兼容导致启动异常，而且 powerline 0.9.0 起已移除自管 fixed-editor，固定输入框
   由 pi 原生 fullscreen（pi 1.0 起默认）负责。背景见 [tmux-bash 兼容性说明](extensions/tmux-bash/README.md#与-pi-powerline-footer-的兼容性)。

4. **个性化设置**：在 `~/.pi/agent/settings.json` 里加（或直接用 `/theme gruvbox-dark` 选主题）：

   ```json
   {
     "theme": "gruvbox-dark",
     "powerline": { "preset": "default", "placement": "above" }
   }
   ```

5. **验证**：启动 pi，敲 `@` 应弹出模糊文件选择器，`/find-file`、`/nav`、`/todos` 命令可用，
   底部出现 powerline 状态栏。

## 卸载

```bash
pi remove https://github.com/Yifang-Qin/my-pi-plugins
```

移除后扩展自动失效；若之前选中了本主题，pi 会自动回退到默认主题。

## 安装原理

pi 是「**登记引用 + 启动时按引用加载**」，不会把整个仓库拷进 `~/.pi`：

- `pi install https://...`（或 `git:...`）把仓库 clone 到 `~/.pi/agent/git/<host>/<path>/`，
  并在 `~/.pi/agent/settings.json` 的 `packages` 数组里登记一条引用。
- 启动时 pi 读 `packages[]`，按每个包的 `pi` manifest 加载 `extensions/*.ts` 和
  `themes/*.json`。扩展默认启用，主题加入可选列表。
- `pi remove` 只删掉 `packages` 里的引用，不会在 `~/.pi` 留下散落文件。

用 `pi config` 可单独启用/禁用某个扩展或主题；用 `pi update --extensions` 更新已装包。
