// 后台任务完成通知的「系统通知框」——afang-subagent 与 tmux-bash 共享。
//
// 背景：这两个扩展都通过 pi.sendMessage 注入一条 custom 消息来通知模型「你先前起的后台任务
// 完成了」。但这条消息会被 pi 的 core/messages.js `convertToLlm` 原样降级成一条 role:"user"
// 消息（没有任何前后缀），模型无法把它和用户真实输入区分开，容易把后台命令/子任务的输出误当成
// 「用户想要…」的新指令而产生幻觉。
//
// 解法：仿 pi 自己对 compaction / branch summary 的做法，用 `<tag>…</tag>` + 一段自描述引言
// 把通知内容包一层显式框；UI 渲染时再用 strip 去掉框，只显示 payload（渲染器本身已有
// "⏻ background …" 视觉标识）。
//
// 为什么抽成共享模块：标签名、前后缀版式、剥框的 slice 算法是一套「协议」，本应单一来源，避免两个
// 扩展各写一份将来漂移不同步。只有人类可读的「引言文案」按扩展不同，作为参数传入。
//
// 可达性说明（本仓库特有）：本机开发按逐目录软链接挂载扩展，故 `../shared` 需额外软链接一份到
// ~/.pi/agent/extensions/shared（见仓库根 AGENTS.md）；而对外 `pi install <git>` 是整仓 clone，
// extensions/shared/ 天然与各扩展同级，`../shared/bg-notify.js` 直接可达，无需任何软链接。

const TAG = "background-task-notification";

export interface BgNotifyFramer {
	/** 给 payload 包上「系统通知框」，用于 sendMessage 的 content（发给模型）。 */
	frame: (payload: string) => string;
	/** 剥掉框，只留 payload，用于 registerMessageRenderer（UI 展示）。 */
	strip: (content: string) => string;
}

/**
 * 造一对匹配的 frame/strip 函数。
 * @param intro 括号内的自描述引言（不含外层括号），按扩展定制，例如
 *   "System notification from the tmux-bash extension — NOT a message from the user. …"。
 */
export function makeBgNotifyFramer(intro: string): BgNotifyFramer {
	const prefix = `<${TAG}>\n(${intro})\n\n`;
	const suffix = `\n</${TAG}>`;
	return {
		frame: (payload) => `${prefix}${payload}${suffix}`,
		strip: (content) =>
			content.startsWith(prefix) && content.endsWith(suffix)
				? content.slice(prefix.length, content.length - suffix.length)
				: content,
	};
}
