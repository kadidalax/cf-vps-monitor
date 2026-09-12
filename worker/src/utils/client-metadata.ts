import { isPublicIpAddress } from './request-ip';
import { PUBLIC_CLIENT_FIELDS, sanitizePublicTags } from './public-client';

// Agent observations never carry authority over administrative name/visibility,
// billing, remarks or membership, even when an HTTP caller has an older row.
export function projectAgentClientMetadata(client: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of [
    'cpu_name', 'virtualization', 'arch', 'cpu_cores', 'os', 'kernel_version',
    'gpu_name', 'ipv4', 'ipv6', 'region', 'mem_total', 'swap_total', 'disk_total', 'version',
  ]) {
    const value = client[field];
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) result[field] = value;
  }
  return result;
}

// Metadata events are patches: absent fields stay absent, including IP-presence
// flags. Neither audience receives token material or arbitrary Agent extensions.
export function projectClientMetadata(client: Record<string, unknown>, administrator: boolean): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const fields: readonly string[] = administrator ? [...PUBLIC_CLIENT_FIELDS, 'ipv4', 'ipv6', 'remark'] : PUBLIC_CLIENT_FIELDS;
  for (const field of fields) {
    const value = client[field];
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) result[field] = value;
  }
  if (Object.hasOwn(client, 'tags')) result.tags = sanitizePublicTags(client.tags);
  for (const field of ['ipv4', 'ipv6'] as const) {
    const flag = `has_${field}`;
    if (Object.hasOwn(client, field)) result[flag] = isPublicIpAddress(String(client[field] || ''));
    else if (typeof client[flag] === 'boolean') result[flag] = client[flag];
  }
  return result;
}
