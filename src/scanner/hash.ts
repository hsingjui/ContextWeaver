import crypto from 'node:crypto';

/**
 * 计算 SHA-256 hash
 *
 * 建议传入原始 Buffer：基于解码后字符串的 hash 会随编码检测（chardet）
 * 的误判或版本升级而变化，触发无谓的全量重索引。
 *
 * @param data 输入内容（原始字节或字符串）
 * @returns 十六进制格式的 hash
 */
export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
