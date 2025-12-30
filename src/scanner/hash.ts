import crypto from 'node:crypto';

/**
 * 计算字符串的 SHA-256 hash
 * @param data 输入字符串
 * @returns 十六进制格式的 hash
 */
export function sha256(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
