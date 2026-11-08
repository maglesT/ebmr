/**
 * Office acts of the Phase 3 slice 6 screens (planning, master data, plant, quality): a plain command (one POST, its
 * refusal shown with the server's own words) and a signed act through C1's ceremony (the signable action, its aggregate
 * and meaning as the server describes them, api/signables.ts). After either, the reads the act may have changed are read again; nothing is
 * updated optimistically and the server's answer is what the screen shows.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactNode } from 'react';
import { buildPath, routes, type AnyRoute, type Attribution, type CallError, type CallInput, type RouteResponse, type SignableAction } from '@ebmr/api-contract';
import { Banner, Button } from '@ebmr/ui-kit';
import { api } from '../api/client.ts';
import { useApiQuery } from '../api/hooks.ts';
import { describeSignable } from '../api/signables.ts';
import { useBadgeTap, useSignatureCeremony } from './ports.tsx';
import { RefusalMessage } from './refusal.tsx';

/** Reads every query whose key starts with one of `ids` again (route ids). */
export function useRefresh(ids: readonly string[]): () => Promise<void> {
  const qc = useQueryClient();
  return useCallback(async () => {
    // A read already on its way may have been sent before the command committed. TanStack Query cancels such a read on
    // invalidation only once the query has data; on a first read it joins it, and the list kept the answer from before
    // the command (E2E library-softgel, 8 November 2026). So the reads on their way are cancelled first (a first read is
    // reverted, not failed), then read afresh.
    await Promise.all(ids.map((id) => qc.cancelQueries({ queryKey: [id] })));
    await Promise.all(ids.map((id) => qc.invalidateQueries({ queryKey: [id] })));
  }, [qc, ids]);
}

export interface RunOptions<R extends AnyRoute> {
  /** Called with the answer once the command committed and before the reads are read again (a form empties itself here,
   *  so a person who starts the next entry as soon as the lists show the last one keeps what they type). */
  onCommitted?: (value: RouteResponse<R>) => void;
}

export interface Command<R extends AnyRoute> {
  run: (input: CallInput<R>, options?: RunOptions<R>) => Promise<RouteResponse<R> | null>;
  busy: boolean;
  error: CallError | null;
  done: RouteResponse<R> | null;
  clear: () => void;
  /** Forgets the last answer and refusal (slice 7g-1: an issued secret is dropped once it has been handed over). */
  reset: () => void;
}

/**
 * One plain command; the reads named in `refresh` are read again after it (refused or not). On a shared terminal (the
 * session's attribution is TAP or TAP_PIN) a route marked FRESH_ON_SHARED is sent with a fresh badge tap of the person
 * signed in (INV-40), as the floor's entries are; a cancelled tap sends nothing.
 */
export function useCommand<R extends AnyRoute>(route: R, refresh: readonly string[] = [], tapReason = 'this act'): Command<R> {
  const reread = useRefresh(refresh);
  const tap = useBadgeTap();
  const session = useApiQuery(routes.session.get, {}, { staleTime: 60_000 });
  const shared = session.data !== undefined && session.data.attribution !== 'NONE';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CallError | null>(null);
  const [done, setDone] = useState<RouteResponse<R> | null>(null);
  const run = async (input: CallInput<R>, options?: RunOptions<R>): Promise<RouteResponse<R> | null> => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      let attribution: Attribution | null = null;
      // Slice 7m: an act pressed before the session was read (a page just opened) waits for it, so a shared terminal
      // still asks for the badge; deciding on the missing answer sent the act untapped and the server refused it (428).
      let onShared = shared;
      if (route.attribution === 'FRESH_ON_SHARED' && session.data === undefined) {
        const read = (await session.refetch()).data;
        onShared = read !== undefined && read.attribution !== 'NONE';
      }
      if (route.attribution === 'FRESH_ON_SHARED' && onShared) {
        const { params, body } = input as { params?: Record<string, unknown>; body?: Record<string, unknown> };
        attribution = await tap.requestTap(tapReason, { method: route.method, path: buildPath(route.path, params ?? {}), body: { ...(body ?? {}) } });
        if (!attribution) return null;
      }
      const r = await api.call(route, attribution ? ({ ...input, attribution }) : input);
      if (r.ok) options?.onCommitted?.(r.value);
      await reread();
      if (!r.ok) {
        setError(r.error);
        return null;
      }
      setDone(r.value);
      return r.value;
    } finally {
      setBusy(false);
    }
  };
  return {
    run,
    busy,
    error,
    done,
    clear: () => setError(null),
    reset: () => {
      setError(null);
      setDone(null);
    },
  };
}

export type SignedOutcome = 'SIGNED' | 'CANCELLED' | 'REFUSED' | 'NOT_CONFIRMED';

export interface SignedAct {
  sign: (action: SignableAction, title: string) => Promise<SignedOutcome>;
  busy: boolean;
  error: CallError | null;
  outcome: SignedOutcome | null;
}

/** A signed act through the ceremony; the reads named in `refresh` are read again after it. */
export function useSignedAct(refresh: readonly string[] = []): SignedAct {
  const ceremony = useSignatureCeremony();
  const reread = useRefresh(refresh);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CallError | null>(null);
  const [outcome, setOutcome] = useState<SignedOutcome | null>(null);
  const sign = async (action: SignableAction, title: string): Promise<SignedOutcome> => {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      // What is signed (aggregate, meaning) is the server's, for this action as sent (esig.describe).
      const described = await describeSignable(action);
      if (!described.ok) {
        setError(described.error);
        setOutcome('REFUSED');
        return 'REFUSED';
      }
      // A two-row act (D-P4-5): the second record and meaning are the server's too (the descriptor's companion).
      const c = described.descriptor.companion;
      const companion = c ? { companion: { aggregateType: c.aggregateType, aggregateId: c.aggregateId, meaning: c.meaning } } : {};
      const o = await ceremony.sign({ ...described.subject, action, title, ...companion });
      if (o.status === 'REFUSED') setError({ kind: 'REFUSAL', status: 409, envelope: o.refusal });
      if (o.status !== 'CANCELLED') await reread();
      setOutcome(o.status);
      return o.status;
    } finally {
      setBusy(false);
    }
  };
  return { sign, busy, error, outcome };
}

/** What an act ended with: the refusal in the server's words, or a short confirmation. */
export function ActResult({ error, done, outcome, label = 'Saved.' }: { error: CallError | null; done?: unknown; outcome?: SignedOutcome | null; label?: string }) {
  if (error) return <RefusalMessage error={error} />;
  if (outcome === 'SIGNED') return <Banner tone="ok" title="Signed." live="polite" />;
  if (outcome === 'NOT_CONFIRMED') return <Banner tone="warning" title="The answer was lost and no matching signature was found: check the record before you sign again." />;
  if (done) return <Banner tone="ok" title={label} live="polite" />;
  return null;
}

/** A plain section of an office page. */
export function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section aria-label={title} data-testid={testId} style={{ marginBlock: '1.5rem' }}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/** A primary button that runs an async act (never twice at once). */
export function ActButton({ label, onPress, disabled = false, primary = true }: { label: string; onPress: () => unknown; disabled?: boolean; primary?: boolean }) {
  return (
    <Button variant={primary ? 'primary' : 'secondary'} onPress={() => void onPress()} isDisabled={disabled}>
      {label}
    </Button>
  );
}
