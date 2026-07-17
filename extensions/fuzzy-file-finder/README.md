# fuzzy-file-finder

fzf/telescope 风格的文件选择器,作为**多文件子目录扩展**加载(pi 把本目录的
`index.ts` 当成一个扩展,`jiti` 在运行时解析相对导入,无需打包或 submodule)。

## 模块

| 文件 | 职责 |
|---|---|
| `index.ts` | 扩展入口。注册 `/find-file` 命令，打开 overlay，选中后插入 mention。缓存文件清单 |
| `finder-overlay.ts` | `ctx.ui.custom({ overlay:true })` 用的 TUI 组件：搜索框 + 双模式（空查询=目录树浏览，打字=扁平模糊列表）+ 键位 |
| `files.ts` | 数据层：`fd`（退回 `git ls-files`）列文件 + `fuzzyFilter` 子序列模糊排序 |
| `tree.ts` | 目录树模型（`buildTree` / `flattenVisible`），浏览模式使用 |

## 分阶段

- **阶段 1（已完成）**：`/find-file` → overlay 扁平模糊列表 → 插入 `@path`。
- **阶段 2（已完成）**：空搜索框 = 可折叠目录树浏览（→/← 展开折叠、enter 在目录上切换、在文件上选中、tab 选中当前节点）；打字切到全库扁平模糊列表，删空又回到树（保留展开状态）。整棵树由内存文件清单构建，展开/折叠零 IO。
- **阶段 3（已放弃）**：曾尝试用 `CustomEditor` + `setEditorComponent` 拦截词首 `@` 自动弹出，但它依赖 `session_start` 在 `/reload` 时重新安装编辑器钩子，实测不稳定（reload 后钩子未生效），已移除。触发以 `/find-file` 命令为准。

## 交互

- 触发：运行 `/find-file`。
- 浏览模式：↑↓ 移动、→/← 展开折叠或跳父目录、enter 目录切换/文件选中、**tab 选中当前节点**（目录插入 `@dir/`，文件插入 `@path `）、esc 取消。
- 过滤模式：打字过滤、↑↓ 移动、enter/tab 选中、esc 取消。

## 依赖

需要 `fd`(缺失时退回 `git ls-files`,故至少要在 git 仓库内)。仅在交互式 TUI 模式可用。
