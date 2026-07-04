import type { PingTask } from '../db/queries';

export const MAX_PING_RESULTS_PER_REPORT = 50;
export const MAX_PING_VALUE_MS = 60_000;
export const PING_LOSS_VALUE = -1;

export interface ValidatedPingResult {
  taskId: number;
  value: number;
}

type ValidationResult =
  | { ok: true; results: ValidatedPingResult[] }
  | { ok: false; status: number; error: string };

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function pingResultPayload(input: unknown): unknown {
  const body = asObject(input);
  if (Array.isArray(body.results)) return body.results;
  if (body.type === 'ping_result' && body.data !== undefined) return body.data;
  return input;
}

export function validatePingResults(
  input: unknown,
  tasks: PingTask[],
  clientUuid: string,
): ValidationResult {
  const payload = pingResultPayload(input);
  const rawResults = Array.isArray(payload) ? payload : [payload];
  if (rawResults.length === 0) {
    return { ok: false, status: 400, error: 'Ping 结果不能为空' };
  }
  if (rawResults.length > MAX_PING_RESULTS_PER_REPORT) {
    return { ok: false, status: 400, error: `Ping 结果单次最多 ${MAX_PING_RESULTS_PER_REPORT} 条` };
  }

  const taskMap = new Map<number, PingTask>();
  for (const task of tasks) {
    if (typeof task.id === 'number') taskMap.set(task.id, task);
  }

  const deduped = new Map<number, ValidatedPingResult>();
  for (const rawResult of rawResults) {
    const result = asObject(rawResult);
    const taskId = Number(result.task_id);
    const value = Number(result.value);
    if (!Number.isInteger(taskId) ||
      taskId <= 0 ||
      !Number.isFinite(value) ||
      (value !== PING_LOSS_VALUE && (value < 0 || value > MAX_PING_VALUE_MS))
    ) {
      return { ok: false, status: 400, error: 'Ping 结果参数无效' };
    }

    const task = taskMap.get(taskId);
    if (!task) {
      return { ok: false, status: 400, error: 'Ping 任务不存在' };
    }
    if (!task.all_clients && !task.clients.includes(clientUuid)) {
      return { ok: false, status: 403, error: 'Ping 任务不属于当前客户端' };
    }

    deduped.set(taskId, { taskId, value });
  }

  return { ok: true, results: Array.from(deduped.values()) };
}
