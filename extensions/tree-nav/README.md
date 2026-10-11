# tree-nav — a user-centric session tree navigator (lazygit style)

**English** | [简体中文](README-CN.md)

> pi's built-in `/tree` lays the whole conversation tree out in a small window above the input box,
> indented horizontally by "distance from the root". Deep linear conversations keep drifting to the
> right and become hard to read. This extension rebuilds the navigation experience in one **large
> overlay**: **user turns are first-class citizens**, the assistant/tool content in between is
> collapsed by default, and jumping is organized around the intuition of "roll back to an earlier
> question". Command: `/nav`.

---

## 1. Requirements (what we are solving)

Based on assumptions about real usage, jumps fall into three frequency tiers:

1. **High frequency**: jump back to a **direct-ancestor user node** of the current node ("go back a few turns") — must be zero-friction.
2. **Medium frequency**: jump to a **user node on another branch** (switch to a different line of exploration).
3. **Very low frequency**: jump to an **assistant/tool intermediate node** under any branch (fine-grained backtracking).

This yields four design goals:

1. Replace the small window squeezed above the input box with a **large overlay**.
2. **Highlight user nodes**; the assistant/tool content between two user nodes is **collapsed into a compact summary**.
3. Make **user nodes first-class** for fast jumping; intermediate nodes get fine-grained drill-down via **manual expansion**.
4. Use heuristics to **visually balance the tree**: keep the "current node → root" ancestor path prominent, and lay out the other branches adaptively.

---

## 2. Key design decisions

### 2.1 Why lazygit-style vertical lanes instead of a 2D tidy tree

A true 2D tree layout (Reingold–Tilford) looks great on a canvas, but in a terminal each "node" is a
**piece of text**, not a point. Horizontal width blows up easily, and long text previews suffer. So the
main view is a **vertically scrollable list + branch-lane gutter** (the lazygit / tig approach): one row
per user turn, with indentation/pipes on the left expressing the branch topology, and the ancestor chain
of the selected item highlighted.

### 2.2 Compact branch depth (the core idea)

The pain point of the built-in `/tree` is that "depth = number of conversation turns", so even a linear
conversation drifts rightward. The depth rule here:

> **A linear chain stays at the same depth; depth only increases by 1 at a real branch point (a user node with more than one user child).**

That is, `childDepth = (parentUser has > 1 user children) ? parentDepth + 1 : parentDepth`.
A 20-turn linear conversation therefore stays entirely at depth 0, and indentation appears only where
the conversation really forks — this is the first step toward "visual balance".

### 2.3 Active path first (active-first)

- Compute the `activePath` set from `leaf → root`.
- During traversal, at a branch point the **subtree containing the activePath is placed first**, so the
  "current path" is always at the top/left.
- Row glyphs: `◉` current turn (accent, bold), `●` on the active path, `○` not on the active path;
  lane connectors `├─`/`╰─`/`│` use accent on the active path and dim otherwise.
- **Time rail + response summary**: the marker sits on its own lane column; below every collapsed turn
  that has a response, a **connector row** is inserted that hangs the response summary on the timeline
  as a short side branch. If the turn has a same-lane child turn, it uses `├╴` (the vertical line runs
  from the middle of the previous dot to the middle of the next one, while a short stub branches off to
  label the summary); the newest/leaf turn (e.g. the current turn) ends with a rounded `╰╴`, so the line
  terminates cleanly instead of trailing a dangling `╵` stub. The summary text is
  `N tool calls · M replies` (muted color) — this moves the single count `·N` that used to sit at the end
  of the row (and got cut off by long prompts) down here, where it can't be truncated and can be more
  detailed. When a turn is expanded, the `│` carried by the segment rows takes over the connection and no
  connector row is inserted; a turn without a response gets a connector row with just a plain `│`. The
  cost is that a collapsed linear conversation takes roughly twice as many rows (in exchange for "line
  through the dot" plus an always-visible summary); connector rows are not selectable, and `↑↓` skips
  them automatically.

### 2.4 Jump semantics (relies on pi's `navigateTree`)

Behavior of `ctx.navigateTree(targetId, { summarize })` (see `agent-session.navigateTree` in the source):

| Target node type | Result |
|---|---|
| **user message** | `leaf = target.parentId`, and the user text is returned as `editorText` — i.e. **roll back to just before this turn and refill the prompt into the input box**, ready to edit and re-ask. |
| non-user node (assistant/tool/summary) | `leaf = target` — continue from that node. |

So: **selecting a user turn = roll back and re-ask** (tiers 1/2); **expanding and selecting an
intermediate node = land right there** (tier 3). With `summarize: false`, no "abandoned branch summary"
is generated, which makes jumping fastest and fits the quick-rollback habit of vibe coding.

### 2.5 Hiding "empty draft" branches (on by default, toggle with `tab`)

The pain point: when you **go back** (double ESC or `/nav`) to edit the previous input and then
resubmit, Pi's append-only session leaves a **dead branch** (the old prompt's segment) on the tree. If
that branch **never produced any assistant/tool turn from start to finish** (typically: fixing a typo,
rolling back and re-asking), it has no value for later auditing and is pure noise.

This extension **does not delete anything from the local file** (staying with the append-only design);
it only filters such branches out in `/nav`'s **display layer**:

> **A user turn U is hidden if and only if: U's whole subtree contains no "valuable content", and U is not on the current active path.**

- **"Valuable content"** = **toolResult** / **an assistant turn with real output** (issued a tool call or
  has non-empty text) / `branch_summary` / `compaction`. Note: **an empty assistant turn does not count**
  — "press Enter, an assistant turn is created immediately, then ESC turns it into `(aborted)`"
  (`stopReason: "aborted"`, no text, no tool call), or an errored empty turn, is not real work and does
  not prevent hiding. Once a tool call was actually issued, or there is any (even partial) text reply, the
  turn is kept (it has audit value). `branch_summary` is kept by requirement; a bare user turn plus
  metadata (label / model / thinking changes) is not valuable.
- **The whole subtree is judged recursively**: if U has no response itself but one of its user
  descendants has a real response, U is a "necessary ancestor of a meaningful conversation" and is kept.
  Only when the **entire subtree is worthless** is it hidden — in that case the whole subtree is pruned
  from its topmost user node (its descendants are necessarily worthless and off-path too), and the branch
  depth/lanes naturally collapse back to linear.
- **Active-path exception**: the turn you are currently on is never hidden. For example, if you open
  `/nav` right after submitting, before the assistant has replied, the latest turn is temporarily
  "response-less" but on the active path, so it is shown as usual — this avoids "the current position
  disappears".
- **`tab` show/hide toggle** (hidden by default): inside the overlay, press `tab` to switch between
  "hide empty drafts / show all"; the title bar shows `+N hidden` to indicate how many are hidden.
  When toggling, the current selection is preserved where possible, otherwise it falls back to the
  current turn. To dig out the original text of a hidden old draft (to copy it or jump to it), switch to
  "show all".
- **Fallback**: if nothing at all is left after hiding (very rare, e.g. the leaf was reset to the root
  and the tree contains only drafts), `/nav` opens in "show all" mode automatically so there is always
  something to navigate.

The implementation lives in the data layer, `buildNavModel(roots, leafId, hideResponseless=true)`: the
filtering happens in the same traversal that builds the user parent/child map, skipping hidden user
nodes, so depth/lanes/`currentIndex`/segment collapsing are all based on the filtered model and the view
layer needs almost no changes. `index.ts` builds both a hidden-view model and a full-view model (`false`)
and hands both to the overlay; `tab` just switches which one is used.

---

## 3. Current state: surveying pi's built-in `/tree` (reuse and wiring)

| Item | Location / conclusion |
|---|---|
| Built-in component | `dist/modes/interactive/components/tree-selector.js` (`TreeSelectorComponent` + `TreeList`, about 1244 lines) |
| Entry point | `interactive-mode.js` `showTreeSelector()` (≈L3805), triggered by the `/tree` command and the `app.session.tree` keybinding |
| Jump primitive | `agent-session.navigateTree()` (`agent-session.d.ts:568`); `ctx.navigateTree()` on the extension side |
| Layout essence | Vertically indented tree (`├ └ │ ─` + fold markers `⊞ ⊟` + active dot `•`) with **horizontal viewport panning**; depth +1 at a branch point / the first generation after a branch, single-child chains stay flat; `maxVisibleLines = max(5, ⌊termRows/2⌋)` |
| Existing filters | `default / no-tools / user-only / labeled-only / all` — **the built-in actually already has `user-only`**, but the UI doesn't present it as a first-class experience |
| Branch-segment jumping | `app.tree.foldOrUp`=`ctrl+left,alt+left`; `app.tree.unfoldOrDown`=`ctrl+right,alt+right` (**note: the `ctrl+u/l` that users assume are actually the `filter.userOnly`/`filter.labeledOnly` filter keys**) |

### Reusable public exports (main entry of `@earendil-works/pi-coding-agent`)

- Types: `SessionTreeNode`, `SessionEntry`, `SessionMessageEntry`, etc. (`dist/index.d.ts:19`).
- Components: `TreeSelectorComponent`, `UserMessageSelectorComponent` (`dist/index.d.ts:28`) —
  can be dropped straight into an overlay for a prototype, but their internal layout is not
  parameterized enough, so a custom component is more flexible in the end.
- Data/UI context: `ctx.sessionManager.getTree()/getLeafId()/getEntry()/getLabel()`,
  `ctx.navigateTree()`, `ctx.fork()`, `pi.setLabel()`, `ctx.ui.custom({ overlay:true, overlayOptions })`.
- TUI building blocks (`@earendil-works/pi-tui`): `Container/Box/Text/Spacer/SelectList/DynamicBorder`,
  `matchesKey/Key`, `truncateToWidth/visibleWidth/wrapTextWithAnsi`; use `tui.terminal.rows/columns` for dimensions.

### Known constraints

- **A command named `tree` cannot be registered** to override the built-in (`interactive-mode.js:391` uses `builtinCommandNames` to filter out extension commands with the same name). Hence `/nav`.
- The overlay is marked **experimental**; `render(width)` returns lines one by one, no line may exceed the width, and scrolling/clipping is on you (there is no 2D canvas).
- The "summarize the abandoned branch?" flow is hand-written in interactive-mode, not inside `navigateTree`; the extension has to supply it itself via `ctx.ui.select` (done, see below).

---

## 4. Architecture and files

```
extensions/tree-nav/
├── index.ts          # Entry: register /nav, fetch the tree → build the model → open the overlay → navigateTree
├── session-tree.ts   # Data layer (no runtime dependencies, type-only imports): collapses SessionTreeNode[]
│                     # into a user-centric model (compact depth / active path / segments)
├── nav-overlay.ts    # View layer: Component+Focusable, large-overlay rendering + keyboard navigation
├── README.md         # this document
└── README-CN.md      # Chinese version
```

Data flow: `getTree()+getLeafId()` → `buildNavModel()` → `NavModel{users[], currentIndex}`
→ `NavOverlay` renders it and preselects the current turn → the user picks an `entryId` → `ctx.navigateTree(entryId, {summarize:false})`.

Key `NavModel` fields:
- `users[]`: `{ id, depth (compact branch depth), onActivePath, isCurrent, isLastSibling, parentSameLane, label?, preview, segment[],
  gutterCols, connectorCol, descGutterCols, laneContinues }` (`parentSameLane` drives the upward connection of the time rail; the last four are lane-rendering info)
- `segment[]`: the responses of that user turn (the assistant/tool entries collected along the active-first child chain up to the next user node)
- `currentIndex`: the index in `users` of the current turn (the user ancestor closest to the leaf)

---

## 5. Implementation status

### Implemented

- **`/nav` large overlay** (`width 90% / maxHeight 90% / center`); does not override the built-in `/tree` (an extension command with the same name would be filtered out by pi).
- **Data layer** (`session-tree.ts`, type-only imports, zero runtime dependencies): compact branch depth (linear chains are not indented,
  +1 only at branch points), active path, active-first ordering, segment-collapsing model.
- **Lane gutter**: `│ ├─ ╰─` draw the pipes, and active-path connectors use accent; when a segment is expanded, the `│` of a non-last branch extends down to its sibling branches below.
- **Time rail + response summary**: the marker sits on the lane column; below each collapsed turn that has a response, a connector row is inserted that
  hangs the summary on the timeline as a short side branch: `├╴` when there is a child turn, a rounded `╰╴` for a leaf turn (e.g. the latest turn)
  (avoiding a dangling `╵` stub); the text comes from
  `summarizeSegment`: toolResult counts as a tool call, an assistant message counts as a reply. A response-less turn gets a connector row with just a plain `│`. When expanded,
  the `│` of the segment rows takes over. A connector row is inserted when "there is a same-lane child turn (`parentSameLane`) or a response summary"; it is not selectable and
  `move()` skips it via `clampToSelectable`.
- **First-class user-turn list**: `◉` current / `●` active path / `○` side branch glyphs, `[label]`, preview, expandable marker `▸/▾` (the response-count summary has moved to the connector row); `→/space` expands, `←` collapses.
- **Search** (option B): typing switches from lane browsing to a flat match list that **searches user turns only** (+label), with tokenized substring AND matching, case-insensitive;
  hits are highlighted (accent bold, distinct from neutral body text); an embedded `Input` propagates `focused` to support IME; `esc` first clears the query and returns to browsing, and only a second press closes the overlay.
- **Jumping**: `ctx.navigateTree`; a user target rolls back and refills the prompt (pi's wrapper has a built-in "don't overwrite a non-empty editor" guard); before jumping, `ctx.ui.select`
  asks whether to summarize the abandoned branch (`collectEntriesForBranchSummary` checks for emptiness, custom instructions go through `ctx.ui.editor`, and it degrades gracefully when there is no model).
- **Keys**: `↑↓` move, `PgUp/PgDn` page, `enter` jump, `tab` toggle hide empty drafts / show all, `esc` cancel / clear the search first (the early `o` expand key was removed so it doesn't get in the way of typing).
- **Hiding empty-draft branches** (on by default, see 2.5): controlled by the third parameter `hideResponseless` of `buildNavModel`; "valuable content" = toolResult / an assistant turn with real output (has a tool call or non-empty text; empty aborted/errored turns don't count) / branch_summary / compaction, judged recursively over the whole subtree, with the active-path exception; `index.ts` builds the hidden and full models, `tab` toggles inside the overlay, the title bar shows `+N hidden`, and if nothing is left after hiding it automatically shows all.

All of this was verified with cold smoke tests using synthetic `SessionTreeNode` trees plus a real driven `Input` (multi-level branch lane connectors, mode switching, highlighting, esc semantics).

### Future enhancements (not scheduled)

- **Viewport-adaptive balancing**: when branches are many/deep, fold distant branches based on the visible height and prioritize expanding the neighborhood of the active path — the full version of requirement 4 (so far only active-first + compact depth is done).
- **summarize**: summarization can't be cancelled midway (`abortBranchSummary` is not exposed to extensions; `navigateTree` uses an internal AbortController); `esc` currently cancels the whole jump, which could be improved to return to the overlay.
- **Search**: could be extended to segments (assistant/tool), sorting with "user hits first", and a debounce for huge sessions (it currently filters on every keystroke, which is fine up to a few hundred entries).
- **Segment summaries**: `formatToolCall` currently covers only read/write/edit/bash/grep; more tools could be added.
- **Multiple roots** (merged display of forked sessions) are only weakly distinguished (all piled up at depth 0).
- **Decided not to do**: label editing / a `labeled-only` view; configuration options (default filter / glyph theme / keybindings).
- **Open questions**: whether a variant that "jumps to the assistant answer of that turn" is needed; `/nav` arguments (e.g. `/nav labeled`); whether the overlay should have a fixed height that fills the screen (currently sized to its content, capped by `maxHeight 90%`).

---

## 6. Open-source prior art (design references)

- **Layout**: lazygit `pkg/gui/presentation/graph/graph.go` (commit lanes), pvigier's "commit graph drawing algorithms", the `reingold-tilford` crate (tidy tree, which this project does **not** use as its main view).
- **LLM conversation-tree TUIs**: `queelius/ctk` (full-screen Textual + SQLite), `malbiruk/frond` (Rust, branch/merge),
  `SarthakB11/claude-code-tree` (a session-tree navigator for Claude Code, the closest in spirit to this project).
- The pi ecosystem has no comparable extension yet; `examples/extensions/bookmark.ts` only touches the topic via `setLabel`.

---

## 7. Enabling (symlink)

```bash
# From the repo root
ln -sfn "$(pwd)/extensions/tree-nav" ~/.pi/agent/extensions/tree-nav
# Inside a pi session
/reload
/nav
```

> The real files live in this repo; `~/.pi/agent/extensions/tree-nav` is only a symlink. Don't edit or run git on the link side.

---

## 8. Testing

- The data layer is made of pure functions (type-only imports, zero runtime dependencies), so you can run
  `buildNavModel` directly on a synthetic `SessionTreeNode` tree and assert `depth / onActivePath / isCurrent / segment / order`.
- This repo has no TS toolchain (pi transpiles at runtime with jiti and does no type checking), so after changes it's advisable to run at least one data-layer smoke test.
