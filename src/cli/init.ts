/**
 * init 命令：引导式配置向导
 *
 * 交互式引导选择 Embedding / Reranker 服务（本地模型或云端 API），
 * 逐项收集 URL / Key / 模型 / 维度，可选连通性测试（自动校验维度一致性），
 * 最终写入 ~/.contextweaver/.env。
 * 非交互环境（管道 / CI）或 --defaults 时回退为写入默认模板。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDefaultEnvContent,
  buildEnvContent,
  type EnvAnswers,
  type EnvRerankerAnswers,
  parseEnvVars,
} from '../utils/envTemplate.js';
import {
  DEFAULT_LOCAL_MODEL_ID,
  listLocalModels,
  type LocalModelId,
} from '../models/index.js';
import { logger } from '../utils/logger.js';
import { probeEmbedding, probeReranker } from './probe.js';
import { confirm, input, isInteractive, NonInteractiveError, password, select } from './prompts.js';
import { Spinner } from './progress.js';
import { color, intro, log, maskSecret, note, outro, symbol, writeLine } from './theme.js';

interface EmbeddingProviderPreset {
  value: string;
  label: string;
  kind: 'remote' | 'local';
  baseUrl?: string;
  model?: string;
  dimensions?: string;
  hint: string;
}

const EMBEDDING_PROVIDERS: EmbeddingProviderPreset[] = [
  {
    value: 'local',
    label: 'ContextWeaver 内置本地模型',
    kind: 'local',
    model: DEFAULT_LOCAL_MODEL_ID,
    hint: 'CPU 离线推理，无需 Embedding API；默认 EmbeddingGemma-300M',
  },
  {
    value: 'siliconflow',
    label: 'SiliconFlow',
    kind: 'remote',
    baseUrl: 'https://api.siliconflow.cn/v1/embeddings',
    model: 'BAAI/bge-m3',
    dimensions: '1024',
    hint: '国内云端 API，推荐',
  },
  {
    value: 'openai',
    label: 'OpenAI / OpenAI 兼容 API',
    kind: 'remote',
    baseUrl: 'https://api.openai.com/v1/embeddings',
    model: 'text-embedding-3-small',
    dimensions: '1536',
    hint: '官方或任意兼容网关',
  },
  {
    value: 'ollama',
    label: 'Ollama（OpenAI 兼容 API）',
    kind: 'remote',
    baseUrl: 'http://localhost:11434/v1/embeddings',
    model: 'bge-m3',
    dimensions: '1024',
    hint: '需先 ollama pull bge-m3；仍通过 HTTP 调用',
  },
  {
    value: 'lmstudio',
    label: 'LM Studio（OpenAI 兼容 API）',
    kind: 'remote',
    baseUrl: 'http://localhost:1234/v1/embeddings',
    model: 'text-embedding-nomic-embed-text-v1.5',
    dimensions: '768',
    hint: '本地 GUI 服务；仍按 remote provider 配置',
  },
  {
    value: 'custom',
    label: '自定义（OpenAI 兼容 API）',
    kind: 'remote',
    baseUrl: '',
    model: '',
    dimensions: '1024',
    hint: '手动输入全部参数',
  },
];

const RERANKER_PROVIDERS = [
  {
    value: 'siliconflow',
    label: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1/rerank',
    model: 'BAAI/bge-reranker-v2-m3',
    hint: '国内云端 API，推荐',
  },
  {
    value: 'custom',
    label: '自定义（兼容 rerank 接口）',
    baseUrl: '',
    model: '',
    hint: '手动输入全部参数',
  },
  {
    value: 'skip',
    label: '暂不配置',
    baseUrl: '',
    model: '',
    hint: '检索功能将不可用，可稍后重新运行 init',
  },
] as const;

type RerankerChoice = (typeof RERANKER_PROVIDERS)[number]['value'];

function validateHttpUrl(value: string): true | string {
  if (/^https?:\/\/.+/i.test(value.trim())) return true;
  return '必须是以 http:// 或 https:// 开头的完整接口地址';
}

function validateNonEmpty(value: string): true | string {
  if (value.trim()) return true;
  return '不能为空';
}

function validatePositiveInt(value: string): true | string {
  if (/^\d+$/.test(value.trim()) && Number.parseInt(value, 10) > 0) return true;
  return '请输入正整数';
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 已存在配置文件的摘要（note 内容体） */
function buildExistingConfigNote(content: string): string {
  const vars = parseEnvVars(content);
  const rows: Array<[string, string]> = [
    ['Embedding Provider', vars.EMBEDDINGS_PROVIDER ?? '(自动判断)'],
    ['Embedding 模型', vars.EMBEDDINGS_MODEL ?? '(未设置)'],
    ['Embedding 地址', vars.EMBEDDINGS_BASE_URL ?? '(本地模型)'],
    ['Embedding 维度', vars.EMBEDDINGS_DIMENSIONS ?? '(未设置)'],
    ['Embedding Key', vars.EMBEDDINGS_API_KEY ? maskSecret(vars.EMBEDDINGS_API_KEY) : '(未设置)'],
    ['Reranker 模型', vars.RERANK_MODEL ?? '(未设置)'],
    ['Reranker 地址', vars.RERANK_BASE_URL ?? '(未设置)'],
  ];
  return rows.map(([label, value]) => `${color.gray(`${label}：`)}${value}`).join('\n');
}

/** 配置摘要（写入成功后的 note 内容体） */
function buildSummaryNote(answers: EnvAnswers): string {
  const { embedding, reranker } = answers;
  const rows: Array<[string, string]> = [];
  if (embedding.provider === 'local') {
    rows.push(
      ['Embedding', `${embedding.model} ${symbol.dot} EmbeddingGemma/内置模型`],
      ['', 'Provider local · 离线 CPU 推理'],
      ['', `安装: contextweaver model install ${embedding.model}`],
    );
  } else {
    rows.push(
      ['Embedding', `${embedding.model} ${symbol.dot} ${embedding.dimensions} 维`],
      ['', embedding.baseUrl],
      ['', `Key ${maskSecret(embedding.apiKey)}`],
    );
  }
  if (reranker) {
    rows.push(
      ['Reranker', reranker.model],
      ['', reranker.baseUrl],
      ['', `Key ${maskSecret(reranker.apiKey)}`],
    );
  } else {
    rows.push(['Reranker', '未配置（检索功能不可用）']);
  }
  return rows
    .map(([label, value]) => (label ? `${color.bold(label)}  ${value}` : `  ${color.gray(value)}`))
    .join('\n');
}

function printNextSteps(localModel?: LocalModelId): void {
  const steps: Array<[string, string]> = [];
  if (localModel) steps.push([`contextweaver model install ${localModel}`, '安装本地模型']);
  steps.push(
    ['contextweaver doctor', '检查配置'],
    ['contextweaver index .', '索引当前目录'],
    ['contextweaver mcp', '添加到 MCP 客户端'],
  );
  note(
    steps.map(([command, label]) => `${color.cyan(command)}\n  ${color.gray(label)}`).join('\n'),
    '下一步',
  );
  writeLine('');
}

/** 交互式向导 */
async function runWizard(envFile: string, existing: boolean): Promise<void> {
  // ===== Embedding =====
  const providerValue = await select({
    message: '选择 Embedding 服务',
    initialValue: 'local',
    options: EMBEDDING_PROVIDERS.map((provider) => ({
      value: provider.value,
      label: provider.label,
      hint: provider.hint,
    })),
  });
  const provider = EMBEDDING_PROVIDERS.find((item) => item.value === providerValue);
  if (!provider) {
    throw new Error(`未知的提供方: ${providerValue}`);
  }

  let localModel: LocalModelId | undefined;
  let baseUrl = '';
  let model = '';
  let apiKey = '';
  let dimensions = '';
  if (provider.kind === 'local') {
    localModel = await select<LocalModelId>({
      message: '选择 ContextWeaver 内置本地模型',
      initialValue: DEFAULT_LOCAL_MODEL_ID,
      options: listLocalModels().map((item) => ({
        value: item.id,
        label: `${item.displayName}（${item.parameterSize}）`,
        hint: `${item.dimensions} 维 ${item.maxContextTokens} token · ${item.license}`,
      })),
    });
    model = localModel;
  } else {
    baseUrl = await input({
      message: 'Embedding Base URL（完整接口地址）',
      defaultValue: provider.baseUrl,
      validate: validateHttpUrl,
    });
    model = await input({
      message: 'Embedding 模型',
      defaultValue: provider.model,
      validate: validateNonEmpty,
    });
    apiKey = await password({
      message: 'API Key',
      validate: validateNonEmpty,
    });
    dimensions = await input({
      message: '向量维度',
      defaultValue: provider.dimensions,
      validate: validatePositiveInt,
    });
  }

  // ===== Reranker =====
  const rerankerChoice = await select<RerankerChoice>({
    message: '选择 Reranker 服务（检索必需）',
    options: RERANKER_PROVIDERS.map((item) => ({
      value: item.value,
      label: item.label,
      hint: item.hint,
    })),
  });
  let reranker: EnvRerankerAnswers | null = null;
  if (rerankerChoice === 'skip') {
    log.warn('未配置 Reranker：检索功能不可用，可稍后重新运行 init 补全');
  } else {
    const preset = RERANKER_PROVIDERS.find((item) => item.value === rerankerChoice);
    const rerankUrl = await input({
      message: 'Reranker Base URL（完整接口地址）',
      defaultValue: preset?.baseUrl ? preset.baseUrl : undefined,
      validate: validateHttpUrl,
    });
    const rerankModel = await input({
      message: 'Reranker 模型',
      defaultValue: preset?.model ? preset.model : undefined,
      validate: validateNonEmpty,
    });
    const rerankKey = await password({
      message: 'Reranker API Key',
      validate: validateNonEmpty,
    });
    reranker = { baseUrl: rerankUrl, model: rerankModel, apiKey: rerankKey, topN: '20' };
  }

  // ===== 连通性测试 =====
  let embeddingProbeOk = true;
  if (await confirm({ message: '立即测试远程连通性？', defaultTrue: true })) {
    const probe = new Spinner();
    if (provider.kind === 'remote') {
      probe.start('正在测试 Embedding 连通性');
      const embeddingProbe = await probeEmbedding({ baseUrl, apiKey, model });
      embeddingProbeOk = embeddingProbe.ok;
      if (embeddingProbe.ok) {
        probe.stop(
          `Embedding 接口 ${symbol.dot} ${embeddingProbe.latencyMs}ms ${symbol.dot} 实际维度 ${embeddingProbe.dimensions}`,
        );
        if (
          embeddingProbe.dimensions !== undefined &&
          embeddingProbe.dimensions !== Number.parseInt(dimensions, 10)
        ) {
          log.warn(
            `维度不一致：配置 ${dimensions}，接口实际返回 ${embeddingProbe.dimensions}（不一致会导致索引与检索失败）`,
          );
          if (await confirm({ message: '将配置维度更新为实际值？', defaultTrue: true })) {
            dimensions = `${embeddingProbe.dimensions}`;
          }
        }
      } else {
        probe.fail(`Embedding 接口不可用：${embeddingProbe.error}`);
      }
    } else {
      log.info('本地 Embedding 不执行网络连通性测试');
    }

    if (reranker) {
      probe.start('正在测试 Reranker 连通性');
      const rerankerProbe = await probeReranker({
        baseUrl: reranker.baseUrl,
        apiKey: reranker.apiKey,
        model: reranker.model,
      });
      if (rerankerProbe.ok) {
        probe.stop(`Reranker 接口 ${symbol.dot} ${rerankerProbe.latencyMs}ms`);
      } else {
        probe.fail(`Reranker 接口不可用：${rerankerProbe.error}`);
      }
    }

    if (!embeddingProbeOk) {
      if (!(await confirm({ message: '连接失败，仍要保存配置吗？', defaultTrue: true }))) {
        outro('已取消，配置未写入');
        return;
      }
    }
  }

  if (provider.kind === 'local' && !localModel) {
    throw new Error('未选择本地 Embedding 模型');
  }
  const answers: EnvAnswers = {
    embedding:
      provider.kind === 'local'
        ? { provider: 'local', model: localModel as LocalModelId }
        : { provider: 'remote', baseUrl, model, apiKey, dimensions },
    reranker,
  };
  if (existing) {
    try {
      await fs.copyFile(envFile, `${envFile}.bak`);
      log.info(`旧配置已备份: ${envFile}.bak`);
    } catch (err) {
      logger.warn({ error: (err as Error).message }, '旧配置备份失败，继续覆盖写入');
      log.warn('旧配置备份失败，将继续覆盖写入');
    }
  }
  await fs.writeFile(envFile, buildEnvContent(answers), 'utf-8');

  note(buildSummaryNote(answers), '配置摘要');
  printNextSteps(localModel);
  log.success(`配置已写入 ${envFile}`);
}

/** 非交互回退：写入默认模板（保持原有行为） */
async function writeDefaultTemplate(envFile: string): Promise<void> {
  if (await fileExists(envFile)) {
    log.info(`已保留现有配置：${envFile}`);
    return;
  }
  try {
    await fs.writeFile(envFile, buildDefaultEnvContent(), 'utf-8');
    log.success(`已创建默认配置：${envFile}`);
  } catch (err) {
    const error = err as { message?: string; stack?: string };
    logger.error({ err, stack: error.stack }, `创建 .env 文件失败: ${error.message}`);
    process.exit(1);
  }
  printNextSteps(DEFAULT_LOCAL_MODEL_ID);
  log.info(`如需远程 Embedding，编辑配置文件：${envFile}`);
}

/** init 命令入口 */
export async function runInitCommand(options: { defaults?: boolean }): Promise<void> {
  const configDir = path.join(os.homedir(), '.contextweaver');
  const envFile = path.join(configDir, '.env');

  try {
    await fs.mkdir(configDir, { recursive: true });
  } catch (err) {
    const error = err as { code?: string; message?: string; stack?: string };
    if (error.code !== 'EEXIST') {
      logger.error({ err, stack: error.stack }, `创建配置目录失败: ${error.message}`);
      process.exit(1);
    }
  }

  intro('配置向导');

  // 非交互环境或显式 --defaults：写入模板并给出编辑指引
  if (options.defaults || !isInteractive()) {
    if (!options.defaults) {
      log.info('非交互模式，使用默认配置模板');
    }
    await writeDefaultTemplate(envFile);
    return;
  }

  log.message(`${color.gray('配置文件：')}${envFile}`);

  let existing = false;
  if (await fileExists(envFile)) {
    existing = true;
    const content = await fs.readFile(envFile, 'utf-8');
    note(buildExistingConfigNote(content), '当前配置');
    const action = await select({
      message: '已存在配置文件，如何处理？',
      options: [
        { value: 'reconfigure', label: '重新配置', hint: '覆盖写入，旧文件备份为 .env.bak' },
        { value: 'keep', label: '保留现有配置', hint: '直接退出' },
      ],
    });
    if (action === 'keep') {
      printNextSteps();
      outro('已保留现有配置');
      return;
    }
  }

  try {
    await runWizard(envFile, existing);
  } catch (err) {
    // 向导中途失去交互能力（stdin 被重定向等）时回退为模板，避免半途而废
    if (err instanceof NonInteractiveError) {
      log.warn('交互中断，改用默认配置模板');
      await writeDefaultTemplate(envFile);
      return;
    }
    throw err;
  }
}
