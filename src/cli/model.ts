/** 本地 Embedding 模型管理命令。 */

import path from 'node:path';
import {
  DEFAULT_LOCAL_MODEL_ID,
  getLocalModelDefinition,
  getModelsDir,
  installLocalModel,
  isLocalModelId,
  type LocalModelId,
  listLocalModelStatuses,
  listLocalModels,
  removeLocalModel,
  useLocalModel,
} from '../models/index.js';
import { ProgressBar, Spinner } from './progress.js';
import { confirm, isInteractive, select } from './prompts.js';
import { color, intro, log, writeLine } from './theme.js';

export type ModelCommandAction = 'install' | 'list' | 'use' | 'remove';

export interface ModelCommandOptions {
  yes?: boolean;
}

export async function runModelCommand(
  requestedAction?: string,
  requestedModel?: string,
  options: ModelCommandOptions = {},
): Promise<void> {
  const action = resolveAction(requestedAction);
  intro('本地模型');
  if (action === 'list') {
    if (requestedModel) throw new Error('model list 不接受模型参数');
    await listModels();
    return;
  }

  const model = await resolveModel(action, requestedModel);
  switch (action) {
    case 'install':
      await installModel(model);
      return;
    case 'use':
      await useModel(model);
      return;
    case 'remove':
      await removeModel(model, options.yes === true);
      return;
  }
}

const ACTION_ALIASES: Record<string, ModelCommandAction> = {
  i: 'install',
  install: 'install',
  ls: 'list',
  list: 'list',
  u: 'use',
  use: 'use',
  r: 'remove',
  remove: 'remove',
};

function resolveAction(requestedAction?: string): ModelCommandAction {
  const action = ACTION_ALIASES[requestedAction?.trim().toLowerCase() || 'list'];
  if (!action) {
    throw new Error(`未知的 model 操作: ${requestedAction}。可选值: install, list, use, remove`);
  }
  return action;
}

async function resolveModel(
  action: Exclude<ModelCommandAction, 'list'>,
  requestedModel?: string,
): Promise<LocalModelId> {
  if (requestedModel) return getLocalModelDefinition(requestedModel.trim().toLowerCase()).id;

  if (action === 'install' && !isInteractive()) {
    return getConfiguredLocalModel() ?? DEFAULT_LOCAL_MODEL_ID;
  }

  if (!isInteractive()) {
    throw new Error(
      `非交互环境下 model ${action} 必须指定模型，可选值: ${listLocalModels()
        .map((model) => model.id)
        .join(', ')}`,
    );
  }

  const statuses = await listLocalModelStatuses();
  const candidates = statuses.filter((status) =>
    action === 'install' ? true : action === 'remove' ? status.hasCache : status.installed,
  );
  if (candidates.length === 0) {
    throw new Error(
      action === 'remove'
        ? '没有可删除的本地模型缓存'
        : '尚未安装本地模型，请先运行: contextweaver model install',
    );
  }

  return select<LocalModelId>({
    message: `选择要${action === 'install' ? '安装' : action === 'use' ? '启用' : '删除'}的本地模型`,
    initialValue:
      candidates.find((status) => status.active)?.model.id ??
      (candidates.some((status) => status.model.id === DEFAULT_LOCAL_MODEL_ID)
        ? DEFAULT_LOCAL_MODEL_ID
        : candidates[0]?.model.id),
    options: candidates.map((status) => ({
      value: status.model.id,
      label: `${status.model.displayName}（${status.model.parameterSize}）`,
      hint: [
        status.installed
          ? '已安装'
          : status.hasCache
            ? '安装未完成或缓存已过期'
            : `${status.model.dimensions} 维`,
        ...(status.active ? ['当前配置'] : []),
        status.model.license,
      ].join(' · '),
    })),
  });
}

async function listModels(): Promise<void> {
  const statuses = await listLocalModelStatuses();
  log.info(`缓存目录：${getModelsDir()}`);
  for (const status of statuses) {
    const state = [
      status.installed ? color.green('已安装') : color.gray('未安装'),
      ...(status.active ? [color.cyan('当前配置')] : []),
    ].join(' · ');
    writeLine(`\n${color.bold(status.model.displayName)}  ${state}`);
    log.message(
      color.gray(
        `${status.model.parameterSize} · ${status.model.dtype} · ${status.model.dimensions} 维 · ${status.model.maxContextTokens} token`,
      ),
    );
    log.message(color.gray(`模型 ID：${status.model.id} · ${status.model.license}`));
  }
}

async function installModel(model: LocalModelId): Promise<void> {
  const definition = getLocalModelDefinition(model);
  const spinner = new Spinner();
  const bar = new ProgressBar({ label: '下载进度' });
  let activeFile: string | undefined;
  spinner.start(`正在安装 ${definition.displayName}（${definition.parameterSize}）`);
  try {
    const result = await installLocalModel(model, (progress) => {
      // 按文件展示，避免总进度与单文件进度交替覆盖。
      if (progress.status === 'progress_total') return;
      const file = progress.file ? path.basename(progress.file) : '模型文件';
      if (progress.status === 'done') {
        const message = `${file} 已就绪`;
        if (bar.isActive() && activeFile === progress.file) {
          bar.done(''); // 清除进度条，用普通行输出结果
          log.success(message);
        } else if (bar.isActive()) {
          log.success(message);
        } else {
          spinner.stop(message);
        }
        if (!bar.isActive()) spinner.start('正在加载模型');
      } else if (progress.progress !== undefined && Number.isFinite(progress.progress)) {
        spinner.stop();
        activeFile = progress.file;
        bar.start();
        bar.update(progress.progress, 100, `正在下载 ${file}`);
      } else if (!bar.isActive()) {
        spinner.message(`正在处理 ${file}`);
      }
    });
    const message = result.alreadyInstalled
      ? `${definition.displayName} 已安装，无需重复下载`
      : '安装完成';
    if (bar.isActive()) {
      bar.done(message);
    } else {
      spinner.stop(message);
    }
    if (getConfiguredLocalModel() === model) {
      await useLocalModel(model); // 同步 .env 中的维度等配置
      log.info('当前配置已使用此模型');
    } else {
      log.info(`运行 contextweaver model use ${model} 启用此模型`);
    }
  } catch (error) {
    if (bar.isActive()) bar.fail('模型安装失败');
    else spinner.fail('模型安装失败');
    throw error;
  }
}

async function useModel(model: LocalModelId): Promise<void> {
  const active = (await listLocalModelStatuses()).some(
    (status) => status.model.id === model && status.active,
  );
  await useLocalModel(model);
  const displayName = getLocalModelDefinition(model).displayName;
  log.success(active ? `${displayName} 已是当前模型` : `已启用 ${displayName}`);
  if (!active) log.info('下次索引时会自动重建不兼容的向量索引');
}

async function removeModel(model: LocalModelId, skipConfirmation: boolean): Promise<void> {
  const definition = getLocalModelDefinition(model);
  const status = (await listLocalModelStatuses()).find((item) => item.model.id === model);
  if (!status?.hasCache) {
    log.success(`${definition.displayName} 无本地缓存，无需删除`);
    return;
  }

  if (!skipConfirmation) {
    if (!isInteractive()) {
      throw new Error('非交互环境下删除模型必须传入 --yes');
    }
    const confirmed = await confirm({
      message: `删除 ${definition.displayName} 的本地缓存${status.active ? '（当前使用的模型，删除后需重装或切换才能继续使用）' : ''}？`,
      defaultTrue: false,
    });
    if (!confirmed) {
      log.info('已取消删除');
      return;
    }
  }

  await removeLocalModel(model);
  log.success(`已删除 ${definition.displayName}`);
  if (status.active) {
    log.warn('已删除当前使用的模型，配置未更改。继续使用前请重装或切换模型：');
    log.info(`contextweaver model install ${model}`);
    log.info('contextweaver model use <model>');
  }
}

function getConfiguredLocalModel(): LocalModelId | null {
  const provider = process.env.EMBEDDINGS_PROVIDER?.trim().toLowerCase();
  const configured = process.env.EMBEDDINGS_MODEL?.trim();
  if (provider === 'remote') return null;
  if (provider === 'local') {
    return configured ? (isLocalModelId(configured) ? configured : null) : DEFAULT_LOCAL_MODEL_ID;
  }

  const hasLegacyRemoteConfig =
    process.env.EMBEDDINGS_API_KEY !== undefined ||
    process.env.EMBEDDINGS_BASE_URL !== undefined ||
    (configured !== undefined && !isLocalModelId(configured));
  if (hasLegacyRemoteConfig) return null;
  return isLocalModelId(configured) ? configured : DEFAULT_LOCAL_MODEL_ID;
}
