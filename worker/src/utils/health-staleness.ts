/**
 * 健康事件的时效判定。单独成文件是为了能被 node --test 直接加载：
 * observability.ts 经 '../db/queries' 无扩展名导入，测试进程解析不了。
 * 这里不许引入任何依赖。
 */

/**
 * 健康事件是「最后一次写入」的快照，没有任何衰减机制：一次 error 写进 settings 后，
 * 除非同组件再写一次 ok，否则永远是 error。组件停用或写入点被删时，那条 error
 * 就把 /api/admin/health 永久钉在 503 上——线上正是被 07-24 的旧错误钉住的。
 *
 * 超过这个窗口没更新过的 error 标为 stale，不再参与 ok 判定。
 */
export const HEALTH_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

interface StaleableEvent {
  status: string;
  updated_at?: string;
}

/**
 * 只对 error 生效：warning 不拉红端点，disabled 是稳定态、放久了也仍然准确，
 * ok 更没有变陈旧的必要。
 *
 * updated_at 解析不出来时返回 false——宁可继续报错，也不要因为一个坏时间戳
 * 把真实故障静默降级掉。
 */
export function isHealthEventStale(
  event: StaleableEvent,
  nowMs: number,
): boolean {
  if (event.status !== 'error') return false;
  const updated = Date.parse(event.updated_at || '');
  return Number.isFinite(updated) && nowMs - updated > HEALTH_STALE_AFTER_MS;
}

/**
 * 给一批存储型事件标 stale。只加字段，不改 status——陈旧不等于没发生过，
 * 详情里仍要看得见原状态和 detail。
 *
 * 调用方只能把「存储型」事件喂进来：现算探针每次请��都是当场算的，
 * 标 stale 会把真实故障降级掉。
 */
export function markStaleEvents<T extends StaleableEvent>(
  events: Record<string, T | null>,
  nowMs: number,
): Record<string, (T & { stale?: boolean }) | null> {
  const marked: Record<string, (T & { stale?: boolean }) | null> = {};
  for (const [component, event] of Object.entries(events)) {
    marked[component] = event && isHealthEventStale(event, nowMs)
      ? { ...event, stale: true }
      : event;
  }
  return marked;
}

/**
 * 端点整体是否健康：存在 error 且未被判陈旧才算不健康。
 */
export function healthComponentsOk(
  components: Record<string, { status: string; stale?: boolean } | null>,
): boolean {
  return Object.values(components).every(
    event => !event || event.status !== 'error' || event.stale === true,
  );
}
