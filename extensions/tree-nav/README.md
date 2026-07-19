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
- **时间轨（time-rail）+ 响应摘要**：marker 坐在自己的 lane 列上；每个收起且有响应的轮次下方插一行
  **连接行**，把该轮响应的摘要当作一条短支线挂在时间轴上：有同 lane 子轮时用 `├╴`（竖线从上一个圆点
  正中间穿到下一个圆点，同时支出一条短线标注摘要），最新/叶子轮（如当前轮）用 `╰╴` 圆角收尾，让线干净
  终止、不再拖一个悬空的 `╵` 断头。摘要文本 `N tool calls · M replies`（muted 色）——把以前放在行末、
  会被长 prompt 截断的单个计数 `·N` 搬到这里，既不会被截断又能写得更详细。展开某轮时改由 segment 行自带的 `│`
  承担连接、不再插连接行；无响应的轮次连接行只画纯 `│`。代价是线性对话收起时行数约翻倍（换取“线穿圆点”
  + 摘要常驻）；连接行不可选中，`↑↓` 会自动跳过。

### 2.4 跳转语义（依赖 pi 的 `navigateTree`）

`ctx.navigateTree(targetId, { summarize })` 的行为（见源码 `agent-session.navigateTree`）：

| 目标节点类型 | 结果 |
|---|---|
| **user 消息** | `leaf = target.parentId`，并返回该 user 文本作为 `editorText`——即**回退到这一轮之前、把 prompt 回填输入框**，可编辑重问。 |
| 非 user 节点（assistant/tool/summary） | `leaf = target`——从该节点继续。 |

所以：**选中一个 user 轮次 = 回退重问**（点 1/2）；**展开后选中中间节点 = 落到该处**（点 3）。
`summarize: false` 时不生成"放弃分支总结"，跳转最快，贴合 vibe coding 的秒回退习惯。

### 2.5 隐藏"空草稿"分支（默认开启，`tab` 切换）

痛点：双击 ESC 或 `/nav` 往回**回溯**改上一轮输入时，只要你重新提交，Pi 的 append-only 会话就会
在树上留下一条**死支**（旧 prompt 那一段）。若这段分支**从头到尾没产生任何 assistant/tool 回合**
（典型：改错别字，回退后重问），它对之后的审计毫无价值，纯属噪音。

本扩展**不删本地文件**（顺着 append-only 设计），只在 `/nav` 的**显示层过滤**掉这类分支：

> **隐藏某个 user 轮 U，当且仅当：U 的整棵子树里不含任何"有价值内容"，且 U 不在当前 active path 上。**

- **"有价值内容"** = **toolResult** / **有实质产出的 assistant 轮**（发过 tool call 或有非空文本）/ `branch_summary` /
  `compaction`。注意：**空的 assistant 轮不算**——“敲回车立即生成一个 assistant 轮、马上 ESC
  变 `(aborted)`”（`stopReason: "aborted"`、无文本无 tool call）或 errored 空轮，都不算真实工作，不会挡隐藏。
  一旦真发起过 tool call、或有了（哪怕部分的）文本回复，就保留（审计价值在）。`branch_summary` 按需求保留；
  纯 user 轮 + 元数据（label / model / thinking 变更）不算有价值。
- **递归判定整棵子树**：若 U 自己没响应、但其某个 user 子孙有真实响应，U 是"通往有效对话的必经祖先"，
  保留。只有**整段子树都无价值**才隐藏——此时从最顶端那个 user 节点剪掉整棵子树（其后代必然也无价值、
  也都 off-path），分支深度/泳道自然塌回线性。
- **active-path 例外**：绝不隐藏"当前所在"的轮次。比如刚提交、assistant 还没回复就开 `/nav`，最新那轮
  暂时"无响应"但在 active path 上，照常显示，避免"当前位置消失"。
- **`tab` 显隐开关**（默认隐藏）：overlay 内按 `tab` 在"隐藏空草稿 / 显示全部"间切换，标题栏显示
  `+N hidden` 提示被隐藏的数量；切换时尽量保留当前选中项、否则回落到当前轮。想翻出某条被隐藏的旧草稿
  原文去 copy/跳转时，切到"显示全部"即可。
- **降级**：若隐藏后一条都不剩（极少见，如 leaf 重置到 root、树里只剩草稿），`/nav` 自动以"显示全部"
  打开，保证有东西可导航。

实现落点在数据层 `buildNavModel(roots, leafId, hideResponseless=true)`：过滤发生在"建 user 父子映射"
的那次遍历里，跳过被隐藏的 user 节点，因此深度/泳道/`currentIndex`/段落折叠全部基于过滤后的模型，视图层
几乎不用改。`index.ts` 同时构建隐藏视图与全量视图（`false`）两个模型交给 overlay，`tab` 只是切换用哪个。

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
- "放弃分支是否总结"的交互流程是 interactive-mode 手写的，不在 `navigateTree` 内；扩展侧需自己用 `ctx.ui.select` 补（已实现，见下）。

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
- `users[]`：`{ id, depth(紧凑分支深度), onActivePath, isCurrent, isLastSibling, parentSameLane, label?, preview, segment[],
  gutterCols, connectorCol, descGutterCols, laneContinues }`（`parentSameLane` 驱动时间轨向上连接；最后四个为泳道渲染信息）
- `segment[]`：该 user 轮次的响应（沿 active-first 子链收集到下一个 user 节点为止的 assistant/tool 条目）
- `currentIndex`：当前轮（leaf 最近的 user 祖先）在 `users` 中的下标

---

## 5. 实现状态

### 已实现

- **`/nav` 大 overlay**（`width 90% / maxHeight 90% / center`），不覆盖内置 `/tree`（同名扩展命令会被 pi 过滤）。
- **数据层**（`session-tree.ts`，纯 `import type`、运行时零依赖）：紧凑分支深度（线性链不缩进、
  仅分支点 +1）、活动路径、active-first 排序、段落折叠模型。
- **泳道 gutter**：`│ ├─ ╰─` 画管线，活动路径连接线用 accent；展开段落时非末位分支的 `│` 会延伸到下方兄弟分支。
- **时间轨（time-rail）+ 响应摘要**：marker 坐在 lane 列上；收起且有响应的轮次下方插连接行，把摘要
  当短支线挂在时间轴上：有子轮用 `├╴`、叶子轮（如最新轮）用 `╰╴` 圆角收尾（避免悬空 `╵` 断头）；文本
  `summarizeSegment`：toolResult 计 tool call、assistant 消息计 reply。无响应轮的连接行只画纯 `│`。展开时
  改由 segment 行的 `│` 承担。连接行在「有同 lane 子轮（`parentSameLane`）或有响应摘要」时插入，不可选中，
  `move()` 经 `clampToSelectable` 跳过。
- **一等 user 轮次列表**：`◉`当前/`●`活动路径/`○`旁支 字形、`[label]`、预览、可展开标记 `▸/▾`（响应条数摘要已移到连接行）；`→/space` 展开、`←` 收起。
- **搜索**（B 方案）：打字即从泳道浏览切为扁平匹配列表，**仅搜 user 轮次**（+label），分词子串 AND、大小写不敏感；
  命中高亮（accent 加粗，与中性正文区分）；内嵌 `Input` 并传播 `focused` 支持 IME；`esc` 先清查询回浏览、再按才关闭。
- **跳转**：`ctx.navigateTree`，user 目标回退并回填 prompt（pi 包装器自带“编辑器非空不覆盖”守卫）；跳转前用 `ctx.ui.select`
  询问是否 summarize 被放弃分支（`collectEntriesForBranchSummary` 判空、custom 走 `ctx.ui.editor`、无模型时降级）。
- **键位**：`↑↓` 移动、`PgUp/PgDn` 翻页、`enter` 跳转、`tab` 切换隐藏空草稿/显示全部、`esc` 取消/先清搜索（早期的 `o` 展开键已去掉，以免挡输入）。
- **隐藏空草稿分支**（默认开启，见 2.5）：`buildNavModel` 第三参 `hideResponseless` 控制；判定"有价值内容"= toolResult / 有实质产出的 assistant 轮（有 tool call 或非空文本，空的 aborted/errored 轮不算）/ branch_summary / compaction，递归整棵子树 + active-path 例外；`index.ts` 建隐藏/全量两模型，overlay 内 `tab` 切换、标题栏显示 `+N hidden`、隐藏后为空则自动显示全部。

均已用合成 `SessionTreeNode` 树 + 驱动真实 `Input` 的冷烟测试验证（多层分支泳道连接、模式切换、高亮、esc 语义）。

### 未来增强（暂不排期）

- **视口自适应平衡**：分支多/深时按可视高度折叠远端分支、优先展开活动路径邻域——需求点 4 的完全体（目前只做到 active-first + 紧凑深度）。
- **summarize**：总结中途无法取消（`abortBranchSummary` 未对扩展暴露，`navigateTree` 用内部 AbortController）；esc 目前取消整个跳转，可优化为退回 overlay。
- **搜索**：可扩到 segment（assistant/tool）、“user 命中排前”排序、超大 session 加 debounce（当前每键即时过滤，几百条内无压力）。
- **段落缩略**：`formatToolCall` 目前只覆盖 read/write/edit/bash/grep，可补齐更多工具。
- **多根**（forked session 合并展示）对多 root 区分较弱（都堆在 depth 0）。
- **已决定不做**：label 编辑 / `labeled-only` 视图；可配置项（默认过滤/字形主题/键位）。
- **开放问题**：是否需要“跳到该轮 assistant 回答处”的变体；`/nav` 参数（如 `/nav labeled`）；overlay 是否固定高度铺满（现按内容高度、`maxHeight 90%` 封顶）。

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
- 本仓库无 TS 工具链（pi 用 jiti 运行时转译，不做类型检查），改动后建议至少跑一次数据层冒烟测试。
