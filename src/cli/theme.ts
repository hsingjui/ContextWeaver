/** CLI 展示主题：无边框布局、单一强调色与明确的状态符号。 */

import { unicodeOr, updateSettings } from '@clack/prompts';
import pc from 'picocolors';

updateSettings({ withGuide: false });

function supportsAnsiStream(stream: { isTTY?: boolean }): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.TERM === 'dumb') return false;
  return stream.isTTY === true;
}

const stdoutAnsi = supportsAnsiStream(process.stdout);

/** 当前 stdout 是否支持 ANSI 转义序列 */
export function supportsAnsi(): boolean {
  return stdoutAnsi;
}

export const color = pc.createColors(stdoutAnsi);

export const symbol = {
  ok: unicodeOr('✓', '+'),
  submit: unicodeOr('✓', '+'),
  err: unicodeOr('✕', 'x'),
  warn: '!',
  info: unicodeOr('·', '-'),
  dot: '·',
  barFull: '█',
  barEmpty: '░',
};

/** 仅用于 CLI 展示，禁止在 MCP / 日志路径调用。 */
export function writeLine(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function intro(title: string): void {
  writeLine(`\n${color.bold('ContextWeaver')} ${color.gray(`${symbol.dot} ${title}`)}`);
}

export const log = {
  message: (text: string): void => writeLine(`  ${text.replaceAll('\n', '\n  ')}`),
  info: (text: string): void => writeLine(`  ${color.gray(text)}`),
  step: (text: string): void => writeLine(`\n${color.bold(text)}`),
  success: (text: string): void => writeLine(`${color.green(symbol.ok)} ${text}`),
  warn: (text: string): void => writeLine(`${color.yellow(symbol.warn)} ${color.yellow(text)}`),
  error: (text: string): void => writeLine(`${color.red(symbol.err)} ${color.red(text)}`),
};

export function note(text: string, title: string): void {
  log.step(title);
  log.message(text);
}

/** 收尾不默认标记成功，取消和保留配置也会使用此处。 */
export function outro(text: string): void {
  writeLine(`\n${color.bold(text)}\n`);
}

/** 敏感信息（API Key 等）展示用脱敏 */
export function maskSecret(secret: string): string {
  if (!secret) return '(未设置)';
  if (secret.length <= 8) return '****';
  return `${secret.slice(0, 4)}****${secret.slice(-2)}`;
}
