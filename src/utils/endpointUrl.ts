/**
 * 由 Base URL 解析完整接口地址
 *
 * 约定 .env 中存储以 /v1 结尾的 Base URL（OpenAI 兼容生态惯例），
 * 客户端调用前拼接资源路径；旧版写入的完整接口地址保持兼容（原样返回）。
 */

/**
 * 解析完整接口地址
 * @param baseUrl Base URL（以 /v1 结尾）或旧版完整接口地址
 * @param resourcePath 资源路径，如 '/embeddings'、'/rerank'
 */
export function resolveEndpointUrl(baseUrl: string, resourcePath: string): string {
  const url = new URL(baseUrl.trim());
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith(resourcePath) ? pathname : `${pathname}${resourcePath}`;
  return url.toString();
}
