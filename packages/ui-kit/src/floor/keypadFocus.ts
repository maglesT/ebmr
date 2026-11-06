/**
 * One keypad at a time (declutter D3): of the numeric entries on screen, only the one last focused shows its glove
 * keypad; before any is focused, the first one does. A keypad stays until another numeric entry takes the focus, so
 * pressing Save (which takes the focus) never moves the page under the finger.
 */
import { useEffect, useSyncExternalStore } from 'react';

let mounted: string[] = [];
let focused: string | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function shown(): string | null {
  return focused !== null && mounted.includes(focused) ? focused : (mounted[0] ?? null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Marks this numeric entry as the one in use (its keypad shows; the others hide theirs). */
export function focusKeypad(id: string): void {
  if (focused === id) return;
  focused = id;
  notify();
}

/** True when this numeric entry's keypad is the one shown. */
export function useKeypadShown(id: string, enabled = true): boolean {
  useEffect(() => {
    if (!enabled) return undefined;
    mounted = [...mounted, id];
    notify();
    return () => {
      mounted = mounted.filter((m) => m !== id);
      if (focused === id) focused = null;
      notify();
    };
  }, [id, enabled]);
  return useSyncExternalStore(subscribe, shown, shown) === id;
}
