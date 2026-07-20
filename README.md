# my-pi-plugins

个人 [pi](https://pi.dev) coding-agent 配置，做成一个原生 pi package，用 `pi install` / `pi remove` 直接安装卸载。

## 包含内容

| 类型 | 文件 | 说明 |
|---|---|---|
| Extension | `extensions/bash-default-timeout.ts` | 给模型发起的 bash 调用补默认超时（默认 120s，`PI_BASH_DEFAULT_TIMEOUT` 可覆盖） |
| Extension | `extensions/fuzzy-at-files.ts` | 把编辑器 `@` 文件补全换成 codex 风格子序列模糊匹配（`@patf` 命中 `path/to/file`，大小写不敏感，无需逐层写全目录） |
| Extension | `extensions/fuzzy-file-finder/` | （多文件子目录扩展）fzf/telescope 风格文件选择器。在编辑器里于**词首打 `@`** 自动在编辑器位置就地打开（拦截内置内联下拉；不用 overlay 模式，避免与 pi-powerline-footer fixed editor 冲突导致全屏重印），也可用 `/find-file` 命令；选中后插入 `@path`（目录插入 `@dir/`）。空搜索框=目录树浏览（→/← 展开折叠、tab 选目录），打字=全库模糊列表（目录带 `/` 后缀一起匹配） |
| Extension | `extensions/tree-nav/` | （多文件子目录扩展）lazygit 风格会话树导航器。命令 `/nav` 弹大 overlay，以 user 轮次为一等公民、左侧分支泳道，enter 跳转（跳前可选 summarize 被放弃分支），中间 assistant/tool 节点折叠可展开；打字即在 user 轮次里搜索 |
| Extension | `extensions/afang-subagent/` | （多文件子目录扩展）fork 自 pi 官方 subagent 示例、自维护演进。注册 `subagent` 工具把任务委派给独立 pi 子进程（上下文隔离），支持 single / parallel / chain 三模式；`background: true` 后台异步执行——完成时 followUp 通知（防抖合并）、结果落盘 `<任务cwd>/.pi/subagent-results/<时间戳>-task-N-<agent>-<topic>.md`；配套 `subagent_tasks` 工具（list / status / result / cancel）。agent 未指定 model 时继承主会话当前模型 |
| Extension | `extensions/todo.ts` | （fork 自 pi 官方 todo 示例、自维护演进）三态任务清单。注册 `todo` 工具给 LLM（`list` / `add` / `set`+`status` / `clear`），状态存于工具结果 `details`（随对话分支自动正确、`/reload` 兼容历史旧数据）；editor 上方常驻 widget 显示三段式进度条（`█` 完成 / `▓` 进行中·浅灰 / `░` 未开始）与三态图标（`○` pending / `◼` in_progress / `✓` completed）；`/todos` 命令弹窗查看当前分支清单 |
| Theme | `themes/gruvbox-dark.json` | gruvbox 深色主题 |

`package.json` 里的 `pi` manifest 声明了上述资源，pi 安装本包时自动加载。

> **注意**：`afang-subagent` 依赖的 **agent 定义**（`agents/*.md`）与 **workflow prompt**（`prompts/*.md`）不是 pi package 的资源类型，不会随包自动安装。扩展本体安装即生效，但 agent 需自行放置：用户级放 `~/.pi/agent/agents/`，项目级放 `.pi/agents/`——仓库 `extensions/afang-subagent/agents/` 下的 4 个样例（scout / planner / reviewer / worker）可直接拷贝；workflow prompt 拷到 `~/.pi/agent/prompts/` 后以 `/implement` 等形式使用。详见 `extensions/afang-subagent/README.md`。

## 安装

```bash
pi install https://github.com/Yifang-Qin/my-pi-plugins
```

安装后：
- **扩展自动生效**：bash 默认超时、`@` 模糊文件补全等扩展安装后立即起作用，无需其它操作。
- **主题需选一次**：安装只是让 `gruvbox-dark` 出现在可选列表里，激活运行一次
  `/theme gruvbox-dark`（或在 `~/.pi/agent/settings.json` 里设 `"theme": "gruvbox-dark"`）。
  这是 pi 的机制——package 不能替用户强行选主题。

## 新机器 Step by Step（只配插件与个性化，不含模型/key）

1. **装 pi 本体**（见[官方文档](https://pi.dev)），可选外部依赖按需装：
   `fd`（fuzzy-file-finder 加速，缺了会回退 `git ls-files`）、
   `ffmpeg` + `yt-dlp`（pi-web-access 视频抽帧）。
   macOS 用 `brew install fd ffmpeg yt-dlp`，Linux 用对应包管理器（如 `apt install fd-find`）。
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

