import { test } from "bun:test";
import assert from "node:assert/strict";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import todoExtension from "../extensions/todo.ts";
import { stripNonSgrAnsi } from "../extensions/shared/terminal-text.ts";
import {
	allTasks,
	applyTodo,
	emptyTodoState,
	readTodoSnapshot,
	restoreTodos,
	snapshotText,
	TodoSchema,
	type TodoDetails,
	type TodoParams,
	type TodoState,
} from "../extensions/shared/todo-state.ts";

const init = (): TodoState =>
	applyTodo(emptyTodoState(), {
		action: "init",
		phases: [
			{ name: "调研", items: ["接口", "边界"] },
			{ name: "实现", items: ["编码", "验证"] },
		],
	}).state;
const statuses = (state: TodoState) => allTasks(state.phases).map((task) => task.status);
const entry = (details: unknown, isError = false) => ({
	type: "message",
	message: { role: "toolResult", toolName: "todo", details, isError },
});
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));

test("init 一次创建两层计划；全清单仅一个 active；done 自动跨 phase 推进", () => {
	let state = init();
	assert.deepEqual(
		allTasks(state.phases).map((task) => task.id),
		[1, 2, 3, 4],
	);
	assert.deepEqual(statuses(state), ["in_progress", "pending", "pending", "pending"]);
	state = applyTodo(state, { action: "done", phase: "调研" }).state;
	assert.deepEqual(statuses(state), ["completed", "completed", "in_progress", "pending"]);
	state = applyTodo(state, { action: "done", id: 3 }).state;
	assert.deepEqual(statuses(state), ["completed", "completed", "completed", "in_progress"]);
});

test("手动跳到后续 phase，再完成时回到最早 pending；已完成任务不会重开", () => {
	let state = applyTodo(init(), { action: "start", id: 4 }).state;
	assert.deepEqual(statuses(state), ["pending", "pending", "pending", "in_progress"]);
	state = applyTodo(state, { action: "done", id: 4 }).state;
	assert.deepEqual(statuses(state), ["in_progress", "pending", "pending", "completed"]);
	assert.match(snapshotText(state.phases), /later completed tasks stay closed/);
});

test("block 保留已关闭任务，清理 blocker，全部阻塞时没有 active", () => {
	let state = applyTodo(init(), { action: "done", id: 1 }).state;
	state = applyTodo(state, { action: "drop", id: 2 }).state;
	state = applyTodo(state, { action: "block", phase: "调研", reason: "不应重开" }).state;
	assert.deepEqual(statuses(state), ["completed", "abandoned", "in_progress", "pending"]);
	state = applyTodo(state, { action: "block", phase: "实现", reason: " 等待\n\x1b[31m用户\x1b[0m \t确认 " }).state;
	assert.deepEqual(statuses(state), ["completed", "abandoned", "blocked", "blocked"]);
	assert.equal(state.phases[1].tasks[0].blocker, "等待 用户 确认");
	assert.match(snapshotText(state.phases), /No actionable tasks/);
	state = applyTodo(state, { action: "unblock", phase: "实现" }).state;
	assert.deepEqual(statuses(state), ["completed", "abandoned", "in_progress", "pending"]);
	assert.ok(allTasks(state.phases).every((task) => task.blocker === undefined));
});

test("block 自动切到下一 pending；重复 block 可清空 reason；start 可重开并清除 blocker", () => {
	let state = applyTodo(init(), { action: "block", id: 1, reason: "等用户" }).state;
	assert.deepEqual(statuses(state), ["blocked", "in_progress", "pending", "pending"]);
	state = applyTodo(state, { action: "block", id: 1 }).state;
	assert.equal(state.phases[0].tasks[0].blocker, undefined);
	state = applyTodo(state, { action: "start", id: 1 }).state;
	assert.deepEqual(statuses(state), ["in_progress", "pending", "pending", "pending"]);
	state = applyTodo(state, { action: "drop", id: 1 }).state;
	state = applyTodo(state, { action: "start", id: 1 }).state;
	assert.equal(statuses(state)[0], "in_progress");
});

test("init/clear/rm 和 JSON 恢复都不复用当前分支 ID", () => {
	let state = init();
	state = applyTodo(state, { action: "init", phases: [{ name: "新计划", items: ["新任务"] }] }).state;
	assert.equal(state.phases[0].tasks[0].id, 5);
	assert.throws(() => applyTodo(state, { action: "done", id: 1 }), /not found/);
	state = applyTodo(state, { action: "rm", phase: "新计划" }).state;
	assert.deepEqual(state, { phases: [], nextId: 6 });
	state = applyTodo(state, { action: "append", phase: "后续", items: ["任务"] }).state;
	state = applyTodo(state, { action: "clear" }).state;
	state = restoreTodos(roundTrip([entry({ action: "clear", version: 2, ...state })]));
	state = applyTodo(state, { action: "init", phases: [{ name: "重启", items: ["任务"] }] }).state;
	assert.equal(state.phases[0].tasks[0].id, 7);
});

test("批量失败原子回滚：重复名称、后一个空 phase、追加中途重复都不消耗 ID", () => {
	const state = init();
	const before = roundTrip(state);
	for (const params of [
		{
			action: "init",
			phases: [
				{ name: "a", items: ["x"] },
				{ name: " a ", items: ["y"] },
			],
		},
		{
			action: "init",
			phases: [
				{ name: "a", items: ["x"] },
				{ name: "b", items: [] },
			],
		},
		{ action: "init", phases: [{ name: "a", items: ["x", " x "] }] },
		{ action: "append", phase: "调研", items: ["新任务", "接口"] },
		{ action: "append", phase: "新阶段", items: ["新任务", "\n\t"] },
	] as TodoParams[]) {
		assert.throws(() => applyTodo(state, params));
		assert.deepEqual(state, before);
	}
	const next = applyTodo(state, { action: "append", phase: "新阶段", items: ["新任务", "接口"] }).state;
	assert.deepEqual(
		next.phases[2].tasks.map((task) => task.id),
		[5, 6],
	);
});

test("扁平 init 合成默认 phase；无关参数被忽略；目标歧义仍报错", () => {
	let state = applyTodo(emptyTodoState(), { action: "init", items: ["a", "b"] }).state;
	assert.equal(state.phases[0].name, "Tasks");
	assert.deepEqual(statuses(state), ["in_progress", "pending"]);
	state = applyTodo(state, { action: "init", phase: "开发", items: ["c"] }).state;
	assert.deepEqual(
		state.phases.map((phase) => phase.name),
		["开发"],
	);
	assert.equal(state.phases[0].tasks[0].id, 3); // 重新规划仍不复用 ID
	state = applyTodo(state, { action: "init", phases: [{ name: "P", items: ["x"] }], items: ["忽略"] }).state;
	assert.deepEqual(
		allTasks(state.phases).map((task) => task.text),
		["x"],
	); // phases 优先于扁平 items
	state = applyTodo(state, { action: "done", id: 4, reason: "忽略" }).state;
	assert.equal(statuses(state)[0], "completed");
	assert.deepEqual(applyTodo(state, { action: "view", items: [] }).state, state);
	assert.deepEqual(
		applyTodo(state, { action: "append", phase: "P", items: ["y"], id: 99 }).state.phases[0].tasks[1].id,
		5,
	);
});

test("目标歧义和缺少必填参数必须报错，不能误操作全部任务", () => {
	const state = init();
	for (const params of [
		{ action: "done", id: 1, phase: "调研" },
		{ action: "clear", id: 1 },
		{ action: "clear", phase: "调研" },
		{ action: "start" },
		{ action: "start", phase: "调研" }, // phase 对 start 无效 → 仍缺 id，不能静默命中整组
		{ action: "block" },
		{ action: "unblock" },
		{ action: "done", phase: "不存在" },
		{ action: "done", phase: "  " },
		{ action: "init" },
		{ action: "append", phase: "实现" },
		{ action: "done", id: 0 },
		{ action: "done", id: 1.5 },
		{ action: "done", id: 999 },
	] as TodoParams[])
		assert.throws(() => applyTodo(state, params));
	assert.deepEqual(state, init());
});

test("rm 删除目标和空 phase；无目标 done/drop/rm 操作全部", () => {
	let state = applyTodo(init(), { action: "rm", id: 1 }).state;
	assert.deepEqual(
		allTasks(state.phases).map((task) => task.id),
		[2, 3, 4],
	);
	assert.equal(statuses(state)[0], "in_progress");
	state = applyTodo(state, { action: "rm", phase: "调研" }).state;
	assert.equal(state.phases.length, 1);
	state = applyTodo(state, { action: "done" }).state;
	assert.deepEqual(statuses(state), ["completed", "completed"]);
	state = applyTodo(state, { action: "drop" }).state;
	assert.deepEqual(statuses(state), ["abandoned", "abandoned"]);
	state = applyTodo(state, { action: "rm" }).state;
	assert.deepEqual(state, { phases: [], nextId: 5 });
});

test("恢复旧 done/status 历史、旧 clear 的 ID 上界，坏结果不覆盖有效快照", () => {
	const entries = [
		entry({
			action: "toggle",
			todos: [
				{ id: 8, text: "旧任务", done: true },
				{ id: 9, text: "待办", done: false },
			],
		}),
		entry({
			action: "set",
			todos: [
				{ id: 8, text: "旧任务", status: "completed" },
				{ id: 9, text: "待办", status: "in_progress" },
			],
			nextId: 10,
		}),
	];
	let state = restoreTodos(entries);
	assert.equal(state.phases[0].name, "Tasks");
	assert.deepEqual(statuses(state), ["completed", "in_progress"]);
	const ignored = [
		entry({}),
		entry({ action: "clear", todos: [], nextId: 1 }, true),
		entry({ todos: [], error: "failed" }),
		entry({ phases: [{ name: "bad", tasks: [null] }] }),
	];
	assert.deepEqual(restoreTodos([...entries, ...ignored]), state);
	state = restoreTodos([...entries, entry({ action: "clear", todos: [], nextId: 1 })]);
	assert.deepEqual(state, { phases: [], nextId: 10 });
	state = applyTodo(state, { action: "append", phase: "新计划", items: ["新任务"] }).state;
	assert.equal(state.phases[0].tasks[0].id, 10);
});

test("view 不规范化旧多 active 状态；成功修改才规范化；快照之间互不污染", () => {
	const state = readTodoSnapshot({
		todos: [
			{ id: 1, text: "a", status: "in_progress" },
			{ id: 2, text: "b", status: "in_progress" },
		],
		nextId: 3,
	})!;
	const viewed = applyTodo(state, { action: "view" }).state;
	assert.deepEqual(viewed, state);
	const updated = applyTodo(state, { action: "append", phase: "Tasks", items: ["c"] }).state;
	assert.deepEqual(statuses(updated), ["in_progress", "pending", "pending"]);
	assert.deepEqual(statuses(state), ["in_progress", "in_progress"]);
	viewed.phases[0].tasks[0].text = "不要改到原快照";
	assert.equal(state.phases[0].tasks[0].text, "a");
});

test("按分支恢复独立历史，view 结果不覆盖 canonical 状态", () => {
	const planned = entry({ version: 2, action: "init", ...init() });
	const done = entry({ version: 2, action: "done", ...applyTodo(init(), { action: "done", id: 1 }).state });
	const clear = entry({ version: 2, action: "clear", phases: [], nextId: 5 });
	assert.equal(statuses(restoreTodos([planned, done]))[0], "completed");
	assert.equal(statuses(restoreTodos([planned]))[0], "in_progress");
	assert.deepEqual(restoreTodos([planned, clear]), { phases: [], nextId: 5 });
	assert.deepEqual(restoreTodos([planned, entry({ version: 2, action: "view", phases: [], nextId: 1 })]), init());
	assert.deepEqual(restoreTodos([]), emptyTodoState());
});

test("快照区分 completed/abandoned/blocked，并始终列出全部任务及 ID", () => {
	let state = applyTodo(init(), { action: "done", id: 1 }).state;
	state = applyTodo(state, { action: "drop", id: 2 }).state;
	state = applyTodo(state, { action: "block", id: 3, reason: "等依赖" }).state;
	const text = snapshotText(state.phases);
	assert.match(text, /1 completed, 1 abandoned, 1 open, 1 blocked/);
	assert.match(text, /#1 \[completed\] 接口/);
	assert.match(text, /#2 \[abandoned\] 边界/);
	assert.match(text, /#3 \[blocked\] 编码 — 等依赖/);
});

type Tool = ToolDefinition<typeof TodoSchema, TodoDetails>;
const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	strikethrough: (text: string) => `~${text}~`,
} as unknown as Theme;
function harness(mode = "tui") {
	let tool!: Tool;
	let widget!: Component & { dispose?: () => void };
	let panel!: Component;
	let installed = 0;
	let renders = 0;
	let active = ["todo"];
	let branch: unknown[] = [];
	const sent: { customType: string; text: string; options: unknown }[] = [];
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	let command!: { handler: (args: string, ctx: any) => Promise<void> };
	const tui = { terminal: { rows: 15 }, requestRender: () => renders++ };
	const ctx = {
		mode,
		sessionManager: { getBranch: () => branch },
		ui: {
			setWidget: (_name: string, factory: Function) => {
				installed++;
				widget = factory(tui, theme);
			},
			custom: async (factory: Function) => {
				panel = factory(tui, theme, {}, () => {});
			},
			notify: () => {},
		},
	} as unknown as ExtensionContext;
	todoExtension({
		on: (name: string, handler: (event: any, ctx: any) => any) => handlers.set(name, handler),
		registerTool: (definition: Tool) => {
			tool = definition;
		},
		registerCommand: (_name: string, definition: typeof command) => {
			command = definition;
		},
		getActiveTools: () => active,
		sendMessage: (message: any, options: unknown) =>
			sent.push({ customType: message.customType, text: message.content[0].text, options }),
	} as unknown as ExtensionAPI);
	return {
		tool,
		ctx,
		handlers,
		sent,
		call: async (params: TodoParams) => {
			const result = await tool.execute("test-call", params, undefined, undefined, ctx as ExtensionToolContext);
			branch.push(entry(roundTrip(result.details)));
			return result;
		},
		event: (name: string, event: unknown = {}) => handlers.get(name)!(event, ctx),
		// 跑一次 before_agent_start：返回写入的 sections 与 handler 结果（eager prelude）
		start: async (prompt = "帮我改个东西。", opts: { selectedTools?: string[] } = {}) => {
			const event = {
				prompt,
				systemPromptOptions: {
					selectedTools: opts.selectedTools ?? ["todo"],
					sections: {} as Record<string, string>,
				},
			};
			const result = await handlers.get("before_agent_start")!(event, ctx);
			return { sections: event.systemPromptOptions.sections, result };
		},
		compact: async (reason = "threshold") => await handlers.get("session_compact")!({ reason, willRetry: false }, ctx),
		// 跑一轮「N 次修改类工具 + turn_end」，返回 turn_end 的 boundary 结果
		turn: async (mutations: number, toolName = "bash") => {
			for (let i = 0; i < mutations; i++) await handlers.get("tool_result")!({ toolName, isError: false }, ctx);
			return await handlers.get("turn_end")!({ toolResults: [{ toolName }], message: {} }, ctx);
		},
		setBranch: (entries: unknown[]) => {
			branch = entries;
		},
		setActive: (tools: string[]) => {
			active = tools;
		},
		get branch() {
			return branch;
		},
		get widget() {
			return widget;
		},
		get installed() {
			return installed;
		},
		get renders() {
			return renders;
		},
		panel: async () => {
			await command.handler("", ctx);
			return panel;
		},
	};
}

test("注册真实入口：schema 只暴露新操作，串行执行，throw 不提交状态", async () => {
	const h = harness("json");
	assert.equal(h.tool.executionMode, "sequential");
	assert.deepEqual((h.tool.parameters.properties.action as unknown as { enum: string[] }).enum, [
		"init",
		"append",
		"start",
		"done",
		"drop",
		"block",
		"unblock",
		"rm",
		"view",
		"clear",
	]);
	assert.equal(h.tool.parameters.properties.id.type, "integer");
	const plan = await h.call({ action: "init", phases: [{ name: "开发", items: ["a", "b"] }] });
	await assert.rejects(() => h.call({ action: "append", phase: "开发", items: ["c", "a"] }), /Duplicate/);
	const view = await h.call({ action: "view" });
	assert.deepEqual(view.details.phases, plan.details.phases);
	assert.equal(view.details.nextId, 3);
	assert.equal(h.installed, 0);
	await h.call({ action: "done", id: 1 });
	assert.equal(plan.details.phases[0].tasks[0].status, "in_progress");
	view.details.phases[0].tasks[0].text = "回执独立于内存";
	assert.equal((await h.call({ action: "view" })).details.phases[0].tasks[0].text, "a");
});

test("session_start / session_tree 恢复；widget 只安装一次，空清单保留位置", async () => {
	const h = harness();
	await h.event("session_start");
	const planned = await h.call({ action: "init", phases: [{ name: "开发", items: ["a", "b"] }] });
	const branch = roundTrip(h.branch);
	await h.call({ action: "clear" });
	assert.deepEqual(h.widget.render(80), []);
	h.setBranch(branch);
	await h.event("session_tree");
	assert.deepEqual((await h.call({ action: "view" })).details.phases, planned.details.phases);
	assert.equal(h.installed, 1);
	assert.ok(h.renders > 0);
	h.widget.dispose?.();
	await h.event("session_start", { reason: "reload" });
	assert.equal(h.installed, 2);
	const resumed = harness();
	resumed.setBranch(roundTrip(branch));
	await resumed.event("session_start", { reason: "resume" });
	assert.deepEqual((await resumed.call({ action: "view" })).details.phases, planned.details.phases);
	h.setBranch([]);
	await h.event("session_start", { reason: "new" });
	assert.equal((await h.call({ action: "view" })).details.nextId, 1);
});

test("widget 跟随较晚 active；长清单可滚动；窄宽、中文和恶意控制符均安全", async () => {
	const h = harness();
	await h.event("session_start");
	await h.call({
		action: "init",
		phases: [{ name: "阶段\n二\x1b[2J", items: Array.from({ length: 30 }, (_, i) => `任务 ${i + 1} 中😀\r\x1b[1A文`) }],
	});
	await h.call({ action: "start", id: 25 });
	const visible = h.widget.render(100).join("\n");
	// 从当前任务往后铺（没有已关闭任务可领头）
	assert.match(visible, /#25/);
	assert.match(visible, /#30/);
	assert.doesNotMatch(visible, /#1 |#24 /);
	assert.deepEqual(visible.match(/#\d+/g), ["#25", "#26", "#27", "#28", "#29", "#30"]);
	assert.match(visible, /… 24 more tasks/);
	for (const width of [1, 10, 40, 80]) {
		for (const line of h.widget.render(width)) {
			assert.ok(visibleWidth(line) <= width);
			assert.equal(stripNonSgrAnsi(line), line); // truncateToWidth 的 SGR reset 是合法的
			assert.doesNotMatch(line, /[\r\n]/);
		}
	}
	const panel = await h.panel();
	assert.doesNotMatch(panel.render(100).join("\n"), /#30/);
	panel.handleInput!("\x1b[F"); // End
	assert.match(panel.render(100).join("\n"), /#30/);
});

test("渲染向 omp 对齐：ASCII 复选框 + 删除线 + 树形连接线 + 单 phase 无头", async () => {
	const h = harness();
	await h.event("session_start");
	// 单 phase：不显示 phase 头，任务直接做树根
	await h.call({ action: "init", items: ["完成项", "进行中", "放弃项", "阻塞项", "待办项"] });
	await h.call({ action: "done", id: 1 });
	await h.call({ action: "drop", id: 3 });
	await h.call({ action: "block", id: 4, reason: "等接口" });
	const lines = h.widget.render(100);
	assert.ok(!lines.some((line) => /^\s*1\. /.test(line))); // 单 phase 无头
	const body = lines.join("\n");
	assert.match(body, /├─ \[x\] #1 ~完成项~/); // 已完成：打勾 + 删除线
	assert.match(body, /├─ \[ \] #2 进行中/); // 进行中：空框（靠颜色区分）
	assert.match(body, /├─ \[ \] #3 ~放弃项~/); // 放弃：空框 + 删除线
	assert.match(body, /├─ \[ \] #4 阻塞项 \(blocked: 等接口\)/);
	assert.match(body, /└─ \[ \] #5 待办项/); // 最后一行收口
	assert.equal((body.match(/└─/g) ?? []).length, 1);
	// 多 phase：恢复 phase 头，任务缩进两格
	await h.call({
		action: "init",
		phases: [
			{ name: "调研", items: ["a"] },
			{ name: "实现", items: ["b"] },
		],
	});
	const multi = h.widget.render(100);
	assert.ok(multi.some((line) => line.includes("1. 调研") && line.includes(" · 0/1")));
	// 连接线必须与 phase **名称**起点同列（标签前缀 `N. ` 宽 3）
	const header = multi.find((line) => line.includes("1. 调研"))!;
	const task = multi.find((line) => line.includes("└─ [ ] #6 a"))!;
	assert.equal(task.indexOf("└"), header.indexOf("调"));
});

test("全部关闭的计划仍展示任务，且 widget / 面板都有左边距（reload 后实测的两个 bug）", async () => {
	const h = harness();
	await h.event("session_start");
	await h.call({
		action: "init",
		phases: [
			{ name: "调研", items: ["a", "b"] },
			{ name: "实现", items: ["c", "d", "e"] },
		],
	});
	await h.call({ action: "done" }); // 全部关闭 → 没有活跃任务
	// 模拟 reload：touchedPhases 被重置，之前这里会只剩两行光秃秃的 phase 标题
	const branch = roundTrip(h.branch);
	h.setBranch(branch);
	await h.event("session_start", { reason: "reload" });
	const lines = h.widget.render(100);
	const body = lines.join("\n");
	assert.match(body, /1\. 调研 · 2\/2/);
	assert.match(body, /2\. 实现 · 3\/3/);
	// 焦点回退到最后一个有任务的 phase，展示其已关闭任务
	assert.match(body, /└─ \[x\] #5 ~e~/);
	assert.ok(lines.length > 3, `不应只剩标题行：${JSON.stringify(lines)}`);
	// 所有非空行都有一列左边距（之前 phase 标题从第 0 列开始、贴着终端左边）
	for (const line of lines) if (line !== "") assert.match(line, /^ /, line);
	const panel = await h.panel();
	for (const line of panel.render(100)) if (line !== "") assert.match(line, /^ /, line);
});

test("折叠预览：已关闭任务领头，hidden 只数未完成项", async () => {
	const h = harness();
	await h.event("session_start");
	await h.call({ action: "init", items: Array.from({ length: 12 }, (_, i) => `t${i + 1}`) });
	// 关闭前 3 条 → 当前任务 #4，领头带一条已关闭的 #3
	for (const id of [1, 2, 3]) await h.call({ action: "done", id });
	const body = h.widget.render(100).join("\n");
	assert.match(body, /\[x\] #3 ~t3~/); // 领头的已关闭任务
	assert.doesNotMatch(body, /#1 |#2 /); // 更早的不展示
	assert.match(body, /\[ \] #4 t4/);
	assert.match(body, /… 1 more task$/m); // 9 条未完成，装下 8 条，剩 1（单数不加 s）
});

test("旧调用、未知 action、校验失败结果均可渲染", () => {
	const h = harness();
	const renderContext = {} as any;
	for (const action of ["add", "set", "toggle", "unknown"]) {
		const args = { action, id: 1, text: "旧\n任务", status: "completed" } as unknown as TodoParams;
		const result = {
			content: [{ type: "text" as const, text: "旧结果" }],
			details: { action, todos: [{ id: 1, text: "旧\n任务\x1b[1A", done: true }], nextId: 2 } as unknown as TodoDetails,
		};
		assert.ok(h.tool.renderCall!(args, theme, renderContext).render(80).length);
		const lines = h.tool.renderResult!(result, { expanded: true, isPartial: false }, theme, renderContext).render(80);
		for (const line of lines) assert.doesNotMatch(line, /[\r\n\x1b]/);
	}
	assert.ok(
		h.tool.renderResult!(
			{ content: [{ type: "text", text: "Invalid args" }], details: {} as TodoDetails },
			{ expanded: false, isPartial: false },
			theme,
			renderContext,
		).render(80).length,
	);
});

test("工具结果始终全展开（已关闭 phase 不再折叠）", async () => {
	const h = harness("json");
	await h.call({
		action: "init",
		phases: [
			{ name: "调研", items: ["a"] },
			{ name: "实现", items: ["b"] },
		],
	});
	const part = (await h.call({ action: "done", phase: "调研" })).content[0];
	const text = part.type === "text" ? part.text : "";
	assert.match(text, /#1 \[completed\] a/); // 旧版此处是「(closed; view shows task IDs)」
	assert.doesNotMatch(text, /view shows task IDs/);
});

test("失败调用补一条隐藏提醒，用 triggerTurn:false 而非 nextTurn", async () => {
	const h = harness("json");
	await h.call({ action: "init", phases: [{ name: "开发", items: ["a"] }] });
	await assert.rejects(() => h.call({ action: "done", id: 99 }));
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0].customType, "todo-error-reminder");
	assert.match(h.sent[0].text, /plan is unchanged and its progress is not visible/);
	assert.match(h.sent[0].text, /Todo #99 not found/);
	assert.deepEqual(h.sent[0].options, { triggerTurn: false });
	await h.call({ action: "view" }); // 成功调用不再发提醒
	assert.equal(h.sent.length, 1);
});

test("mid-run nudge：按修改类工具计数、每轮上限 2、极简且永不 continue", async () => {
	const h = harness("json");
	await h.call({ action: "init", phases: [{ name: "开发", items: ["a", "b", "c"] }] });
	assert.equal(await h.turn(11), undefined); // 未达阈值
	const first = await h.turn(1); // 累计 12
	assert.equal(first.entries.length, 1);
	assert.equal(first.entries[0].customType, "todo-nudge");
	assert.equal(first.continue, undefined); // 绝不延长 run / 拦收工
	assert.match(first.entries[0].content, /3 todo items still open/);
	assert.doesNotMatch(first.entries[0].content, /#1|\[pending\]/); // 不带清单
	assert.ok(first.entries[0].content.length < 220); // 体积可控
	assert.equal(await h.turn(11), undefined); // 触发后计数器归零
	assert.ok((await h.turn(1)).entries); // 第 2 次
	assert.equal(await h.turn(20), undefined); // 本轮配额用尽
});

test("nudge 门槛：只读工具/失败不计数、todo 调用清零、收工轮不插话", async () => {
	const h = harness("json");
	await h.call({ action: "init", phases: [{ name: "开发", items: ["a"] }] });
	assert.equal(await h.turn(30, "read"), undefined); // 读 30 个文件 → 一次也不注入
	assert.equal(await h.turn(30, "grep"), undefined);
	for (let i = 0; i < 30; i++) await h.event("tool_result", { toolName: "bash", isError: true });
	assert.equal(await h.turn(0), undefined); // 失败的修改不计数
	await h.turn(11);
	await h.event("tool_result", { toolName: "todo", isError: false }); // todo 调用清零
	assert.equal(await h.turn(1), undefined);
	// 本轮没调工具（模型正在收工）→ 不插话
	await h.turn(12);
	assert.equal(await h.handlers.get("turn_end")!({ toolResults: [], message: {} }, h.ctx), undefined);
});

test("nudge 在未激活/无可执行项时不触发；before_agent_start 重置预算", async () => {
	const h = harness("json");
	await h.call({ action: "init", phases: [{ name: "开发", items: ["a"] }] });
	h.setActive([]);
	assert.equal(await h.turn(12), undefined);
	h.setActive(["todo"]);
	await h.call({ action: "block", phase: "开发", reason: "等用户" });
	assert.equal(await h.turn(12), undefined); // 全部 blocked → 不催
	await h.call({ action: "unblock", phase: "开发" });
	assert.ok((await h.turn(12)).entries);
	assert.ok((await h.turn(12)).entries); // 第 2 次
	assert.equal(await h.turn(12), undefined); // 配额用尽
	const prompt = { systemPromptOptions: { selectedTools: ["todo"], sections: {} as Record<string, string> } };
	await h.event("before_agent_start", prompt); // 新 user prompt → 预算重置
	assert.ok((await h.turn(12)).entries);
});

test("system prompt 注入静态 guide + 紧凑状态摘要；不挂 context / 不做收工拦截", async () => {
	const h = harness("json");
	// 有未完成项：一行计数 + 当前任务，**不**重述全量清单
	await h.call({ action: "init", phases: [{ name: "开发", items: ["a", "b", "c"] }] });
	let sections = (await h.start()).sections;
	assert.match(sections.todo_guide, /init/);
	assert.doesNotMatch(sections.todo_guide, /`set`|`add`|`list`/);
	assert.match(sections.todo_state, /3 open, 0 blocked, 0\/3 closed/);
	assert.match(sections.todo_state, /Current: #1 a\./);
	assert.match(sections.todo_state, /fine to stop and hand back to the user/);
	assert.doesNotMatch(sections.todo_state, /#2|#3/); // 全量清单由 view 提供
	assert.ok(sections.todo_state.length < 300);
	// 全部 blocked：不再声称有当前任务
	await h.call({ action: "block", phase: "开发", reason: "等用户" });
	sections = (await h.start()).sections;
	assert.match(sections.todo_state, /0 open, 3 blocked/);
	assert.match(sections.todo_state, /No actionable task/);
	// 全部关闭：提示 clear / init
	await h.call({ action: "unblock", phase: "开发" });
	await h.call({ action: "done" });
	sections = (await h.start()).sections;
	assert.match(sections.todo_state, /fully closed \(3\/3\)/);
	// todo 未激活：两个 section 都不写
	sections = (await h.start("做事", { selectedTools: [] })).sections;
	assert.deepEqual(sections, {});
	// 刻意不挂的两个钩子
	assert.ok(!h.handlers.has("context"));
	assert.ok(!h.handlers.has("agent_before_settle")); // 收工拦截已整体撑销
});

test("eager prelude：仅会话首条 user 消息 + 空清单 + 非提问时建议先铺计划", async () => {
	const h = harness("json");
	const first = await h.start("帮我重构登录模块。");
	assert.equal(first.result.message.customType, "todo-eager-prelude");
	assert.match(first.result.message.content[0].text, /Consider calling `todo` first/);
	assert.match(first.result.message.content[0].text, /Skip it for trivial single-step work/);
	assert.equal(first.sections.todo_state, undefined); // 与 todo_state 天然互斥
	// 提问 / 感叹结尾 → 不推
	for (const prompt of ["这个怎么实现？", "why does it fail?", "太好了！", "nice!"])
		assert.equal((await h.start(prompt)).result, undefined, prompt);
	// todo 未激活 → 不推
	assert.equal((await h.start("做事", { selectedTools: [] })).result, undefined);
	// 已有清单 → 不推，改走 todo_state
	await h.call({ action: "init", phases: [{ name: "开发", items: ["a"] }] });
	const withPlan = await h.start("继续。");
	assert.equal(withPlan.result, undefined);
	assert.match(withPlan.sections.todo_state, /1 open/);
	// 非首条（分支里已有 user 消息）→ 不推
	const resumed = harness("json");
	resumed.setBranch([{ type: "message", message: { role: "user", content: [] } }]);
	assert.equal((await resumed.start("再来一个任务。")).result, undefined);
});

test("compaction 后补注入：有计划补状态摘要，没计划重申 eager", async () => {
	const h = harness("json");
	await h.compact();
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0].customType, "todo-compaction-reminder");
	assert.match(h.sent[0].text, /Consider calling `todo` first/);
	assert.deepEqual(h.sent[0].options, { triggerTurn: false }); // 不自己拉起一轮
	// 有计划：压缩吃掉了承载计划的工具结果 → 当场补一份摘要
	await h.call({ action: "init", phases: [{ name: "开发", items: ["a", "b"] }] });
	await h.compact("overflow");
	assert.match(h.sent[1].text, /Compaction dropped earlier context/);
	assert.match(h.sent[1].text, /2 open, 0 blocked, 0\/2 closed/);
	assert.match(h.sent[1].text, /Current: #1 a\./);
	assert.doesNotMatch(h.sent[1].text, /#2/); // 不重述全量清单
	// 未激活 → 不注入
	h.setActive([]);
	await h.compact();
	assert.equal(h.sent.length, 2);
});
