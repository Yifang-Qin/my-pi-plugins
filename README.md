# my-pi-plugins

**English** | [简体中文](README-CN.md)

A personal [pi](https://pi.dev) coding-agent setup, packaged as a native pi package: install and remove it with `pi install` / `pi remove`.

## 📦 What's included

| Name | Type | In one line | Key features |
|---|---|---|---|
| 🧩 `tmux-bash` | Extension | Overrides the built-in bash with tmux backgrounding so long commands no longer block | Directory extension · three usage modes · companion `bg` tool · colored status line |
| 📂 `fuzzy-file-finder` | Extension | Takes over everything `@` does: directory tree browsing + repo-wide fuzzy completion | In-place popup · unified directory/file matching · absorbs `fuzzy-at-files.ts` · `fd`-accelerated |
| 🌳 `tree-nav` | Extension | lazygit-style session tree navigator that makes user-turn branches obvious | `/nav` opens a large overlay · enter to jump · type to search · optional summarize before jumping |
| 🤖 `afang-subagent` | Extension | Delegates tasks to isolated pi subprocesses (context isolation) | single/parallel/chain · `background:true` async · `subagent_tasks` tool · self-contained agents + prompts |
| ✅ `todo` | Extension | Phase → task hierarchical plan + a persistent progress widget above the editor | Batch init/append · five task states · auto-advance · branch restore · checkbox tree rendering · `/todos` full view |
| 🎨 `gruvbox-dark` | Theme | Classic dark, warm-toned gruvbox theme | High contrast · easy on the eyes in long sessions · best with the powerline status bar |

The `pi` manifest in `package.json` declares the resources above, and pi loads them automatically when this package is installed.

## Details

### 🧩 tmux-bash

Overrides pi's built-in bash: long commands run in a detached tmux window while **output is streamed back in the foreground**, so you are no longer stuck behind the built-in bash's synchronous wait.

- **Three usage modes**: without `timeout`, it waits in the foreground for ~120s (override with `PI_TMUX_BASH_FOREGROUND_TIMEOUT`); if the command is still running, it is **automatically moved to the background** (**the command is not killed**) and you get a notification on completion. An explicit `timeout` is a hard kill at the deadline (exit code **124**, no backgrounding). `background:true` detaches immediately.
- A companion `bg` tool (`list` / `logs` / `kill`) manages background jobs; results end with a colored status line such as `✓ done · 1.2s` / `✗ exit 1`.
- Processes are owned by the tmux server, so restarting pi, `/reload`, or exiting does not affect background jobs.
- **Requires `tmux` to be installed** (without it the bash tool reports that it is unavailable).

### 📂 fuzzy-file-finder

An fzf / telescope-style file picker that **takes over everything `@` does in the editor**.

- **Bare `@` at the start of a word**: opens the picker in place at the cursor (**no overlay mode**, which avoids full-screen repaints caused by conflicts with the pi-powerline-footer fixed editor); it is also available as the `/find-file` command.
- **Empty query = directory tree browsing** (`→` / `←` expand/collapse, `tab` selects a directory); **typing = repo-wide fuzzy list** (directories are matched together, with a trailing `/`). The selection is inserted as `@path`, and directories as `@dir/`.
- **`@query` (already typed)** uses a codex-style subsequence fuzzy inline dropdown: e.g. `@patf` matches `path/to/file` (this absorbs the former standalone extension `fuzzy-at-files.ts`).
- The index is complete (`--no-ignore`), but paths you would never reference by hand, such as `node_modules` / `.git` / `.env`, are hard-excluded. Install `fd` for speed (without it, it falls back to `git ls-files`).

### 🌳 tree-nav

A lazygit-style session tree navigator: it shows the whole session structure with **user turns as first-class nodes and branch lanes on the left**, making it easy to jump back to any historical branch.

- `/nav` opens a large overlay; press enter to jump to any historical user turn (**optionally summarize the abandoned branch before jumping**, compressing the detour into a short summary).
- Intermediate assistant / tool nodes are collapsed by default and can be expanded.
- Typing while on a user turn searches.

### 🤖 afang-subagent

Forked from pi's official subagent example and maintained independently. It registers a `subagent` tool that delegates tasks to **isolated pi subprocesses** (**context isolation**: the main session's context is not polluted), together with a `subagent_tasks` tool (`list` / `status` / `result` / `cancel`).

- **Three modes**: `single` (one agent) / `parallel` (concurrent agents) / `chain` (each result feeds the next).
- **`background:true` async mode**: a followUp notification (debounced and merged) arrives on completion, and the result is written to `<task cwd>/.pi/subagent-results/<timestamp>-task-N-<agent>-<topic>.md`.
- When an agent doesn't specify a model, it **inherits the main session's current model**.
- **Self-contained agents + prompts**: the built-in agent definitions (`scout` / `planner` / `reviewer` / `worker`, discovered by the extension from its own `agents/` directory) and the workflow prompts (`/implement` / `/scout-and-plan` / `/implement-and-review`, whose `prompts/` directory is registered automatically via `resources_discover`) all ship with the extension, so it works out of the box after `pi install` with no files to copy or symlink.
- To override a built-in agent, put a same-named `.md` in `~/.pi/agent/agents/` or in the project's `.pi/agents/` (with `agentScope: "both"`); **precedence is builtin < user < project**. See `extensions/afang-subagent/README.md` for details.

### ✅ todo

Forked from pi's official todo example and maintained independently. Tasks are organized in **two levels, phase → task**; a phase's progress is derived from its subtasks, and a persistent widget above the editor shows the current plan.

- **Batch planning**: `init` replaces the whole plan in one call; a single-phase plan can also be written flat as `items: [...]` (optionally with `phase` for its name, `Tasks` if omitted). This is a common way models write it, so it is synthesized automatically instead of forcing a retry. `append` adds a batch to a phase, creating the phase if it doesn't exist.
- **Five states**: `○ pending` / `◼ in_progress` / `✓ completed` / `− abandoned` / `! blocked`. A block can record a `reason`; completed or abandoned tasks are not reopened by a phase-level `block`.
- **Auto-advance**: after a successful mutation, at most one task in the whole list is `in_progress`; when none is in progress, the first pending task in phase/task order is started, skipping blocked ones. After `done` you normally don't need to call `start`.
- **Stable IDs and atomic operations**: tasks are addressed by the numeric ID in the receipt, or a whole group by phase name; within the current branch, `init` / `clear` / `rm` never reuse IDs. If an operation fails validation, the whole operation is discarded and no IDs are consumed. Task text must be unique within a phase.
- **Restore and compatibility**: the full snapshot is stored in the tool result's `details.phases` and restored when a session loads or a branch switches. Legacy `details.todos` (including the `done` boolean format) is restored into the default `Tasks` phase; old error results never overwrite a valid state. `view` is read-only and does not move the pointer.
- **Rendering (aligned with omp)**: task rows use **ASCII checkboxes** `[x]` / `[ ]`, and state is conveyed by **color + strikethrough**. Completed is a success-colored check with strikethrough, abandoned is an error-colored empty box with strikethrough, in_progress is an accent-colored empty box (**the symbol doesn't change**, so the checkbox column stays aligned when scanning vertically), blocked is a warning-colored empty box + `(blocked: reason)`, and pending is dimmed. Tasks hang under their phase with **tree connectors** `├─` / `└─`, and the "N more" line is the final `└─` row. The phase header is "number + name + ` · closed/total`", with the active phase in bold accent and the rest muted, and **no status icon**; **with a single phase, the phase header is omitted** (so the `Tasks` phase produced by a flat init doesn't add a pointless line). Two deliberate differences from omp: Arabic instead of Roman numerals (more readable, stable width), and **task IDs are shown** as `#4` (omp addresses tasks by their original text and so has no IDs; we do, and showing them makes them easy to refer to in conversation).
- **The collapsed preview's "walking window"**: trailing closed tasks lead (extra, not counted against the open-task quota), then it extends from the current task to 8 rows, and `… N more tasks` counts only **unfinished** tasks that didn't fit. This way a checked-off row is always visible even when tasks complete out of order. The only deviation from omp: when the window isn't full (the current task is near the end), a few more closed tasks are pulled in from before it to fill the space, which is more informative than leaving it blank.
- **Display levels**: the widget and the collapsed receipt expand the current phase and the phase(s) touched by the latest operation (plus any phase that has no active task but has blocked tasks); other phases keep just a one-line header. `completed + abandoned` count as closed, while blocked is counted separately. `/todos` supports arrow keys and PgUp/PgDn to scroll through the full list, and expanding the tool result also shows every task. All three renderers (widget / tool result / `/todos`) **share the same `taskLine` and `treeLines`**, so they can never disagree.
- **Model context (injected in three places, all purely informational and never interfering with control flow)**: the tool result **is always fully expanded** as a hierarchical snapshot (overall progress + current task + the full phase tree), and it is the **single authoritative carrier of state**.
  - `before_agent_start`: a static `todo_guide` + a compact `todo_state` (one line of counts + the current task, about 30 tokens; for details the model calls `view` itself). The unfinished plan is always visible at the start of a turn without restating the whole list every turn. It fires once per user prompt (independent of how many tool calls follow).
  - **eager prelude**: when the list is empty and this is the **first** user message of the session, a hidden suggestion is injected (lay out a phased plan with a single `init` first). Prompts ending in `?` / `？` / `!` / `！` are questions rather than assignments and are not nudged; once a list exists, `todo_state` takes over, so the two are naturally mutually exclusive and never pressure twice. It only matches omp's `preferred` tier (a suggestion, not a requirement), because pi has no interface to force `tool_choice` and because pi places handler messages **after** the user message (omp places them before).
  - `session_compact`: compaction summarizes away **the tool results that carry the plan**, while `before_agent_start` only fires on a user prompt and can't cover the window of an automatic continuation. So a message is injected on the spot: a state summary if there is a plan, or a restated eager prelude if not. It also uses `triggerTurn: false` and never starts a turn on its own.
  - `turn_end`: the **mid-run nudge** fires once the count of "mutating tools" (`bash`/`edit`/`write` etc.; failures don't count) reaches ≥ 12, at most 2 times per user prompt, and any `todo` call resets the counter. The content is a single line, "N items still unfinished" (about 30 tokens), **without the list**. Reading files or searching never triggers it, however much; it is also skipped when the model made no tool calls this turn (it is wrapping up). It **only appends `entries` and never returns `continue`**.
  - On a failed call: a hidden reminder is added (the plan is unchanged, the user can't see progress, fix the arguments and retry). From the second failure in a row it switches to "stop retrying: change the arguments or leave the plan as it is and continue", because a reminder that keeps saying "call todo again" only drives a retry loop; a success or a new user prompt resets the streak. It uses `triggerTurn: false` rather than `deliverAs: "nextTurn"`, because in pi the latter isn't delivered until the next user prompt, which is too late for a mid-run failure.
- **Deliberately no control-flow intervention**: it never blocks wrapping up because "todos are still unfinished"; when to stop is entirely up to the model. We once built an `agent_before_settle` interception + automatic continuation following omp's `checkCompletion` (with six exits: a blocked exemption, a count cap, disabled in subagents, and so on), and after testing **scrapped it entirely**: it first has to decide whether the model is waiting for a user's answer, which can only be done with keyword/regex heuristics, and a miss forces a continuation and has the model make decisions for the user, which fails in the dangerous direction. A real counterexample: "I'd need you to confirm…" has no "please" and doesn't end with a question mark, so it was missed. There are endless ways to say "I'm waiting on you" in natural language, so patching the regex is whack-a-mole; **don't try this again**.

The parameters visible to the model are `action` plus the optional `phases` / `items` / `id` / `phase` / `reason`; the legacy `add` / `set` / `list` actions are no longer declared, but historical calls can still be restored and rendered.

| action | Parameters | Effect |
|---|---|---|
| `init` | `phases: [{name, items: string[]}]`, or flat `items` (+ optional `phase`) | Replace the plan; `phases: []` clears it |
| `append` | `phase`, `items: string[]` | Append a batch of tasks |
| `start` | `id` | Set the current task; the previously in-progress task goes back to pending; can also reopen a closed task |
| `done` / `drop` | `id` or `phase`; if neither is given, applies to all | Complete / abandon |
| `block` / `unblock` | `id` or `phase` is required; `block` can take a `reason` | Block / unblock (auto-advance then proceeds as usual) |
| `rm` | `id` or `phase`; if neither is given, removes everything | Remove the target tasks and empty phases |
| `view` / `clear` | none | View the full plan / clear the whole plan |

**Parameter leniency**: some models fill every optional parameter, often echoing the previous call's `id` / `phase`. An argument check that such a model can only satisfy by *omitting* a field traps it in a retry loop, so stray-but-harmless arguments are applied in the safe direction and reported in the result message (`... Ignored phase="X" (...)`) instead of failing the call. Concretely: before schema validation, fields that don't apply to the current action are dropped (e.g. `reason` on `done`, `items` on `view`, `null` values). When `done`/`drop`/`block`/`unblock`/`rm` receive both `id` and `phase`, the narrower target `id` always wins (touching one task when a whole phase was meant is a recoverable under-reach; the reverse would close or delete work by mistake). `clear` with an `id`/`phase` simply clears when nothing unfinished is left; if pending/in-progress/blocked tasks would be discarded it asks once ("use `rm` to remove only some tasks, or call `clear` again"), and the very next `clear` call confirms, whatever its arguments, while any other `todo` call disarms the confirmation. The remaining errors: both targets explicitly blank (`null` / `""`, never silently widened to "every task"); `start` without an `id` (`phase` is meaningless for `start`, so it never silently matches a whole group); a non-existent `id` (never falls back to the phase). Error messages echo the offending values, and the failure reminder includes the arguments received. Task/phase names and blockers are sanitized of ANSI and have whitespace collapsed into a single line.

```json
{"action":"init","phases":[{"name":"Research","items":["Check the API","Confirm the boundaries"]},{"name":"Implement","items":["Make the change","Verify the behavior"]}]}
```

In a new session the tasks above get `#1`–`#4`, and `#1` starts automatically; `{"action":"done","id":1}` advances to `#2`. Always go by the IDs in the latest receipt. IDs keep growing when a session is reused or the plan is redone.

State and integration tests: `bun test tests/todo.test.ts` (the local pi types/runtime packages must be resolvable).

- **Stacking order with `pi-powerline-footer`**: the vertical order of `aboveEditor` widgets is determined by the insertion order of the *first* `setWidget` call (repeated `setWidget` calls with the same key are moved to the bottom). This extension registers once in `session_start` and refreshes content only via `requestRender`, so it reliably stays **above** the powerline status bar.
  This assumes this extension **receives `session_start` before `pi-powerline-footer`**, and event dispatch order = extension load order = pi's discovery order:
  ① project-level `.pi/extensions/` → ② global `~/.pi/agent/extensions/` → ③ `packages` in `settings.json` (in array order).
  So an extension placed in `~/.pi/agent/extensions/` (for example symlinked from a local checkout) naturally loads before every entry in `packages`, with no extra configuration;
  if you install it through `packages` with `pi install` instead, `my-pi-plugins` must be listed **before** `npm:pi-powerline-footer`.

### 🎨 gruvbox-dark

The classic dark, retro warm-toned gruvbox theme.

- Dark brown `bg`, with soft, saturated `red` / `yellow` / `green` / `blue` accents.
- High contrast, comfortable for long sessions.
- Looks best together with the `pi-powerline-footer` status bar.

## Installation

```bash
pi install https://github.com/Yifang-Qin/my-pi-plugins
```

After installing:

- **Extensions take effect automatically**: the tmux-backed bash, `@` fuzzy file completion, and the other extensions work immediately with nothing else to do.
- **Pick the theme once**: installing only makes `gruvbox-dark` appear in the list of available themes. Activate it by running
  `/theme gruvbox-dark` once (or set `"theme": "gruvbox-dark"` in `~/.pi/agent/settings.json`).
  This is how pi works: a package cannot force-select a theme for the user.

## New machine, step by step (plugins and personalization only; no models/keys)

1. **Install pi itself** (see the [official docs](https://pi.dev)), and optionally install external dependencies as needed:
   `tmux` (required for tmux-bash backgrounding; without it the bash tool reports that it is unavailable),
   `fd` (speeds up fuzzy-file-finder; without it, it falls back to `git ls-files`),
   `ffmpeg` + `yt-dlp` (video frame extraction for pi-web-access).
   On macOS use `brew install tmux fd ffmpeg yt-dlp`; on Linux use the matching package manager (e.g. `apt install tmux fd-find`).
2. **Install this package**

   ```bash
   pi install https://github.com/Yifang-Qin/my-pi-plugins
   ```

3. **Install the companion npm packages**

   ```bash
   pi install npm:pi-powerline-footer
   pi install npm:pi-web-access
   ```

   Install `pi-powerline-footer` at latest (currently 0.19.1; peer `>=0.81.0` with no upper bound; verified on pi 1.1.0).
   An older setup pinned `pi-powerline-footer@0.7.0` to avoid the scroll ghosting of the 0.8.0 fixed editor under tmux. That pin has been removed: on pi
   0.84+ it breaks startup because of the peer incompatibility, and since powerline 0.9.0 its self-managed fixed editor is gone, with the fixed input box
   now handled by pi's native fullscreen mode (the default since pi 1.0). For background, see the [tmux-bash compatibility notes](extensions/tmux-bash/README.md#compatibility-with-pi-powerline-footer).

4. **Personalize**: add the following to `~/.pi/agent/settings.json` (or simply pick the theme with `/theme gruvbox-dark`):

   ```json
   {
     "theme": "gruvbox-dark",
     "powerline": { "preset": "default", "placement": "above" }
   }
   ```

5. **Verify**: start pi. Typing `@` should pop up the fuzzy file picker, the `/find-file`, `/nav`, and `/todos` commands should be available,
   and the powerline status bar should appear at the bottom.

## Uninstalling

```bash
pi remove https://github.com/Yifang-Qin/my-pi-plugins
```

After removal the extensions stop working automatically; if this theme was selected, pi falls back to the default theme.

## How installation works

pi works by **registering a reference and loading by reference at startup**; it does not copy the whole repo into `~/.pi`:

- `pi install https://...` (or `git:...`) clones the repo to `~/.pi/agent/git/<host>/<path>/`
  and registers a reference in the `packages` array of `~/.pi/agent/settings.json`.
- At startup pi reads `packages[]` and, following each package's `pi` manifest, loads `extensions/*.ts` and
  `themes/*.json`. Extensions are enabled by default, and themes are added to the list of available ones.
- `pi remove` only deletes the reference from `packages`; it leaves no stray files in `~/.pi`.

Use `pi config` to enable/disable an individual extension or theme, and `pi update --extensions` to update installed packages.
