export const COMMON_CURRENCIES = [
  { symbol: '¥', name: '人民币' },
  { symbol: '$', name: '美元' },
  { symbol: '€', name: '欧元' },
  { symbol: '£', name: '英镑' },
  { symbol: '₩', name: '韩元' },
  { symbol: '₽', name: '卢布' },
  { symbol: '₣', name: '法郎' },
  { symbol: '₹', name: '印度卢比' },
  { symbol: '₫', name: '越南盾' },
  { symbol: '฿', name: '泰铢' },
  { symbol: '₺', name: '土耳其里拉' },
] as const;

export const BILLING_CYCLE_OPTIONS = [
  { label: '天', value: 1 },
  { label: '周', value: 7 },
  { label: '月', value: 30 },
  { label: '季', value: 92 },
  { label: '半年', value: 184 },
  { label: '年', value: 365 },
  { label: '三年', value: 1095 },
  { label: '一次性', value: -1 },
] as const;

export function formatBillingCycle(cycle?: number): string {
  const value = Number(cycle);
  if (!Number.isFinite(value) || value === 0) return '';
  if (value === -1) return '一次性';
  if (value === 1) return '天';
  if (value === 7) return '周';
  if (value >= 27 && value <= 32) return '月';
  if (value >= 87 && value <= 95) return '季';
  if (value >= 175 && value <= 185) return '半年';
  if (value >= 360 && value <= 370) return '年';
  if (value >= 720 && value <= 750) return '两年';
  if (value >= 1080 && value <= 1150) return '三年';
  if (value >= 1800 && value <= 1850) return '五年';
  return `${value}天`;
}

export function getLongTermDateValue(): string {
  const futureDate = new Date();
  futureDate.setFullYear(futureDate.getFullYear() + 200);
  return futureDate.toISOString().slice(0, 10);
}

export function toDateInputValue(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

export function isValidDisplayPrice(price: number): boolean {
  return Number.isFinite(price) && (price >= 0 || price === -1);
}
