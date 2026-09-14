/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

// 扩展自带的内建 agent 定义目录（与本文件同级的 agents/），随扩展分发、自包含。
const BUILTIN_AGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");

export type AgentScope = "user" | "project" | "both";

export type AgentSource = "builtin" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	/**
	 * 派发时继承自父会话的 thinking level（仅对未显式指定 `model` 的 agent 注入，
	 * 与官方 subagent 示例一致：自带 model 的 agent 不套用父会话的思考档位）。
	 * frontmatter 里不支持声明，由 execute 在发现后填充。
	 */
	thinkingLevel?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

interface AgentFrontmatter extends Record<string, unknown> {
	name?: string;
	description?: string;
	model?: string;
	tools?: unknown;
}

/**
 * 把 frontmatter 的 `tools` 归一化为工具名列表。两种写法都接受：
 *
 *     tools: read, bash        # 逗号字符串
 *     tools: [read, bash]      # YAML 数组
 *
 * 其他类型（数字/对象等）视为未声明而不是抛错：这里跑在 agent 发现流程里，
 * 单个写坏的文件不应拖垮整个 agent 列表。
 */
function parseToolList(raw: unknown): string[] | undefined {
	const items: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
	const tools = items
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

// 内建 agent 是随扩展分发的静态集合：供注册时扫描一次、写进工具描述（system prompt 可见）。
export function discoverBuiltinAgents(): AgentConfig[] {
	return loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin");
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	// builtin 随 user scope 一起启用（是扩展出厂默认）；project scope 保持只用项目 agent。
	const builtinAgents = scope === "project" ? [] : loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin");
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	// 同名覆盖优先级：builtin < user < project（后写入 Map 的覆盖先写入的）。
	const agentMap = new Map<string, AgentConfig>();
	for (const agent of builtinAgents) agentMap.set(agent.name, agent);
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	for (const agent of projectAgents) agentMap.set(agent.name, agent);

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}
