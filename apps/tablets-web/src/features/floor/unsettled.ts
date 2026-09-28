/**
 * Entries not yet settled on this page (module C4; DI-28): waiting for a tap, on their way, or NOT SAVED. While
 * any exists, leaving the page is held back, so a lost answer is never left without its NOT SAVED notice.
 * Memory only.
 */
import { useBlocker } from '@tanstack/react-router';
import { useState, useSyncExternalStore } from 'react';

const unsettled = new Set<string>();
const listeners = new Set<() => void>();

export function markUnsettled(id: string, on: boolean): void {
  const had = unsettled.has(id);
  if (on) unsettled.add(id);
  else unsettled.delete(id);
  if (had !== on) for (const l of listeners) l();
}

export function anyUnsettled(): boolean {
  return unsettled.size > 0;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAnyUnsettled(): boolean {
  return useSyncExternalStore(subscribe, anyUnsettled, anyUnsettled);
}

/** Holds back navigation (and asks before a reload) while an entry is unsettled; true after a held-back attempt. */
export function useLeaveGuard(): boolean {
  const [held, setHeld] = useState(false);
  const pending = useAnyUnsettled();
  useBlocker({
    shouldBlockFn: () => {
      const block = anyUnsettled();
      setHeld(block);
      return block;
    },
    enableBeforeUnload: () => anyUnsettled(),
  });
  return held && pending;
}
