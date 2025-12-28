/**
 * NWS (Non-Whitespace) 前缀和计算器
 *
 * 使用 Uint32Array 实现 O(1) 时间复杂度的任意区间非空白字符计数。
 * 用于确保 Chunk 不会因为包含大量空格而"虚胖"。
 *
 */
export class NwsCalculator {
    private prefixSum: Uint32Array;

    constructor(code: string) {
        // prefixSum[i] = 位置 i 之前的非空白字符总数
        this.prefixSum = new Uint32Array(code.length + 1);
        let count = 0;

        // 简单的 ASCII 空白检查：空格、制表符、换行、回车
        // 覆盖 99% 场景，追求速度
        for (let i = 0; i < code.length; i++) {
            const cc = code.charCodeAt(i);
            // 0x20 = 空格, 0x09 = 制表符, 0x0a = 换行, 0x0d = 回车
            if (!(cc === 0x20 || cc === 0x09 || cc === 0x0a || cc === 0x0d)) {
                count++;
            }
            this.prefixSum[i + 1] = count;
        }
    }

    /**
     * O(1) 获取任意片段的 NWS 大小
     * @param start 起始索引（包含）
     * @param end 结束索引（不包含）
     * @returns 非空白字符数量
     */
    public getSize(start: number, end: number): number {
        // 边界保护
        const maxIndex = this.prefixSum.length - 1;
        const s = Math.max(0, Math.min(maxIndex, start));
        const e = Math.max(0, Math.min(maxIndex, end));
        return this.prefixSum[e] - this.prefixSum[s];
    }

    /**
     * 获取总的非空白字符数
     */
    public getTotalSize(): number {
        return this.prefixSum[this.prefixSum.length - 1];
    }
}
