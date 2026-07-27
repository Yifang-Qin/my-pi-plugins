// 终端文本清洗 —— afang-subagent 的 `/subagent` 与 tmux-bash 的 `/bg` 两个 overlay 面板共享。
//
// 为什么需要它（血泪教训，别删）：pi-tui 的硬约束是
//   「Component.render() 返回的数组里，每个字符串 = 恰好一个终端物理行」。
// compositeOverlays 按下标把每个字符串贴到一行上（tui.js: result[idx] = compositeLineAt(...)），
// 而 visibleWidth("\n") === 0 —— 于是裸 \n 同时躲过了：
//   1) truncateToWidth 的截断（宽度不算数）；
//   2) 行尾补白（padVisible 以为还很短）；
//   3) 合成器那句防御性 sliceByColumn（visibleWidth > w 才触发）。
// 结果就是这一"行"打印时光标下移且不归列 → 边框断裂、内容溢出 overlay 格子。
// 同理 \r（宽度 0、把光标拉回列 0）、\x1b[2K/\x1b[1A 这类光标移动/擦除序列也会毁掉画面。
//
// 典型触发：subagent 跑 `python - << 'PY' … PY` 这种多行 heredoc（命令预览里带真换行），
// 或后台任务输出里带进度条（\r 回车覆盖）与彩色/擦行控制序列。
//
// 注意：\x1b 不能一刀切删掉——主题上色全靠 SGR；\t 也保留，pi-tui 自己会展开成 3 空格
// 且 visibleWidth 的计算与之一致。

// 单行化：换行折成可见的 ⏎，其余 C0 控制符（含 \r）删除；刻意保留 \x1b 与 \t。
export function toSingleLine(s: string): string {
	return s
		.replace(/\r\n|\r|\n/g, " ⏎ ")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g, "");
}

// 多行文本 → 安全的单行数组（有滚动的输出/轨迹视图逐行展示，比压扁成一行更好读）。
export function toSafeLines(s: string): string[] {
	return s.split(/\r?\n/).map(toSingleLine);
}

// 剥掉会移动光标 / 擦除屏幕的 ANSI，只保留 SGR（颜色样式，形如 ESC[…m）与 OSC 8 超链接。
export function stripNonSgrAnsi(s: string): string {
	if (!s.includes("\x1b")) return s;
	const keep: string[] = [];
	const stash = (m: string) => `\u0000${keep.push(m) - 1}\u0000`;
	let out = s
		// CSI：终止字节是 'm' 的是 SGR，留；其余（光标移动 A/B/C/D、擦除 J/K、DECTCEM h/l…）删。
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, (m) => (m.endsWith("m") ? stash(m) : ""))
		// OSC：只留超链接 OSC 8（pi 自己也用），其余（改标题、剪贴板…）删。
		.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, (m) => (m.startsWith("\x1b]8;") ? stash(m) : ""))
		// 剩余零散 ESC 序列（\x1b(B、\x1b=、DCS/APC 起始等）整体删掉。
		.replace(/\x1b(?:[@-Z\\-_]|[ -/]*[0-~])?/g, "");
	out = out.replace(/\u0000(\d+)\u0000/g, (_m, i) => keep[Number(i)] ?? "");
	return out;
}

// 按终端语义处理行内回车覆盖：`aaaa\rbb` → `bbaa`（进度条最终态），而不是把 \r 当普通字符。
export function applyCarriageReturns(line: string): string {
	if (!line.includes("\r")) return line;
	let out = "";
	for (const seg of line.split("\r")) {
		out = seg.length >= out.length ? seg : seg + out.slice(seg.length);
	}
	return out;
}

// 剥掉全部 ANSI（含 SGR）—— 用于「给模型看的文本」：颜色转义在上下文里只是噪音与 token 浪费。
export function stripAnsi(s: string): string {
	if (!s.includes("\x1b")) return s;
	return s
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b(?:[@-Z\\-_]|[ -/]*[0-~])?/g, "");
}

// 真实终端输出（tmux .out / capture-pane）的整段清洗：CR 覆盖 → 剥非 SGR ANSI → 单行化。
// 返回的每个元素都可直接当作 overlay 的一行使用。
export function sanitizeTerminalOutput(text: string): string[] {
	return text.split("\n").map((line) => toSingleLine(stripNonSgrAnsi(applyCarriageReturns(line))));
}
