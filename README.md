# my-pi-config

个人 [pi](https://pi.dev) coding-agent 配置，做成一个原生 pi package，用 `pi install` / `pi remove` 直接安装卸载。

## 包含内容

| 类型 | 文件 | 说明 |
|---|---|---|
| Extension | `extensions/bash-default-timeout.ts` | 给模型发起的 bash 调用补默认超时（默认 120s，`PI_BASH_DEFAULT_TIMEOUT` 可覆盖） |
| Extension | `extensions/fuzzy-at-files.ts` | 把编辑器 `@` 文件补全换成 codex 风格子序列模糊匹配（`@patf` 命中 `path/to/file`，大小写不敏感，无需逐层写全目录） |
| Extension | `extensions/fuzzy-file-finder/` | （多文件子目录扩展）fzf/telescope 风格文件选择器。命令 `/find-file` 打开 overlay，选中后向编辑器插入 `@path`。分阶段开发：阶段 1 扁平模糊列表（已完成）→ 阶段 2 目录树展开/折叠 → 阶段 3 拦截 `@` 键直接弹出 |
| Theme | `themes/gruvbox-dark.json` | gruvbox 深色主题 |

`package.json` 里的 `pi` manifest 声明了上述资源，pi 安装本包时自动加载。

## 安装

```bash
pi install git:github.com/you/my-pi-config
```

安装后：
- **扩展自动生效**：bash 默认超时、`@` 模糊文件补全等扩展安装后立即起作用，无需其它操作。
- **主题需选一次**：安装只是让 `gruvbox-dark` 出现在可选列表里，激活运行一次
  `/theme gruvbox-dark`（或在 `~/.pi/agent/settings.json` 里设 `"theme": "gruvbox-dark"`）。
  这是 pi 的机制——package 不能替用户强行选主题。

> 本仓库只包含模型之外的通用 pi 配置，不含任何 provider / 模型 / 凭据，也不动
> `defaultModel` / `defaultThinkingLevel` 等模型相关设置。

## 卸载

```bash
pi remove git:github.com/you/my-pi-config
```

移除后扩展自动失效；若之前选中了本主题，pi 会自动回退到默认主题。

## 安装原理

pi 是「**登记引用 + 启动时按引用加载**」，不会把整个仓库拷进 `~/.pi`：

- `pi install git:...` 把仓库 clone 到 `~/.pi/agent/git/<host>/<path>/`，并在
  `~/.pi/agent/settings.json` 的 `packages` 数组里登记一条 `git:` 引用。
- 启动时 pi 读 `packages[]`，按每个包的 `pi` manifest 加载 `extensions/*.ts` 和
  `themes/*.json`。扩展默认启用，主题加入可选列表。
- `pi remove` 只删掉 `packages` 里的引用，不会在 `~/.pi` 留下散落文件。

用 `pi config` 可单独启用/禁用某个扩展或主题；用 `pi update --extensions` 更新已装包。

## 不在本仓库范围内（新机器需手动）

- **powerline 状态栏**：`pi install npm:pi-powerline-footer`，并按需在 settings 里配
  `"powerline": { "preset": "default", "fixedEditor": true, "placement": "above" }`。
- **联网搜索 / 网页・视频理解**：`pi install npm:pi-web-access`，开箱即用（Exa 免密钥、
  无需配置，`web_search` / `fetch_content` 等工具在会话启动时自动注册）。如需 YouTube /
  本地视频抽帧，另装 `brew install ffmpeg yt-dlp`；OpenAI / Gemini 等其它搜索源需自备 key，
  写入本机 `~/.pi/web-search.json`（不进本仓库）。
- **`fd` 二进制**：`brew install fd`。

## 维护约定

不提交任何机密/本机状态：`auth.json`、`sessions/`、`tmp/`、`node_modules/` 已在 `.gitignore` 中。
