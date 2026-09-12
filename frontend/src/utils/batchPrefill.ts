/**
 * 批量编辑对话框的「当前值」预填。
 *
 * 批量编辑覆盖多个节点，各节点当前值可能并不一致，因此不能简单取某一个。
 * 规则（与用户确认）：
 * - 全部相同 → 用该值，且视为一致；
 * - 不一致 → 取出现次数最多的值（众数），并由调用方给出「当前值不一致」提示；
 * - 并列时取较小值，保证同一份选择每次预填结果稳定、不随遍历顺序漂移；
 * - 选择为空 → 用传入的默认值。
 *
 * 未配置过通知的节点由调用方按默认值计入，使统计覆盖全部选中项。
 */
export type SelectionSummary = {
  /** 预填到输入框的值 */
  value: number;
  /** 选中项当前值是否一致；false 时调用方应提示 */
  consistent: boolean;
};

export function summarizeSelectionValue(values: number[], fallback: number): SelectionSummary {
  const usable = values.filter((value) => Number.isFinite(value));
  if (usable.length === 0) return { value: fallback, consistent: true };

  const unique = new Set(usable);
  if (unique.size === 1) return { value: usable[0], consistent: true };

  const counts = new Map<number, number>();
  for (const value of usable) counts.set(value, (counts.get(value) ?? 0) + 1);

  let best = usable[0];
  let bestCount = -1;
  // 先按数值升序，再取首个达到最高频次的值 → 并列时自然落在较小值上
  for (const [value, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return { value: best, consistent: false };
}
