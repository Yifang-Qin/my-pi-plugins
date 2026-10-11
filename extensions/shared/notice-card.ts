// 后台任务通知的「卡片」渲染——tmux-bash 与 afang-subagent 的 message renderer 共用。
//
// 为什么需要：pi 的 CustomMessageComponent 在扩展提供了 renderer 时**直接挂我们返回的组件**，不再套它
// 默认的 customMessageBg 背景 Box（见 pi-coding-agent dist/modes/interactive/components/custom-message.js）。
// 所以后台通知原先是「裸文字」，夹在 assistant 正文之间看不出是任务输出。这里补上：
//   - 背景卡片：Box(outputPad, 1, bg)，与 pi 自己的工具行 / 默认 custom 消息同一套 padding 与 bg token；
//     bg 由调用方按结果选（全成功 toolSuccessBg / 有失败 toolErrorBg / 仅用户 kill toolPendingBg）。
//   - 单条点击展开：pi 内置工具行、compaction / branch summary 都用 MouseRegion 做「左键单击切换该条」，
//     但 custom message 的 renderer 只拿到全局 `options.expanded`（Ctrl+O），拿不到自己那条的 setExpanded。
//     做法同内置：外层 MouseRegion 接左键 click → 翻转**本条**的展开态 → 返回 { handled: true }（click 默认
//     会触发重绘）。鼠标事件只在 fullscreen 模式路由给组件（regular 模式鼠标归终端），键盘路径始终是 Ctrl+O。
//
// 本条展开态存在 WeakMap<message, …>：Ctrl+O / 主题切换会让 pi 重新调用 renderer、生成新组件，状态不能放在
// 组件实例上。语义对齐内置 ToolExecutionComponent：全局 Ctrl+O 一切换就覆盖各条的单独状态（全部展开或全部折叠），
// 之后再单击某条只翻转那一条。

import { Box, MouseRegion, Text, type Component } from "@earendil-works/pi-tui";
import { keyText, type Theme } from "@earendil-works/pi-coding-agent";

type ThemeBg = Parameters<Theme["bg"]>[0];

interface ExpandState {
	/** 上一次看到的全局 Ctrl+O 状态；变化即重置本条状态。 */
	global: boolean;
	expanded: boolean;
}

const expandStates = new WeakMap<object, ExpandState>();

function stateFor(message: object, globalExpanded: boolean): ExpandState {
	let st = expandStates.get(message);
	if (!st || st.global !== globalExpanded) {
		st = { global: globalExpanded, expanded: globalExpanded };
		expandStates.set(message, st);
	}
	return st;
}

/** 「点击或 Ctrl+O 展开 / 收起」提示文案；keybinding 未初始化（如离线渲染测试）时退回字面 Ctrl+O。 */
export function expandHint(expanded: boolean): string {
	let key = "ctrl+o";
	try {
		key = keyText("app.tools.expand") || key;
	} catch {
		/* keybindings not initialized */
	}
	return expanded ? `点击或 ${key} 收起` : `点击或 ${key} 展开`;
}

export interface NoticeCardOptions {
	/** 卡片背景 token。 */
	bg: ThemeBg;
	/** 按当前展开态生成卡片正文（已上色的多行文本；每行须是单个物理行）。 */
	body: (expanded: boolean) => string;
	/** 折叠 / 展开后内容一样（无可展开的东西）时传 false，则不响应点击。默认 true。 */
	expandable?: boolean;
}

/**
 * 生成一张带背景、可单击展开的通知卡片。
 * @param message renderer 收到的 message 对象（作为本条展开态的 key）
 */
export function renderNoticeCard(
	message: object,
	renderOptions: { expanded: boolean; outputPad: number },
	theme: Theme,
	opts: NoticeCardOptions,
): Component {
	const st = stateFor(message, renderOptions.expanded);
	// 按展开态各缓存一个 Box：Box/Text 自带按宽度的渲染缓存，来回切换不必重建。
	const boxes = new Map<boolean, Box>();
	const boxFor = (expanded: boolean): Box => {
		let box = boxes.get(expanded);
		if (!box) {
			box = new Box(renderOptions.outputPad, 1, (t) => theme.bg(opts.bg, t));
			box.addChild(new Text(opts.body(expanded), 0, 0));
			boxes.set(expanded, box);
		}
		return box;
	};
	const card: Component = {
		render: (width) => boxFor(st.expanded).render(width),
		invalidate: () => {
			for (const box of boxes.values()) box.invalidate();
		},
		handleMouse: (event) => boxFor(st.expanded).handleMouse(event),
	};
	if (opts.expandable === false) return card;
	return new MouseRegion(card, (event) => {
		if (event.type !== "click" || event.button !== "left") return undefined;
		st.expanded = !st.expanded;
		return { handled: true };
	});
}
