import {
  createBashToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";

// 覆盖内置 bash 工具的渲染：工具框背景不再随成功/失败变色
// （配合主题把 toolSuccessBg / toolErrorBg 设成与 toolPendingBg 一致），
// 改为在内置输出末尾追加一行彩色状态文字（✓ done · 1.2s / ✗ exit 1 · 0.4s）。
//
// 实现要点：
// - 直接展开 createBashToolDefinition()，execute / renderCall / 参数 schema 全部沿用内置；
// - 只重写 renderResult：内部委托内置 renderResult（保留输出预览、截断提示），
//   再包一层 Container 追加状态行；
// - 内置 renderResult 依赖 context.lastComponent 复用它自己的有状态组件
//   （BashResultRenderComponent，带行缓存和计时间隔）。如果直接把我们的 wrapper 传回去，
//   内置渲染器会拿到错误类型而抛异常。所以把内置组件句柄存进共享 state 的自有槽位，
//   委托时通过 lastComponent 回传给它；
// - 内置的 "Took Xs" 页脚在计时可用时（state.startedAt 存在）恒为内置组件的最后一个
//   child，且耗时就是 state.endedAt - state.startedAt。我们摘掉该页脚，把耗时合并进
//   状态行，避免两行重复信息。运行中（isPartial）的 "Elapsed Xs" 保持不变。

const EXIT_CODE_PATTERN = /Command exited with code (\d+)/;

export default function (pi: ExtensionAPI) {
  const builtin = createBashToolDefinition(process.cwd());

  // 内置渲染器的 state 类型没有从包里导出，这里从签名反推并加上自有槽位
  type BuiltinState = Parameters<
    NonNullable<(typeof builtin)["renderResult"]>
  >[3]["state"];
  type State = BuiltinState & { __inner?: Component };

  pi.registerTool({
    ...builtin,

    renderResult(result, options, theme, context) {
      const state = context.state as State;

      // 委托内置渲染；lastComponent 回传我们保管的内置组件，保证其状态复用不断裂
      const inner = builtin.renderResult!(result, options, theme, {
        ...context,
        lastComponent: state.__inner,
      });
      state.__inner = inner;

      // 运行中（流式更新）不加状态行，直接返回内置组件
      if (options.isPartial) {
        return inner;
      }

      // 摘掉内置的 "Took Xs" 页脚（存在时恒为最后一个 child），耗时合并进状态行。
      // 历史会话（resumed）没有 startedAt，此时无页脚可摘、也不显示耗时。
      let duration: string | undefined;
      if (state.startedAt !== undefined && state.endedAt !== undefined) {
        const children = (inner as Container).children;
        if (children.length > 0) {
          children.pop();
        }
        duration = `${((state.endedAt - state.startedAt) / 1000).toFixed(1)}s`;
      }

      let status: string;
      if (!context.isError) {
        status = theme.fg("success", "✓ done");
      } else {
        const text =
          result.content.find((c) => c.type === "text")?.text ?? "";
        const exitCode = EXIT_CODE_PATTERN.exec(text)?.[1];
        status = theme.fg(
          "error",
          exitCode ? `✗ exit ${exitCode}` : "✗ failed",
        );
      }
      if (duration) {
        status += theme.fg("muted", ` · ${duration}`);
      }

      const wrapper = new Container();
      wrapper.addChild(inner);
      wrapper.addChild(new Text(`\n${status}`, 0, 0));
      return wrapper;
    },
  });
}
