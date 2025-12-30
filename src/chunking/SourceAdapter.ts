/**
 * SourceAdapter - 统一索引域适配器
 *
 * 设计目标：
 * 1. 在文件解析后探测 Tree-sitter 使用的索引域（UTF-16 vs UTF-8）
 * 2. 提供统一的 slice() 和 nws() 接口，屏蔽底层编码差异
 * 3. 当检测到 UTF-8 索引域时，使用 Buffer 进行安全切片
 *
 * 索引域探测逻辑：
 * - UTF-16: root.endIndex === code.length (JS 字符串长度)
 * - UTF-8: root.endIndex === Buffer.byteLength(code, 'utf8')
 * - Unknown: 两者都不匹配，需要使用 startPosition/endPosition 定位
 */

export type IndexDomain = 'utf16' | 'utf8' | 'unknown';

export interface SourceAdapterConfig {
  code: string;
  endIndex: number; // Tree-sitter root.endIndex
}

export class SourceAdapter {
  private readonly code: string;
  private readonly domain: IndexDomain;
  private readonly buffer: Buffer | null;

  // UTF-8 字节偏移 -> 字符偏移的映射表（仅 UTF-8 域使用）
  private readonly byteToCharMap: Uint32Array | null;

  // UTF-16 前缀和（用于 NWS 计算）
  private readonly nwsPrefixSum: Uint32Array;

  constructor(config: SourceAdapterConfig) {
    this.code = config.code;

    // 1. 探测索引域
    const lenUtf16 = config.code.length;
    const lenUtf8 = Buffer.byteLength(config.code, 'utf8');

    if (config.endIndex === lenUtf16) {
      this.domain = 'utf16';
      this.buffer = null;
      this.byteToCharMap = null;
    } else if (config.endIndex === lenUtf8) {
      this.domain = 'utf8';
      this.buffer = Buffer.from(config.code, 'utf8');
      this.byteToCharMap = this.buildByteToCharMap();
    } else {
      // 索引域不明确，降级处理
      this.domain = 'unknown';
      this.buffer = null;
      this.byteToCharMap = null;
      console.warn(
        `[SourceAdapter] Index domain unclear: endIndex=${config.endIndex}, ` +
          `utf16Len=${lenUtf16}, utf8Len=${lenUtf8}`,
      );
    }

    // 2. 构建 NWS 前缀和（始终在字符域，保持语义一致）
    this.nwsPrefixSum = this.buildNwsPrefixSum();
  }

  /**
   * 获取检测到的索引域
   */
  public getDomain(): IndexDomain {
    return this.domain;
  }

  /**
   * 安全切片：根据索引域选择正确的切片方式
   *
   * 对于 UTF-8 域，先将字节边界对齐到字符边界，再进行切片
   *
   * @param start Tree-sitter 返回的 startIndex
   * @param end Tree-sitter 返回的 endIndex
   * @returns 切片后的字符串
   */
  public slice(start: number, end: number): string {
    if (this.domain === 'utf16' || this.domain === 'unknown') {
      // 直接使用 JS 字符串切片
      return this.code.slice(start, end);
    }

    // UTF-8 域：先将字节偏移转换为字符偏移，再在字符串上切片
    // 这样可以避免切到多字节字符中间产生乱码
    if (!this.byteToCharMap) {
      return this.code.slice(start, end);
    }

    const charStart = this.byteToChar(start);
    const charEnd = this.byteToChar(end);
    return this.code.slice(charStart, charEnd);
  }

  /**
   * 计算区间的非空白字符数
   *
   * 注意：NWS 始终在字符域计算，保持语义一致性
   * 如果索引域是 UTF-8，需要先将字节偏移转换为字符偏移
   *
   * @param start Tree-sitter 返回的 startIndex
   * @param end Tree-sitter 返回的 endIndex
   * @returns 非空白字符数
   */
  public nws(start: number, end: number): number {
    let charStart: number;
    let charEnd: number;

    if (this.domain === 'utf8' && this.byteToCharMap) {
      // 字节偏移 -> 字符偏移
      charStart = this.byteToChar(start);
      charEnd = this.byteToChar(end);
    } else {
      charStart = start;
      charEnd = end;
    }

    // 使用字符域的前缀和计算
    const maxIndex = this.nwsPrefixSum.length - 1;
    const s = Math.max(0, Math.min(maxIndex, charStart));
    const e = Math.max(0, Math.min(maxIndex, charEnd));
    return this.nwsPrefixSum[e] - this.nwsPrefixSum[s];
  }

  /**
   * 获取总的非空白字符数
   */
  public getTotalNws(): number {
    return this.nwsPrefixSum[this.nwsPrefixSum.length - 1];
  }

  /**
   * 将字节偏移转换为字符偏移
   */
  private byteToChar(byteOffset: number): number {
    if (!this.byteToCharMap) return byteOffset;

    const safeOffset = Math.max(0, Math.min(this.byteToCharMap.length - 1, byteOffset));
    return this.byteToCharMap[safeOffset];
  }

  /**
   * 构建字节偏移到字符偏移的映射表
   *
   * 对于 UTF-8 编码，一个字符可能占用 1-4 个字节
   * 此映射表允许 O(1) 查找任意字节偏移对应的字符偏移
   */
  private buildByteToCharMap(): Uint32Array {
    // 这里的 buffer 在构造函数中已经被初始化（只有 utf8 域才会调用此方法）
    const buffer = this.buffer as Buffer;
    const map = new Uint32Array(buffer.length + 1);

    let charIndex = 0;
    let byteIndex = 0;

    while (byteIndex < buffer.length) {
      map[byteIndex] = charIndex;

      // 确定当前字符占用的字节数
      const byte = buffer[byteIndex];
      let charBytes: number;

      if ((byte & 0x80) === 0) {
        // ASCII: 0xxxxxxx
        charBytes = 1;
      } else if ((byte & 0xe0) === 0xc0) {
        // 2-byte: 110xxxxx
        charBytes = 2;
      } else if ((byte & 0xf0) === 0xe0) {
        // 3-byte: 1110xxxx
        charBytes = 3;
      } else if ((byte & 0xf8) === 0xf0) {
        // 4-byte: 11110xxx (注意：这在 UTF-16 中是代理对，占 2 个 code unit)
        charBytes = 4;
      } else {
        // 无效字节，按 1 处理
        charBytes = 1;
      }

      // 填充中间字节的映射（指向同一个字符）
      for (let i = 1; i < charBytes && byteIndex + i < buffer.length; i++) {
        map[byteIndex + i] = charIndex;
      }

      byteIndex += charBytes;

      // 4字节 UTF-8 在 JS 中是代理对，占 2 个字符位
      if (charBytes === 4) {
        charIndex += 2;
      } else {
        charIndex += 1;
      }
    }

    map[buffer.length] = charIndex;
    return map;
  }

  /**
   * 构建字符域的 NWS 前缀和
   */
  private buildNwsPrefixSum(): Uint32Array {
    const prefixSum = new Uint32Array(this.code.length + 1);
    let count = 0;

    for (let i = 0; i < this.code.length; i++) {
      const cc = this.code.charCodeAt(i);
      // 空格、制表符、换行、回车
      if (!(cc === 0x20 || cc === 0x09 || cc === 0x0a || cc === 0x0d)) {
        count++;
      }
      prefixSum[i + 1] = count;
    }

    return prefixSum;
  }
}
