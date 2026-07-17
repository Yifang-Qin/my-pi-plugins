# my-pi-config

个人 [pi](https://pi.dev) coding-agent 配置，做成一个原生 pi package，用 `pi install` / `pi remove` 直接安装卸载。

## 包含内容

| 类型 | 文件 | 说明 |
|---|---|---|
| Extension | `extensions/bash-default-timeout.ts` | 给模型发起的 bash 调用补默认超时（默认 120s，`PI_BASH_DEFAULT_TIMEOUT` 可覆盖） |
| Theme | `themes/gruvbox-dark.json` | gruvbox 深色主题 |

`package.json` 里的 `pi` manifest 声明了上述资源，pi 安装本包时自动加载。

## 安装

```bash
pi install git:github.com/you/my-pi-config
```

安装后：
- **扩展自动生效**：bash 默认超时立即起作用，无需其它操作。
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
- **`fd` 二进制**：`brew install fd`。

## 维护约定

不提交任何机密/本机状态：`auth.json`、`sessions/`、`tmp/`、`node_modules/` 已在 `.gitignore` 中。
