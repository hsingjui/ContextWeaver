export type RetrievalIntent =
  | 'symbol'
  | 'path'
  | 'reference'
  | 'call-chain'
  | 'feature'
  | 'overview'
  | 'compound';

export interface RetrievalPlan {
  intent: RetrievalIntent;
  useVector: boolean;
  useLexical: boolean;
  useExact: boolean;
  usePath: boolean;
  expandNeighbors: boolean;
  expandDependencies: boolean;
  dependencyDirection: 'forward' | 'reverse' | 'both';
  dependencyMaxDepth: number;
  dependencyMaxFiles: number;
  dependencyChunksPerFile: number;
  dependencyDecay: number;
  maxSeeds: number;
  minSeedFiles: number;
}

const SYMBOL_CUES = [
  /\bdefined?\b/i,
  /\bdefinition\b/i,
  /\bdeclare[ds]?\b/i,
  /\bclass\b/i,
  /\binterface\b/i,
  /\bfunction\b/i,
  /\bmethod\b/i,
  /定义|声明|类|接口|函数|方法|实现在哪里|实现位置/u,
];
const PATH_CUES = [
  /\bfile(?:name)?\b/i,
  /\bpath\b/i,
  /\bdirectory\b/i,
  /\bfolder\b/i,
  /\.(?:ts|tsx|js|jsx|py|go|rs|java|cs|c|cc|cpp|h|hpp)\b/i,
  /哪个文件|在哪个文件|文件在哪里|实现文件在哪里|放在哪里|哪[个里]?目录|文件路径|路径|文件名/u,
];
const REFERENCE_CUES = [
  /\bwho\s+(?:uses?|calls?|references?|imports?)\b/i,
  /\bwhere\s+(?:is|are)\s+.+\bused\b/i,
  /\breferences?\s+to\b/i,
  /\busages?\b/i,
  /谁(?:在)?(?:用|调用|引用|导入)|哪些地方(?:用|调用|引用)|被谁(?:用|调用|引用)/u,
  /在哪里.*(?:复用|调用|使用|引用|导入)/u,
  /(?:在哪里|什么地方|哪些地方|哪些入口|哪些组件).*被(?:用|用于|调用|引用|复用)/u,
  /被哪些.*(?:用|调用|引用)|在哪些.*被用于/u,
];
const CALL_CHAIN_CUES = [
  /\bcall[- ]?chain\b/i,
  /\bflow\b/i,
  /\btrace\b/i,
  /\bfrom\b.+\bto\b/i,
  /调用链|调用流程|执行流程|请求流程|链路/u,
  /从.+(?:进入|经过|流向|传到|写入|交给)/u,
  /怎样经过.+再进入/u,
  /(?:怎样|如何).+(?:经过|进入).+(?:再|然后|最终|构建|写入)/u,
  /(?:怎样|如何).+(?:再|然后|接着).+(?:进入|交给|调用|写入|处理)/u,
  /(?:产生|完成|执行)后，.+(?:如何|怎样).+(?:解析|补充|进入|写入)/u,
];
const OVERVIEW_CUES = [
  /\boverview\b/i,
  /\barchitecture\b/i,
  /\bhigh[- ]level\b/i,
  /\bhow\s+(?:does|is)\s+.+\bwork/i,
  /整体|概览|架构|全局|模块划分|工作原理|子系统|存储层|完整.+流程|系统如何组织|如何分工/u,
];

function matchesAny(query: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(query));
}

function looksCompound(query: string): boolean {
  const questionMarks = query.match(/[?？]/g)?.length ?? 0;
  if (questionMarks >= 2) return true;

  const nonEmptyLines = query
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (nonEmptyLines.length >= 3) return true;
  if (nonEmptyLines.filter((line) => /^[-*•]|^\d+[.)、]/u.test(line)).length >= 2) return true;

  const clauses = query
    .split(/[。；;!?！？]/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4);
  if (clauses.length >= 3) return true;

  const stageCueCount = query.match(/然后|接着|随后|最后|并最终|再|分别/gu)?.length ?? 0;
  if (stageCueCount >= 1 && query.length >= 28) return true;
  const enumerationCount = query.match(/、/g)?.length ?? 0;
  if (enumerationCount >= 2 && query.length >= 32) return true;
  // A multi-condition setup is compound; a single conditional clause is not.
  if (/、.+(?:或|和).+(?:时|情况下)，/u.test(query) && query.length >= 36) return true;
  return false;
}

export function classifyRetrievalIntent(query: string): RetrievalIntent {
  const normalized = query.trim();
  // Strong coding intents take precedence over generic multi-clause structure.
  if (matchesAny(normalized, CALL_CHAIN_CUES)) return 'call-chain';
  if (matchesAny(normalized, REFERENCE_CUES)) return 'reference';
  if (matchesAny(normalized, OVERVIEW_CUES)) return 'overview';
  if (matchesAny(normalized, SYMBOL_CUES)) return 'symbol';
  if (matchesAny(normalized, PATH_CUES)) return 'path';
  if (looksCompound(normalized)) return 'compound';
  return 'feature';
}

export function buildRetrievalPlan(query: string): RetrievalPlan {
  const intent = classifyRetrievalIntent(query);
  switch (intent) {
    case 'symbol':
      return {
        intent,
        useVector: true,
        useLexical: true,
        useExact: true,
        usePath: false,
        expandNeighbors: true,
        expandDependencies: false,
        dependencyDirection: 'forward',
        dependencyMaxDepth: 0,
        dependencyMaxFiles: 0,
        dependencyChunksPerFile: 0,
        dependencyDecay: 0.65,
        maxSeeds: 4,
        minSeedFiles: 1,
      };
    case 'path':
      return {
        intent,
        useVector: true,
        useLexical: true,
        useExact: false,
        usePath: true,
        expandNeighbors: true,
        expandDependencies: false,
        dependencyDirection: 'forward',
        dependencyMaxDepth: 0,
        dependencyMaxFiles: 0,
        dependencyChunksPerFile: 0,
        dependencyDecay: 0.65,
        maxSeeds: 4,
        minSeedFiles: 1,
      };
    case 'overview':
      return {
        intent,
        useVector: true,
        useLexical: true,
        useExact: false,
        usePath: false,
        expandNeighbors: true,
        expandDependencies: false,
        dependencyDirection: 'forward',
        dependencyMaxDepth: 0,
        dependencyMaxFiles: 0,
        dependencyChunksPerFile: 0,
        dependencyDecay: 0.65,
        maxSeeds: 6,
        minSeedFiles: 4,
      };
    case 'reference':
      return {
        intent,
        useVector: true,
        useLexical: true,
        // Exact definitions are used as graph roots separately, not as rerank candidates.
        useExact: false,
        usePath: false,
        expandNeighbors: true,
        expandDependencies: true,
        dependencyDirection: 'reverse',
        dependencyMaxDepth: 1,
        dependencyMaxFiles: 6,
        dependencyChunksPerFile: 1,
        // Reverse-import traversal is supporting dependency context, not caller evidence.
        dependencyDecay: 0.55,
        maxSeeds: 3,
        minSeedFiles: 2,
      };
    case 'call-chain':
      return {
        intent,
        useVector: true,
        useLexical: true,
        useExact: true,
        usePath: false,
        expandNeighbors: true,
        expandDependencies: true,
        dependencyDirection: 'both',
        dependencyMaxDepth: 2,
        dependencyMaxFiles: 2,
        dependencyChunksPerFile: 1,
        dependencyDecay: 0.65,
        maxSeeds: 4,
        minSeedFiles: 3,
      };
    case 'compound':
      return {
        intent,
        useVector: true,
        useLexical: true,
        useExact: true,
        usePath: true,
        expandNeighbors: true,
        expandDependencies: true,
        dependencyDirection: 'both',
        dependencyMaxDepth: 1,
        dependencyMaxFiles: 2,
        dependencyChunksPerFile: 1,
        dependencyDecay: 0.65,
        maxSeeds: 8,
        minSeedFiles: 4,
      };
    default:
      return {
        intent: 'feature',
        useVector: true,
        useLexical: true,
        useExact: true,
        usePath: false,
        expandNeighbors: true,
        expandDependencies: false,
        dependencyDirection: 'forward',
        dependencyMaxDepth: 0,
        dependencyMaxFiles: 0,
        dependencyChunksPerFile: 0,
        dependencyDecay: 0.65,
        maxSeeds: 4,
        minSeedFiles: 1,
      };
  }
}
