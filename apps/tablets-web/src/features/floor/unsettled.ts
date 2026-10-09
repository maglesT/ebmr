/**
 * Entries not yet settled on this page (module C4; DI-28): waiting for a tap, on their way, or NOT SAVED. While
 * any exists, leaving the page is held back, so a lost answer is never left without its NOT SAVED notice.
 * Memory only.
 */
import { useBlocker } from '@tanstack/react-router';
import { useEffect, useId, useState, useSyncExternalStore } from 'react';

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

/**
 * Forms with values typed, chosen, scanned or captured and not saved yet. A reload or closing the tab asks first: a
 * value not saved is in no record and would be gone (found in the owner's demo run). Moving to another page of the
 * application is not held back for them. Memory only: the values themselves never leave the form.
 */
const drafts = new Set<string>();

export function anyDraft(): boolean {
  return drafts.size > 0;
}

/** Marks the calling form as holding unsaved values while `unsaved` is true. */
export function useDraftGuard(unsaved: boolean): void {
  const id = useId();
  useEffect(() => {
    if (unsaved) drafts.add(id);
    else drafts.delete(id);
    return () => {
      drafts.delete(id);
    };
  }, [id, unsaved]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAnyUnsettled(): boolean {
  return useSyncExternalStore(subscribe, anyUnsettled, anyUnsettled);
}

/**
 * Holds back navigation (and asks before a reload) while an entry is unsettled; true after a held-back attempt. A
 * reload also asks while a form holds unsaved values (useDraftGuard).
 */
export function useLeaveGuard(): boolean {
  const [held, setHeld] = useState(false);
  const pending = useAnyUnsettled();
  useBlocker({
    shouldBlockFn: () => {
      const block = anyUnsettled();
      setHeld(block);
      return block;
    },
    enableBeforeUnload: () => anyUnsettled() || anyDraft(),
  });
  return held && pending;
}
