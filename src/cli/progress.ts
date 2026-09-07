/**
 * CLI 进度展示：进度条与 Spinner
 *
 * 使用无侧栏的单行进度与状态符号。
 * TTY 模式下原地单行重绘，并通过 utils/terminal 的行中断钩子与 logger 协调：
 * logger 输出前先清除进度行，下一帧再重绘，日志不会拼接在进度条后面。
 * 非 TTY（管道 / CI）模式自动降级：进度条按里程碑输出纯文本，Spinner 只输出静态行。
 */

import { setLineInterrupt } from '../utils/terminal.js';
import { color, supportsAnsi, symbol } from './theme.js';

const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];
const DEFAULT_BAR_WIDTH = 16;
const RENDER_INTERVAL_MS = 80;
const SPINNER_INTERVAL_MS = 100;

export interface ProgressRendererOptions {
  /** 输出函数（默认 process.stdout.write，测试注入内存缓冲） */
  write?: (text: string) => void;
  /** 强制覆盖 ANSI 能力检测（默认 supportsAnsi()） */
  useAnsi?: boolean;
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds - minutes * 60)}s`;
}

/** 单行进度条 */
export class ProgressBar {
  private readonly write: (text: string) => void;
  private readonly useAnsi: boolean;
  private readonly barWidth: number;
  private readonly label: string;
  private active = false;
  private startedAt = 0;
  private lastRenderAt = 0;
  private lastMessage = '';
  private renderTimer: ReturnType<typeof setInterval> | null = null;
  private lastPercent = 0;
  /** 非 TTY 模式下一次输出的百分比里程碑 */
  private nextMilestone = 0;
  /** 非 TTY 模式下最近一次已输出的百分比（避免同值重复输出） */
  private lastPrintedPercent = -1;

  constructor(options: ProgressRendererOptions & { label?: string } = {}) {
    this.write = options.write ?? ((text: string) => process.stdout.write(text));
    this.useAnsi = options.useAnsi ?? supportsAnsi();
    this.barWidth = DEFAULT_BAR_WIDTH;
    this.label = options.label ?? '索引进度';
  }

  isActive(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.startedAt = Date.now();
    this.lastRenderAt = 0;
    this.lastPercent = 0;
    if (this.useAnsi) {
      setLineInterrupt(() => this.eraseCurrentLine());
      this.renderTimer = setInterval(() => this.renderFrame(this.lastPercent, this.lastMessage), 1000);
    } else {
      this.nextMilestone = 0;
      this.lastPrintedPercent = -1;
    }
  }

  private clearTimer(): void {
    if (this.renderTimer !== null) {
      clearInterval(this.renderTimer);
      this.renderTimer = null;
    }
  }

  update(current: number, total: number, message?: string): void {
    if (!this.active) return;
    const percent = total > 0 ? Math.min(100, Math.floor((current / total) * 100)) : 0;
    this.lastPercent = percent;
    this.lastMessage = message ?? '';

    if (this.useAnsi) {
      const now = Date.now();
      if (now - this.lastRenderAt < RENDER_INTERVAL_MS) return;
      this.lastRenderAt = now;
      this.renderFrame(percent, message);
      return;
    }

    if (percent >= this.nextMilestone && percent !== this.lastPrintedPercent) {
      this.write(`${this.label} ${percent}%${message ? ` ${symbol.dot} ${message}` : ''}\n`);
      this.lastPrintedPercent = percent;
      this.nextMilestone = percent + 10;
    }
  }

  /** 完成进度条；空消息仅清除动画，由调用方输出汇总。 */
  done(message?: string): void {
    if (!this.active) return;
    setLineInterrupt(null);
    this.clearTimer();
    if (this.useAnsi) {
      if (message === '') {
        this.eraseCurrentLine();
      } else {
        this.renderFrame(100, message ?? '完成', true);
        this.write('\n');
      }
    } else if (this.lastPercent < 100) {
      this.write(`${this.label} 100%${message ? ` ${symbol.dot} ${message}` : ''}\n`);
    }
    this.active = false;
  }

  /** 中止进度条并输出错误标记 */
  fail(message?: string): void {
    if (!this.active) return;
    setLineInterrupt(null);
    this.clearTimer();
    if (this.useAnsi) {
      this.eraseCurrentLine();
      this.write(`${color.red(symbol.err)} ${message ?? '失败'}\n`);
    } else {
      this.write(`失败: ${message ?? ''}\n`);
    }
    this.active = false;
  }

  private renderFrame(percent: number, message?: string, finished = false): void {
    const filled = Math.round((percent / 100) * this.barWidth);
    const accent = finished ? color.green : color.cyan;
    const bar =
      accent(symbol.barFull.repeat(filled)) +
      color.gray(symbol.barEmpty.repeat(this.barWidth - filled));
    const head = finished ? color.green(symbol.submit) : color.cyan(symbol.info);
    const parts: string[] = [`${head} ${bar} ${color.bold(`${`${percent}`.padStart(3)}%`)}`];
    if (message) parts.push(message);
    // 对齐整秒：无论 update 多密集，时间显示每秒只跳一次
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000) * 1000;
    parts.push(color.gray(formatDuration(elapsed)));
    this.write(`\r\x1b[2K${parts.join(' ')}`);
  }

  private eraseCurrentLine(): void {
    this.write('\r\x1b[2K');
  }
}

/** 不确定耗时的等待动画（扫描阶段、连通性探测等） */
export class Spinner {
  private readonly write: (text: string) => void;
  private readonly useAnsi: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frameIndex = 0;
  private messageText = '';
  private active = false;

  constructor(options: ProgressRendererOptions = {}) {
    this.write = options.write ?? ((text: string) => process.stdout.write(text));
    this.useAnsi = options.useAnsi ?? supportsAnsi();
  }

  start(message: string): void {
    if (this.active) {
      this.messageText = message;
      return;
    }
    this.active = true;
    this.messageText = message;
    if (!this.useAnsi) {
      // 非 TTY：输出一次静态行，结束时由 stop/fail 补充结果行
      this.write(`${message}...\n`);
      return;
    }
    setLineInterrupt(() => this.eraseCurrentLine());
    this.renderFrame();
    this.timer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
      this.renderFrame();
    }, SPINNER_INTERVAL_MS);
  }

  /** 更新提示文案（下一帧生效） */
  message(text: string): void {
    if (this.active) this.messageText = text;
  }

  /** 停止动画；传入 finalMessage 时输出成功行 */
  stop(finalMessage?: string): void {
    if (!this.active) return;
    this.active = false;
    this.clearTimer();
    setLineInterrupt(null);
    if (this.useAnsi) {
      this.eraseCurrentLine();
    }
    if (finalMessage) {
      this.write(`${color.green(symbol.submit)} ${finalMessage}\n`);
    }
  }

  /** 停止动画并输出错误行 */
  fail(text: string): void {
    if (!this.active) return;
    this.active = false;
    this.clearTimer();
    setLineInterrupt(null);
    if (this.useAnsi) {
      this.eraseCurrentLine();
    }
    this.write(`${color.red(symbol.err)} ${text}\n`);
  }

  private renderFrame(): void {
    this.write(`\r\x1b[2K${color.cyan(SPINNER_FRAMES[this.frameIndex])} ${this.messageText}`);
  }

  private eraseCurrentLine(): void {
    this.write('\r\x1b[2K');
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
