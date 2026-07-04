type HeaderReader = {
  req: {
    header(name: string): string | undefined;
  };
};

export function getCloudflareClientIp(c: HeaderReader, fallback = 'unknown'): string {
  const ip = (c.req.header('CF-Connecting-IP') || '').trim();
  return (ip || fallback).slice(0, 128);
}

function parseIpv4(ip: string): number[] | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map(part => Number(part));
  return nums.every(num => Number.isInteger(num) && num >= 0 && num <= 255) ? nums : null;
}

export function isPublicIpAddress(value: string): boolean {
  const ip = value.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!ip) return false;
  const v4 = parseIpv4(ip);
  if (v4) {
    const [a, b, c] = v4;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (!ip.includes(':')) return false;
  const mappedIpv4 = ip.match(/(?:^|:)ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (mappedIpv4) return isPublicIpAddress(mappedIpv4);
  const first = ip.split(':').find(Boolean);
  const firstHextet = first ? Number.parseInt(first, 16) : 0;
  if (!Number.isFinite(firstHextet)) return false;
  return !(
    ip === '::' ||
    ip === '::1' ||
    (firstHextet & 0xfe00) === 0xfc00 ||
    (firstHextet & 0xffc0) === 0xfe80 ||
    (firstHextet & 0xff00) === 0xff00 ||
    ip.startsWith('2001:db8:')
  ) && firstHextet >= 0x2000 && firstHextet <= 0x3fff;
}
