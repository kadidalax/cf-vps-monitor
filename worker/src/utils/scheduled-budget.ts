import { AsyncLocalStorage } from 'node:async_hooks';

export class ScheduledBudgetExceeded extends Error {
  constructor() {
    super('Scheduled work deferred until the next invocation');
    this.name = 'ScheduledBudgetExceeded';
  }
}

export class ScheduledBudget {
  private used = 0;
  private completing = false;
  private readonly now: () => number;
  private readonly deadline: number;
  private readonly maximum: number;
  private readonly reserveRequests: number;
  private readonly reserveMs: number;
  private readonly cleanups: Array<() => void> = [];

  constructor(options: { now?: () => number; maxSubrequests?: number; maxDurationMs?: number; reserveRequests?: number; reserveMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.maximum = options.maxSubrequests ?? 44; // Six platform requests remain for manual-route authentication/tail work.
    this.reserveRequests = options.reserveRequests ?? 4;
    this.reserveMs = options.reserveMs ?? 5_000;
    this.deadline = this.now() + (options.maxDurationMs ?? 60_000);
  }

  remainingMs(): number { return Math.max(0, this.deadline - (this.completing ? 0 : this.reserveMs) - this.now()); }
  get usedSubrequests(): number { return this.used; }

  canStart(requests = 1): boolean {
    return this.remainingMs() > 0 && this.used + requests <= this.maximum - (this.completing ? 0 : this.reserveRequests);
  }

  ensureCanStart(requests = 1): void {
    if (!this.canStart(requests)) throw new ScheduledBudgetExceeded();
  }

  consume(requests = 1): void {
    if (this.remainingMs() <= 0 || this.used + requests > this.maximum) throw new ScheduledBudgetExceeded();
    this.used += requests;
  }

  requestSignal(original?: AbortSignal | null): AbortSignal {
    const controller = new AbortController();
    const abort = () => controller.abort(original?.reason);
    if (original?.aborted) abort();
    else original?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(this.remainingMs() <= 0
      ? new ScheduledBudgetExceeded() : new Error('Scheduled subrequest timed out')), Math.min(30_000, this.remainingMs()));
    this.cleanups.push(() => {
      clearTimeout(timeout);
      original?.removeEventListener('abort', abort);
      controller.abort();
    });
    return controller.signal;
  }

  async complete<T>(work: () => Promise<T>): Promise<T> {
    this.completing = true;
    try { return await work(); } finally { this.completing = false; }
  }

  close(): void { for (const cleanup of this.cleanups) cleanup(); }
}

const activeBudget = new AsyncLocalStorage<ScheduledBudget>();
export function currentScheduledBudget(): ScheduledBudget | undefined { return activeBudget.getStore(); }

export async function withScheduledBudget<T>(budget: ScheduledBudget, work: () => Promise<T>): Promise<T> {
  try { return await activeBudget.run(budget, work); } finally { budget.close(); }
}

export function consumeScheduledSubrequests(count = 1): void { currentScheduledBudget()?.consume(count); }

export async function scheduledFetch(
  input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] = {}, fetcher: typeof fetch = fetch,
): Promise<Response> {
  const budget = currentScheduledBudget();
  if (!budget) return fetcher(input, init);
  budget.consume();
  const signal = budget.requestSignal(init?.signal);
  try {
    // Redirect hops otherwise consume invisible extra platform subrequests.
    return await fetcher(input, { ...init, redirect: 'manual', signal });
  } catch (error) {
    if (budget.remainingMs() <= 0 || signal.reason instanceof ScheduledBudgetExceeded) throw new ScheduledBudgetExceeded();
    throw error;
  }
}

export interface ScheduledCursorContext {
  budget?: ScheduledBudget;
  orderScheduledItems?<T>(key: string, items: readonly T[], identify: (item: T) => string): Promise<T[]>;
  advanceScheduledCursor?(key: string, nextIdentity: string): void;
  flushScheduledCursors?(): Promise<void>;
}

export function rotateScheduledItems<T>(items: readonly T[], seed: number): T[] {
  if (items.length === 0) return [];
  const start = Math.abs(Math.floor(seed)) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

export async function* scheduledItems<T>(
  context: ScheduledCursorContext, key: string, items: readonly T[], identify: (item: T) => string, requiredRequests = 14,
  completed?: () => void,
): AsyncGenerator<T> {
  const ordered = context.orderScheduledItems ? await context.orderScheduledItems(key, items, identify) : [...items];
  for (let index = 0; index < ordered.length; index += 1) {
    context.budget?.ensureCanStart(requiredRequests);
    yield ordered[index];
    // next() is reached only after the consumer completed the item. Exceptions
    // (including budget cancellation) leave this identity pending for retry.
    context.advanceScheduledCursor?.(key, identify(ordered[(index + 1) % ordered.length]));
    completed?.();
  }
}
