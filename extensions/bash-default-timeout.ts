import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// pi 的 bash 工具默认不设超时（timeout 单位：秒）。
// 这里给 LLM 发起的 bash 调用补一个默认超时，避免命令卡死。
// 可用环境变量 PI_BASH_DEFAULT_TIMEOUT 覆盖（单位：秒）。
const DEFAULT_BASH_TIMEOUT_SECONDS = Number(process.env.PI_BASH_DEFAULT_TIMEOUT) || 120;

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (isToolCallEventType("bash", event)) {
      // 只有模型没显式指定 timeout 时才补默认值，
      // 模型自己传的（比如长任务）依然尊重。
      if (event.input.timeout === undefined) {
        event.input.timeout = DEFAULT_BASH_TIMEOUT_SECONDS;
      }
    }
  });
}
