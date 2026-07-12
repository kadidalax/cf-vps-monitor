import React from 'react';

const DEFAULT_FLAG_CODE = 'UN';
const REGIONAL_INDICATOR_START = 0x1f1e6;
const ASCII_ALPHA_START = 0x41;

const regionAliases: Record<string, string[]> = {
  CN: ['cn', 'china', '中国', '中华人民共和国', '大陆', '北京', '上海', '广州', '深圳'],
  HK: ['hk', 'hongkong', 'hong kong', '香港'],
  MO: ['mo', 'macau', 'macao', '澳门'],
  TW: ['tw', 'taiwan', '台湾', '台灣', '台北'],
  US: ['us', 'usa', 'united states', 'america', '美国', '美國', '洛杉矶', '洛杉磯', '硅谷', '矽谷', '弗吉尼亚', '俄勒冈', '俄亥俄', '纽约', '西雅图', '达拉斯', '圣何塞', 'los angeles', 'silicon valley', 'new york', 'seattle', 'dallas', 'san jose'],
  JP: ['jp', 'japan', '日本', '东京', '東京', '大阪', 'tokyo', 'osaka'],
  SG: ['sg', 'singapore', '新加坡'],
  DE: ['de', 'germany', 'deutschland', '德国', '德國', '法兰克福', '法蘭克福', 'frankfurt'],
  GB: ['gb', 'uk', 'united kingdom', 'britain', 'england', '英国', '英國', '伦敦', '倫敦', 'london'],
  KR: ['kr', 'korea', 'south korea', '韩国', '韓國', '首尔', '首爾', 'seoul'],
  FR: ['fr', 'france', '法国', '法國', '巴黎', 'paris'],
  NL: ['nl', 'netherlands', 'holland', '荷兰', '荷蘭', '阿姆斯特丹', 'amsterdam'],
  CA: ['ca', 'canada', '加拿大', '多伦多', '多倫多', 'toronto', 'vancouver'],
  AU: ['au', 'australia', '澳大利亚', '澳洲', '悉尼', 'sydney'],
  IN: ['in', 'india', '印度', '孟买', '孟買', 'mumbai'],
  BR: ['br', 'brazil', '巴西', '圣保罗', '聖保羅', 'sao paulo'],
  RU: ['ru', 'russia', '俄罗斯', '俄羅斯', '莫斯科', 'moscow'],
  AE: ['ae', 'uae', 'united arab emirates', '阿联酋', '阿聯酋', '迪拜', 'dubai'],
  MY: ['my', 'malaysia', '马来西亚', '馬來西亞', '吉隆坡', 'kuala lumpur'],
  TH: ['th', 'thailand', '泰国', '泰國', '曼谷', 'bangkok'],
  VN: ['vn', 'vietnam', '越南', '河内', '河內', 'hanoi'],
  ID: ['id', 'indonesia', '印度尼西亚', '印尼', 'jakarta', '雅加达'],
  PH: ['ph', 'philippines', '菲律宾', '菲律賓', 'manila'],
  NZ: ['nz', 'new zealand', '新西兰', '新西蘭'],
  CH: ['ch', 'switzerland', '瑞士'],
  SE: ['se', 'sweden', '瑞典', '斯德哥尔摩', 'stockholm'],
  IT: ['it', 'italy', '意大利', '米兰', '米蘭', 'milan'],
  ES: ['es', 'spain', '西班牙', '马德里', '馬德里', 'madrid'],
  PL: ['pl', 'poland', '波兰', '波蘭', '华沙', '華沙', 'warsaw'],
  UA: ['ua', 'ukraine', '乌克兰', '烏克蘭'],
  TR: ['tr', 'turkey', '土耳其'],
  AR: ['ar', 'argentina', '阿根廷'],
  MX: ['mx', 'mexico', '墨西哥'],
  CL: ['cl', 'chile', '智利'],
  ZA: ['za', 'south africa', '南非'],
  EG: ['eg', 'egypt', '埃及'],
  SA: ['sa', 'saudi arabia', '沙特', '沙特阿拉伯'],
  IL: ['il', 'israel', '以色列'],
  FI: ['fi', 'finland', '芬兰', '芬蘭'],
  NO: ['no', 'norway', '挪威'],
  DK: ['dk', 'denmark', '丹麦', '丹麥'],
  BE: ['be', 'belgium', '比利时', '比利時'],
  AT: ['at', 'austria', '奥地利', '奧地利'],
  CZ: ['cz', 'czech', 'czech republic', '捷克'],
  RO: ['ro', 'romania', '罗马尼亚', '羅馬尼亞'],
};

const aliasToCountryCode = new Map<string, string>();

function normalizeAlias(value: string) {
  return value.trim().toLowerCase().replace(/[\s_.-]+/g, '');
}

Object.entries(regionAliases).forEach(([code, aliases]) => {
  aliasToCountryCode.set(normalizeAlias(code), code);
  aliases.forEach((alias) => aliasToCountryCode.set(normalizeAlias(alias), code));
});

export const flagMap: Record<string, string> = Object.fromEntries(
  Object.keys(regionAliases).map((code) => [code, countryCodeToFlagEmoji(code)]),
);

function countryCodeToFlagEmoji(code: string) {
  const normalized = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized) || normalized === DEFAULT_FLAG_CODE) return '🏳️';

  return Array.from(normalized)
    .map((char) => String.fromCodePoint(char.charCodeAt(0) - ASCII_ALPHA_START + REGIONAL_INDICATOR_START))
    .join('');
}

export function getCountryCodeFromFlagEmoji(value: string): string | null {
  const chars = Array.from(value.trim());
  if (chars.length !== 2) return null;

  const first = chars[0].codePointAt(0);
  const second = chars[1].codePointAt(0);
  if (!first || !second) return null;

  if (
    first >= REGIONAL_INDICATOR_START &&
    first <= 0x1f1ff &&
    second >= REGIONAL_INDICATOR_START &&
    second <= 0x1f1ff
  ) {
    return [
      String.fromCodePoint(first - REGIONAL_INDICATOR_START + ASCII_ALPHA_START),
      String.fromCodePoint(second - REGIONAL_INDICATOR_START + ASCII_ALPHA_START),
    ].join('');
  }

  return null;
}

export function resolveFlagCode(region?: string): string {
  const raw = (region || '').trim();
  if (!raw) return DEFAULT_FLAG_CODE;

  const emojiCode = getCountryCodeFromFlagEmoji(raw);
  if (emojiCode) return emojiCode;

  const normalized = normalizeAlias(raw);
  const directAlias = aliasToCountryCode.get(normalized);
  if (directAlias) return directAlias;

  const trailingCode = raw.match(/(?:^|[^a-zA-Z])([a-zA-Z]{2})\s*$/);
  if (trailingCode) {
    const normalizedCode = trailingCode[1].toUpperCase();
    return aliasToCountryCode.get(normalizeAlias(normalizedCode)) || normalizedCode;
  }

  for (const [alias, code] of aliasToCountryCode.entries()) {
    if (/^[a-z]{2}$/i.test(alias)) continue;
    if (normalized.includes(alias)) return code;
  }

  const standaloneCode = raw.match(/(?:^|[^a-zA-Z])([a-zA-Z]{2})(?=$|[^a-zA-Z])/);
  if (standaloneCode) {
    const normalizedCode = standaloneCode[1].toUpperCase();
    return aliasToCountryCode.get(normalizeAlias(normalizedCode)) || normalizedCode;
  }

  return DEFAULT_FLAG_CODE;
}

export function guessFlag(region: string): string {
  return countryCodeToFlagEmoji(resolveFlagCode(region));
}

interface FlagProps {
  region?: string;
  size?: number;
}

export default React.memo(function Flag({ region, size = 20 }: FlagProps) {
  const code = resolveFlagCode(region);
  const pixelWidth = `${Math.round(size * 4 / 3)}px`;
  const pixelHeight = `${size}px`;
  const alt = `地区旗帜: ${code}`;

  return (
    <span
      className="flag-icon"
      title={region}
      aria-label={alt}
      style={{
        width: pixelWidth,
        height: pixelHeight,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      <img
        src={`/assets/flags/${code}.svg`}
        alt={alt}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        onError={(event) => {
          event.currentTarget.onerror = null;
          event.currentTarget.src = `/assets/flags/${DEFAULT_FLAG_CODE}.svg`;
        }}
      />
    </span>
  );
});
