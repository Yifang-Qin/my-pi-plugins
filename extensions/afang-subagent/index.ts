/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { makeBgNotifyFramer } from "../shared/bg-notify.js";
import { type AgentConfig, type AgentScope, type AgentSource, discoverAgents, discoverBuiltinAgents } from "./agents.ts";

// 扩展自带的 workflow prompt 模板目录（prompts/*.md），通过 resources_discover 自包含地注册。
const BUILTIN_PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts");

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

// 递归深度护栏：主 session 深度 0，每 spawn 一层子 pi 就把 PI_SUBAGENT_DEPTH +1 传下去。
// 达到上限的子进程干脆不注册 subagent / subagent_tasks 工具（模型看不见，天然无法再派）。
// 默认上限 2：主 session(0) 派的 subagent(1) 最多再派一层(2)；可用 PI_SUBAGENT_MAX_DEPTH 覆盖。
function parseIntEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}
const SUBAGENT_DEPTH = parseIntEnv("PI_SUBAGENT_DEPTH", 0);
const SUBAGENT_MAX_DEPTH = Math.max(1, parseIntEnv("PI_SUBAGENT_MAX_DEPTH", 2));
const SUBAGENT_DEPTH_EXHAUSTED = SUBAGENT_DEPTH >= SUBAGENT_MAX_DEPTH;

// 子进程环境：spawn 时现算（而非模块加载时快照），保证继承当前 process.env 的最新状态。
function childEnv(): NodeJS.ProcessEnv {
	return { ...process.env, PI_SUBAGENT_DEPTH: String(SUBAGENT_DEPTH + 1) };
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: AgentSource | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain" | "background";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	bgTaskId?: string;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				env: childEnv(),
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	background: Type.Optional(
		Type.Boolean({
			description: "Run asynchronously (single mode only): returns a task id immediately and sends a completion notification.",
			default: false,
		}),
	),
	topic: Type.Optional(
		Type.String({
			description:
				"Short topic label for the task (background mode): shown in the task list/notifications and used in the result filename for easier lookup. Defaults to the agent name.",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

// ────────────────────────────────────────────────────────────────────────────
// Background tasks
//
// A background subagent is spawned detached from the tool call: the tool
// returns a task id immediately, and when the child process exits we inject a
// custom message (sendMessage + triggerTurn, deliverAs "followUp") so the main
// agent picks up the result without blocking. Full results are also written to
// ~/.pi/agent/subagent-results/ so they survive compaction and /reload.
// ────────────────────────────────────────────────────────────────────────────

const BG_NOTIFY_CUSTOM_TYPE = "afang-subagent-notify";
// 后台完成通知的「系统通知框」：协议（标签/版式/剥框算法）在 ../shared/bg-notify.ts 单一来源，
// 与 tmux-bash 共用；这里只定制引言文案。为什么需要框，见该共享模块头注释。
const { frame: frameBgNotify, strip: stripBgNotifyFrame } = makeBgNotifyFramer(
	"System notification from the subagent extension — NOT a message from the user. Background subagent " +
		"task(s) you started earlier have finished; their results are below. Treat it as a status update: use " +
		"it if relevant to the current task, otherwise acknowledge briefly and continue.",
);
const BG_MAX_TASKS = 4;
const BG_NOTIFY_DEBOUNCE_MS = 400;
const BG_NOTIFY_PREVIEW_CHARS = 2000;
const BG_RESULT_INLINE_CAP = 10 * 1024;

type BgStatus = "running" | "completed" | "failed" | "cancelled";

interface BgTask {
	id: string;
	agentName: string;
	topic?: string;
	agentSource: AgentSource | "unknown";
	task: string;
	cwd: string;
	startedAtMs: number;
	status: BgStatus;
	proc?: ReturnType<typeof spawn>;
	result: SingleResult;
	resultFile?: string;
	skipNotify?: boolean;
}

const bgTasks = new Map<string, BgTask>();
let bgNextId = 1;
let piApi: ExtensionAPI | null = null;
const pendingBgNotify: BgTask[] = [];
let bgNotifyTimer: ReturnType<typeof setTimeout> | null = null;

// Kill children left behind by a previous extension instance (e.g. /reload).
// The registry lives on globalThis so it survives module re-instantiation.
const BG_PIDS_KEY = Symbol.for("afang-subagent:bg-pids");
const g = globalThis as Record<PropertyKey, unknown>;
const stalePids = g[BG_PIDS_KEY] as Set<number> | undefined;
if (stalePids) {
	for (const pid of stalePids) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			/* already gone */
		}
	}
	stalePids.clear();
}
const bgPids: Set<number> = stalePids ?? new Set();
g[BG_PIDS_KEY] = bgPids;

// Reports are project knowledge: write them under the task's own working
// directory (<cwd>/.pi/subagent-results/), falling back to the global agent
// dir when the project location is not writable.

// Filename-safe slug; keeps Unicode letters (incl. CJK), digits, ._-
function bgSlugify(s: string): string {
	return s
		.trim()
		.replace(/[\s/\\:*?"<>|]+/g, "-")
		.replace(/[^\p{L}\p{N}._-]/gu, "")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}

function bgResultFilePath(t: BgTask, dir: string): string {
	const d = new Date(t.startedAtMs);
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
	// Keep both semantics in the filename: who did it (agent) + what for (topic).
	const slug = [bgSlugify(t.agentName), bgSlugify(t.topic ?? "")].filter(Boolean).join("-");
	return path.join(dir, `${stamp}-${t.id}${slug ? `-${slug}` : ""}.md`);
}

function bgProjectResultsDir(t: BgTask): string {
	return path.join(t.cwd, CONFIG_DIR_NAME, "subagent-results");
}

function bgGlobalResultsDir(): string {
	return path.join(getAgentDir(), "subagent-results");
}

function bgElapsed(t: BgTask): string {
	return `${((Date.now() - t.startedAtMs) / 1000).toFixed(1)}s`;
}

function writeBgResultFile(t: BgTask): void {
	for (const dir of [bgProjectResultsDir(t), bgGlobalResultsDir()]) {
		try {
			writeBgResultFileTo(t, dir);
			return;
		} catch {
			/* try next location */
		}
	}
}

function writeBgResultFileTo(t: BgTask, dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	const file = bgResultFilePath(t, dir);
	const lines = [
		`# ${t.id} (${t.agentName}${t.topic ? ` — ${t.topic}` : ""}) — ${t.status}`,
		"",
		`- Started: ${new Date(t.startedAtMs).toISOString()}`,
		`- Elapsed: ${bgElapsed(t)}`,
		`- Model: ${t.result.model ?? "(unknown)"}`,
		`- Usage: ${formatUsageStats(t.result.usage, t.result.model) || "n/a"}`,
	];
	if (t.result.errorMessage) lines.push(`- Error: ${t.result.errorMessage}`);
	lines.push("", "## Task", "", t.task, "", "## Output", "", getResultOutput(t.result));
	fs.writeFileSync(file, lines.join("\n"), { encoding: "utf-8" });
	t.resultFile = file;
}

function formatBgCompletion(t: BgTask): string {
	const output = getResultOutput(t.result);
	const preview =
		output.length > BG_NOTIFY_PREVIEW_CHARS
			? `${output.slice(0, BG_NOTIFY_PREVIEW_CHARS)}\n…[truncated]`
			: output;
	const usage = formatUsageStats(t.result.usage, t.result.model);
	return [
		`**${t.id}** (${t.agentName}${t.topic ? ` — ${t.topic}` : ""}) — ${t.status}`,
		preview.trim() || "(no output)",
		usage,
		t.resultFile
			? `Full result: subagent_tasks {action:"result", id:"${t.id}"} or read ${t.resultFile}`
			: `Full result: subagent_tasks {action:"result", id:"${t.id}"}`,
	]
		.filter(Boolean)
		.join("\n");
}

function flushBgNotify(): void {
	bgNotifyTimer = null;
	const items = pendingBgNotify.splice(0);
	if (items.length === 0 || !piApi) return;
	const header =
		items.length === 1 ? "Background subagent task finished:" : `Background subagent tasks finished (${items.length}):`;
	const content = [header, "", ...items.map(formatBgCompletion)].join("\n\n");
	try {
		piApi.sendMessage(
			{ customType: BG_NOTIFY_CUSTOM_TYPE, content: frameBgNotify(content), display: true, details: { taskIds: items.map((t) => t.id) } },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	} catch {
		/* session may be shutting down */
	}
}

function scheduleBgNotify(t: BgTask): void {
	pendingBgNotify.push(t);
	if (bgNotifyTimer) clearTimeout(bgNotifyTimer);
	bgNotifyTimer = setTimeout(flushBgNotify, BG_NOTIFY_DEBOUNCE_MS);
}

function finalizeBgTask(t: BgTask, exitCode: number): void {
	if (t.proc?.pid) bgPids.delete(t.proc.pid);
	if (t.status !== "cancelled") {
		t.result.exitCode = exitCode;
		t.status =
			exitCode === 0 && t.result.stopReason !== "error" && t.result.stopReason !== "aborted" ? "completed" : "failed";
		writeBgResultFile(t);
		if (!t.skipNotify) scheduleBgNotify(t);
	}
}

function killBgTask(t: BgTask): void {
	if (t.status !== "running") return;
	t.status = "cancelled";
	t.skipNotify = true;
	try {
		t.proc?.kill("SIGTERM");
	} catch {
		/* ignore */
	}
	setTimeout(() => {
		try {
			t.proc?.kill("SIGKILL");
		} catch {
			/* ignore */
		}
	}, 5000);
	writeBgResultFile(t);
}

function killAllBgTasks(): void {
	for (const t of bgTasks.values()) {
		if (t.status === "running") killBgTask(t);
	}
}

function startBackgroundTask(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	topic: string | undefined,
): BgTask | string {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return `Unknown agent: "${agentName}". Available agents: ${available}.`;
	}
	const running = [...bgTasks.values()].filter((t) => t.status === "running").length;
	if (running >= BG_MAX_TASKS) {
		return `Too many background tasks running (${running}/${BG_MAX_TASKS}). Wait for one to finish or cancel it with subagent_tasks.`;
	}

	const id = `task-${bgNextId++}`;
	const t: BgTask = {
		id,
		agentName,
		topic: topic?.trim() || undefined,
		agentSource: agent.source,
		task,
		cwd: cwd ?? defaultCwd,
		startedAtMs: Date.now(),
		status: "running",
		result: {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			model: agent.model,
		},
	};
	bgTasks.set(id, t);

	void (async () => {
		const args: string[] = ["--mode", "json", "-p", "--no-session"];
		if (agent.model) args.push("--model", agent.model);
		if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

		let tmpPromptDir: string | null = null;
		let tmpPromptPath: string | null = null;
		try {
			if (agent.systemPrompt.trim()) {
				const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
				tmpPromptDir = tmp.dir;
				tmpPromptPath = tmp.filePath;
				args.push("--append-system-prompt", tmpPromptPath);
			}
			args.push(`Task: ${task}`);

			const exitCode = await new Promise<number>((resolve) => {
				const invocation = getPiInvocation(args);
				const proc = spawn(invocation.command, invocation.args, {
					cwd: t.cwd,
					env: childEnv(),
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
				});
				t.proc = proc;
				if (proc.pid) bgPids.add(proc.pid);
				let buffer = "";

				const processLine = (line: string) => {
					if (!line.trim()) return;
					let event: any;
					try {
						event = JSON.parse(line);
					} catch {
						return;
					}
					if (event.type === "message_end" && event.message) {
						const msg = event.message as Message;
						t.result.messages.push(msg);
						if (msg.role === "assistant") {
							t.result.usage.turns++;
							const usage = msg.usage;
							if (usage) {
								t.result.usage.input += usage.input || 0;
								t.result.usage.output += usage.output || 0;
								t.result.usage.cacheRead += usage.cacheRead || 0;
								t.result.usage.cacheWrite += usage.cacheWrite || 0;
								t.result.usage.cost += usage.cost?.total || 0;
								t.result.usage.contextTokens = usage.totalTokens || 0;
							}
							if (!t.result.model && msg.model) t.result.model = msg.model;
							if (msg.stopReason) t.result.stopReason = msg.stopReason;
							if (msg.errorMessage) t.result.errorMessage = msg.errorMessage;
						}
					}
					if (event.type === "tool_result_end" && event.message) {
						t.result.messages.push(event.message as Message);
					}
				};

				proc.stdout.on("data", (data) => {
					buffer += data.toString();
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) processLine(line);
				});
				proc.stderr.on("data", (data) => {
					t.result.stderr += data.toString();
				});
				proc.on("close", (code) => {
					if (buffer.trim()) processLine(buffer);
					resolve(code ?? 0);
				});
				proc.on("error", (err) => {
					t.result.errorMessage = err.message;
					resolve(1);
				});
			});
			finalizeBgTask(t, exitCode);
		} catch (err) {
			t.result.errorMessage = err instanceof Error ? err.message : String(err);
			finalizeBgTask(t, 1);
		} finally {
			if (tmpPromptPath)
				try {
					fs.unlinkSync(tmpPromptPath);
				} catch {
					/* ignore */
				}
			if (tmpPromptDir)
				try {
					fs.rmdirSync(tmpPromptDir);
				} catch {
					/* ignore */
				}
		}
	})();

	return t;
}

const BgTasksParams = Type.Object({
	action: StringEnum(["list", "status", "result", "cancel"] as const, {
		description: "list: all tasks; status/result/cancel: act on one task (requires id)",
	}),
	id: Type.Optional(Type.String({ description: "Task id, e.g. task-1" })),
});

export default function (pi: ExtensionAPI) {
	piApi = pi;

	// 内建 agent 是注册时就确定的静态集合：扫描一次并写进工具描述，让模型在 system prompt
	// 里就能看到可用 agent（描述随 /reload 重建，不会过期）；user/project 定制仍在 execute 时
	// 动态发现，描述里只提示存放位置与查看方法（无 mode 调用 = 列出当前可用 agent）。
	const builtinAgents = discoverBuiltinAgents();

	// 自包含：把扩展自带的 workflow prompt（/scout-and-plan 等）注册进 prompt 模板发现，
	// 本机自动发现与 pi install 两种加载方式下都生效，无需软链接到 ~/.pi/agent/prompts/。
	pi.on("resources_discover", () => ({
		promptPaths: [BUILTIN_PROMPTS_DIR],
	}));

	pi.registerMessageRenderer(BG_NOTIFY_CUSTOM_TYPE, (message, _options, theme) => {
		const raw =
			typeof message.content === "string"
				? message.content
				: message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		// 注入时加的「系统通知框」只给模型看，UI 里剔掉。
		const text = stripBgNotifyFrame(raw);
		return new Text(theme.fg("accent", "⏻ background subagent") + "\n" + theme.fg("toolOutput", text), 0, 0);
	});

	pi.on("session_shutdown", () => killAllBgTasks());
	pi.on("session_before_switch", () => killAllBgTasks());
	pi.on("session_before_fork", () => killAllBgTasks());

	// 递归深度护栏：到达上限的子进程不注册 subagent / subagent_tasks，模型看不到工具即无法再派。
	// 深度经 spawn 时注入的 PI_SUBAGENT_DEPTH 逐层 +1 传递（见 childEnv）。
	if (SUBAGENT_DEPTH_EXHAUSTED) return;

	pi.registerTool({
		name: "subagent_tasks",
		label: "Subagent Tasks",
		description:
			"Manage background subagent tasks: list all tasks, check status, fetch a full result, or cancel a running task.",
		parameters: BgTasksParams,

		async execute(_toolCallId, params) {
			const reply = (text: string, isError = false) => ({
				content: [{ type: "text" as const, text }],
				details: null,
				...(isError ? { isError: true } : {}),
			});
			const find = (id?: string): BgTask | undefined => (id ? bgTasks.get(id) : undefined);

			if (params.action === "list") {
				if (bgTasks.size === 0) return reply("No background tasks.");
				const lines = [...bgTasks.values()].map((t) => {
					const preview = t.task.length > 60 ? `${t.task.slice(0, 60)}...` : t.task;
					return `${t.id} [${t.status}] ${t.agentName}${t.topic ? ` (${t.topic})` : ""} — ${bgElapsed(t)} — ${preview}`;
				});
				return reply(lines.join("\n"));
			}

			const t = find(params.id);
			if (!t) {
				const known = [...bgTasks.keys()].join(", ") || "none";
				return reply(`Unknown task id: "${params.id ?? ""}". Known tasks: ${known}`, true);
			}

			if (params.action === "status") {
				const lines = [
					`${t.id} (${t.agentName}, ${t.agentSource}) — ${t.status}`,
					...(t.topic ? [`Topic: ${t.topic}`] : []),
					`Elapsed: ${bgElapsed(t)} | Turns so far: ${t.result.usage.turns}`,
					`Task: ${t.task}`,
				];
				if (t.resultFile) lines.push(`Result file: ${t.resultFile}`);
				if (t.status === "failed" && t.result.errorMessage) lines.push(`Error: ${t.result.errorMessage}`);
				return reply(lines.join("\n"));
			}

			if (params.action === "result") {
				if (t.status === "running") {
					return reply(
						`${t.id} still running (${bgElapsed(t)}, ${t.result.usage.turns} turns so far). Try again later or cancel it.`,
					);
				}
				let output = getResultOutput(t.result);
				let note = "";
				if (Buffer.byteLength(output, "utf8") > BG_RESULT_INLINE_CAP) {
					output = `${output.slice(0, BG_RESULT_INLINE_CAP)}\n\n[truncated]`;
					note = t.resultFile ? `\n\nFull result: read ${t.resultFile}` : "";
				}
				return reply(`${t.id} — ${t.status}\n\n${output}${note}`);
			}

			// cancel
			if (t.status !== "running") {
				return reply(`${t.id} is not running (status: ${t.status}).`);
			}
			killBgTask(t);
			return reply(`Cancelled ${t.id}.`);
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Single mode supports background: true — returns a task id at once, notifies via a custom message on completion; manage with the subagent_tasks tool.",
			...(builtinAgents.length > 0
				? [
						`Built-in agents (always available):\n${builtinAgents.map((a) => `- ${a.name}: ${a.description}`).join("\n")}`,
					]
				: []),
			`Custom agents override same-name built-ins (priority: builtin < user < project). User-level: ${path.join(getAgentDir(), "agents")} (always loaded). Project-level: ${CONFIG_DIR_NAME}/agents, only loaded with agentScope "both" or "project" (default scope: "user").`,
			'To list all currently available agents (including user/project customizations), call this tool with no mode parameters — e.g. {} or {agentScope:"both"}.',
			...(SUBAGENT_DEPTH + 1 >= SUBAGENT_MAX_DEPTH
				? [
						`Nesting limit: subagents you spawn run at depth ${SUBAGENT_DEPTH + 1}/${SUBAGENT_MAX_DEPTH} and will NOT have the subagent tool — do not ask them to delegate further.`,
					]
				: []),
		].join("\n"),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;

			// Agents without an explicit `model` inherit the main session's current model
			// (mutating is safe: agents are freshly discovered on every invocation).
			const inheritedModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			if (inheritedModel) {
				for (const agent of agents) {
					if (!agent.model) agent.model = inheritedModel;
				}
			}
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain" | "background") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount === 0) {
				// 一等公民的 agent 发现入口：不传任何 mode 参数 = 列出当前 scope 下可用的 agent（非错误）。
				const lines = agents.map((a) => `- ${a.name} (${a.source}): ${a.description}`);
				let note: string;
				if (agentScope === "user") {
					note = `Project agents (${CONFIG_DIR_NAME}/agents) are not scanned in scope "user"; pass agentScope: "both" to include them.`;
				} else if (discovery.projectAgentsDir) {
					note = `Project agents dir: ${discovery.projectAgentsDir}`;
				} else {
					note = `No ${CONFIG_DIR_NAME}/agents directory found from ${ctx.cwd}.`;
				}
				return {
					content: [
						{
							type: "text",
							text: `Available agents (scope: ${agentScope}):\n${lines.join("\n") || "(none)"}\n\n${note}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (modeCount > 1) {
				return {
					content: [
						{
							type: "text",
							text: "Invalid parameters: provide exactly one mode — single {agent, task}, parallel {tasks}, or chain {chain}.",
						},
					],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.background) {
				if (!hasSingle) {
					return {
						content: [
							{
								type: "text",
								text: "background: true requires single mode: provide exactly {agent, task} (no tasks/chain arrays).",
							},
						],
						details: makeDetails("single")([]),
						isError: true,
					};
				}
				const started = startBackgroundTask(ctx.cwd, agents, params.agent!, params.task!, params.cwd, params.topic);
				if (typeof started === "string") {
					return {
						content: [{ type: "text", text: started }],
						details: makeDetails("single")([]),
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `Started background ${started.id} (agent: ${started.agentName}). You will be notified when it completes; no need to poll. Use subagent_tasks {action:"status"|"result"|"cancel", id:"${started.id}"} to manage it.`,
						},
					],
					details: { ...makeDetails("background")([]), bgTaskId: started.id },
				};
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (!args.agent && !args.task) {
				// 无 mode 参数 = 列出可用 agent（参数仍在流式传输时也会短暂走到这里，可接受）。
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) +
						theme.fg("accent", "list agents") +
						theme.fg("muted", ` [${scope}]`),
					0,
					0,
				);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`) +
				(args.background ? theme.fg("warning", " [bg]") : "");
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
