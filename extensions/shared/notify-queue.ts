// 后台完成通知的「自管投递队列」——afang-subagent 与 tmux-bash 共享。
//
// 为什么不直接 `pi.sendMessage(…, { deliverAs: "steer", triggerTurn: true })`（2026-10 核对 pi 1.1.0 源码）：
//
// 1) **一条一轮**：pi 的 steering 队列默认 `steeringMode: "one-at-a-time"`，每个 turn 边界只取 1 条
//    （pi-agent-core `PendingMessageQueue.peek()`）。一次长前台调用期间完成 N 个后台任务 → 之后要多 N−1
//    轮 LLM 调用，且模型在看到第 1 条时并不知道第 2 条早已到达（会去 `bg list` 查、随后又收到重复信息）。
//    这是用户的全局偏好（也决定用户自己插话的投递方式），扩展不该去改它。
// 2) **Esc 会丢通知**：interactive 模式按 Esc → `restoreQueuedMessagesToEditor({ abort: true })` →
//    `agent.clearAllQueues()`。用户自己的 steer 文本在 `_steeringMessages` 有备份、会恢复到编辑器，而扩展经
//    `agent.steer(appMessage)` 进队的 custom 消息**没有任何备份，被静默清掉**——后台任务的完成通知永久丢失。
//
// 解法：扩展自己持有队列，**确认进入 transcript 才出队**：
//
//   enqueue ─▶ pending ──(发出)──▶ inflight ──(message_end 见到同 batchId)──▶ 出队
//                 ▲                    │
//                 └── run 结束仍未确认 ─┘   （= 被 Esc 清掉了，退回重发）
//
// 发出时机（都把当时 pending 的**全部**合并成**一条**消息，按完成先后排列）：
//   - Agent 运行中：不碰 pi 的队列，攒着；在 `turn_end` handler 里一次发出（steer）。pi 在
//     `agent.finishTurn` 里 await 扩展的 turn_end 处理，之后才 `getSteeringMessages()`，所以这条合并
//     消息会被**同一个** turn 边界取走——送达时机与原先逐条 steer 完全一致，只是合并了。
//   - Agent 空闲：等 idleDebounceMs（攒住几乎同时完成的任务）后发出并 triggerTurn。
//   - run 结束（agent_settled）：先把未确认的 inflight 退回 pending；`aborted`（用户按了 Esc）时**不唤醒**，
//     留到用户下一次输入时随 `before_agent_start` 带上（= nextTurn 语义，且不会和 pi 自己的 nextTurn 队列
//     重复）；否则立即发出（pi 会把 settled 期间的 triggerTurn 推迟到 settle 之后执行）。
//   - `wake: false` 的条目（如用户在 /bg 面板手动 kill 的通知）：运行中照常随 turn_end 发出，空闲时不唤醒，
//     只随下一次用户输入或下一次唤醒性发送一起带上。
//
// 体积控制（溢出不写队列文件：队列条目只是元数据，占空间的输出本就在磁盘上——tmux-bash 的 `.out`、
// afang-subagent 的 subagent-results）：
//   - 单条上限 maxItemBytes；整条消息正文预算 totalBudgetBytes，多条时平分，短条目省下的预算再分给被截的；
//   - 平分后每条不足 minItemBytes → 只有前 K 条（按完成先后）内联输出，其余降级为一行索引（含完整日志路径）；
//   - 索引行也超过 maxIndexLines → 全量索引落盘到 spillDir/<batchId>.md，消息里只放前若干行 + 文件路径。
//
// 已知边界：非 interactive 的 abort（如 RPC `abort` 而不 `clear_queue`）不会清 pi 的队列，此时被退回重发的
// 条目可能与 pi 稍后补投的旧消息**重复一次**——重复无害，丢失才有害，故选择宁重勿丢。
// `/reload` 会重建扩展实例，内存里尚未投递的条目随之丢失（与「reload 后不恢复 job 表」同属一个已知限制）。

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface RenderedItem {
	text: string;
	/** 正文是否因预算被截断（用于把省下的预算优先补给被截的条目）。 */
	truncated: boolean;
}

export interface NotifyQueueOptions<T> {
	/** sendMessage / before_agent_start 消息的 customType（扩展自己的 message renderer 认它）。 */
	customType: string;
	/** 给整条 payload 包「系统通知框」（随机边界协议见 bg-notify.ts）。 */
	frame: (payload: string) => string;
	/** 批次标题；返回空串则不加（单条时通常不加，保持旧版单条通知的版式）。 */
	header: (count: number) => string;
	/** 渲染一个条目；正文须控制在 budgetBytes 以内（标题行等少量开销不计）。 */
	renderItem: (item: T, budgetBytes: number) => RenderedItem;
	/** 一行索引（预算不够内联时用），应包含能找到完整输出的路径或命令。 */
	indexLine: (item: T) => string;
	/** 写进消息 details.items 的结构化信息（renderer 用它画折叠态）。 */
	itemDetails: (item: T) => Record<string, unknown>;
	maxItemBytes: number;
	totalBudgetBytes: number;
	minItemBytes: number;
	idleDebounceMs: number;
	/** 超量索引落盘目录，默认 $TMPDIR/pi-bg-notify。 */
	spillDir?: () => string;
	/** 消息里直接列出的索引行上限，超出则落盘。默认 40。 */
	maxIndexLines?: number;
}

export interface NotifyQueue<T> {
	/** 入队一条完成通知。wake=false：空闲时不唤醒模型（默认 true）。 */
	enqueue(item: T, opts?: { wake?: boolean }): void;
	/** 诊断 / 测试用快照。 */
	snapshot(): { pending: number; inflight: number; running: boolean };
	/** 丢弃全部条目并停掉定时器（换会话 / 退出时）。 */
	clear(): void;
}

interface Entry<T> {
	seq: number;
	item: T;
	wake: boolean;
	batchId?: string;
}

export interface BatchDetails {
	batchId: string;
	items: Record<string, unknown>[];
	/** 只有索引、没有内联输出的条目数。 */
	indexedOnly: number;
	spillFile?: string;
}

const SECTION_SEPARATOR = "\n\n---\n\n";

/** 把字符串截到 maxBytes 以内（按 UTF-8 字节，从头保留），不切坏多字节字符。 */
export function truncateUtf8Head(text: string, maxBytes: number): { text: string; truncated: boolean } {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) return { text, truncated: false };
	let end = Math.max(0, maxBytes);
	// 回退到 UTF-8 字符边界（续字节形如 10xxxxxx）。
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
	return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

export function createNotifyQueue<T>(pi: ExtensionAPI, opts: NotifyQueueOptions<T>): NotifyQueue<T> {
	let seq = 0;
	let pending: Entry<T>[] = [];
	const inflight = new Map<string, Entry<T>[]>();
	let running = false;
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	const maxIndexLines = opts.maxIndexLines ?? 40;

	const clearIdleTimer = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = null;
	};

	// —— 组装一条合并消息 —— //
	function buildPayload(entries: Entry<T>[], batchId: string): { payload: string; details: BatchDetails } {
		const n = entries.length;
		let per = Math.min(opts.maxItemBytes, Math.floor(opts.totalBudgetBytes / n));
		let inlineCount = n;
		if (per < opts.minItemBytes) {
			per = opts.minItemBytes;
			inlineCount = Math.max(1, Math.floor(opts.totalBudgetBytes / opts.minItemBytes));
		}
		const inlineEntries = entries.slice(0, inlineCount);
		const indexEntries = entries.slice(inlineCount);

		// 第一遍：均分预算；第二遍：把短条目省下的预算补给被截断的条目（不超过单条上限）。
		let rendered = inlineEntries.map((e) => opts.renderItem(e.item, per));
		const used = rendered.reduce((sum, r) => sum + Buffer.byteLength(r.text, "utf8"), 0);
		const truncatedIdx = rendered.flatMap((r, i) => (r.truncated ? [i] : []));
		const leftover = opts.totalBudgetBytes - used;
		if (leftover > 0 && truncatedIdx.length > 0 && per < opts.maxItemBytes) {
			const bonus = Math.floor(leftover / truncatedIdx.length);
			const boosted = Math.min(opts.maxItemBytes, per + bonus);
			if (boosted > per) {
				rendered = rendered.map((r, i) => (r.truncated ? opts.renderItem(inlineEntries[i].item, boosted) : r));
			}
		}

		const parts: string[] = [];
		const header = opts.header(n);
		if (header) parts.push(header);
		const body = rendered.map((r) => r.text).join(SECTION_SEPARATOR);

		let indexBlock = "";
		let spillFile: string | undefined;
		if (indexEntries.length > 0) {
			const lines = indexEntries.map((e) => opts.indexLine(e.item));
			const intro =
				`${indexEntries.length} more finished item(s) are listed without inline output ` +
				"(notification size budget exceeded). Read their full output only if you need it:";
			if (lines.length > maxIndexLines) {
				spillFile = writeSpill(batchId, [intro, ...lines].join("\n"));
				const shown = lines.slice(0, maxIndexLines);
				const tail = spillFile
					? `… and ${lines.length - shown.length} more; full list: ${spillFile}`
					: `… and ${lines.length - shown.length} more (could not write the full list to disk).`;
				indexBlock = [intro, ...shown, tail].join("\n");
			} else {
				indexBlock = [intro, ...lines].join("\n");
			}
		}

		const payload = [parts.join("\n\n"), body, indexBlock].filter(Boolean).join("\n\n");
		return {
			payload,
			details: {
				batchId,
				items: entries.map((e) => opts.itemDetails(e.item)),
				indexedOnly: indexEntries.length,
				...(spillFile ? { spillFile } : {}),
			},
		};
	}

	function writeSpill(batchId: string, text: string): string | undefined {
		try {
			const dir = opts.spillDir?.() ?? join(tmpdir(), "pi-bg-notify");
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			const file = join(dir, `${batchId}.md`);
			writeFileSync(file, text, { encoding: "utf-8", mode: 0o600 });
			return file;
		} catch {
			return undefined;
		}
	}

	// 把当前 pending 全部打成一批、标记 inflight，返回待发的消息。
	function takeBatch(): { message: { customType: string; content: string; display: true; details: BatchDetails } } | null {
		if (pending.length === 0) return null;
		const entries = pending;
		pending = [];
		const batchId = randomBytes(6).toString("hex");
		for (const e of entries) e.batchId = batchId;
		inflight.set(batchId, entries);
		const { payload, details } = buildPayload(entries, batchId);
		return { message: { customType: opts.customType, content: opts.frame(payload), display: true, details } };
	}

	function sendNow(): void {
		const batch = takeBatch();
		if (!batch) return;
		try {
			// 运行中 = 进 steering 队列被本 turn 边界取走；空闲 = 立即开一轮；settled 期间 = pi 推迟到 settle 后。
			pi.sendMessage(batch.message, { deliverAs: "steer", triggerTurn: true });
		} catch {
			// 会话正在拆除等：退回 pending，交给下一次时机。
			requeue(batch.message.details.batchId);
		}
	}

	function requeue(batchId: string): void {
		const entries = inflight.get(batchId);
		if (!entries) return;
		inflight.delete(batchId);
		for (const e of entries) e.batchId = undefined;
		pending = [...entries, ...pending].sort((a, b) => a.seq - b.seq);
	}

	function flushIdle(): void {
		idleTimer = null;
		if (running) return; // 运行中交给 turn_end
		if (!pending.some((e) => e.wake)) return; // 全是不唤醒的条目：等用户下一次输入
		sendNow();
	}

	// —— 事件接线 —— //
	pi.on("agent_start", () => {
		running = true;
		clearIdleTimer();
	});

	pi.on("turn_end", (event, ctx) => {
		if (pending.length === 0) return;
		// 这一轮是被中断 / 出错结束的：agent loop 接下来直接 agent_end，不会再取 steering 队列。此时发出去的消息
		// 会滞留在 pi 队列里、在下一次 run 开头才被补投，而我们在 settled 时又会把它当作「丢了」退回重发 → 重复。
		// 所以这种轮次不发，留在 pending 交给 agent_settled / before_agent_start。
		const stopReason = (event.message as { stopReason?: string }).stopReason;
		if (ctx.signal?.aborted || stopReason === "aborted" || stopReason === "error") return;
		sendNow();
	});

	pi.on("message_end", (event) => {
		const msg = event.message as { role?: string; customType?: string; details?: { batchId?: unknown } };
		if (msg.role !== "custom" || msg.customType !== opts.customType) return;
		const batchId = msg.details?.batchId;
		if (typeof batchId === "string") inflight.delete(batchId);
	});

	pi.on("agent_settled", (event) => {
		running = false;
		// run 结束仍未确认的批次 = 被清掉了（Esc）：退回 pending。
		for (const batchId of [...inflight.keys()]) requeue(batchId);
		if (event.aborted) return; // 用户刚喊停：不唤醒，等下一次输入（before_agent_start）或新的唤醒性完成
		if (pending.some((e) => e.wake)) sendNow();
	});

	// 用户下一次输入：把还没发出的（不唤醒 / Esc 后退回的）条目随这次 prompt 一起带上。
	pi.on("before_agent_start", () => {
		const batch = takeBatch();
		return batch ? { message: batch.message } : undefined;
	});

	pi.on("session_shutdown", () => {
		// quit / 换会话：旧会话的通知不该投到新会话；reload：实例即将重建，条目随之丢失（见头注释）。
		clearIdleTimer();
		pending = [];
		inflight.clear();
	});

	return {
		enqueue(item, enqueueOpts) {
			pending.push({ seq: seq++, item, wake: enqueueOpts?.wake ?? true });
			if (!running && !idleTimer) idleTimer = setTimeout(flushIdle, opts.idleDebounceMs);
		},
		snapshot: () => ({
			pending: pending.length,
			inflight: [...inflight.values()].reduce((sum, list) => sum + list.length, 0),
			running,
		}),
		clear() {
			clearIdleTimer();
			pending = [];
			inflight.clear();
		},
	};
}
