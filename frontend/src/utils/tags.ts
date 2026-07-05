export const TAG_COLORS = [
  'ruby', 'gray', 'gold', 'bronze', 'brown', 'yellow', 'amber', 'orange',
  'tomato', 'red', 'crimson', 'pink', 'plum', 'purple', 'violet', 'iris',
  'indigo', 'blue', 'cyan', 'teal', 'jade', 'green', 'grass', 'lime', 'mint', 'sky',
] as const;

export type TagColor = typeof TAG_COLORS[number];

export type MonitorTag = {
  text: string;
  color: TagColor | null;
};

export function parseTagWithColor(tag: string): MonitorTag {
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

export function parseMonitorTags(tags?: string | string[]): MonitorTag[] {
  const rawTags = Array.isArray(tags) ? tags : (tags || '').split(/[;,]/);
  return rawTags
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter((tag) => !isIpVersionTag(tag))
    .map(parseTagWithColor);
}

export function getVisibleMonitorTags(tags?: string | string[], limit = Infinity): MonitorTag[] {
  return parseMonitorTags(tags).slice(0, limit);
}

function isIpVersionTag(tag: string): boolean {
  const text = tag.replace(/<\w+>$/, '').trim().toLowerCase();
  return ['ipv4', 'ipv6', 'ip4', 'ip6', 'v4', 'v6'].includes(text);
}
