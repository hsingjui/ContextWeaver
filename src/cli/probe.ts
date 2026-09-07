/**
 * 配置连通性探测（init 向导与 doctor 共用）
 *
 * 用最小请求验证三件事：地址可达、Key 有效、返回向量维度与配置一致。
 * 不记录任何 Key 信息到日志；错误映射为面向用户的中文提示。
 */

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  /** Embedding 探测成功时为接口实际返回的向量维度 */
  dimensions?: number;
  error?: string;
}

const PROBE_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function describeHttpError(status: number): string {
  if (status === 401 || status === 403) {
    return `鉴权失败 (${status})：请检查 API Key`;
  }
  if (status === 404) {
    return '接口不存在 (404)：请检查 Base URL 是否为完整接口路径';
  }
  if (status === 400 || status === 422) {
    return `请求被拒绝 (${status})：请检查模型名称是否正确`;
  }
  if (status === 429) {
    return '触发限流 (429)：请稍后重试';
  }
  return `服务端错误 (${status})`;
}

function describeNetworkError(err: unknown): string {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return `连接超时（>${PROBE_TIMEOUT_MS / 1000}s）：服务未启动或网络不可达`;
  }
  const cause = (err as { cause?: { code?: string } }).cause;
  const code = cause?.code;
  if (code === 'ECONNREFUSED') {
    return '连接被拒绝：本地服务是否已启动？';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return '域名解析失败：请检查 Base URL';
  }
  if (code === 'ETIMEDOUT') {
    return '网络连接超时';
  }
  return `网络错误: ${err instanceof Error ? err.message : String(err)}`;
}

export interface EmbeddingProbeParams {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 探测 Embedding 接口，成功时返回实际向量维度 */
export async function probeEmbedding(params: EmbeddingProbeParams): Promise<ProbeResult> {
  const startedAt = Date.now();
  try {
    const response = await fetch(params.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify({
        model: params.model,
        input: ['ping'],
        encoding_format: 'float',
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: describeHttpError(response.status),
      };
    }
    const payload: unknown = await response.json();
    const firstItem =
      isRecord(payload) && Array.isArray(payload.data) ? payload.data[0] : undefined;
    if (
      !isRecord(firstItem) ||
      !Array.isArray(firstItem.embedding) ||
      firstItem.embedding.length === 0
    ) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: '响应格式不符合 OpenAI embeddings 规范，请确认 Base URL 指向 /embeddings 接口',
      };
    }
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      dimensions: firstItem.embedding.length,
    };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: describeNetworkError(err) };
  }
}

export interface RerankerProbeParams {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 探测 Reranker 接口 */
export async function probeReranker(params: RerankerProbeParams): Promise<ProbeResult> {
  const startedAt = Date.now();
  try {
    const response = await fetch(params.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify({
        model: params.model,
        query: 'ping',
        documents: ['hello world', 'ping pong'],
        top_n: 1,
        return_documents: false,
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: describeHttpError(response.status),
      };
    }
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.results)) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: '响应格式不符合 rerank 规范，请确认 Base URL 指向 rerank 接口',
      };
    }
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: describeNetworkError(err) };
  }
}
