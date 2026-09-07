/**
 * ContextWeaver 内置本地 Embedding 模型目录与生命周期。
 *
 * 模型 ID、仓库、revision 和推理规则全部固定在这里；CLI 不接受任意模型路径，
 * 以避免模型配置漂移和从不受信任位置加载代码。
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODEL_INSTALL_MARKER = 'install.json';

const MODEL_CATALOG = {
  'jina-embeddings-v2-base-code': {
    displayName: 'jina-embeddings-v2-base-code',
    parameterSize: '161M',
    repo: 'jinaai/jina-embeddings-v2-base-code',
    revision: '516f4baf13dec4ddddda8631e019b5737c8bc250',
    dtype: 'q8',
    dimensions: 768,
    maxContextTokens: 8192,
    runtime: 'feature-extraction',
    pooling: 'mean',
    queryPrefix: '',
    documentPrefix: '',
    documentInputSpaceVersion: 'jina-mean-v1',
    license: 'Apache-2.0',
  },
  'embeddinggemma-300m': {
    displayName: 'EmbeddingGemma-300M',
    parameterSize: '300M',
    repo: 'onnx-community/embeddinggemma-300m-ONNX',
    revision: '5090578d9565bb06545b4552f76e6bc2c93e4a66',
    dtype: 'q8',
    dimensions: 768,
    maxContextTokens: 2048,
    runtime: 'sentence-embedding',
    pooling: 'sentence_embedding',
    queryPrefix: 'task: code retrieval | query: ',
    documentPrefix: 'title: none | text: ',
    documentInputSpaceVersion: 'embeddinggemma-code-retrieval-v1',
    license: 'Gemma license',
  },
  'qwen3-embedding-0.6b': {
    displayName: 'Qwen3-Embedding-0.6B',
    parameterSize: '600M',
    repo: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    revision: 'c25a394dd583836952667c12f008335071b3f43d',
    dtype: 'q8',
    dimensions: 1024,
    maxContextTokens: 32768,
    runtime: 'feature-extraction',
    pooling: 'last_token',
    queryPrefix:
      'Instruct: Given a code search query, retrieve relevant code snippets that answer the query\nQuery:',
    documentPrefix: '',
    documentInputSpaceVersion: 'qwen3-last-token-v1',
    license: 'Apache-2.0',
  },
} as const;

export type LocalModelId = keyof typeof MODEL_CATALOG;

export type LocalModelDefinition = {
  id: LocalModelId;
} & (typeof MODEL_CATALOG)[LocalModelId];

export const DEFAULT_LOCAL_MODEL_ID: LocalModelId = 'embeddinggemma-300m';
export const LOCAL_MODEL_IDS = Object.keys(MODEL_CATALOG) as LocalModelId[];

export interface ModelProgress {
  status: string;
  file?: string;
  progress?: number;
}

export interface ModelInstallMarker {
  version: 1;
  model: LocalModelId;
  repo: string;
  revision: string;
  dtype: string;
  dimensions: number;
}

export interface LocalModelStatus {
  model: LocalModelDefinition;
  installed: boolean;
  hasCache: boolean;
  active: boolean;
}

export function listLocalModels(): LocalModelDefinition[] {
  return LOCAL_MODEL_IDS.map((id) => getLocalModelDefinition(id));
}

export function isLocalModelId(value: string | undefined | null): value is LocalModelId {
  return typeof value === 'string' && Object.hasOwn(MODEL_CATALOG, value);
}

export function getLocalModelDefinition(model: string): LocalModelDefinition {
  if (!isLocalModelId(model)) {
    throw new Error(`未知的本地 Embedding 模型: ${model}。可选值: ${LOCAL_MODEL_IDS.join(', ')}`);
  }
  return { id: model, ...MODEL_CATALOG[model] };
}

export function getContextWeaverDir(): string {
  return path.join(os.homedir(), '.contextweaver');
}

export function getModelsDir(): string {
  return path.join(getContextWeaverDir(), 'models');
}

export function getLocalModelDir(model: string): string {
  const definition = getLocalModelDefinition(model);
  return path.join(getModelsDir(), definition.id);
}

export function getLocalModelCacheDir(model: string): string {
  return getLocalModelDir(model);
}

export function getInstallMarkerPath(model: string): string {
  return path.join(getLocalModelDir(model), MODEL_INSTALL_MARKER);
}

/** 只读本地标记；不会触发模型加载或网络访问。 */
export async function readModelInstallMarker(model: string): Promise<ModelInstallMarker | null> {
  const definition = getLocalModelDefinition(model);
  try {
    const [stats, content] = await Promise.all([
      fs.stat(getLocalModelDir(definition.id)),
      fs.readFile(getInstallMarkerPath(definition.id), 'utf8'),
    ]);
    if (!stats.isDirectory()) return null;
    const marker = JSON.parse(content) as Partial<ModelInstallMarker>;
    if (
      marker.version !== 1 ||
      marker.model !== definition.id ||
      marker.repo !== definition.repo ||
      marker.revision !== definition.revision ||
      marker.dtype !== definition.dtype ||
      marker.dimensions !== definition.dimensions
    ) {
      return null;
    }
    return marker as ModelInstallMarker;
  } catch {
    return null;
  }
}

export async function isLocalModelInstalled(model: string): Promise<boolean> {
  return (await readModelInstallMarker(model)) !== null;
}

async function hasLocalModelCache(model: LocalModelId): Promise<boolean> {
  try {
    return (await fs.stat(getLocalModelDir(model))).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function listLocalModelStatuses(): Promise<LocalModelStatus[]> {
  const active = getActiveLocalModelId();
  return Promise.all(
    listLocalModels().map(async (model) => ({
      model,
      installed: await isLocalModelInstalled(model.id),
      hasCache: await hasLocalModelCache(model.id),
      active: active === model.id,
    })),
  );
}

/**
 * 显式安装模型。只有该路径允许 Transformers.js 访问网络。
 * 安装标记在完整加载成功后才原子写入。
 */
export async function installLocalModel(
  model: string,
  onProgress?: (progress: ModelProgress) => void,
): Promise<{ model: LocalModelDefinition; alreadyInstalled: boolean }> {
  const definition = getLocalModelDefinition(model);
  if (await isLocalModelInstalled(definition.id)) {
    return { model: definition, alreadyInstalled: true };
  }

  const modelDir = getLocalModelDir(definition.id);
  await fs.mkdir(modelDir, { recursive: true });

  try {
    const { loadLocalModel } = await import('../api/localEmbedding.js');
    const loaded = await loadLocalModel(definition, {
      localFilesOnly: false,
      onProgress,
    });
    await loaded.dispose();

    await writeInstallMarker({
      version: 1,
      model: definition.id,
      repo: definition.repo,
      revision: definition.revision,
      dtype: definition.dtype,
      dimensions: definition.dimensions,
    });
    return { model: definition, alreadyInstalled: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`本地模型安装失败（${definition.id}）：${message}`);
  }
}

export async function useLocalModel(model: string): Promise<void> {
  const definition = getLocalModelDefinition(model);
  if (!(await isLocalModelInstalled(definition.id))) {
    throw new Error(
      `本地模型 ${definition.id} 尚未安装，请先运行: contextweaver model install ${definition.id}`,
    );
  }

  const envFile = path.join(getContextWeaverDir(), '.env');
  let content = '';
  try {
    content = await fs.readFile(envFile, 'utf8');
  } catch (error) {
    const code = error as { code?: string };
    if (code.code !== 'ENOENT') throw error;
  }

  const next = setEnvValues(content, {
    EMBEDDINGS_PROVIDER: 'local',
    EMBEDDINGS_MODEL: definition.id,
    EMBEDDINGS_DIMENSIONS: String(definition.dimensions),
  });
  if (next === content) return;

  await fs.mkdir(getContextWeaverDir(), { recursive: true });
  await atomicWrite(envFile, next);
}

export async function removeLocalModel(model: string): Promise<void> {
  const definition = getLocalModelDefinition(model);
  await fs.rm(getLocalModelDir(definition.id), { recursive: true, force: true });
}

function getActiveLocalModelId(): LocalModelId | null {
  const provider = process.env.EMBEDDINGS_PROVIDER?.trim().toLowerCase();
  const model = process.env.EMBEDDINGS_MODEL?.trim();
  if (provider === 'remote') return null;
  if (provider === 'local') {
    return model ? (isLocalModelId(model) ? model : null) : DEFAULT_LOCAL_MODEL_ID;
  }

  const hasLegacyRemoteConfig =
    process.env.EMBEDDINGS_API_KEY !== undefined ||
    process.env.EMBEDDINGS_BASE_URL !== undefined ||
    (model !== undefined && !isLocalModelId(model));
  if (hasLegacyRemoteConfig) return null;
  return isLocalModelId(model) ? model : DEFAULT_LOCAL_MODEL_ID;
}

async function writeInstallMarker(marker: ModelInstallMarker): Promise<void> {
  const markerPath = getInstallMarkerPath(marker.model);
  const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporaryPath, markerPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function setEnvValues(content: string, updates: Record<string, string>): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();

  for (const [key, value] of Object.entries(updates)) {
    const pattern = new RegExp(
      `^(\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=\\s*)(.*?)(\\s+#.*)?$`,
    );
    let matched = false;
    for (let index = 0; index < lines.length; index++) {
      const match = lines[index].match(pattern);
      if (!match) continue;
      lines[index] = `${match[1]}${value}${match[3] ?? ''}`;
      matched = true;
    }
    if (!matched) lines.push(`${key}=${value}`);
  }

  return `${lines.join(newline)}${newline}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let mode = 0o600;
  try {
    mode = (await fs.stat(filePath)).mode & 0o777;
  } catch {
    // 新配置文件使用仅 owner 可读写的权限。
  }

  try {
    await fs.writeFile(temporaryPath, content, { encoding: 'utf8', mode });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new Error(
      `更新 ${filePath} 失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
