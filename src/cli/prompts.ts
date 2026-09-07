/**
 * CLI 交互式提示原语：@clack/prompts 封装
 *
 * 统一收口三件事：
 * - 消除 clack 的取消哨兵（isCancel）：用户按 Ctrl+C / ESC 时先渲染取消收尾，
 *   再抛 PromptCancelError，由命令层决定退出方式
 * - 校验协议适配：内部约定 validate 返回 true / 错误文案，clack 约定 undefined / 错误文案
 * - 非交互环境（stdin/stdout 非 TTY）抛 NonInteractiveError，由调用方降级处理
 */

import {
  cancel,
  confirm as clackConfirm,
  password as clackPassword,
  select as clackSelect,
  text as clackText,
  isCancel,
  type Option,
} from '@clack/prompts';
import { writeLine } from './theme.js';

/** 用户取消（Ctrl+C / ESC） */
export class PromptCancelError extends Error {
  constructor() {
    super('用户已取消操作');
    this.name = 'PromptCancelError';
  }
}

/** 非交互环境（stdin/stdout 非 TTY）无法进行交互 */
export class NonInteractiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonInteractiveError';
  }
}

/** 当前进程是否具备交互条件 */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

// clack 的 Validate 入参为 string | undefined（首次渲染时会以 undefined 调用）
type InternalValidate = (value: string | undefined) => string | undefined;

/** 内部 validate（true=合法 / string=错误文案）→ clack validate（undefined=合法 / string=错误文案） */
function adaptValidate(validate?: (value: string) => true | string): InternalValidate | undefined {
  if (!validate) return undefined;
  return (value) => {
    if (value === undefined) return undefined;
    const result = validate(value);
    return result === true ? undefined : result;
  };
}

function assertInteractive(message: string): void {
  if (!isInteractive()) {
    throw new NonInteractiveError(`非交互环境无法进行交互：${message}`);
  }
}

interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  /** 选项右侧的灰色补充说明 */
  hint?: string;
}

export interface SelectConfig<T extends string> {
  message: string;
  options: Array<SelectOption<T>>;
  initialValue?: T;
}

/** 单选（↑↓/jk 移动，Enter 确认，Ctrl+C 取消） */
export async function select<T extends string>(config: SelectConfig<T>): Promise<T> {
  assertInteractive(config.message);
  writeLine('');
  const value = await clackSelect({
    message: config.message,
    // Option<Value> 是按 Value 是否 Primitive 展开的条件类型，泛型 T 下无法直接推断
    options: config.options as Option<T>[],
    initialValue: config.initialValue,
  });
  if (isCancel(value)) {
    cancel('已取消');
    throw new PromptCancelError();
  }
  return value;
}

export interface InputConfig {
  message: string;
  /** 预填 + 回车兜底：进入输入框即为可编辑的初始值，清空提交时也回退到该值 */
  defaultValue?: string;
  /** 返回 true 表示合法，返回字符串为错误提示 */
  validate?: (value: string) => true | string;
}

/** 文本输入（带默认值与校验循环） */
export async function input(config: InputConfig): Promise<string> {
  assertInteractive(config.message);
  writeLine('');
  const value = await clackText({
    message: config.message,
    defaultValue: config.defaultValue,
    initialValue: config.defaultValue,
    validate: adaptValidate(config.validate),
  });
  if (isCancel(value)) {
    cancel('已取消');
    throw new PromptCancelError();
  }
  return value;
}

/** 密码输入（掩码显示，不回显原文） */
export async function password(config: {
  message: string;
  validate?: (value: string) => true | string;
}): Promise<string> {
  assertInteractive(config.message);
  writeLine('');
  const value = await clackPassword({
    message: config.message,
    validate: adaptValidate(config.validate),
  });
  if (isCancel(value)) {
    cancel('已取消');
    throw new PromptCancelError();
  }
  return value;
}

/** 是/否确认（y/n 或 ←→ 切换，回车取默认值） */
export async function confirm(config: {
  message: string;
  defaultTrue?: boolean;
}): Promise<boolean> {
  assertInteractive(config.message);
  writeLine('');
  const value = await clackConfirm({
    message: config.message,
    active: '是',
    inactive: '否',
    initialValue: config.defaultTrue ?? true,
  });
  if (isCancel(value)) {
    cancel('已取消');
    throw new PromptCancelError();
  }
  return value;
}
