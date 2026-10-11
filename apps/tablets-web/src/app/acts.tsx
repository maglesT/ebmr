/**
 * Office acts of the Phase 3 slice 6 screens (planning, master data, plant, quality): a plain command (one POST, its
 * refusal shown with the server's own words) and a signed act through C1's ceremony (the signable action, its aggregate
 * and meaning from api/signables.ts). After either, the reads the act may have changed are read again; nothing is
 * updated optimistically and the server's answer is what the screen shows.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactNode } from 'react';
import type { AnyRoute, CallError, CallInput, RouteResponse, SignableAction } from '@ebmr/api-contract';
import { Banner, Button } from '@ebmr/ui-kit';
import { api } from '../api/client.ts';
import { subjectOf, type SubjectFacts } from '../api/signables.ts';
import { useSignatureCeremony } from './ports.tsx';
import { RefusalMessage } from './refusal.tsx';

type S6Signable = Parameters<typeof subjectOf>[0];

/** Reads every query whose key starts with one of `ids` again (route ids). */
export function useRefresh(ids: readonly string[]): () => Promise<void> {
  const qc = useQueryClient();
  return useCallback(async () => {
    await Promise.all(ids.map((id) => qc.invalidateQueries({ queryKey: [id] })));
  }, [qc, ids]);
}

export interface Command<R extends AnyRoute> {
  run: (input: CallInput<R>) => Promise<RouteResponse<R> | null>;
  busy: boolean;
  error: CallError | null;
  done: RouteResponse<R> | null;
  clear: () => void;
}

/** One plain command; the reads named in `refresh` are read again after it (refused or not). */
export function useCommand<R extends AnyRoute>(route: R, refresh: readonly string[] = []): Command<R> {
  const reread = useRefresh(refresh);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CallError | null>(null);
  const [done, setDone] = useState<RouteResponse<R> | null>(null);
  const run = async (input: CallInput<R>): Promise<RouteResponse<R> | null> => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await api.call(route, input);
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
  return { run, busy, error, done, clear: () => setError(null) };
}

export type SignedOutcome = 'SIGNED' | 'CANCELLED' | 'REFUSED' | 'NOT_CONFIRMED';

export interface SignedAct {
  sign: (action: S6Signable, title: string, facts?: SubjectFacts) => Promise<SignedOutcome>;
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
  const sign = async (action: S6Signable, title: string, facts: SubjectFacts = {}): Promise<SignedOutcome> => {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const o = await ceremony.sign({ ...subjectOf(action, facts), action: action as SignableAction, title });
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
export function ActButton({ label, onPress, disabled = false, primary = true }: { label: string; onPress: () => void | Promise<unknown>; disabled?: boolean; primary?: boolean }) {
  return (
    <Button variant={primary ? 'primary' : 'secondary'} onPress={() => void onPress()} isDisabled={disabled}>
      {label}
    </Button>
  );
}
