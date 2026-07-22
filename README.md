# my-pi-plugins

个人 [pi](https://pi.dev) coding-agent 配置，做成一个原生 pi package，用 `pi install` / `pi remove` 直接安装卸载。

## 📦 包含内容

| 名称 | 类型 | 一句话定位 | 关键能力 |
|---|---|---|---|
| 🧩 `tmux-bash` | Extension | 用 tmux 后台化覆盖内置 bash，长命令不再卡 | 子目录扩展 · 三种使用模式 · 配套 `bg` 工具 · 彩色状态行 |
| 📂 `fuzzy-file-finder` | Extension | 接管 `@` 的全部交互：目录树浏览 + 全库模糊补全 | 原地弹窗 · 目录/文件统一匹配 · 已吸收 `fuzzy-at-files.ts` · `fd` 加速 |
| 🌳 `tree-nav` | Extension | lazygit 风格会话树导航，user 轮次分支一目了然 | `/nav` 弹大 overlay · enter 跳转 · 打字搜索 · 跳前可选 summarize |
| 🤖 `afang-subagent` | Extension | 把任务委派给独立 pi 子进程（上下文隔离） | single/parallel/chain · `background:true` 异步 · `subagent_tasks` 工具 · 自包含 agent+prompt |
| ✅ `todo` | Extension | 三态任务清单 + editor 上方常驻进度条 widget | `list`/`add`/`set`/`clear` · 随对话分支自动正确 · `/todos` 弹窗 |
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

fork 自 pi 官方 todo 示例、自维护演进。三态任务清单，**editor 上方常驻 widget 显示三段式进度**，一眼看出还剩多少。

- 注册 `todo` 工具给 LLM（`list` / `add` / `set`+`status` / `clear`）；状态存于工具结果 `details`，**随对话分支自动正确**，`/reload` 兼容历史旧数据
- editor 上方 widget：三段式进度条 `█`（完成）/ `▓`（进行中·浅灰）/ `░`（未开始） + 三态图标 `○`（pending）/ `◼`（in_progress）/ `✓`（completed）
- `/todos` 命令弹窗查看当前分支清单

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

4. **个性化设置**：在 `~/.pi/agent/settings.json` 里加（或直接用 `/theme gruvbox-dark` 选主题）：

   ```json
   {
     "theme": "gruvbox-dark",
     "powerline": { "preset": "default", "fixedEditor": true, "placement": "above" }
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
