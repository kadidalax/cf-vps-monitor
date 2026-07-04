import React from 'react';
import { Badge, Flex } from '@radix-ui/themes';
import { formatBillingCycle } from '../utils/billing';

interface PriceTagsProps {
  price?: number;
  billing_cycle?: number;
  currency?: string;
  expired_at?: string | number;
  tags?: string | string[];
  style?: React.CSSProperties;
  hidden?: boolean;
  showTags?: boolean;
  showExpiry?: boolean;
}

function getExpiryInfo(expired_at?: string | number): { label: string; color: string } {
  if (!expired_at) return { label: '', color: 'gray' };
  const expiredDate = new Date(expired_at);
  const now = new Date();
  const diffTime = expiredDate.getTime() - now.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) return { label: '已过期', color: 'red' };
  if (diffDays > 36500) return { label: '长期', color: 'green' };
  if (diffDays <= 7) return { label: `${diffDays}天后到期`, color: 'red' };
  if (diffDays <= 15) return { label: `${diffDays}天后到期`, color: 'orange' };
  return { label: `${diffDays}天后到期`, color: 'green' };
}

const TAG_COLORS = [
  'ruby', 'gray', 'gold', 'bronze', 'brown', 'yellow', 'amber', 'orange',
  'tomato', 'red', 'crimson', 'pink', 'plum', 'purple', 'violet', 'iris',
  'indigo', 'blue', 'cyan', 'teal', 'jade', 'green', 'grass', 'lime', 'mint', 'sky',
] as const;

type TagColor = typeof TAG_COLORS[number];

function parseTagWithColor(tag: string): { text: string; color: TagColor | null } {
  const match = tag.match(/<(\w+)>$/);
  if (match) {
    const color = match[1].toLowerCase();
    const text = tag.replace(/<\w+>$/, '');
    if (TAG_COLORS.includes(color as TagColor)) {
      return { text, color: color as TagColor };
    }
  }
  return { text: tag, color: null };
}

function parseTags(tags?: string | string[]): string[] {
  const rawTags = Array.isArray(tags)
    ? tags
    : (tags || '').split(/[;,]/);
  return rawTags
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter((tag) => !isIpVersionTag(tag));
}

function isIpVersionTag(tag: string): boolean {
  const text = tag.replace(/<\w+>$/, '').trim().toLowerCase();
  return ['ipv4', 'ipv6', 'ip4', 'ip6', 'v4', 'v6'].includes(text);
}

export default function PriceTags({
  price = 0,
  billing_cycle = 30,
  currency = '¥',
  expired_at,
  tags,
  style,
  hidden: hiddenProp,
  showTags = true,
  showExpiry = true,
}: PriceTagsProps) {
  if (hiddenProp) return null;

  const tagList = showTags ? parseTags(tags) : [];
  const hasPrice = price !== undefined && price !== 0;
  const billingLabel = formatBillingCycle(billing_cycle);
  const expiry = showExpiry ? getExpiryInfo(expired_at) : { label: '', color: 'gray' };

  return (
    <Flex gap="1" wrap="wrap" style={style}>
      {hasPrice && (
        <Badge size="1" variant="soft" color="iris">
          <span style={{ fontSize: 11 }}>
            {price === -1 ? '免费' : billingLabel ? `${currency}${price}/${billingLabel}` : `${currency}${price}`}
          </span>
        </Badge>
      )}

      {expiry.label && (
        <Badge size="1" variant="soft" color={expiry.color as any}>
          <span style={{ fontSize: 11 }}>{expiry.label}</span>
        </Badge>
      )}

      {tagList.map((tag, index) => {
        const { text, color } = parseTagWithColor(tag);
        return (
          <Badge
            key={index}
            size="1"
            variant="soft"
            color={color || TAG_COLORS[index % TAG_COLORS.length]}
          >
            <span style={{ fontSize: 11 }}>{text}</span>
          </Badge>
        );
      })}
    </Flex>
  );
}
