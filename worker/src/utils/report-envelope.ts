export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function unwrapMonitorReportEnvelope(report: JsonObject): JsonObject {
  return report.type === 'report' && isJsonObject(report.data)
    ? report.data
    : report;
}
