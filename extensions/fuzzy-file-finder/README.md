# fuzzy-file-finder

fzf/telescope 风格的文件选择器,作为**多文件子目录扩展**加载(pi 把本目录的
`index.ts` 当成一个扩展,`jiti` 在运行时解析相对导入,无需打包或 submodule)。

## 模块

| 文件 | 职责 |
|---|---|
| `index.ts` | 扩展入口。注册 `/find-file` 命令,打开 overlay,选中后 `@path` 插入编辑器。缓存文件清单 |
| `finder-overlay.ts` | `ctx.ui.custom({ overlay:true })` 用的 TUI 组件:搜索框 + 可滚动结果列表 + 键位 |
| `files.ts` | 数据层:`fd`(退回 `git ls-files`)列文件 + `fuzzyFilter` 子序列模糊排序 |
| `tree.ts` | 目录树模型(`buildTree` / `flattenVisible`),阶段 2 的地基,当前未接入 overlay |

## 分阶段

- **阶段 1（已完成）**：`/find-file` → overlay 扁平模糊列表 → 插入 `@path`。
- **阶段 2（待做）**：把 `finder-overlay.ts` 的扁平列表换成 `tree.ts` 的目录树,支持
  ←/→ 展开折叠、目录懒加载。
- **阶段 3（待做）**：用 `CustomEditor` 包装(`ctx.ui.setEditorComponent`)拦截词首的
  `@`,直接弹出本 overlay,替代内置自动补全下拉。注意先 `getEditorComponent()`
  组合已有的自定义编辑器。

## 依赖

需要 `fd`(缺失时退回 `git ls-files`,故至少要在 git 仓库内)。仅在交互式 TUI 模式可用。
