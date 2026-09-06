import chardet from 'chardet';
import iconv from 'iconv-lite';

/**
 * 规范化编码名称，使其与 iconv-lite 兼容
 */
function normalizeEncoding(encoding: string): string {
  const map: Record<string, string> = {
    'UTF-8': 'utf8',
    'UTF-16 LE': 'utf16le',
    'UTF-16 BE': 'utf16be',
    'UTF-32 LE': 'utf32le',
    'UTF-32 BE': 'utf32be',
    GB18030: 'gb18030',
    GBK: 'gbk',
    GB2312: 'gb2312',
    Big5: 'big5',
    Shift_JIS: 'shiftjis',
    'EUC-JP': 'eucjp',
    'EUC-KR': 'euckr',
    'ISO-8859-1': 'iso88591',
    'windows-1252': 'win1252',
    ASCII: 'utf8', // ASCII 是 UTF-8 的子集
  };
  return map[encoding] || encoding.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * 检测 BOM（Byte Order Mark）
 */
function detectBOM(buffer: Buffer): string | null {
  if (buffer.length >= 4) {
    // UTF-32 LE
    if (buffer[0] === 0xff && buffer[1] === 0xfe && buffer[2] === 0x00 && buffer[3] === 0x00) {
      return 'UTF-32 LE';
    }
    // UTF-32 BE
    if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0xfe && buffer[3] === 0xff) {
      return 'UTF-32 BE';
    }
  }
  if (buffer.length >= 3) {
    // UTF-8 BOM
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      return 'UTF-8';
    }
  }
  if (buffer.length >= 2) {
    // UTF-16 LE
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      return 'UTF-16 LE';
    }
    // UTF-16 BE
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      return 'UTF-16 BE';
    }
  }
  return null;
}

/**
 * 解码缓冲区为 UTF-8 字符串（自动检测编码）
 *
 * 调用方须先用 buffer.includes(0) 做二进制检测——必须在解码前基于原始字节进行，
 * 解码（尤其误判为 UTF-16 时）可能吃掉 NUL 字节导致漏判。
 *
 * @param buffer 原始文件字节
 * @returns 解码后的 UTF-8 内容
 */
export function decodeBuffer(buffer: Buffer): string {
  // 检测编码：BOM 优先，其次 chardet 启发式检测
  const encoding = detectBOM(buffer) || chardet.detect(buffer) || 'UTF-8';
  const normalizedEncoding = normalizeEncoding(encoding);

  // 解码（iconv 对无效字节采用替换策略，不会抛异常）
  let content: string;
  if (iconv.encodingExists(normalizedEncoding)) {
    content = iconv.decode(buffer, normalizedEncoding);
  } else {
    content = buffer.toString('utf-8');
  }

  // 剥离 BOM 字符：iconv-lite 对 UTF-8 不剥离 BOM（UTF-16/32 会自动剥），
  // 统一去除开头的 U+FEFF，避免其进入 hash/AST/chunk
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }

  return content;
}
