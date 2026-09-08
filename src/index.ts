#!/usr/bin/env node
// 配置必须最先加载（包含环境变量初始化）
import './config.js';

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cac from 'cac';
import {
  color,
  intro,
  log,
  ProgressBar,
  PromptCancelError,
  runDoctorCommand,
  runInitCommand,
  runModelCommand,
  Spinner,
  symbol,
  writeLine,
} from './cli/index.js';
import { parseJsonlLine, toCliSearchResult } from './cli/searchResult.js';
import { generateProjectId } from './db/index.js';
import { type ScanStats, scan } from './scanner/index.js';
import { logger, setConsoleTarget, setConsoleVerbose } from './utils/logger.js';

// 读取 package.json 获取版本号
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.resolve(__dirname, '../package.json');
const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));

// 下游管道提前关闭（如 ... | head）时静默退出，避免 EPIPE 崩溃栈
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

const cli = cac('contextweaver');

async function runModelAction(
  action?: string,
  model?: string,
  options: { yes?: boolean } = {},
): Promise<void> {
  try {
    await runModelCommand(action, model, options);
  } catch (err) {
    if (err instanceof PromptCancelError) return;
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, consoleMessage: `模型命令失败: ${message}` }, `模型命令失败: ${message}`);
    process.exitCode = 1;
  }
}

// 自定义版本输出，只显示版本号
if (process.argv.includes('-v') || process.argv.includes('--version')) {
  console.log(pkg.version);
  process.exit(0);
}

/** TTY 与管道共用的索引汇总，计数单位均为文件。 */
function printIndexSummary(stats: ScanStats, duration: string, errors: number): void {
  const result =
    stats.vectorIndex && stats.vectorIndex.indexed > 0
      ? `已更新 ${stats.vectorIndex.indexed} 个文件的索引`
      : '索引完成';
  const heading = `${result} ${color.gray(`${symbol.dot} ${duration}s`)}`;
  if (errors > 0) {
    log.warn(`索引部分失败 ${color.gray(`${symbol.dot} ${duration}s`)}`);
  } else {
    log.success(heading);
  }
  log.message(`共扫描 ${stats.totalFiles} 个文件`);
  const changes: Array<[string, number]> = [
    ['新增', stats.added],
    ['更新', stats.modified],
    ['删除', stats.deleted],
    ['跳过', stats.skipped],
  ];
  const details = changes
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label} ${count} 个文件`);
  if (details.length > 0) log.message(color.gray(details.join('，')));
  if (errors > 0) {
    if (stats.vectorIndex) {
      log.message(`已成功更新 ${stats.vectorIndex.indexed} 个文件的索引`);
    }
    log.error(`${errors} 项处理失败，可重新运行命令重试，详见日志`);
  }
}

cli
  .command('init', '初始化 ContextWeaver 配置（交互式向导）')
  .option('-y, --defaults', '跳过向导，直接写入默认模板配置')
  .action(async (options: { defaults?: boolean }) => {
    try {
      await runInitCommand({ defaults: options.defaults === true });
    } catch (err) {
      if (err instanceof PromptCancelError) {
        // 取消画面已由提示层渲染
        return;
      }
      const error = err as { message?: string; stack?: string };
      logger.error({ err, stack: error.stack }, `初始化失败: ${error.message}`);
      process.exit(1);
    }
  });

cli
  .command('index [path]', '扫描代码库并建立索引')
  .option('-f, --force', '强制重新索引')
  .action(async (targetPath: string | undefined, options: { force?: boolean }) => {
    const rootPath = targetPath ? path.resolve(targetPath) : process.cwd();
    const projectId = generateProjectId(rootPath);
    const startTime = Date.now();
    intro('索引');
    writeLine(rootPath);
    if (options.force) log.info('强制重建');
    writeLine('');

    const spinner = new Spinner();
    const bar = new ProgressBar();
    let barStarted = false;

    try {
      const { withLock } = await import('./utils/lock.js');

      // 索引期间控制台只保留 warn/error（info 走进度条与汇总面板，文件日志不受影响）
      setConsoleVerbose(false);
      spinner.start('正在扫描代码库');

      const stats: ScanStats = await withLock(
        projectId,
        'index',
        async () =>
          scan(rootPath, {
            force: options.force,
            onProgress: (current, total, message) => {
              if (!barStarted) {
                // 空仓库时首个回调即为 100%，不闪现进度条
                if (total !== undefined && current >= total) return;
                spinner.stop();
                bar.start();
                barStarted = true;
              }
              // scan 的 ProgressCallback 中 total 可能为 undefined（CLI 路径恒为 100）
              bar.update(current, total ?? 100, message);
            },
          }),
        10 * 60 * 1000,
      );

      spinner.stop();
      if (barStarted) bar.done('');
      setConsoleVerbose(true);

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const errors = stats.errors + (stats.vectorIndex?.errors ?? 0);
      printIndexSummary(stats, duration, errors);
      if (errors > 0) process.exitCode = 1;
    } catch (err) {
      spinner.stop();
      if (barStarted) bar.fail('索引失败');
      setConsoleVerbose(true);
      const error = err as { message?: string; stack?: string };
      logger.error({ err, stack: error.stack }, `索引失败: ${error.message}`);
      process.exit(1);
    }
  });

cli
  .command('model [action] [model]', '管理内置本地 Embedding 模型（默认列出状态）')
  .option('-y, --yes', '删除模型时跳过确认')
  .example('contextweaver model list')
  .example('contextweaver model install embeddinggemma-300m')
  .example('contextweaver model use qwen3-embedding-0.6b')
  .example('contextweaver model remove jina-embeddings-v2-base-code --yes')
  .action(
    async (action: string | undefined, model: string | undefined, options: { yes?: boolean }) => {
      await runModelAction(action, model, options);
    },
  );

cli
  .command('doctor', '体检配置：环境变量、目录权限、Embedding / Reranker 连通性与模型状态')
  .option('--offline', '跳过网络连通性测试')
  .action(async (options: { offline?: boolean }) => {
    await runDoctorCommand({ offline: options.offline === true });
  });

cli.command('mcp', '启动 MCP 服务器').action(async () => {
  // 动态导入并启动 MCP 服务器
  const { startMcpServer } = await import('./mcp/server.js');
  try {
    await startMcpServer();
  } catch (err) {
    const error = err as { message?: string; stack?: string };
    logger.error(
      { error: error.message, stack: error.stack },
      `MCP 服务器启动失败: ${error.message}`,
    );
    process.exit(1);
  }
});

type SearchOptions = {
  repoPath?: string;
  informationRequest?: string;
  technicalTerms?: string;
  json?: boolean;
  jsonl?: boolean;
};

/** search 命令主体；错误统一由 action 包装处理，机器输出模式按行输出 {"error": ...}。 */
async function runSearchAction(options: SearchOptions): Promise<void> {
  const repoPath = options.repoPath ? path.resolve(options.repoPath) : process.cwd();
  const informationRequest = options.informationRequest;

  // 机器输出模式提前切换：stdout 只保留 JSON 流，日志（含校验失败提示）改走 stderr
  if (options.json || options.jsonl) {
    setConsoleVerbose(false);
    setConsoleTarget(process.stderr);
  }

  if (!informationRequest && !options.jsonl) {
    // 统一抛给 action 包装层：json/jsonl 模式输出 {"error": ...}，人读模式走日志。
    // 不能在这里 process.exit，否则会绕过统一错误契约。
    throw new Error('缺少 --information-request');
  }

  const technicalTerms = (options.technicalTerms || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  if (options.jsonl) {
    if (process.stdin.isTTY) {
      throw new Error(
        '--jsonl 需要管道输入，例如 cat queries.jsonl | contextweaver search --jsonl',
      );
    }
    const { prepareCodebaseRetrieval, retrieveIndexedCodebase } = await import(
      './mcp/tools/codebaseRetrieval.js'
    );
    const input = await new Promise<string>((resolve, reject) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        data += chunk;
      });
      process.stdin.on('end', () => resolve(data));
      process.stdin.on('error', reject);
    });
    const lines = input
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean);
    if (lines.length === 0) throw new Error('JSONL input contains no queries');

    // 先整体校验输入：若全是坏行，直接逐行输出错误并返回，
    // 不触发索引准备 / 模型工作；否则坏行不终止批量，逐行输出对应错误。
    const parsedRows = lines.map((line, index) => ({
      index,
      row: parseJsonlLine(line, index + 1),
    }));
    if (!parsedRows.some(({ row }) => row.ok)) {
      for (const { row } of parsedRows) {
        if (!row.ok) process.stdout.write(`${JSON.stringify({ error: row.error })}\n`);
      }
      process.exitCode = 1;
      return;
    }

    const progressWrite = (text: string) => process.stderr.write(text);
    const indexProgress = new ProgressBar({
      label: '索引准备',
      write: progressWrite,
      useAnsi: false,
    });
    indexProgress.start();
    await prepareCodebaseRetrieval(repoPath, (current, total, message) => {
      indexProgress.update(current, total ?? 100, message);
    });
    indexProgress.done('索引已就绪');

    process.stderr.write(`开始检索 ${parsedRows.length} 条 query\n`);
    const startedAt = Date.now();
    let lineFailed = false;
    for (const { index, row } of parsedRows) {
      const queryStartedAt = Date.now();
      const prefix = `[${String(index + 1).padStart(String(lines.length).length)}/${lines.length}] `;
      if (!row.ok) {
        // 坏行不终止批量：该行输出 {"error": ...}，继续处理后续行，最终以非零码收尾
        lineFailed = true;
        process.stdout.write(`${JSON.stringify({ error: row.error })}\n`);
        process.stderr.write(`${prefix}失败: ${row.error}\n`);
        continue;
      }
      const query = row.query;
      try {
        const contextPack = await retrieveIndexedCodebase({
          repo_path: repoPath,
          information_request: query.information_request,
          technical_terms: query.technical_terms,
        });
        process.stdout.write(`${JSON.stringify(toCliSearchResult(contextPack))}\n`);
        const queryMs = Date.now() - queryStartedAt;
        const elapsedMs = Date.now() - startedAt;
        process.stderr.write(
          `${prefix}完成 ${queryMs} ms · 累计 ${(elapsedMs / 1000).toFixed(1)}s\n`,
        );
      } catch (err) {
        // 坏行不终止批量：该行输出 {"error": ...}，继续处理后续行，最终以非零码收尾
        lineFailed = true;
        const message = err instanceof Error ? err.message : String(err);
        process.stdout.write(`${JSON.stringify({ error: message })}\n`);
        process.stderr.write(`${prefix}失败: ${message}\n`);
      }
    }
    if (lineFailed) process.exitCode = 1;
    return;
  }

  const retrievalInput = {
    repo_path: repoPath,
    information_request: informationRequest as string,
    technical_terms: technicalTerms.length > 0 ? technicalTerms : undefined,
  };

  if (options.json) {
    const { retrieveCodebase } = await import('./mcp/tools/codebaseRetrieval.js');
    const contextPack = await retrieveCodebase(retrievalInput);
    process.stdout.write(`${JSON.stringify(toCliSearchResult(contextPack))}\n`);
    return;
  }

  const { handleCodebaseRetrieval } = await import('./mcp/tools/codebaseRetrieval.js');
  const response = await handleCodebaseRetrieval(retrievalInput);
  const text = response.content.map((item) => item.text).join('\n');
  process.stdout.write(`${text}\n`);
}

cli
  .command('search', '本地检索（参数对齐 MCP）')
  .option('--repo-path <path>', '代码库根目录（默认当前目录）')
  .option('--information-request <text>', '自然语言问题描述（必填）')
  .option(
    '--technical-terms <terms>',
    '精确术语（逗号分隔；--jsonl 模式下忽略，以每行查询的 technical_terms 为准）',
  )
  .option('--json', '以 JSON 输出结构化检索结果')
  .option('--jsonl', '从标准输入读取 JSONL 查询并逐行输出 JSON 结果')
  .action(async (options: SearchOptions) => {
    try {
      await runSearchAction(options);
    } catch (err) {
      // json/jsonl 契约：stdout 单行 {"error": ...}；人读模式简短提示，详情看日志
      const message = err instanceof Error ? err.message : String(err);
      if (options.json || options.jsonl) {
        process.stdout.write(`${JSON.stringify({ error: message })}\n`);
      } else {
        logger.error({ err, consoleMessage: `检索失败: ${message}` }, `检索失败: ${message}`);
      }
      process.exitCode = 1;
    }
  });

cli.help((sections) => {
  const titles: Record<string, string> = {
    Usage: '用法',
    Commands: '命令',
    Options: '选项',
    Examples: '示例',
  };
  return sections.map((section) => {
    if (!section.title) {
      return { body: color.bold('ContextWeaver') };
    }
    if (section.title === 'Commands') {
      return {
        title: color.bold('命令'),
        body: cli.commands
          .map(
            (command) => `  ${color.cyan(command.rawName)}\n    ${color.gray(command.description)}`,
          )
          .join('\n'),
      };
    }
    if (section.title.startsWith('For more info')) {
      return { body: color.gray('  contextweaver <command> --help 查看命令选项') };
    }
    return {
      title: color.bold(titles[section.title] ?? section.title),
      body: section.body,
    };
  });
});
const helpOption = cli.globalCommand.options.find((option) => option.name === 'help');
if (helpOption) helpOption.description = '显示帮助';
cli.usage('<command> [options]');
cli.parse();
if (process.argv.length === 2) cli.outputHelp();
