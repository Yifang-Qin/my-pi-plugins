# tree-nav — 以 user 节点为中心的会话树导航器（lazygit 风格）

> pi 内置 `/tree` 把整棵对话树按"亲缘从远到近"横向缩进摊在输入框上方的小窗口里，
> 深层线性对话会不断向右漂移、难读。本扩展用一个**大 overlay** 重做导航体验：
> **user 轮次是一等公民**，中间的 assistant/tool 内容默认折叠，跳转按"回退到某轮提问"
> 的直觉来组织。触发命令：`/nav`。

---

## 1. 需求（我们要解决什么）

基于对真实使用行为的假设，跳转频率分三档：

1. **高频**：跳回当前节点的**直系祖先 user 节点**（"往回退几轮"）——必须零摩擦。
2. **中频**：跳到**其他 branch 上的 user 节点**（切换探索路线）。
3. **极低频**：跳到任意 branch 下的某个 **assistant/tool 中间节点**（精细回溯）。

由此定下四条设计目标：

1. 用**大 overlay** 替代挤在输入框上方的局部小窗口。
2. **高亮 user 节点**；两个 user 节点之间的 assistant/tool 内容**缩略折叠**。
3. **user 节点作为一等公民**优先支持快速跳转；中间节点提供**手动展开**的细粒度下钻。
4. 用启发式在视觉上**平衡这棵树**：让"当前节点→根"的祖先路径处在醒目位置，不同 branch 自适应布局。

---

## 2. 关键设计决策

### 2.1 为什么是 lazygit 式纵向泳道，而不是 2D tidy-tree

真正的 2D 树布局（Reingold–Tilford）在画布上很美，但终端里每个"节点"是**一段文本**而非一个点，
横向宽度极易爆炸、且不利于长文本预览。因此主视图采用 **纵向可滚动列表 + 分支泳道 gutter**
（lazygit / tig 的思路）：每行一个 user 轮次，左侧用缩进/管线表达分支拓扑，高亮选中项的祖先链。

### 2.2 紧凑 branch 深度（核心）

内置 `/tree` 的痛点是"深度=对话轮数"，线性对话也一路右移。本扩展的深度规则：

> **线性链保持同一深度；只有在真正的分支点（某个 user 节点拥有 >1 个 user 子节点）才 +1。**

即 `childDepth = (parentUser 的 user 子节点数 > 1) ? parentDepth + 1 : parentDepth`。
这样 20 轮线性对话全部停在 depth 0，只有真正分叉的地方才产生缩进——这正是"视觉平衡"的第一步。

### 2.3 活动路径优先（active-first）

- 计算 `leaf → root` 的 `activePath` 集合。
- 遍历时，分支点上**含 activePath 的子树排在最前**，使"当前路径"始终位于顶部/左侧。
- 行的字形区分：`◉` 当前轮次（accent 加粗）、`●` 在活动路径上、`○` 不在活动路径上；
  泳道连接线 `├─`/`╰─`/`│` 在活动路径上用 accent、否则 dim。

### 2.4 跳转语义（依赖 pi 的 `navigateTree`）

`ctx.navigateTree(targetId, { summarize })` 的行为（见源码 `agent-session.navigateTree`）：

| 目标节点类型 | 结果 |
|---|---|
| **user 消息** | `leaf = target.parentId`，并返回该 user 文本作为 `editorText`——即**回退到这一轮之前、把 prompt 回填输入框**，可编辑重问。 |
| 非 user 节点（assistant/tool/summary） | `leaf = target`——从该节点继续。 |

所以：**选中一个 user 轮次 = 回退重问**（点 1/2）；**展开后选中中间节点 = 落到该处**（点 3）。
`summarize: false` 时不生成"放弃分支总结"，跳转最快，贴合 vibe coding 的秒回退习惯。

---

## 3. 现状：pi 内置 `/tree` 摸底（复用与接线）

| 事项 | 位置 / 结论 |
|---|---|
| 内置组件 | `dist/modes/interactive/components/tree-selector.js`（`TreeSelectorComponent` + `TreeList`，约 1244 行） |
| 打开入口 | `interactive-mode.js` `showTreeSelector()`（≈L3805），由 `/tree` 命令与 `app.session.tree` 键位触发 |
| 跳转原语 | `agent-session.navigateTree()`（`agent-session.d.ts:568`），扩展侧为 `ctx.navigateTree()` |
| 布局本质 | 纵向缩进树（`├ └ │ ─` + 折叠 `⊞ ⊟` + 活动点 `•`），带**水平视口平移**；深度在分支点/分支后首代 +1，单子链保持平坦；`maxVisibleLines = max(5, ⌊termRows/2⌋)` |
| 已有过滤 | `default / no-tools / user-only / labeled-only / all`——**内置其实已有 `user-only`**，但 UI 呈现没做成一等体验 |
| 分支段跳转 | `app.tree.foldOrUp`=`ctrl+left,alt+left`；`app.tree.unfoldOrDown`=`ctrl+right,alt+right`（**注意：用户以为的 `ctrl+u/l` 其实是 `filter.userOnly`/`filter.labeledOnly` 过滤键**） |

### 可复用的公开导出（`@earendil-works/pi-coding-agent` 主入口）

- 类型：`SessionTreeNode`、`SessionEntry`、`SessionMessageEntry` 等（`dist/index.d.ts:19`）。
- 组件：`TreeSelectorComponent`、`UserMessageSelectorComponent`（`dist/index.d.ts:28`）——
  可直接塞进 overlay 做原型；但内部布局参数化不足，最终自研组件更灵活。
- 数据/UI 上下文：`ctx.sessionManager.getTree()/getLeafId()/getEntry()/getLabel()`、
  `ctx.navigateTree()`、`ctx.fork()`、`pi.setLabel()`、`ctx.ui.custom({ overlay:true, overlayOptions })`。
- TUI 积木（`@earendil-works/pi-tui`）：`Container/Box/Text/Spacer/SelectList/DynamicBorder`、
  `matchesKey/Key`、`truncateToWidth/visibleWidth/wrapTextWithAnsi`；`tui.terminal.rows/columns` 取尺寸。

### 已知约束

- **不能注册名为 `tree` 的命令**覆盖内置（`interactive-mode.js:391` 用 `builtinCommandNames` 过滤掉同名扩展命令）。故用 `/nav`。
- overlay 标注 **experimental**；`render(width)` 逐行返回、每行不得超宽，滚动/裁剪自理（无 2D 画布）。
- "放弃分支是否总结"的交互流程是 interactive-mode 手写的，不在 `navigateTree` 内；要对齐得自己补（见 Roadmap Stage 2）。

---

## 4. 架构与文件

```
extensions/tree-nav/
├── index.ts          # 入口：注册 /nav，取树→建模→开 overlay→navigateTree
├── session-tree.ts   # 数据层（无运行时依赖，纯 import type）：把 SessionTreeNode[]
│                     # 折叠成 user 中心模型（紧凑深度 / 活动路径 / 段落）
├── nav-overlay.ts    # 视图层：Component+Focusable，大 overlay 渲染 + 键盘导航
└── README.md         # 本文档
```

数据流：`getTree()+getLeafId()` → `buildNavModel()` → `NavModel{users[], currentIndex}`
→ `NavOverlay` 渲染并预选当前轮 → 用户选中 `entryId` → `ctx.navigateTree(entryId, {summarize:false})`。

`NavModel` 关键字段：
- `users[]`：`{ id, depth(紧凑分支深度), onActivePath, isCurrent, isLastSibling, label?, preview, segment[] }`
- `segment[]`：该 user 轮次的响应（沿 active-first 子链收集到下一个 user 节点为止的 assistant/tool 条目）
- `currentIndex`：当前轮（leaf 最近的 user 祖先）在 `users` 中的下标

---

## 5. Roadmap（分阶段）

### Stage 1 — 骨架（本次已完成，可 `/reload` 试用）
- [x] `/nav` 命令 + 大 overlay（`width 90% / maxHeight 90% / center`）。
- [x] 数据层：紧凑分支深度、活动路径、active-first 排序、段落折叠模型（已用合成树单测验证）。
- [x] user 轮次一等公民列表：`◉/●/○` 字形、缩进表分支、`[label]`、预览、段落条数 `·N`。
- [x] 键位：`↑↓` 移动、`PgUp/PgDn` 翻页、`enter` 跳转、`→/space/o` 展开段落、`←` 收起、`esc` 取消。
- [x] 预选当前轮；`navigateTree(id,{summarize:false})`，user 目标回填 `editorText`。

### Stage 2 — 泳道图形 + 体验补齐
- [x] 真·分支泳道 gutter：`│ ├─ ╰─` 画管线，`connectorCol`/`gutterCols`/`descGutterCols`/`isLastSibling`
      驱动连接线（参考 lazygit `graph.go`）；展开段落时非末位分支的 `│` 会继续延伸到下方兄弟分支。
- [ ] "Summarize branch?" 流程对齐内置（`ctx.navigateTree` 前用 `ctx.ui.select` 询问 no/yes/custom）。
- [ ] label 编辑（`pi.setLabel`）与 `labeled-only` 视图；书签跳转。
- [ ] 段落内 assistant 文本 / toolCall 更好的缩略（复用内置 `formatToolCall` 的更多分支）。
- [ ] 尊重用户 `editorText` 非空时不覆盖（当前直接 set，需读当前编辑器文本判空）。

### Stage 3 — 自适应布局 + 搜索
- [ ] 视口内**自适应平衡**：当分支很多/很深时，按可视高度折叠远端分支、优先展开活动路径邻域。
- [ ] 模糊搜索（`Input` + `Focusable` 已预留），跨 user/assistant 文本过滤并保留祖先链。
- [ ] 多根（forked session 合并展示）与超大树的性能（缓存 + 惰性）。
- [ ] 可配置：默认过滤模式、字形主题、键位（`pi.registerShortcut` / keybindings.json）。

---

## 6. 开源先例（设计参考）

- **布局**：lazygit `pkg/gui/presentation/graph/graph.go`（commit 泳道）、pvigier《commit graph drawing algorithms》、`reingold-tilford` crate（tidy tree，本项目**不**作主视图）。
- **LLM 对话树 TUI**：`queelius/ctk`（Textual 全屏 + SQLite）、`malbiruk/frond`（Rust，branch/merge）、
  `SarthakB11/claude-code-tree`（Claude Code 的 session 树导航器，与本项目最同构）。
- pi 生态暂无同类扩展；`examples/extensions/bookmark.ts` 仅用 `setLabel` 沾边。

---

## 7. 启用方式（软链接，见仓库 AGENTS.md 约定）

```bash
# 在仓库根目录
ln -sfn "$(pwd)/extensions/tree-nav" ~/.pi/agent/extensions/tree-nav
# 在 pi 会话里
/reload
/nav
```

> 真身在本仓库，`~/.pi/agent/extensions/tree-nav` 只是软链接。别在链接侧改内容或做 git。

---

## 8. 测试

- 数据层是纯函数（仅 `import type`，运行时零依赖），可用合成 `SessionTreeNode` 树直接跑
  `buildNavModel`，断言 `depth / onActivePath / isCurrent / segment / 顺序`。
- 本仓库无 TS 工具链（pi 用 jiti 运行时转译，不做类型检查），提交前建议至少跑一次数据层冒烟测试。

## 9. 待定问题（Open questions）

- 跳到 user 节点会 `leaf = parentId` 并回填 prompt：是否需要一个"跳到该轮的 assistant 回答处"
  的变体（即跳到该 user 的第一个 assistant 子节点）？可能更符合"只想看看那轮结论"的场景。
- 是否要提供 `/nav` 的参数（如 `/nav labeled` 直接进书签视图）。
- overlay 是否需要固定高度铺满（现在按内容高度，`maxHeight 90%` 封顶）。
