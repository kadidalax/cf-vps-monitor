type StructuredAuditDetail = {
  summary?: unknown;
};

function readStructuredAuditDetail(detail: string): StructuredAuditDetail | null {
  const trimmed = detail.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as StructuredAuditDetail
      : null;
  } catch {
    return null;
  }
}

export function getAuditLogDetailText(detail: unknown) {
  if (typeof detail !== 'string') return '-';
  const trimmed = detail.trim();
  if (!trimmed) return '-';
  const structured = readStructuredAuditDetail(trimmed);
  return typeof structured?.summary === 'string' && structured.summary.trim()
    ? structured.summary.trim()
    : trimmed;
}

export function getAuditLogRawDetailText(detail: unknown) {
  return typeof detail === 'string' && detail.trim() ? detail.trim() : '-';
}

export function getAuditLogDetailSearchText(detail: unknown) {
  if (typeof detail !== 'string') return '';
  const display = getAuditLogDetailText(detail);
  return display === detail ? detail : `${display} ${detail}`;
}

export function formatAuditLogDetailPreview(detail: unknown, maxLength = 120) {
  const text = getAuditLogDetailText(detail);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
