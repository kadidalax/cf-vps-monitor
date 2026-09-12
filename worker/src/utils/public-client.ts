import type { PublicClientRow } from '../db/types';
import { isPublicIpAddress } from './request-ip.ts';

export type PublicClient = Omit<PublicClientRow, 'ipv4' | 'ipv6'> & {
  has_ipv4: boolean;
  has_ipv6: boolean;
  tags: string;
};

type PublicClientSource = PublicClientRow & {
  token?: unknown;
  remark?: unknown;
};

export const PUBLIC_CLIENT_FIELDS = [
  'uuid', 'name', 'cpu_name', 'virtualization', 'arch', 'cpu_cores', 'os',
  'kernel_version', 'gpu_name', 'region', 'public_remark', 'mem_total', 'swap_total',
  'disk_total', 'version', 'price', 'billing_cycle', 'auto_renewal', 'currency',
  'expired_at', 'group', 'tags', 'hidden', 'traffic_limit', 'traffic_limit_type',
  'traffic_reset_day', 'sort_order', 'created_at', 'updated_at',
] as const;

function pickFields<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    // Patches omit missing fields; explicit zero/empty/null values remain meaningful.
    if (Object.hasOwn(source, key) && source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function isPublicTag(tag: string): boolean {
  const text = tag.replace(/<\w+>$/, '').trim().toLowerCase();
  return !['ipv4', 'ipv6', 'ip4', 'ip6', 'v4', 'v6'].includes(text);
}

export function sanitizePublicTags(tags: unknown): string {
  if (typeof tags !== 'string') return '';
  return tags
    .split(/[;,]/)
    .map(tag => tag.trim())
    .filter(Boolean)
    .filter(isPublicTag)
    .join(';');
}

export function toPublicClient(client: PublicClientSource): PublicClient {
  const { ipv4, ipv6 } = client;
  const publicClient = pickFields(client, PUBLIC_CLIENT_FIELDS);
  return {
    ...publicClient,
    has_ipv4: typeof ipv4 === 'string' && isPublicIpAddress(ipv4),
    has_ipv6: typeof ipv6 === 'string' && isPublicIpAddress(ipv6),
    tags: sanitizePublicTags(publicClient.tags),
  };
}
