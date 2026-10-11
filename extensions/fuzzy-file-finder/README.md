# fuzzy-file-finder

**English** | [简体中文](README-CN.md)

An fzf/telescope-style file picker, loaded as a **multi-file directory extension** (pi treats this
directory's `index.ts` as one extension, and `jiti` resolves relative imports at runtime, so there is no
bundling and no submodule).

## Modules

| File | Responsibility |
|---|---|
| `index.ts` | Extension entry. Registers the `/find-file` command and, in `session_start`, adds an autocomplete provider wrapper that takes over everything `@` does: a bare `@` at the start of a word opens the finder; `@query` (already typed) goes through an inline subsequence-fuzzy dropdown (absorbed from the former standalone `fuzzy-at-files.ts` extension); everything else is delegated back to the built-in chain. Caches the file list (warmed up at session_start) |
| `finder-overlay.ts` | The TUI component used by `ctx.ui.custom()` (editor-slot mode): search box + two modes (empty query = directory tree browsing, typing = flat fuzzy list) + key bindings. The list area has a fixed height so the layout doesn't jitter while typing |
| `files.ts` | Data layer: lists all files with `fd --no-ignore` (falling back to `git ls-files --cached --others`), filters them through a hard-coded blocklist (`node_modules`/`.git`/`.env*`, etc.), extracts directory prefixes from the file list, and ranks with the `fuzzyFilter` subsequence fuzzy matcher |
| `tree.ts` | Directory tree model (`buildTree` / `flattenVisible`), used by browse mode |

## Phases

- **Phase 1 (done)**: `/find-file` → flat fuzzy list → insert `@path`.
- **Phase 2 (done)**: an empty search box = collapsible directory tree browsing (→/← expand/collapse, enter toggles on a directory and selects on a file, tab selects the current node); typing switches to a repo-wide flat fuzzy list, and clearing the box returns to the tree (expansion state is preserved). The whole tree is built from the in-memory file list, so expanding/collapsing involves zero IO.
- **Phase 3 (done)**: a bare `@` at the start of a word automatically opens the picker, replacing the built-in inline dropdown. **It works at the autocomplete provider layer, not with `CustomEditor`**. Pitfalls and conclusions:
  - We first tried `CustomEditor` + `setEditorComponent` to intercept `handleInput`: the logic itself was fine, but it was **pre-empted by `pi-powerline-footer`**, which unconditionally takes over the editor with its own `BashModeEditor` (`setEditorComponent`), takes the autocomplete provider only from the wrapped editor, and **does not forward key presses to its `handleInput`**. Our interception became dead code, and the symptom was "always the inline dropdown".
  - Load order: `~/.pi/agent/extensions/` (this extension) loads before the `packages` in settings (powerline), so powerline wraps later and wins.
  - A different route: pi-tui's `Editor` hard-codes `@` as a completion trigger (`DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS`), and the only two interception points are `handleInput` or the **autocomplete provider chain**. Powerline preserves the provider chain (`ModeAwareAutocompleteProvider` delegates back when not in bash mode), so we hook in via `addAutocompleteProvider` instead: on a **bare `@` at the start of a word** (`^@` or ` @`/`\t@` with nothing typed after it) we open the finder with `ctx.ui.custom` and return **empty items** so the editor closes the inline dropdown. This works with both powerline and native pi.
  - **Don't use `{ overlay: true }`** (this conclusion was reached with powerline < 0.9; since 0.9.0 powerline has removed its self-managed fixed editor and pi's native fullscreen mode handles it, so the compositor problem described below no longer exists. Editor-slot rendering is still closer to the built-in picker, so it is left unchanged; going back to an overlay would need re-verification under pi 1.0 fullscreen): a pi-tui overlay sends powerline's fixed-editor compositor into the "overlay visible" branch — `terminal.rows` jumps back to full height and `tui.render` returns the full buffer, so pi-tui does a full clear and reprints the whole conversation history (seen as "history jumps, the input box is wiped, content shifts down"). With **editor-slot rendering** (the default mode of `ctx.ui.custom()`), the compositor draws the component in the fixed cluster at the bottom and the chat viewport doesn't move; under native pi it behaves like the built-in selector.
  - Insertion: the `@` is already in the buffer (it is the keystroke that triggered the picker), so after selection only the tail `path `/`dir/` is inserted (`mention.slice(1)`), giving `@path `/`@dir/`. Cancelling (esc) leaves a bare `@` (the key isn't lost, and it is also the escape hatch for typing a literal `@`/an email address or falling back to the inline fuzzy dropdown).
  - `@foo` (already typed) and `a@` (mid-word, e.g. an email address) are not intercepted and are delegated unchanged to the provider chain.
  - `addAutocompleteProvider` must be called in `session_start`: `/reload` clears the provider wrappers and then re-fires `session_start` with `reason:"reload"`, so installing it there is what gets it reinstalled.
- **Phase 4 (done)**: directory candidates are merged into filter mode. Previously the candidate list contained only files (`fd --type f` / `git ls-files`), so directories vanished as soon as you typed; now all directory prefixes are extracted from the file list (zero IO, the same data source as the tree), and directories, with a trailing `/`, take part in fuzzy matching together with files, mixed by score; selecting one inserts `@dir/`. Empty directories remain invisible (consistent with browse mode).
- **Phase 5 (done)**: merged the former standalone extension `fuzzy-at-files.ts`. `@query` (already typed) no longer delegates back to the built-in "contiguous substring" matching; the same provider now serves the inline subsequence-fuzzy dropdown directly (`@patf` matches `path/to/file`), and still falls back to the built-in chain when nothing matches. Benefits: one shared file list / cache / blocklist, so the session warm-up runs `fd` only once; word boundaries consistently use PATH_DELIMITERS (space/tab/`"`/`'`/`=`), so the decisions for "bare `@` opens the finder" and "`@query` inline fuzzy" no longer diverge; and the implicit handshake between the two extensions, where each yielded to the other on a bare `@`, is no longer needed. After cancelling the finder (esc), continuing to type falls into inline fuzzy, so the escape hatch is unchanged.

## Interaction

- Trigger: run `/find-file`, or type `@` at the start of a word in the editor. The finder is rendered at the editor's position (at the bottom), not as a floating overlay.
- Inline fuzzy (without opening the finder): typing `@query` directly does subsequence-fuzzy matching of repo-wide files in the built-in dropdown (`@patf` matches `path/to/file`, `@src idx` matches `src/.../index.ts`); enter/tab inserts `@path`.
- Browse mode: ↑↓ move, →/← expand/collapse or jump to the parent directory, enter toggles a directory / selects a file, **tab selects the current node** (a directory inserts `@dir/`, a file inserts `@path `), esc cancels.
- Filter mode: type to filter (directories and files are matched together, directories with a trailing `/`), ↑↓ move, enter/tab selects (a directory inserts `@dir/`, a file inserts `@path `), esc cancels.

## Requirements

Requires `fd` (falls back to `git ls-files` when it is missing, so you must at least be inside a git repo). Available in interactive TUI mode only.
