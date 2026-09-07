import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import { isDev, isMcpMode } from '../config.js';
import { interruptLineRendering } from './terminal.js';

const logLevel = isDev ? 'debug' : 'info';
const logDir = path.join(os.homedir(), '.contextweaver', 'logs');
const LOG_RETENTION_DAYS = 7;

/**
 * 控制台详细模式开关（文件日志不受影响）。
 *
 * CLI 命令在进度条 / 汇总面板展示期间设为 false，让 info 级日志只写文件，
 * 控制台保留 warn/error，避免与进度条输出交叉干扰。
 */
let consoleVerbose = true;

/** 设置控制台是否输出 info/debug 级日志（warn/error 始终输出） */
export function setConsoleVerbose(enabled: boolean): void {
  consoleVerbose = enabled;
}

function ensureLogDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getLogFileName(): string {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  return `app.${dateStr}.log`;
}

function formatTime(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function getLevelLabel(level: number): string {
  const labels: Record<number, string> = {
    10: 'TRACE',
    20: 'DEBUG',
    30: 'INFO',
    40: 'WARN',
    50: 'ERROR',
    60: 'FATAL',
  };
  return labels[level] || 'INFO';
}

function cleanupOldLogs(dir: string): void {
  try {
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir);
    const now = Date.now();
    const maxAge = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    const logPattern = /^app\.(\d{4}-\d{2}-\d{2})\.log$/;

    for (const file of files) {
      const match = file.match(logPattern);
      if (!match) continue;

      const dateStr = match[1];
      const fileDate = new Date(dateStr).getTime();

      // 解析失败则跳过
      if (Number.isNaN(fileDate)) continue;

      // 检查是否过期
      if (now - fileDate > maxAge) {
        const filePath = path.join(dir, file);
        try {
          fs.unlinkSync(filePath);
          // 使用 console.error 而非 console.log 避免污染 stdout（MCP 模式需要纯净的 stdout）
          console.error(`[Logger] 清理过期日志: ${file}`);
        } catch {
          // 删除失败时静默忽略
        }
      }
    }
  } catch {
    // 清理失败时静默忽略，不影响主流程
  }
}

// =========================================
// 格式化流
// =========================================

// 自定义 Writable Stream 来格式化日志
function createFormattedStream(filePath: string): Writable {
  const writeStream = fs.createWriteStream(filePath, { flags: 'a' });

  let disabled = false;
  const disableWriteStream = (err?: { message?: string }) => {
    if (disabled) return;
    disabled = true;
    if (!writeStream.destroyed) {
      writeStream.destroy();
    }
    // 使用 console.error 避免污染 stdout（MCP 模式需要纯净的 stdout）
    console.error(`[Logger] 日志写入失败，降级为仅控制台输出: ${err?.message ?? 'unknown error'}`);
  };

  writeStream.on('error', (err) => {
    disableWriteStream(err);
  });

  return new Writable({
    write(
      chunk: Buffer | string,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ) {
      if (disabled || writeStream.destroyed || !writeStream.writable) {
        callback();
        return;
      }

      const handleWrite = (line: string) => {
        writeStream.write(line, (err) => {
          if (err) {
            disableWriteStream(err);
          }
          callback();
        });
      };

      try {
        const log = JSON.parse(chunk.toString());
        const time = formatTime();
        const level = getLevelLabel(log.level);
        const msg = log.msg || '';

        // 提取额外的属性（排除 pino 内部字段）
        const { level: _l, time: _t, pid: _p, hostname: _h, name: _n, msg: _m, ...extra } = log;

        // 如果有额外属性，将其格式化为单行 JSON
        let line = `${time} [${level}] ${msg}`;
        if (Object.keys(extra).length > 0) {
          line += ` ${JSON.stringify(extra)}`;
        }

        handleWrite(`${line}\n`);
      } catch {
        handleWrite(chunk.toString());
      }
    },
    final(callback: (error?: Error | null) => void) {
      if (disabled || writeStream.destroyed || !writeStream.writable) {
        callback();
        return;
      }
      writeStream.end(callback);
    },
  });
}

// 控制台格式化输出（彩色），不依赖 pino-pretty
function createConsoleStream(): Writable {
  // ANSI 颜色码
  const colors: Record<number, string> = {
    10: '\x1b[90m', // TRACE - 灰色
    20: '\x1b[36m', // DEBUG - 青色
    30: '\x1b[32m', // INFO - 绿色
    40: '\x1b[33m', // WARN - 黄色
    50: '\x1b[31m', // ERROR - 红色
    60: '\x1b[35m', // FATAL - 品红
  };
  const reset = '\x1b[0m';

  const stream = new Writable({
    write(
      chunk: Buffer | string,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ) {
      try {
        const log = JSON.parse(chunk.toString());
        // 非详细模式：控制台仅保留 warn 及以上（info/debug 仍写入日志文件）
        if (!consoleVerbose && (log.level ?? 30) < 40) {
          callback();
          return;
        }
        const time = formatTime();
        const level = getLevelLabel(log.level);
        const color = colors[log.level] || '';
        const msg = log.msg || '';

        // 提取额外的属性
        const { level: _l, time: _t, pid: _p, hostname: _h, name: _n, msg: _m, ...extra } = log;

        let line = `${color}${time} [${level}]${reset} ${msg}`;
        if (Object.keys(extra).length > 0) {
          const extraStr = JSON.stringify(extra);
          line += ` ${color}${extraStr}${reset}`;
        }

        // 进度条 / Spinner 行内渲染期间先清除当前行，避免日志拼接在进度条后
        interruptLineRendering();
        process.stdout.write(`${line}\n`, callback);
      } catch {
        interruptLineRendering();
        process.stdout.write(chunk.toString(), callback);
      }
    },
  });
  // 下游管道提前关闭（如 ... | head）时静默丢弃控制台输出，避免未处理 'error' 崩溃；
  // 其余控制台写入错误降级到 stderr（文件日志流不受影响）。
  stream.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
      console.error(`[Logger] 控制台输出失败: ${(err as Error).message}`);
    }
  });
  return stream;
}

// =========================================
// Logger 创建
// =========================================

// 开发环境：写入 ~/.contextweaver/logs + 控制台输出
function createDevLogger(): pino.Logger {
  ensureLogDir(logDir);

  // 启动时清理过期日志
  cleanupOldLogs(logDir);

  const logPath = path.join(logDir, getLogFileName());
  const logStream = createFormattedStream(logPath);

  // 控制台日志（彩色，使用自定义流）
  const consoleStream = createConsoleStream();

  return pino(
    {
      level: logLevel,
      name: 'contextweaver',
    },
    // MCP 模式下禁用控制台输出，避免污染 STDIO 协议流
    isMcpMode
      ? logStream
      : pino.multistream([
          { stream: logStream, level: logLevel },
          { stream: consoleStream, level: logLevel },
        ]),
  );
}

// 生产环境：写入 ~/.contextweaver/logs + 控制台输出（不依赖 pino-pretty）
function createProdLogger(): pino.Logger {
  ensureLogDir(logDir);

  // 启动时清理过期日志
  cleanupOldLogs(logDir);

  const logPath = path.join(logDir, getLogFileName());
  const logStream = createFormattedStream(logPath);

  // 控制台输出流（使用自定义格式化，不依赖 pino-pretty）
  const consoleStream = createConsoleStream();

  return pino(
    {
      level: logLevel,
      name: 'contextweaver',
    },
    // MCP 模式下禁用控制台输出，避免污染 STDIO 协议流
    isMcpMode
      ? logStream
      : pino.multistream([
          { stream: logStream, level: logLevel },
          { stream: consoleStream, level: logLevel },
        ]),
  );
}

// =========================================
// 导出
// =========================================

// 导出 logger 实例
export const logger = isDev ? createDevLogger() : createProdLogger();

/**
 * 检查当前是否启用 debug 级别日志
 *
 * 用于惰性求值，避免在非 debug 模式下构造复杂的日志参数
 *
 * @example
 * ```ts
 * if (isDebugEnabled()) {
 *   logger.debug({ expensiveComputation: computeStats() }, "调试信息");
 * }
 * ```
 */
export function isDebugEnabled(): boolean {
  return logger.isLevelEnabled('debug');
}
