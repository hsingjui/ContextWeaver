/**
 * 语义分片器核心实现
 *
 * 采用 AST-Based Semantic Windowing 策略：
 * 1. Dual-Text Strategy - displayCode 用于展示，vectorText 用于 Embedding
 * 2. Gap-Aware Budgeting - 分片大小计算包含节点间缝隙
 * 3. Split-then-Merge - 先递归拆解大块，再滑动窗口合并小块
 * 4. SourceAdapter - 统一索引域适配（UTF-16/UTF-8）
 */
import type Parser from '@keqingmoe/tree-sitter';
import { getLanguageSpec, type LanguageSpecConfig } from './LanguageSpec.js';
import { SourceAdapter } from './SourceAdapter.js';
import type { ChunkMetadata, ProcessedChunk, SplitterConfig, Window } from './types.js';

export class SemanticSplitter {
  private config: SplitterConfig;
  private adapter!: SourceAdapter;
  private code!: string;
  private language!: string;

  constructor(config: Partial<SplitterConfig> = {}) {
    const maxChunkSize = config.maxChunkSize ?? 2500;
    this.config = {
      maxChunkSize,
      minChunkSize: config.minChunkSize ?? 100,
      chunkOverlap: config.chunkOverlap ?? 200,
      // 物理字符硬上限：默认为 maxChunkSize * 4（假设 1 token ≈ 4 chars）
      maxRawChars: config.maxRawChars ?? maxChunkSize * 4,
    };
  }

  /**
   * 对代码进行语义分片
   * @param tree Tree-sitter 解析树
   * @param code 源代码字符串
   * @param filePath 文件路径
   * @param language 语言标识
   * @returns 处理后的分片数组
   */
  public split(
    tree: Parser.Tree,
    code: string,
    filePath: string,
    language: string,
  ): ProcessedChunk[] {
    // 1. 使用 SourceAdapter 进行索引域探测
    this.adapter = new SourceAdapter({
      code,
      endIndex: tree.rootNode.endIndex,
    });

    const domain = this.adapter.getDomain();

    // 索引域不明确时降级
    if (domain === 'unknown') {
      console.warn(
        `[SemanticSplitter] Unknown index domain for ${filePath}, falling back to simple split`,
      );
      return this.fallbackSplit(code, filePath, language);
    }

    // 记录索引域信息（调试用）
    if (domain === 'utf8') {
      console.info(`[SemanticSplitter] Using UTF-8 byte indexing for ${filePath}`);
    }

    // 2. 初始化
    this.code = code;
    this.language = language;

    // 3. 递归分片
    const initialContext = [filePath];
    const windows = this.visitNode(tree.rootNode, initialContext);

    // 4. 生成结果
    return this.windowsToChunks(windows, filePath, language);
  }

  /**
   * 公开的纯文本分片接口
   *
   * 用于不支持 AST 解析的语言，或作为 AST 解析失败时的降级方案。
   * 使用 UTF-16 索引（JS 原生字符串），按行切分。
   *
   * @param code 源代码字符串
   * @param filePath 文件路径
   * @param language 语言标识
   * @returns 处理后的分片数组
   */
  public splitPlainText(code: string, filePath: string, language: string): ProcessedChunk[] {
    return this.fallbackSplit(code, filePath, language);
  }

  /**
   * 降级分片：当索引域不明确时使用
   *
   * 使用 UTF-16 索引（JS 原生字符串），按行切分
   * 注意：fallback 模式不支持 overlap
   */
  private fallbackSplit(code: string, filePath: string, language: string): ProcessedChunk[] {
    // 创建一个 UTF-16 域的 adapter（强制使用 code.length 作为 endIndex）
    const adapter = new SourceAdapter({
      code,
      endIndex: code.length,
    });
    const totalSize = adapter.getTotalNws();

    // 如果总大小够小，直接作为一个块
    if (totalSize <= this.config.maxChunkSize) {
      return [
        {
          displayCode: code,
          vectorText: `// Context: ${filePath}\n${code}`,
          nwsSize: totalSize,
          metadata: {
            startIndex: 0,
            endIndex: code.length,
            rawSpan: { start: 0, end: code.length },
            vectorSpan: { start: 0, end: code.length },
            filePath,
            language,
            contextPath: [filePath],
          },
        },
      ];
    }

    // 按行切分
    const lines = code.split('\n');
    const chunks: ProcessedChunk[] = [];
    let currentLines: string[] = [];
    let currentSize = 0;

    // 追踪当前行的起始位置 (UTF-16 index)
    let lineStartIndex = 0;

    let chunkStartIndex = 0; // 当前 Chunk 的语义起始
    let chunkRawStart = 0; // 当前 Chunk 的 Raw 起始

    for (const line of lines) {
      // 计算当前行的结束位置
      // line.length 不包含 \n，但原始 code 包含 \n
      // 所以这一行的有效内容区间是 [lineStartIndex, lineStartIndex + line.length]
      const lineEndIndex = lineStartIndex + line.length;

      // 使用全局 Adapter 计算 NWS (O(1) 查表)
      const lineNws = adapter.nws(lineStartIndex, lineEndIndex);

      if (currentSize + lineNws > this.config.maxChunkSize && currentLines.length > 0) {
        const displayCode = currentLines.join('\n');

        // 计算精确的 endIndex
        const chunkEndIndex = chunkStartIndex + displayCode.length;

        chunks.push({
          displayCode,
          vectorText: `// Context: ${filePath}\n${displayCode}`,
          nwsSize: currentSize,
          metadata: {
            startIndex: chunkStartIndex,
            endIndex: chunkEndIndex,
            rawSpan: { start: chunkRawStart, end: chunkEndIndex + 1 }, // +1 for newline gap
            vectorSpan: { start: chunkStartIndex, end: chunkEndIndex },
            filePath,
            language,
            contextPath: [filePath],
          },
        });

        // 更新状态
        chunkRawStart = chunkEndIndex + 1;
        chunkStartIndex += displayCode.length + 1;
        currentLines = [line];
        currentSize = lineNws;
      } else {
        currentLines.push(line);
        currentSize += lineNws;
      }

      // 移动到下一行 (+1 跳过 \n)
      lineStartIndex = lineEndIndex + 1;
    }

    // 处理剩余行
    if (currentLines.length > 0) {
      const displayCode = currentLines.join('\n');
      const chunkEndIndex = chunkStartIndex + displayCode.length;
      chunks.push({
        displayCode,
        vectorText: `// Context: ${filePath}\n${displayCode}`,
        nwsSize: currentSize,
        metadata: {
          startIndex: chunkStartIndex,
          endIndex: chunkEndIndex,
          rawSpan: { start: chunkRawStart, end: code.length },
          vectorSpan: { start: chunkStartIndex, end: chunkEndIndex },
          filePath,
          language,
          contextPath: [filePath],
        },
      });
    }

    return chunks;
  }

  /**
   * 递归遍历 AST 节点
   */
  private visitNode(node: Parser.SyntaxNode, context: string[]): Window[] {
    const start = node.startIndex;
    const end = node.endIndex;
    const nodeSize = this.adapter.nws(start, end);

    // --- 上下文更新 ---
    let nextContext = context;
    const spec = getLanguageSpec(this.language);

    if (spec?.hierarchy.has(node.type)) {
      const name = this.extractNodeName(node, spec);
      if (name) {
        const prefix = spec.prefixMap[node.type] ?? '';
        nextContext = [...context, `${prefix}${name}`];
      }
    }

    // Base Case: 节点够小，直接返回
    if (nodeSize <= this.config.maxChunkSize) {
      return [{ nodes: [node], size: nodeSize, contextPath: nextContext }];
    }

    // Recursive Step: 递归处理子节点
    const children = node.children;
    if (children.length === 0) {
      // 无子节点但过大（例如超长字符串），强制作为单块返回
      return [{ nodes: [node], size: nodeSize, contextPath: nextContext }];
    }

    const childWindows: Window[] = [];
    for (const child of children) {
      childWindows.push(...this.visitNode(child, nextContext));
    }

    // Sibling Merge: 合并相邻的小窗口
    return this.mergeAdjacentWindows(childWindows);
  }

  /**
   * 从节点中提取名称（数据驱动）
   */
  private extractNodeName(node: Parser.SyntaxNode, spec: LanguageSpecConfig): string | null {
    // 遍历命名子节点，按 nameNodeTypes 匹配
    for (const child of node.namedChildren) {
      if (spec.nameNodeTypes.has(child.type)) {
        return child.text;
      }
    }

    // fallback: 第一个命名子节点（短文本）
    if (node.firstNamedChild) {
      const firstChild = node.firstNamedChild;
      if (firstChild.text.length <= 100 && !firstChild.text.includes('\n')) {
        return firstChild.text;
      }
    }

    return null;
  }

  /**
   * Gap-Aware 相邻窗口合并
   *
   * 使用三重预算策略：
   * - NWS 预算：控制有效代码量
   * - Raw 预算：控制物理字符数，防止大量注释撑爆 Token
   * - 语义边界惩罚：不同 contextPath 的窗口合并门槛更高
   *
   * 前向吸附策略：
   * - 如果当前窗口以 comment 结尾，将 comment 推到下一个窗口
   * - 保证 JSDoc/注释与其描述的代码在同一个 chunk
   */
  private mergeAdjacentWindows(windows: Window[]): Window[] {
    if (windows.length === 0) return [];

    const merged: Window[] = [];
    let current = windows[0];

    for (let i = 1; i < windows.length; i++) {
      const next = windows[i];

      // 0. 前向吸附：如果 current 以 comment 结尾，将其推到 next
      this.forwardAbsorbComments(current, next);

      // 如果 current 被吸附后变空，直接用 next 替代
      if (current.nodes.length === 0) {
        current = next;
        continue;
      }

      // 1. 计算边界
      const currentStart = current.nodes[0].startIndex;
      const currentEnd = current.nodes[current.nodes.length - 1].endIndex;
      const nextStart = next.nodes[0].startIndex;
      const nextEnd = next.nodes[next.nodes.length - 1].endIndex;

      // 2. 计算 NWS 大小（语义预算）
      const gapNws = this.adapter.nws(currentEnd, nextStart);
      const combinedNws = current.size + gapNws + next.size;

      // 3. 计算 Raw 大小（物理预算）
      const combinedRawLen = nextEnd - currentStart;

      // 4. 语义边界检测
      // 如果两个窗口属于不同的语义单元（contextPath 不同），提高合并门槛
      const sameContext = this.isSameContext(current.contextPath, next.contextPath);
      const boundaryPenalty = sameContext ? 1.0 : 0.7; // 跨边界时预算打 7 折

      // 5. 三重预算决策
      const isTiny = current.size < this.config.minChunkSize;
      const effectiveBudget = this.config.maxChunkSize * boundaryPenalty;

      // NWS 预算检查（考虑语义边界惩罚）
      const fitsNwsBudget =
        combinedNws <= effectiveBudget || (isTiny && combinedNws < effectiveBudget * 1.5);

      // Raw 预算检查（熔断机制）
      const fitsRawBudget = combinedRawLen <= this.config.maxRawChars * boundaryPenalty;

      // 必须同时满足预算才能合并
      if (fitsNwsBudget && fitsRawBudget) {
        current.nodes.push(...next.nodes);
        current.size = combinedNws;
        // 保留更具体的 contextPath（较长的那个）
        // 因为合并后的 chunk 内容属于更具体的语义单元
        if (next.contextPath.length > current.contextPath.length) {
          current.contextPath = next.contextPath;
        }
      } else {
        merged.push(current);
        current = next;
      }
    }

    merged.push(current);
    return merged;
  }

  /**
   * 前向吸附：将 current 尾部的 comment 节点推到 next 头部
   *
   * 这确保 JSDoc/docstring/注释与其描述的函数/方法在同一个 chunk 中，
   * 而不是被切到前一个 chunk 的末尾。
   *
   * 注意：此方法会直接修改 current 和 next
   */
  private forwardAbsorbComments(current: Window, next: Window): void {
    // 获取当前语言的注释节点类型
    const spec = getLanguageSpec(this.language);
    const commentTypes = spec?.commentTypes ?? new Set(['comment']);

    // 从 current 尾部收集连续的 comment 节点
    const absorbedNodes: Parser.SyntaxNode[] = [];
    let absorbedNws = 0;

    while (current.nodes.length > 0) {
      const lastNode = current.nodes[current.nodes.length - 1];
      if (commentTypes.has(lastNode.type)) {
        current.nodes.pop();
        const nodeNws = this.adapter.nws(lastNode.startIndex, lastNode.endIndex);
        absorbedNodes.unshift(lastNode); // 保持顺序
        absorbedNws += nodeNws;
        current.size -= nodeNws;
      } else {
        break;
      }
    }

    // 将吸附的 comment 推到 next 头部
    if (absorbedNodes.length > 0) {
      // 计算 gap（从最后一个 absorbed comment 到 next 第一个节点）
      const gapNws =
        next.nodes.length > 0
          ? this.adapter.nws(
              absorbedNodes[absorbedNodes.length - 1].endIndex,
              next.nodes[0].startIndex,
            )
          : 0;

      next.nodes.unshift(...absorbedNodes);
      next.size += absorbedNws + gapNws;
    }
  }

  /**
   * 检查两个 contextPath 是否属于同一语义单元
   *
   * 规则：如果两者的公共前缀长度 >= 较短路径长度，认为是同一单元
   * 例如：
   * - ["file", "class A", "method foo"] 和 ["file", "class A", "method bar"] -> false（不同方法）
   * - ["file", "class A"] 和 ["file", "class A", "method foo"] -> true（父子关系）
   */
  private isSameContext(a: string[], b: string[]): boolean {
    const minLen = Math.min(a.length, b.length);
    let commonLen = 0;
    for (let i = 0; i < minLen; i++) {
      if (a[i] === b[i]) {
        commonLen++;
      } else {
        break;
      }
    }
    return commonLen >= minLen;
  }

  /**
   * 将窗口转换为最终的 ProcessedChunk
   *
   * Gap 归属策略：gap 归属到后一个 chunk（即 chunk 的 rawSpan.start 向前延伸到前一个 chunk 的 endIndex）
   * Overlap 策略：vectorSpan 向前延伸 chunkOverlap 个 NWS 字符，提升语义检索召回率
   *
   * 保证：所有 rawSpan 拼接后 === 完整文件（不重叠）
   */
  private windowsToChunks(windows: Window[], filePath: string, language: string): ProcessedChunk[] {
    if (windows.length === 0) return [];

    const chunks: ProcessedChunk[] = [];
    let prevEnd = 0; // 前一个 chunk 的语义结束位置
    const overlap = this.config.chunkOverlap;

    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      const start = w.nodes[0].startIndex;
      const end = w.nodes[w.nodes.length - 1].endIndex;

      // rawSpan 策略（不重叠）
      const isLast = i === windows.length - 1;
      const codeEndIndex =
        this.adapter.getDomain() === 'utf8'
          ? Buffer.byteLength(this.code, 'utf8')
          : this.code.length;
      const rawSpanEnd = isLast ? codeEndIndex : end;

      // vectorSpan 策略（可重叠）
      // - 第一个 chunk 不向前延伸
      // - 其他 chunk 向前延伸 overlap 个 NWS 字符
      let vectorStart = start;
      if (i > 0 && overlap > 0) {
        const candidateStart = this.findOverlapStart(start, overlap);
        const overlapRawLen = start - candidateStart;
        // P1 熔断：如果 overlap 导致 raw 超过 25% 预算，放弃 overlap
        if (overlapRawLen <= this.config.maxRawChars * 0.25) {
          vectorStart = candidateStart;
        }
        // 否则 vectorStart 保持为 start（不 overlap）
      }
      const vectorEnd = end;

      // 使用 adapter.slice() 进行安全切片
      const displayCode = this.adapter.slice(start, end);
      const vectorCode = this.adapter.slice(vectorStart, vectorEnd);

      const metadata: ChunkMetadata = {
        startIndex: start,
        endIndex: end,
        rawSpan: { start: prevEnd, end: rawSpanEnd },
        vectorSpan: { start: vectorStart, end: vectorEnd },
        filePath,
        language,
        contextPath: w.contextPath,
      };

      chunks.push({
        displayCode,
        vectorText: generateVectorText(vectorCode, w.contextPath),
        nwsSize: w.size,
        metadata,
      });

      prevEnd = end;
    }

    return chunks;
  }

  /**
   * 找到 overlap 的起始位置
   *
   * 从 start 位置向前搜索，找到包含 targetNws 个非空白字符的位置
   *
   * @param start 当前 chunk 的起始位置
   * @param targetNws 目标 overlap 大小（NWS 字符数）
   * @returns overlap 起始位置
   */
  private findOverlapStart(start: number, targetNws: number): number {
    if (start <= 0 || targetNws <= 0) return start;

    // 向前搜索，找到包含 targetNws 个 NWS 字符的位置
    // 使用二分查找优化
    let low = 0;
    let high = start;
    let result = start;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const nwsInRange = this.adapter.nws(mid, start);

      if (nwsInRange >= targetNws) {
        result = mid;
        low = mid + 1; // 尝试找更靠后的位置（更少的 overlap）
      } else {
        high = mid - 1; // 需要更靠前的位置（更多的内容）
      }
    }

    // 确保不会超出文件开头
    return Math.max(0, result);
  }

}

/**
 * 生成向量化文本（包含面包屑上下文）
 */
function generateVectorText(code: string, contextPath: string[]): string {
  const breadcrumb = contextPath.join(' > ');
  return `// Context: ${breadcrumb}\n${code}`;
}
