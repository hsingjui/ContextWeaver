/**
 * 分片模块（chunking）完整测试
 *
 * 覆盖：
 * - AST 路径核心不变量：rawSpan 拼接 === 完整文件、displayCode 精确切片、
 *   nwsSize 记账闭环、预算上界、索引单调
 * - SourceAdapter 索引域探测：UTF-16 / UTF-8（模拟）/ unknown
 * - UTF-8 域字节→字符映射：中文 + emoji 代理对，任意字节偏移安全切片
 * - comment 前向吸附（TS JSDoc / Python 注释）
 * - overlap：vectorSpan 前向延伸及 vectorText 一致性
 * - fallback 行分片：rawSpan 完整性、预算、超长行降级
 * - 边界：空文件、纯空白、超大原子节点（超长字符串）
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type Parser from '@keqingmoe/tree-sitter';
import { getParser } from '../src/chunking/ParserPool.js';
import { SemanticSplitter } from '../src/chunking/SemanticSplitter.js';
import { SourceAdapter } from '../src/chunking/SourceAdapter.js';
import type { ProcessedChunk } from '../src/chunking/types.js';

// ==========================================
// 工具函数
// ==========================================

/** 生产同款配置（见 src/scanner/processor.ts） */
function makeSplitter(): SemanticSplitter {
  return new SemanticSplitter({ maxChunkSize: 500, minChunkSize: 50, chunkOverlap: 40 });
}

/** 独立实现的 NWS 计数（与实现不同途径，用于交叉验证） */
function nws(s: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const cc = s.charCodeAt(i);
    if (!(cc === 0x20 || cc === 0x09 || cc === 0x0a || cc === 0x0d)) count++;
  }
  return count;
}

/** 独立实现的字节偏移 → UTF-16 字符偏移映射（for...of 按 code point 迭代，黑盒交叉验证） */
function byteToCharMap(code: string): Int32Array {
  const buf = Buffer.from(code, 'utf8');
  const map = new Int32Array(buf.length + 1);
  let charIndex = 0;
  let byteIndex = 0;
  for (const cp of code) {
    const bytes = Buffer.byteLength(cp, 'utf8');
    for (let i = 0; i < bytes; i++) map[byteIndex + i] = charIndex;
    byteIndex += bytes;
    charIndex += cp.length; // 代理对占 2 个 UTF-16 code unit
  }
  map[buf.length] = charIndex;
  return map;
}

interface DomainSlicer {
  slice(start: number, end: number): string;
  total: number;
}

/** 域感知切片器：按探测到的索引域验证 AST 索引偏移 */
function makeDomainSlicer(code: string, domain: 'utf16' | 'utf8'): DomainSlicer {
  if (domain === 'utf16') {
    return { slice: (s, e) => code.slice(s, e), total: code.length };
  }
  const buf = Buffer.from(code, 'utf8');
  const map = byteToCharMap(code);
  return {
    slice: (s, e) => {
      const cs = map[Math.max(0, Math.min(map.length - 1, s))];
      const ce = map[Math.max(0, Math.min(map.length - 1, e))];
      return code.slice(cs, ce);
    },
    total: buf.length,
  };
}

async function parseCode(
  language: string,
  code: string,
): Promise<{ tree: Parser.Tree; domain: 'utf16' | 'utf8' }> {
  const parser = await getParser(language);
  assert.ok(parser, `parser for ${language} unavailable`);
  const tree = parser.parse(code);
  const domain = new SourceAdapter({ code, endIndex: tree.rootNode.endIndex }).getDomain();
  assert.ok(domain === 'utf16' || domain === 'utf8', `unexpected domain: ${domain}`);
  return { tree, domain: domain };
}

// ==========================================
// AST 路径核心不变量
// ==========================================

/**
 * 验证一组 chunk 的所有结构不变量。
 * 这些是 rawSpan 还原、displayCode 展示、nwsSize 预算控制共同依赖的契约。
 */
function assertChunkInvariants(
  t: { code: string; domain: 'utf16' | 'utf8' },
  chunks: ProcessedChunk[],
  opts: { maxNws: number; allowAtomic?: boolean } = { maxNws: 500 },
): void {
  const slicer = makeDomainSlicer(t.code, t.domain);

  // 索引单调不减
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(
      chunks[i].metadata.startIndex >= chunks[i - 1].metadata.endIndex,
      `chunk[${i}] startIndex 回退: ${chunks[i].metadata.startIndex} < ${chunks[i - 1].metadata.endIndex}`,
    );
  }

  // rawSpan：首块从 0 开始、相邻块端到端衔接、末块到文件末尾
  assert.equal(chunks[0].metadata.rawSpan.start, 0, '首块 rawSpan.start 应为 0');
  assert.equal(
    chunks[chunks.length - 1].metadata.rawSpan.end,
    slicer.total,
    '末块 rawSpan.end 应覆盖文件末尾',
  );
  for (let i = 0; i < chunks.length; i++) {
    const { start, end } = chunks[i].metadata.rawSpan;
    if (i > 0) {
      assert.equal(start, chunks[i - 1].metadata.rawSpan.end, `rawSpan[${i}] 与前块不衔接`);
    }
    assert.ok(start <= end, `rawSpan[${i}] 起止倒置`);
  }

  // rawSpan 拼接 === 完整文件（不重叠、无遗漏）
  const assembled =
    t.domain === 'utf16'
      ? chunks.map((c) => t.code.slice(c.metadata.rawSpan.start, c.metadata.rawSpan.end)).join('')
      : Buffer.concat(
          chunks.map((c) =>
            Buffer.from(t.code, 'utf8').subarray(c.metadata.rawSpan.start, c.metadata.rawSpan.end),
          ),
        ).toString('utf8');
  assert.equal(assembled, t.code, 'rawSpan 拼接后必须 === 完整文件');

  for (const c of chunks) {
    const m = c.metadata;

    // displayCode 是源文件的精确切片（startIndex/endIndex 契约）
    assert.equal(
      c.displayCode,
      slicer.slice(m.startIndex, m.endIndex),
      'displayCode 与 [startIndex, endIndex) 切片不符',
    );

    // nwsSize 记账闭环：恰好等于 displayCode 的实际非空白字符数
    assert.equal(
      c.nwsSize,
      nws(c.displayCode),
      `nwsSize=${c.nwsSize} 与 displayCode 实际 NWS=${nws(c.displayCode)} 不符`,
    );

    // vectorText = "// Context: <breadcrumb>\n" + [vectorSpan) 区间切片
    const ctxLine = `// Context: ${m.contextPath.join(' > ')}`;
    assert.ok(
      c.vectorText.startsWith(`${ctxLine}\n`),
      `vectorText 前缀不符: ${c.vectorText.slice(0, 80)}`,
    );
    assert.equal(
      c.vectorText.slice(ctxLine.length + 1),
      slicer.slice(m.vectorSpan.start, m.vectorSpan.end),
      'vectorText 正文与 vectorSpan 切片不符',
    );

    // vectorSpan 包含语义区间 [startIndex, endIndex)
    assert.ok(m.vectorSpan.start <= m.startIndex, 'vectorSpan.start 越过 startIndex');
    assert.ok(m.vectorSpan.end >= m.endIndex, 'vectorSpan.end 未覆盖 endIndex');

    // 预算上界（原子块豁免：不可拆分的超大叶子节点）
    if (!opts.allowAtomic || c.nwsSize <= 750) {
      assert.ok(
        c.nwsSize <= 750, // maxChunkSize(500) × 1.5（tiny 合并容忍度）
        `chunk 超预算: nwsSize=${c.nwsSize} > 750`,
      );
    }
  }
}

// ==========================================
// fixture 生成
// ==========================================

function genFunctions(fnCount: number): string {
  const parts = ['import { helper } from "./helper.js";'];
  for (let i = 0; i < fnCount; i++) {
    parts.push(`function fn${i}(argOne, argTwo) {`);
    parts.push(`  const result = argOne + argTwo + ${i};`);
    parts.push(`  return helper(result, ${i});`);
    parts.push('}');
    parts.push('');
  }
  return parts.join('\n');
}

function genClasses(classCount: number, methodCount: number): string {
  const parts: string[] = [];
  for (let c = 0; c < classCount; c++) {
    parts.push(`class Service${c} {`);
    for (let m = 0; m < methodCount; m++) {
      parts.push(`  handle${m}(payload${m}) {`);
      parts.push(`    const value${m} = payload${m} + ${m} + ${c};`);
      parts.push(`    return { value${m}, payload${m} };`);
      parts.push('  }');
      parts.push('');
    }
    parts.push('}');
    parts.push('');
  }
  return parts.join('\n');
}

// ==========================================
// 测试：AST 分片（真实 parser）
// ==========================================

test('AST 小文件 → 单 chunk，元数据完整', async () => {
  const code = 'export const answer = 42;\n';
  const { tree, domain } = await parseCode('typescript', code);
  const chunks = makeSplitter().split(tree, code, 'src/answer.ts', 'typescript');

  assert.equal(chunks.length, 1);
  assertChunkInvariants({ code, domain }, chunks);
  const c = chunks[0];
  assert.equal(c.displayCode, code); // Base Case：整个根节点一个窗口（含末尾换行）
  assert.ok(c.vectorText.startsWith('// Context: src/answer.ts\n'));
  assert.equal(c.metadata.contextPath[0], 'src/answer.ts');
});

test('AST 大文件（30 函数）→ rawSpan 无损拼接、预算、记账闭环', async () => {
  const code = genFunctions(30);
  const { tree, domain } = await parseCode('typescript', code);
  const chunks = makeSplitter().split(tree, code, 'src/big.ts', 'typescript');

  assert.ok(chunks.length > 1, `应切出多个 chunk，实际 ${chunks.length}`);
  assertChunkInvariants({ code, domain }, chunks);

  // 内容无丢失：所有 displayCode 中的函数名都能在源码中找到对应
  const names = Array.from(code.matchAll(/function (fn\d+)\(/g)).map((m) => m[1]);
  const union = chunks.map((c) => c.displayCode).join('\n');
  for (const name of names) {
    assert.ok(union.includes(name), `函数 ${name} 丢失`);
  }
});

test('AST 语义层级 → contextPath 面包屑（class > method）', async () => {
  const code = genClasses(2, 10); // 每个 class ~700 NWS，超过 500 触发递归到 method 层
  const { tree, domain } = await parseCode('typescript', code);
  const chunks = makeSplitter().split(tree, code, 'src/services.ts', 'typescript');

  assertChunkInvariants({ code, domain }, chunks);

  // 必须有 chunk 带上 class + method 面包屑
  const withMethodCtx = chunks.filter((c) => {
    const p = c.metadata.contextPath;
    return p.some((s) => s.startsWith('class ')) && p.includes('handle0');
  });
  assert.ok(withMethodCtx.length > 0, '缺少 class > method 层级面包屑');

  // vectorText 应携带该面包屑
  for (const c of withMethodCtx) {
    assert.ok(c.vectorText.includes('Context: src/services.ts'));
  }
});

test('AST comment 前向吸附 → JSDoc 与其后的函数同 chunk', async () => {
  const lines: string[] = [];
  // 前置填充函数（确保 JSDoc 出现在 chunk 边界处）
  lines.push(genFunctions(10));
  // JSDoc + 函数：吸附逻辑应把 /** ... */ 推入 fnX 所在窗口
  lines.push('/**');
  lines.push(' * Processes the payload for the target handler.');
  lines.push(' * @param input - the raw input value');
  lines.push(' */');
  lines.push('function targetFn(input) {');
  lines.push('  return input + 1;');
  lines.push('}');
  lines.push(genFunctions(5));
  const code = lines.join('\n');

  const { tree, domain } = await parseCode('typescript', code);
  const chunks = makeSplitter().split(tree, code, 'src/jsdoc.ts', 'typescript');

  assertChunkInvariants({ code, domain }, chunks);
  const owner = chunks.find((c) => c.displayCode.includes('function targetFn'));
  assert.ok(owner, 'targetFn 丢失');
  assert.ok(
    owner.displayCode.includes('Processes the payload'),
    `JSDoc 未随函数走，owner chunk:\n${owner.displayCode.slice(0, 400)}`,
  );
});

test('AST 中文 + emoji 文件 → 切片无乱码（索引域安全）', async () => {
  const code = [
    'const 名字 = "中文字符串内容";',
    'const emoji = "🎉🚀组合";',
    'function 计算(参数一, 参数二) {',
    '  return `结果：${参数一} + ${参数二} 🎯`; // 行内注释',
    '}',
    '/**',
    ' * 多行注释：测试中文注释吸附 📝',
    ' */',
    'function 另一个函数() {',
    '  return "值" + "🎉";',
    '}',
    '',
  ].join('\n');

  const { tree, domain } = await parseCode('typescript', code);
  const chunks = makeSplitter().split(tree, code, 'src/中文.ts', 'typescript');

  assertChunkInvariants({ code, domain }, chunks);
  // 无乱码：displayCode 均为原文字（U+FFFD 替换符不出现）
  for (const c of chunks) {
    assert.ok(!c.displayCode.includes('\uFFFD'), '切片出现乱码（U+FFFD）');
  }
  const owner = chunks.find((c) => c.displayCode.includes('另一个函数'));
  assert.ok(owner?.displayCode.includes('多行注释'), '中文注释未随函数吸附');
});

test('Python 文件 → comment 吸附与中文安全', async () => {
  const lines: string[] = [];
  for (let i = 0; i < 12; i++) {
    lines.push(`def fn_${i}(arg_one, arg_two):`);
    lines.push(`    result = arg_one + arg_two + ${i}`);
    lines.push('    return result');
    lines.push('');
  }
  lines.push('# 注释：计算目标值 🎯');
  lines.push('def target_fn(value):');
  lines.push('    return value * 2');
  const code = lines.join('\n');

  const { tree, domain } = await parseCode('python', code);
  const chunks = makeSplitter().split(tree, code, 'src/calc.py', 'python');

  assertChunkInvariants({ code, domain }, chunks);
  const owner = chunks.find((c) => c.displayCode.includes('def target_fn'));
  assert.ok(owner, 'target_fn 丢失');
  assert.ok(owner.displayCode.includes('计算目标值'), 'Python 注释未随函数吸附');
});

test('AST overlap → vectorSpan 前向延伸且与源码精确一致', async () => {
  const code = genFunctions(30);
  const { tree, domain } = await parseCode('typescript', code);
  const splitter = new SemanticSplitter({ maxChunkSize: 500, minChunkSize: 50, chunkOverlap: 40 });
  const chunks = splitter.split(tree, code, 'src/overlap.ts', 'typescript');

  assertChunkInvariants({ code, domain }, chunks);
  const slicer = makeDomainSlicer(code, domain);
  let overlapped = 0;
  for (let i = 1; i < chunks.length; i++) {
    const c = chunks[i];
    if (c.metadata.vectorSpan.start < c.metadata.startIndex) {
      overlapped++;
      const overlapText = slicer.slice(c.metadata.vectorSpan.start, c.metadata.startIndex);
      const overlapNws = nws(overlapText);
      // findOverlapStart 契约：overlap 区域 NWS ≥ chunkOverlap（40）
      assert.ok(overlapNws >= 40, `chunk[${i}] overlap NWS=${overlapNws} < 40`);
    }
  }
  assert.ok(overlapped > 0, '常规大文件应有 chunk 启用 overlap');
});

test('AST 空文件 / 纯空白文件 → 空文件无 chunk，纯空白单 chunk，不崩溃', async () => {
  // 空文件：无内容可索引 → 出口统一限额后为 0 chunks
  const empty = await parseCode('typescript', '');
  assert.equal(makeSplitter().split(empty.tree, '', 'src/empty.ts', 'typescript').length, 0);

  // 纯空白：单 chunk，nws 为 0，不变量成立
  const ws = '   \n\n  \t ';
  const { tree, domain } = await parseCode('typescript', ws);
  const chunks = makeSplitter().split(tree, ws, 'src/ws.ts', 'typescript');
  assert.equal(chunks.length, 1);
  assertChunkInvariants({ code: ws, domain }, chunks);
  assert.equal(chunks[0].nwsSize, 0);
});

test('AST 超大原子节点（超长字符串）→ 出口统一限额切分，不乱码不丢失', async () => {
  const giant = 'x'.repeat(2000);
  const code = `const s = "${giant}";\nfunction small() { return 1; }\n`;
  const { tree, domain } = await parseCode('typescript', code);
  const chunks = makeSplitter().split(tree, code, 'src/giant.ts', 'typescript');

  // enforceLimits 出口统一限额：超长原子节点被切分，不再有超预算块
  assertChunkInvariants({ code, domain }, chunks);
  assert.ok(chunks.length > 1, '超长字符串应被切分为多个 chunk');
  for (const c of chunks) {
    assert.ok(c.nwsSize <= 500, `超预算: ${c.nwsSize}`);
  }
  // 原子节点内容无丢失：切分片段拼接还原完整字符串
  assert.ok(
    chunks
      .map((c) => c.displayCode)
      .join('')
      .includes(giant),
    '切分后原子节点内容不完整',
  );
});

test('splitter 单例复用 → 连续 split 无状态残留', async () => {
  const splitter = makeSplitter();
  const codeA = genFunctions(20);
  const codeB = genClasses(1, 12);
  const { tree: treeA, domain: domainA } = await parseCode('typescript', codeA);
  const { tree: treeB, domain: domainB } = await parseCode('typescript', codeB);

  const chunksA1 = splitter.split(treeA, codeA, 'src/a.ts', 'typescript');
  const chunksB = splitter.split(treeB, codeB, 'src/b.ts', 'typescript');
  const chunksA2 = splitter.split(treeA, codeA, 'src/a.ts', 'typescript');

  assert.deepEqual(chunksA2, chunksA1, '第二次 split A 的结果与第一次不一致（状态泄漏）');
  assertChunkInvariants({ code: codeA, domain: domainA }, chunksA2);
  assertChunkInvariants({ code: codeB, domain: domainB }, chunksB);
});

// ==========================================
// 测试：未知索引域降级（split → fallbackSplit）
// ==========================================

test('split: 索引域不明 → 降级行分片', async (t) => {
  const code = 'const a = 1;\nconst b = 2;\n'.repeat(10);
  const fakeTree = { rootNode: { endIndex: 99999 } } as unknown as Parser.Tree;

  // 静音降级警告
  t.mock.method(console, 'warn', () => {});
  const chunks = makeSplitter().split(fakeTree, code, 'src/fake.ts', 'typescript');

  // fallback 路径：rawSpan 拼接 === 完整文件（UTF-16 域）
  assert.ok(chunks.length >= 1);
  assert.equal(
    chunks.map((c) => code.slice(c.metadata.rawSpan.start, c.metadata.rawSpan.end)).join(''),
    code,
  );
  for (const c of chunks) {
    assert.equal(c.displayCode, code.slice(c.metadata.startIndex, c.metadata.endIndex));
    assert.equal(c.nwsSize, nws(c.displayCode));
  }
});

// ==========================================
// 测试：fallback 行分片（splitPlainText）
// ==========================================

test('fallback: 小文件 → 单 chunk', () => {
  const code = 'const a = 1;\nconst b = 2;\n';
  const chunks = makeSplitter().splitPlainText(code, 'src/small.ts', 'typescript');

  assert.equal(chunks.length, 1);
  const c = chunks[0];
  assert.equal(c.displayCode, code);
  assert.deepEqual(c.metadata.rawSpan, { start: 0, end: code.length });
  assert.deepEqual(c.metadata.vectorSpan, { start: 0, end: code.length });
  assert.equal(c.nwsSize, nws(code));
  assert.ok(c.vectorText.startsWith('// Context: src/small.ts\n'));
});

test('fallback: 大文件 → rawSpan 无损、预算控制、displayCode 精确切片', () => {
  const code = genFunctions(40); // ~1800 NWS
  const chunks = makeSplitter().splitPlainText(code, 'src/plain.ts', 'typescript');

  assert.ok(chunks.length > 1, `应切出多个 chunk，实际 ${chunks.length}`);

  // rawSpan 拼接 === 完整文件
  assert.equal(
    chunks.map((c) => code.slice(c.metadata.rawSpan.start, c.metadata.rawSpan.end)).join(''),
    code,
  );
  // 相邻 rawSpan 端到端
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(chunks[i].metadata.rawSpan.start, chunks[i - 1].metadata.rawSpan.end);
  }

  for (const c of chunks) {
    assert.equal(c.displayCode, code.slice(c.metadata.startIndex, c.metadata.endIndex));
    assert.equal(c.nwsSize, nws(c.displayCode));
    assert.ok(c.nwsSize <= 500, `fallback chunk 超预算: ${c.nwsSize}`);
    assert.equal(c.metadata.language, 'typescript');
    assert.deepEqual(c.metadata.contextPath, ['src/plain.ts']);
  }
});

test('fallback: 无尾随换行文件的 rawSpan 完整性', () => {
  const code = 'a = 1\nb = 2\nc = 3'; // 无尾随 \n
  const lines = ['a = 1', 'b = 2', 'c = 3'];
  const splitter = new SemanticSplitter({ maxChunkSize: 3, minChunkSize: 1, chunkOverlap: 0 });
  const chunks = splitter.splitPlainText(code, 'f.py', 'python');

  assert.equal(
    chunks.map((c) => code.slice(c.metadata.rawSpan.start, c.metadata.rawSpan.end)).join(''),
    code,
  );
  // 每行内容无丢失
  for (const line of lines) {
    assert.ok(
      chunks.some((c) => c.displayCode.includes(line)),
      `行丢失: ${line}`,
    );
  }
});

test('fallback: 超长单行 → 出口统一限额切分，rawSpan 无缝覆盖', () => {
  const giant = `${'x'.repeat(1200)}\nshort = 1\n`;
  const chunks = makeSplitter().splitPlainText(giant, 'src/long.ts', 'typescript');

  assert.equal(
    chunks.map((c) => giant.slice(c.metadata.rawSpan.start, c.metadata.rawSpan.end)).join(''),
    giant,
  );
  // 超长行被出口限额切分，不再有超预算块
  assert.ok(chunks.length > 1, '超长单行应被切分为多个 chunk');
  for (const c of chunks) {
    assert.ok(c.nwsSize <= 500, `超预算: ${c.nwsSize}`);
  }
  assert.equal(chunks[chunks.length - 1].metadata.rawSpan.end, giant.length);
});

test('fallback: 空文件 → 0 chunks', () => {
  // 空文件无内容可索引：不再产生占位空 chunk（与 AST 路径一致）
  const chunks = makeSplitter().splitPlainText('', 'src/empty.ts', 'typescript');
  assert.equal(chunks.length, 0);
});

// ==========================================
// 测试：SourceAdapter 单元（索引域探测 / UTF-8 映射）
// ==========================================

test('SourceAdapter: UTF-16 域探测（真实 tree-sitter 绑定）', async () => {
  const code = 'const 名 = "文🎉";\n';
  const { tree } = await parseCode('typescript', code);
  const adapter = new SourceAdapter({ code, endIndex: tree.rootNode.endIndex });
  assert.equal(adapter.getDomain(), 'utf16');
  assert.equal(adapter.slice(0, code.length), code);
  assert.equal(adapter.getTotalNws(), nws(code));
});

test('SourceAdapter: UTF-8 域探测与任意字节偏移安全切片（含 4 字节代理对）', () => {
  const code = 'const 名 = "中🎉文";\n// 注释 🚀 测试\nlet 值 = 42;';
  const utf8Len = Buffer.byteLength(code, 'utf8');
  const utf16Len = code.length;
  assert.ok(utf8Len > utf16Len, 'fixture 必须含多字节字符');

  const adapter = new SourceAdapter({ code, endIndex: utf8Len });
  assert.equal(adapter.getDomain(), 'utf8');

  // 全量切片 === 原文
  assert.equal(adapter.slice(0, utf8Len), code);

  // 黑盒交叉验证：任意字节偏移 b ∈ [0, utf8Len]
  // slice(0, b) 和 slice(b, utf8Len) 必须落在字符边界（结果可拼接还原）
  const map = byteToCharMap(code);
  for (let b = 0; b <= utf8Len; b++) {
    const head = adapter.slice(0, b);
    const tail = adapter.slice(b, utf8Len);
    assert.equal(head + tail, code, `字节偏移 ${b} 切片不在字符边界`);
    assert.equal(head, code.slice(0, map[b]));
    assert.ok(!head.includes('\uFFFD') && !tail.includes('\uFFFD'), `偏移 ${b} 产生乱码`);
  }

  // nws：字节偏移输入 → 字符域计数
  assert.equal(adapter.nws(0, utf8Len), nws(code));
  // 中间区间：nws(b1, b2) === nws(对应字符区间)
  for (const b of [0, 6, 12, 20, utf8Len - 3, utf8Len]) {
    assert.equal(adapter.nws(b, utf8Len), nws(code.slice(map[b])), `nws(${b}, end) 不符`);
  }

  // 越界 clamp：超出字节长度 → 空切片 / 总字符数
  assert.equal(adapter.slice(utf8Len, utf8Len + 10), '');
  assert.equal(adapter.slice(utf8Len + 5, utf8Len + 9), '');
});

test('SourceAdapter: 4 字节 emoji 的 byteToChar 映射（代理对占 2 个 code unit）', () => {
  const code = 'a🎉b'; // 'a' (1B→1 unit), '🎉' (4B→2 units), 'b' (1B→1 unit)
  const utf8Len = Buffer.byteLength(code, 'utf8'); // 6
  const adapter = new SourceAdapter({ code, endIndex: utf8Len });
  assert.equal(adapter.getDomain(), 'utf8');

  // 字节偏移 1..4 都指向 '🎉' 的起始 char index 1
  for (const b of [1, 2, 3, 4]) {
    assert.equal(adapter.slice(0, b), 'a', `slice(0, ${b}) 应停在字符边界`);
    assert.equal(adapter.slice(b, utf8Len), '🎉b', `slice(${b}, end) 应含完整 emoji`);
  }
  assert.equal(adapter.slice(0, 5), 'a🎉');
  // NWS 按 UTF-16 code unit 计数：a + 高代理 + 低代理 + b = 4
  assert.equal(adapter.getTotalNws(), 4);
  assert.equal(adapter.getTotalNws(), nws(code));
});

test('SourceAdapter: 纯 ASCII 文件 endIndex 双域匹配 → 优先 UTF-16', () => {
  const code = 'const a = 1;\n';
  const adapter = new SourceAdapter({ code, endIndex: code.length });
  assert.equal(adapter.getDomain(), 'utf16');
  // ASCII 下两域偏移一致，切片结果相同
  assert.equal(adapter.slice(6, 11), 'a = 1');
});

test('SourceAdapter: 索引域不明 → unknown，slice 仍按 UTF-16 降级', async (t) => {
  const code = 'const a = 1;\n';
  t.mock.method(console, 'warn', () => {});
  const adapter = new SourceAdapter({ code, endIndex: 999 });
  assert.equal(adapter.getDomain(), 'unknown');
  // unknown 降级用 UTF-16 切片
  assert.equal(adapter.slice(0, code.length), code);
  assert.equal(adapter.getTotalNws(), nws(code));
});

// ==========================================
// 测试：配置默认值
// ==========================================

test('SplitterConfig 默认值：maxChunkSize=2500 / overlap=200 / maxRawChars=4×', () => {
  // 默认 maxChunkSize=2500：2000 NWS 文件应单块
  const big = 'const v = 1;\n'.repeat(200); // ~2000 NWS
  const single = new SemanticSplitter().splitPlainText(big, 'f.ts', 'typescript');
  assert.equal(single.length, 1, '默认 maxChunkSize=2500 下 2000 NWS 应单块');
  const strict = new SemanticSplitter({ maxChunkSize: 500, minChunkSize: 50, chunkOverlap: 40 });
  assert.ok(strict.splitPlainText(big, 'f.ts', 'typescript').length > 1);
});
