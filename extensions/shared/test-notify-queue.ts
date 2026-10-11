// shared/notify-queue.ts 的状态机与体积预算测试（bun 运行，不需要 tmux / 网络 / pi 进程）。
// 用法：仓库根目录执行 `bun extensions/shared/test-notify-queue.ts`。
//
// 用一个假的 ExtensionAPI 记录 pi.on 注册的 handler 与 sendMessage 调用，手动按 pi 1.1.0 的真实顺序
// 发事件（agent_start → turn_end → message_end → agent_settled / before_agent_start）来驱动队列。
// 「pi 把消息放进 transcript」由测试手动发 message_end 模拟；「Esc 清队列」= 不发 message_end。
import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { makeBgNotifyFramer, parseBgNotifyFrame } from "./bg-notify.ts";
import { createNotifyQueue, truncateUtf8Head, type NotifyQueue } from "./notify-queue.ts";

let failed = 0;
function check(name: string, cond: boolean, extra?: string) {
	console.log(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!cond) failed++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Sent = { message: { customType: string; content: string; details: { batchId: string; items: { id: string }[]; indexedOnly: number; spillFile?: string } }; options?: { deliverAs?: string; triggerTurn?: boolean } };
type Item = { id: string; text: string };

function harness(overrides: Partial<Parameters<typeof createNotifyQueue<Item>>[1]> = {}) {
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const sent: Sent[] = [];
	const pi = {
		on(name: string, fn: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), fn]);
			return () => {};
		},
		sendMessage(message: Sent["message"], options?: Sent["options"]) {
			sent.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	const framer = makeBgNotifyFramer("Test notification — NOT a message from the user.");
	const q: NotifyQueue<Item> = createNotifyQueue<Item>(pi, {
		customType: "test-notify",
		frame: framer.frame,
		header: (n) => (n > 1 ? `${n} items finished (in completion order):` : ""),
		renderItem: (it, budget) => {
			const t = truncateUtf8Head(it.text, budget);
			return { text: `## ${it.id}\n${t.text}${t.truncated ? "\n[truncated]" : ""}`, truncated: t.truncated };
		},
		indexLine: (it) => `- ${it.id}`,
		itemDetails: (it) => ({ id: it.id }),
		maxItemBytes: 12 * 1024,
		totalBudgetBytes: 24 * 1024,
		minItemBytes: 1024,
		idleDebounceMs: 300,
		...overrides,
	});
	const emit = (name: string, event: Record<string, unknown> = {}, ctx: Record<string, unknown> = {}) => {
		let result: unknown;
		for (const fn of handlers.get(name) ?? []) result = fn({ type: name, ...event }, ctx) ?? result;
		return result;
	};
	// 模拟 pi 把某条消息放进 transcript。
	const deliver = (message: Sent["message"]) =>
		emit("message_end", { message: { role: "custom", customType: message.customType, details: message.details } });
	const payloadOf = (s: Sent | { message: Sent["message"] } | undefined) =>
		s ? (parseBgNotifyFrame(s.message.content)?.payload ?? "<not framed>") : "";
	const idsOf = (s: Sent | undefined) => s?.message.details.items.map((i) => i.id).join(",") ?? "";
	return { q, sent, emit, deliver, payloadOf, idsOf };
}
const normalTurn = { message: { role: "assistant", stopReason: "toolUse" } };

// 1. 空闲：几乎同时完成的两条攒成一条，triggerTurn 唤醒；确认后出队。
{
	const h = harness();
	h.q.enqueue({ id: "A", text: "a-out" });
	await sleep(50);
	h.q.enqueue({ id: "B", text: "b-out" });
	check("空闲：攒批窗口内不立即发送", h.sent.length === 0);
	await sleep(400);
	check("空闲：合并成 1 条消息", h.sent.length === 1, String(h.sent.length));
	check("空闲：steer + triggerTurn 唤醒", h.sent[0]?.options?.deliverAs === "steer" && h.sent[0]?.options?.triggerTurn === true);
	check("空闲：按完成先后排列", h.idsOf(h.sent[0]) === "A,B", h.idsOf(h.sent[0]));
	check("空闲：带随机边界通知框与批次标题", h.payloadOf(h.sent[0]).startsWith("2 items finished"));
	check("空闲：未确认前留在 inflight", h.q.snapshot().inflight === 2);
	h.deliver(h.sent[0].message);
	check("空闲：message_end 确认后出队", h.q.snapshot().inflight === 0 && h.q.snapshot().pending === 0);
}

// 2. 运行中：不碰 pi 队列，turn_end 一次合并发出（对齐「同一 turn 边界送达」）。
{
	const h = harness();
	h.emit("agent_start");
	h.q.enqueue({ id: "A", text: "a" });
	await sleep(400);
	h.q.enqueue({ id: "B", text: "b" });
	check("运行中：攒批窗口过后也不自行发送", h.sent.length === 0);
	h.emit("turn_end", normalTurn);
	check("运行中：turn_end 合并发出 1 条", h.sent.length === 1 && h.idsOf(h.sent[0]) === "A,B", h.idsOf(h.sent[0]));
	h.deliver(h.sent[0].message);
	h.emit("agent_settled", { aborted: false });
	check("运行中：确认后 settle 不再重发", h.sent.length === 1 && h.q.snapshot().pending === 0);
}

// 3. Esc：已发出但被 pi 清队列（无 message_end）→ settle(aborted) 退回、不唤醒 → 随下次输入带上。
{
	const h = harness();
	h.emit("agent_start");
	h.q.enqueue({ id: "A", text: "a" });
	h.emit("turn_end", normalTurn);
	const firstBatch = h.sent[0]?.message.details.batchId;
	h.emit("agent_settled", { aborted: true });
	check("Esc：未确认批次退回 pending", h.q.snapshot().pending === 1 && h.q.snapshot().inflight === 0);
	await sleep(400);
	check("Esc：不唤醒模型", h.sent.length === 1);
	const r = h.emit("before_agent_start") as { message?: Sent["message"] } | undefined;
	check("Esc：下次输入时随 before_agent_start 带上", r?.message?.details.items[0]?.id === "A");
	check("Esc：重发用新批次 id", !!r?.message && r.message.details.batchId !== firstBatch);
	if (r?.message) h.deliver(r.message);
	check("Esc：送达后出队", h.q.snapshot().pending === 0 && h.q.snapshot().inflight === 0);
}

// 4. 被中断的那一轮 turn_end 不发（否则消息滞留 pi 队列、下次 run 补投 → 与我们的重发重复）。
{
	const h = harness();
	h.emit("agent_start");
	h.q.enqueue({ id: "A", text: "a" });
	h.emit("turn_end", { message: { role: "assistant", stopReason: "aborted" } });
	check("中断轮：turn_end 不发送", h.sent.length === 0);
	h.emit("turn_end", normalTurn, { signal: AbortSignal.abort() });
	check("中断信号已触发：turn_end 不发送", h.sent.length === 0);
	h.emit("agent_settled", { aborted: true });
	h.q.enqueue({ id: "C", text: "c" });
	await sleep(400);
	check("中断后新的唤醒性完成：连同旧条目一起发出", h.sent.length === 1 && h.idsOf(h.sent[0]) === "A,C", h.idsOf(h.sent[0]));
}

// 5. wake:false（用户 kill）：空闲时不唤醒，等下次输入。
{
	const h = harness();
	h.q.enqueue({ id: "K", text: "killed" }, { wake: false });
	await sleep(400);
	check("wake:false：空闲时不发送", h.sent.length === 0);
	const r = h.emit("before_agent_start") as { message?: Sent["message"] } | undefined;
	check("wake:false：随下次输入带上", r?.message?.details.items[0]?.id === "K");
}

// 6. 最后一个 turn_end 之后、settle 之前完成的：settle(非中断) 时立即发出。
{
	const h = harness();
	h.emit("agent_start");
	h.emit("turn_end", normalTurn);
	h.q.enqueue({ id: "L", text: "late" });
	h.emit("agent_settled", { aborted: false });
	check("尾部完成：settle 时发出并唤醒", h.sent.length === 1 && h.sent[0]?.options?.triggerTurn === true);
}

// 7. 换会话 / 退出：清空。
{
	const h = harness();
	h.q.enqueue({ id: "X", text: "x" });
	h.emit("session_shutdown", { reason: "new" });
	await sleep(400);
	check("session_shutdown：清空且不再发送", h.sent.length === 0 && h.q.snapshot().pending === 0);
}

// 8. 体积预算：平分 / 再分配 / 降级索引 / 落盘。
{
	const big = "x".repeat(20 * 1024);
	const h = harness();
	for (const id of ["A", "B", "C", "D", "E"]) h.q.enqueue({ id, text: big });
	await sleep(400);
	const p = h.payloadOf(h.sent[0]);
	check("预算：5 条大输出全部内联", ["A", "B", "C", "D", "E"].every((id) => p.includes(`## ${id}`)));
	check("预算：整条正文约束在 24KB 量级", Buffer.byteLength(p) < 25 * 1024, `${Buffer.byteLength(p)}B`);

	const h2 = harness();
	h2.q.enqueue({ id: "BIG", text: big });
	h2.q.enqueue({ id: "s1", text: "small" });
	h2.q.enqueue({ id: "s2", text: "small" });
	await sleep(400);
	const bigSection = h2.payloadOf(h2.sent[0]).split("\n\n---\n\n")[0];
	check("预算：短条目省下的预算补给被截的大条目（≈12KB 上限）", Buffer.byteLength(bigSection) > 11 * 1024 && Buffer.byteLength(bigSection) < 13 * 1024, `${Buffer.byteLength(bigSection)}B`);

	const h3 = harness();
	for (let i = 0; i < 40; i++) h3.q.enqueue({ id: `t${i}`, text: big });
	await sleep(400);
	const d3 = h3.sent[0]?.message.details;
	const p3 = h3.payloadOf(h3.sent[0]);
	check("降级：每条不足 1KB 时只内联前 24 条", d3?.indexedOnly === 16 && p3.includes("## t23") && !p3.includes("## t24"), `indexedOnly=${d3?.indexedOnly}`);
	check("降级：其余为索引行", p3.includes("- t24") && p3.includes("- t39"));
	check("降级：details.items 仍包含全部条目", d3?.items.length === 40);

	const h4 = harness();
	for (let i = 0; i < 100; i++) h4.q.enqueue({ id: `u${i}`, text: "y" });
	await sleep(400);
	const d4 = h4.sent[0]?.message.details;
	const p4 = h4.payloadOf(h4.sent[0]);
	check("落盘：索引超过 40 行写入文件", !!d4?.spillFile && existsSync(d4.spillFile), d4?.spillFile);
	check("落盘：消息里给出文件路径", !!d4?.spillFile && p4.includes(d4.spillFile));
	check("落盘：文件含完整索引", !!d4?.spillFile && readFileSync(d4.spillFile, "utf-8").includes("- u99"));
}

// 9. truncateUtf8Head 不切坏多字节字符。
{
	const t = truncateUtf8Head("中文字符", 7); // 每字 3 字节 → 只能放下 2 个字
	check("UTF-8 截断落在字符边界", t.text === "中文" && t.truncated, JSON.stringify(t));
}

console.log(failed === 0 ? "\n全部通过 🎉" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
