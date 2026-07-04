const RATE_LIMIT_STORAGE_PREFIX = 'rate-limit:';
const RATE_LIMIT_MAX_BUCKETS = 5000;
const RATE_LIMIT_CLEANUP_ALARM_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX_BODY_BYTES = 2 * 1024;

export class RateLimitDO {
  private state: DurableObjectState;
  private sweepCounter = 0;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/rate-limit') {
      return this.checkRateLimit(request);
    }
    return Response.json({ error: 'Not Found' }, { status: 404 });
  }

  private async checkRateLimit(request: Request): Promise<Response> {
    const contentLength = Number(request.headers.get('Content-Length') || '0');
    if (Number.isFinite(contentLength) && contentLength > RATE_LIMIT_MAX_BODY_BYTES) {
      return Response.json({ error: 'Rate limit payload too large' }, { status: 413 });
    }

    let body: { bucket?: unknown; ip?: unknown; max?: unknown; windowMs?: unknown } = {};
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid rate limit payload' }, { status: 400 });
    }
    if (new TextEncoder().encode(JSON.stringify(body)).byteLength > RATE_LIMIT_MAX_BODY_BYTES) {
      return Response.json({ error: 'Rate limit payload too large' }, { status: 413 });
    }

    const bucket = typeof body.bucket === 'string' ? body.bucket.slice(0, 96) : '';
    const ip = typeof body.ip === 'string' ? body.ip.slice(0, 128) : '';
    const max = Number(body.max);
    const windowMs = Number(body.windowMs);
    if (!bucket || !ip || !Number.isInteger(max) || max <= 0 || !Number.isInteger(windowMs) || windowMs < 1000) {
      return Response.json({ error: 'Invalid rate limit payload' }, { status: 400 });
    }

    const now = Date.now();
    this.sweepCounter += 1;
    if (this.sweepCounter % 256 === 0) {
      await this.cleanupExpiredBuckets(now);
    }

    const key = `${RATE_LIMIT_STORAGE_PREFIX}${bucket}:${ip}`;
    const current = await this.state.storage.get<{ count: number; resetAt: number }>(key);
    const state = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + windowMs }
      : current;
    state.count += 1;
    await this.state.storage.put(key, state);
    await this.scheduleCleanupAlarm(now);
    if (this.sweepCounter % 1024 === 0) {
      await this.enforceBucketLimit(now);
    }

    const retryAfter = Math.max(1, Math.ceil((state.resetAt - now) / 1000));
    const remaining = Math.max(0, max - state.count);
    return Response.json({
      allowed: state.count <= max,
      retry_after: retryAfter,
      limit: max,
      remaining,
      reset: Math.ceil(state.resetAt / 1000),
    });
  }

  private async cleanupExpiredBuckets(now: number): Promise<void> {
    try {
      const entries = await this.state.storage.list<{ count: number; resetAt: number }>({
        prefix: RATE_LIMIT_STORAGE_PREFIX,
      });
      const expired: string[] = [];
      for (const [key, value] of entries) {
        if (!value || value.resetAt <= now) expired.push(key);
      }
      await Promise.all(expired.map(key => this.state.storage.delete(key)));
    } catch {
      // Best effort; active buckets overwrite themselves.
    }
  }

  private async scheduleCleanupAlarm(now: number): Promise<void> {
    try {
      const current = await this.state.storage.getAlarm();
      if (current === null) {
        await this.state.storage.setAlarm(now + RATE_LIMIT_CLEANUP_ALARM_MS);
      }
    } catch {
      // Best effort; request-triggered sweeps still run.
    }
  }

  private async enforceBucketLimit(now: number): Promise<void> {
    try {
      const entries = await this.state.storage.list<{ count: number; resetAt: number }>({
        prefix: RATE_LIMIT_STORAGE_PREFIX,
      });
      if (entries.size <= RATE_LIMIT_MAX_BUCKETS) return;

      const expired: string[] = [];
      const active: Array<{ key: string; resetAt: number }> = [];
      for (const [key, value] of entries) {
        if (!value || value.resetAt <= now) {
          expired.push(key);
        } else {
          active.push({ key, resetAt: value.resetAt });
        }
      }

      const overflow = Math.max(0, active.length - RATE_LIMIT_MAX_BUCKETS);
      const oldest = overflow > 0
        ? active.sort((a, b) => a.resetAt - b.resetAt).slice(0, overflow).map(item => item.key)
        : [];
      await Promise.all([...expired, ...oldest].map(key => this.state.storage.delete(key)));
    } catch {
      // Best effort; rate-limit correctness does not depend on compaction.
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    await this.cleanupExpiredBuckets(now);
    await this.enforceBucketLimit(now);

    try {
      const entries = await this.state.storage.list({ prefix: RATE_LIMIT_STORAGE_PREFIX, limit: 1 });
      if (entries.size > 0) {
        await this.state.storage.setAlarm(now + RATE_LIMIT_CLEANUP_ALARM_MS);
      } else {
        await this.state.storage.deleteAlarm();
      }
    } catch {
      // If storage inspection fails, try again later.
      await this.state.storage.setAlarm(now + RATE_LIMIT_CLEANUP_ALARM_MS);
    }
  }
}
