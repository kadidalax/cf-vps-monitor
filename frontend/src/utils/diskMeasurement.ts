export function diskMeasurementMetadata(record: {
  disk?: unknown;
  disk_source?: unknown;
  disk_sampled_at?: unknown;
}) {
  const attempted = record.disk_source !== undefined || record.disk_sampled_at !== undefined;
  const sampledAt = record.disk_sampled_at;
  const valid = record.disk_source === 'directory' && typeof record.disk === 'number'
    && Number.isFinite(record.disk) && record.disk >= 0 && record.disk <= 1_000_000_000_000_000
    && typeof sampledAt === 'number' && Number.isSafeInteger(sampledAt)
    && sampledAt > 0 && sampledAt <= 8_640_000_000_000_000;
  return { attempted, valid, sampledAt: valid ? sampledAt as number : undefined };
}
