function cleanCpuName(name: string): string {
  return name
    .replace(/\(R\)|\(TM\)|CPU|Processor|\d+-Core|@\s*[0-9.]+\s*GHz/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatCpuModelShort(name?: string): string {
  const text = cleanCpuName(String(name || '').trim());
  if (!text) return '';
  if (/Common KVM/i.test(text)) return 'KVM';
  if (/QEMU Virtual/i.test(text)) return 'QEMU';

  const patterns = [
    /(?:Intel\s+)?(?:Xeon|Core)\s+(?:[im][3579]-)?[A-Z0-9-]+(?:\s+v\d+)?/i,
    /(?:AMD\s+)?(?:EPYC|Ryzen|Athlon)\s+[A-Z0-9]+(?:\s+[A-Z0-9]+)?/i,
    /(?:Intel\s+)?N\d{2,4}/i,
    /(?:ARM\s+)?(?:Cortex|Neoverse)[-\s]?[A-Z0-9]+/i,
    /Apple\s+[A-Z0-9]+/i,
  ];
  const match = patterns.map((pattern) => text.match(pattern)?.[0]).find(Boolean);
  return (match || text.split(' ').slice(0, 3).join(' '))
    .replace(/^(Intel|AMD|ARM)\s+/i, '')
    .trim();
}

export function formatCpuCardLabel(name?: string, cores?: number): string {
  const model = formatCpuModelShort(name);
  const count = Number(cores || 0);
  if (model && count > 0) return `${model} x${count}`;
  if (model) return model;
  if (count > 0) return `x${count}`;
  return 'CPU';
}

export function formatCpuSpec(name?: string, cores?: number): string {
  const model = String(name || '').trim();
  const count = Number(cores || 0);
  if (model && count > 0) return `${model} (x${count})`;
  if (model) return model;
  if (count > 0) return `x${count}`;
  return '-';
}
