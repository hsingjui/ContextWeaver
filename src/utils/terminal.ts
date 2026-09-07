/**
 * 终端行内渲染协调器
 *
 * 进度条 / Spinner 会在当前行原地重绘；logger 的控制台输出需要在打印前
 * 先清掉这一行，否则日志会拼接在进度条后面。logger（utils 层）与
 * 进度条（cli 层）通过本模块解耦，避免相互依赖。
 */

let lineInterrupt: (() => void) | null = null;

/** 注册 / 注销行内渲染的清行回调（进度条启动时注册，停止时注销） */
export function setLineInterrupt(handler: (() => void) | null): void {
  lineInterrupt = handler;
}

/** logger 控制台流每次输出前调用：存在行内渲染时先清除当前行 */
export function interruptLineRendering(): void {
  lineInterrupt?.();
}
