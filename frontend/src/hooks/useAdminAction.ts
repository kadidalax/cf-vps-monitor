import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';

export function useAdminAction() {
  const inFlight = useRef(new Set<string>());
  const [pendingActions, setPendingActions] = useState<ReadonlySet<string>>(() => new Set());
  const run = useCallback(async (key: string, action: () => Promise<void>) => {
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setPendingActions(new Set(inFlight.current));
    try {
      await action();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败，请重试');
    } finally {
      inFlight.current.delete(key);
      setPendingActions(new Set(inFlight.current));
    }
  }, []);
  return { run, pendingActions };
}
