# fuzzy-file-finder

fzf/telescope 风格的文件选择器,作为**多文件子目录扩展**加载(pi 把本目录的
`index.ts` 当成一个扩展,`jiti` 在运行时解析相对导入,无需打包或 submodule)。

## 模块

| 文件 | 职责 |
|---|---|
| `index.ts` | 扩展入口。注册 `/find-file` 命令 + 在 `session_start` 加一个 autocomplete provider 包装器（词首 `@` 弹 overlay）；打开 overlay，选中后插入 mention。缓存文件清单 |
| `finder-overlay.ts` | `ctx.ui.custom({ overlay:true })` 用的 TUI 组件：搜索框 + 双模式（空查询=目录树浏览，打字=扁平模糊列表）+ 键位 |
| `files.ts` | 数据层：`fd`（退回 `git ls-files`）列文件 + `fuzzyFilter` 子序列模糊排序 |
| `tree.ts` | 目录树模型（`buildTree` / `flattenVisible`），浏览模式使用 |

## 分阶段

- **阶段 1（已完成）**：`/find-file` → overlay 扁平模糊列表 → 插入 `@path`。
- **阶段 2（已完成）**：空搜索框 = 可折叠目录树浏览（→/← 展开折叠、enter 在目录上切换、在文件上选中、tab 选中当前节点）；打字切到全库扁平模糊列表，删空又回到树（保留展开状态）。整棵树由内存文件清单构建，展开/折叠零 IO。
- **阶段 3（已完成）**：词首 `@` 自动弹 overlay，替代内置内联下拉。**走 autocomplete provider 层，不用 `CustomEditor`**。踩坑与结论：
  - 先试过 `CustomEditor` + `setEditorComponent` 拦 `handleInput`：逻辑本身没问题，但被 **`pi-powerline-footer` 抢占**——它无条件用自己的 `BashModeEditor` 占据编辑器（`setEditorComponent`），且只从被包装的编辑器里取 autocomplete provider，**不把按键转发给它的 `handleInput`**，所以我们的拦截成了死代码，表现就是「一直是内联下拉」。
  - 加载顺序：`~/.pi/agent/extensions/`（本扩展）先于 settings 里 `packages`（powerline）加载，所以 powerline 后包装、后胜出。
  - 换路子：pi-tui 的 `Editor` 把 `@` 硬编码成补全触发符（`DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS`），唯二的拦截点是 `handleInput` 或 **autocomplete provider 链**。powerline 会保留 provider 链（`ModeAwareAutocompleteProvider` 非 bash 模式时委托回来），所以我们改在 `addAutocompleteProvider` 里：命中**词首裸 `@`**（`^@` 或 ` @`/`\t@`，后面还没打字）就 `ctx.ui.custom` 弹 overlay，并返回**空 items** 让编辑器收起内联下拉。这条路对 powerline 与原生 pi 都成立。
  - 插入：`@` 已在缓冲区里（就是触发的那一下），选中后只补插尾巴 `path `/`dir/`（`mention.slice(1)`）→ 得到 `@path `/`@dir/`；取消（esc）→ 留下裸 `@`（键不丢，也是打字面 `@`/邮箱、或回落到内联模糊下拉的逃生口）。
  - `@foo`（已打字）、`a@`（词中，如邮箱）都不拦，原样委托给 provider 链。
  - 必须在 `session_start` 里 `addAutocompleteProvider`：`/reload` 会清空 provider 包装器再以 `reason:"reload"` 重触发 `session_start`，装在这里才会被重装。

## 交互

- 触发：运行 `/find-file`，或在编辑器里于词首打 `@`。
- 浏览模式：↑↓ 移动、→/← 展开折叠或跳父目录、enter 目录切换/文件选中、**tab 选中当前节点**（目录插入 `@dir/`，文件插入 `@path `）、esc 取消。
- 过滤模式：打字过滤、↑↓ 移动、enter/tab 选中、esc 取消。

## 依赖

需要 `fd`(缺失时退回 `git ls-files`,故至少要在 git 仓库内)。仅在交互式 TUI 模式可用。
