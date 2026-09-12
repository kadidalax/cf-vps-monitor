/**
 * 敏感配置的掩码预览。
 *
 * 用途：后台需要让管理员看出「这项配了没有、配的是不是我想的那个」，
 * 但不应把 bot token / 密码 / 密钥的原文下发到浏览器——原文一旦进了
 * API 响应，开发者工具里就能直接看到，前端再怎么显示成星号也没有意义。
 *
 * 因此服务端只下发本函数生成的预览串：两头保留少量明文，中间用固定数量的
 * 星号代替。星号数量固定（不随原值长度变化），避免顺带泄露原值长度。
 */

/** 中间固定使用的星号数量。固定值可避免从预览串反推原值长度。 */
const MASK_RUN = 8;
/** 两端各保留的明文字符数。 */
const EDGE = 4;
/**
 * 短于该长度的值不保留任何明文。
 * 取 12 是因为 EDGE*2=8，只有当中间确实还有内容被遮住时，露出两头才是安全的。
 */
const MIN_LENGTH_FOR_EDGES = 12;

/**
 * 生成掩码预览串。
 * - 空值返回空串（调用方据此判断「未配置」）；
 * - 过短的值全部打码，不露出任何明文；
 * - 其余保留首尾各 4 个字符，中间固定 8 个星号。
 */
export function maskSecretPreview(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (trimmed.length < MIN_LENGTH_FOR_EDGES) return '*'.repeat(MASK_RUN);
  return `${trimmed.slice(0, EDGE)}${'*'.repeat(MASK_RUN)}${trimmed.slice(-EDGE)}`;
}

/**
 * 判断某个字符串是否是本模块生成的掩码预览。
 * 用于防止前端把预览串当成真实值回传后被写进数据库。
 */
export function isMaskedSecretPreview(value: unknown): boolean {
  return typeof value === 'string' && value.includes('*'.repeat(MASK_RUN));
}
