/** 本地 Embedding 模型管理命令。 */

import path from 'node:path';
import {
  DEFAULT_LOCAL_MODEL_ID,
  getLocalModelDefinition,
  getModelsDir,
  installLocalModel,
  isLocalModelId,
  isLocalModelInstalled,
  listLocalModelStatuses,
  listLocalModels,
  removeLocalModel,
  type LocalModelId,
  useLocalModel,
} from '../models/index.js';
import { isInteractive, select } from './prompts.js';
import { Spinner } from './progress.js';
import { color, intro, log, writeLine } from './theme.js';

export type ModelCommandAction = 'install' | 'list' | 'use' | 'remove';

export async function runModelCommand(
  action: ModelCommandAction,
  requestedModel?: string,
): Promise<void> {
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
      await removeModel(model);
      return;
  }
}

async function resolveModel(
  action: Exclude<ModelCommandAction, 'list'>,
  requestedModel?: string,
): Promise<LocalModelId> {
  if (requestedModel) return getLocalModelDefinition(requestedModel.trim()).id;

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

  return select<LocalModelId>({
    message: `选择要${action === 'install' ? '安装' : action === 'use' ? '启用' : '删除'}的本地模型`,
    options: listLocalModels().map((model) => ({
      value: model.id,
      label: `${model.displayName}（${model.parameterSize}）`,
      hint: `${model.dimensions} 维 · ${model.license}`,
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
    log.message(color.gray(`${status.model.parameterSize} · ${status.model.dimensions} 维`));
    log.message(color.gray(`模型 ID：${status.model.id}`));
  }
}

async function installModel(model: LocalModelId): Promise<void> {
  const definition = getLocalModelDefinition(model);
  const spinner = new Spinner();
  spinner.start(`正在安装 ${definition.displayName}（${definition.parameterSize}）`);
  let lastProgress = -1;
  try {
    const result = await installLocalModel(model, (progress) => {
      const percent = progress.progress === undefined ? undefined : Math.floor(progress.progress);
      if (percent !== undefined && percent === lastProgress) return;
      if (percent !== undefined) lastProgress = percent;
      const file = progress.file ? path.basename(progress.file) : '模型文件';
      spinner.message(
        percent === undefined ? `正在处理 ${file}` : `正在下载 ${file} ${percent}%`,
      );
    });
    spinner.stop(result.alreadyInstalled ? `${definition.displayName} 已安装` : '安装完成');
  } catch (error) {
    spinner.fail(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function useModel(model: LocalModelId): Promise<void> {
  await useLocalModel(model);
  log.success(`已启用 ${getLocalModelDefinition(model).displayName}`);
}

async function removeModel(model: LocalModelId): Promise<void> {
  const installed = await isLocalModelInstalled(model);
  await removeLocalModel(model);
  log.success(
    `${getLocalModelDefinition(model).displayName} ${installed ? '已删除' : '未安装，保持不变'}`,
  );
}

function getConfiguredLocalModel(): LocalModelId | null {
  const provider = process.env.EMBEDDINGS_PROVIDER?.trim().toLowerCase();
  const configured = process.env.EMBEDDINGS_MODEL?.trim();
  if (provider === 'remote') return null;
  if (provider === 'local') return isLocalModelId(configured) ? configured : null;

  const hasLegacyRemoteConfig =
    process.env.EMBEDDINGS_API_KEY !== undefined ||
    process.env.EMBEDDINGS_BASE_URL !== undefined ||
    (configured !== undefined && !isLocalModelId(configured));
  if (hasLegacyRemoteConfig) return null;
  return isLocalModelId(configured) ? configured : DEFAULT_LOCAL_MODEL_ID;
}
