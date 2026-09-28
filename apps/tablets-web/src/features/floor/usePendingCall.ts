/**
 * usePendingCall and useRunCommand (module C4): drive one entry through the pendingEntry machine
 * (plan section 9; decision D1; DI-28; INV-40).
 *
 * - SUBMIT fixes the body and a new Idempotency-Key. On a kiosk the entry waits for a badge tap of the
 *   signed-in person; the tap's proof is bound to exactly this request (method, path, body without
 *   attribution), and a tap is single use, so every send (a resend too) asks for a fresh one.
 * - The attribution lives only in a local variable of the one send it belongs to: never in React state, the
 *   machine, a query cache, browser storage or a log.
 * - A lost answer leaves the entry NOT SAVED; the resend uses the same key and the same body.
 * - A session change discards what is pending; before any send the signed-in person is checked against the
 *   person who made the entry, so an entry is never sent under someone else.
 * - A late answer for an entry that was discarded meanwhile is ignored.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useMachine } from '@xstate/react';
import { useCallback, useEffect, useRef } from 'react';
import {
  buildPath,
  routes,
  type AnyRoute,
  type Attribution,
  type CallInput,
  type ClientIntent,
  type RefusalEnvelope,
  type RouteParamsInput,
  type RouteResponse,
  type StepScreenView,
} from '@ebmr/api-contract';
import { floor } from '@ebmr/ui-kit';
import { api } from '../../api/client.ts';
import { useBadgeTap } from '../../app/ports.tsx';
import { describeChanges, describeIntent } from './describe.ts';
import { classifyOutcome } from './outcome.ts';
import { applyStepView, refreshRun, runQueryKey, stepQueryKey } from './queries.ts';
import { useFloorSession, useSessionChange } from './session.tsx';

export interface PendingCall {
  state: floor.PendingEntryState;
  context: floor.PendingEntryContext;
  /** A tap is awaited or the request is on its way: other actions wait. */
  busy: boolean;
  tapRequired: boolean;
  submit: (body: Record<string, unknown>, summary: string) => void;
  resend: () => void;
  discard: () => void;
  reset: () => void;
}

export interface PendingCallOptions<R extends AnyRoute> {
  /** What the badge prompt says the tap is for. */
  reason: string;
  onSaved?: (value: RouteResponse<R>) => void | Promise<void>;
  /** Reloads what the stale entry was about and says what changed. */
  onStale?: () => Promise<string[]>;
  /** After the person discards a NOT SAVED entry: reload what the record holds. */
  onDiscard?: () => void | Promise<void>;
  /**
   * A definite answer that nothing was applied (refused, stale, another person's badge). Scale readings named
   * by the entry are used up even by a refused command, so forms clear them: a retry needs a fresh capture.
   */
  onNotApplied?: () => void;
  /** The entry was discarded because another person's badge was tapped: forms clear what was typed. */
  onDiscarded?: () => void;
}

const newKey = (): string => globalThis.crypto.randomUUID();

export function usePendingCall<R extends AnyRoute>(route: R, params: RouteParamsInput<R>, options: PendingCallOptions<R>): PendingCall {
  const session = useFloorSession();
  const tap = useBadgeTap();
  const tapRequired = session.attribution !== 'NONE';
  const [snapshot, send, actorRef] = useMachine(floor.pendingEntryMachine, { input: { tapRequired, newKey } });

  const live = useRef({ session, options, params, tap });
  useEffect(() => {
    live.current = { session, options, params, tap };
  });

  useSessionChange(() => {
    const was = actorRef.getSnapshot().value;
    send({ type: 'SESSION_CHANGED' });
    // Something may have reached the server before the change: reload what the record holds.
    if (was === 'sending' || was === 'notSaved') void live.current.options.onDiscard?.();
  });

  const transmit = useCallback(async () => {
    const start = actorRef.getSnapshot();
    const body = start.context.payload;
    const key = start.context.key;
    const owner = start.context.owner;
    if (!body || !key) return;
    const { params: p, options: o, tap: t } = live.current;
    let attribution: Attribution | null = null;
    if (start.value === 'awaitingTap') {
      const path = buildPath(route.path, p as Record<string, unknown>);
      attribution = await t.requestTap(o.reason, { method: route.method, path, body: { ...body } });
      const after = actorRef.getSnapshot();
      if (after.value !== 'awaitingTap' || after.context.key !== key) return;
      if (!attribution) {
        send({ type: 'TAP_CANCELLED' });
        return;
      }
      if (live.current.session.personId !== owner) {
        send({ type: 'SESSION_CHANGED' });
        return;
      }
      send({ type: 'TAPPED' });
    }
    if (actorRef.getSnapshot().value !== 'sending') return;
    if (live.current.session.personId !== owner) {
      send({ type: 'SESSION_CHANGED' });
      return;
    }
    const input = { params: p, body, idempotencyKey: key, ...(attribution ? { attribution } : {}) } as unknown as CallInput<R>;
    const result = await api.call(route, input);
    const now = actorRef.getSnapshot();
    if (now.value !== 'sending' || now.context.key !== key) return;
    const outcome = classifyOutcome(result);
    switch (outcome.kind) {
      case 'SAVED':
        await live.current.options.onSaved?.(outcome.value);
        send({ type: 'SAVED' });
        return;
      case 'LOST':
        send({ type: 'LOST' });
        return;
      case 'SWITCH_USER':
        // Another person's badge: the entry is discarded and never sent under that person; C1 then offers the
        // switch ("Switch to <name>?" + PIN). If they switch, they enter their own values themselves.
        live.current.options.onNotApplied?.();
        live.current.options.onDiscarded?.();
        send({ type: 'SWITCH_USER', refusal: outcome.envelope });
        await live.current.tap.offerSwitch(outcome.envelope);
        return;
      case 'REFUSED':
        live.current.options.onNotApplied?.();
        send({ type: 'REFUSED', refusal: outcome.envelope });
        return;
      case 'STALE': {
        live.current.options.onNotApplied?.();
        const changes = (await live.current.options.onStale?.()) ?? [];
        send({ type: 'STALE', refusal: outcome.envelope, changes });
        return;
      }
    }
  }, [actorRef, route, send]);

  const submit = useCallback(
    (body: Record<string, unknown>, summary: string) => {
      const owner = live.current.session.personId;
      if (!owner) return;
      send({ type: 'SUBMIT', payload: body, summary, owner });
      void transmit();
    },
    [send, transmit],
  );
  const resend = useCallback(() => {
    send({ type: 'RESEND' });
    void transmit();
  }, [send, transmit]);
  const discard = useCallback(() => {
    send({ type: 'DISCARD' });
    void live.current.options.onDiscard?.();
  }, [send]);
  const reset = useCallback(() => send({ type: 'RESET' }), [send]);

  const state: floor.PendingEntryState = snapshot.value;
  return { state, context: snapshot.context, busy: state === 'awaitingTap' || state === 'sending', tapRequired, submit, resend, discard, reset };
}

export interface RunCommand extends PendingCall {
  /** Sends a plain intent against the run version the person is looking at. */
  send: (intent: ClientIntent, expectedVersion: number, view?: StepScreenView) => void;
}

/**
 * A plain engine intent on a test run (POST /api/test-runs/:runId/commands). `viewStepKey` names the step whose
 * view comes back (and is reloaded when the entry arrives stale).
 */
export function useRunCommand(runId: string, viewStepKey: string | null, reason: string, extra: { onSaved?: () => void; onNotApplied?: () => void; onDiscarded?: () => void } = {}): RunCommand {
  const qc = useQueryClient();
  const extraRef = useRef(extra);
  useEffect(() => {
    extraRef.current = extra;
  });
  const call = usePendingCall(routes.execution.command, { runId }, {
    reason,
    onSaved: async (value) => {
      if (value.step) applyStepView(qc, value.step);
      await refreshRun(qc, { steps: value.step === null });
      extraRef.current.onSaved?.();
    },
    onNotApplied: () => extraRef.current.onNotApplied?.(),
    onDiscarded: () => extraRef.current.onDiscarded?.(),
    onStale: async () => {
      if (!viewStepKey) {
        await qc.invalidateQueries({ queryKey: runQueryKey(runId) });
        return ['The run was reloaded from the server.'];
      }
      const key = stepQueryKey(runId, viewStepKey);
      const before = qc.getQueryData<StepScreenView>(key);
      await qc.invalidateQueries({ queryKey: key });
      const after = qc.getQueryData<StepScreenView>(key);
      await refreshRun(qc, { steps: false });
      return after ? describeChanges(before, after) : ['The step was reloaded from the server.'];
    },
    onDiscard: () => {
      extraRef.current.onNotApplied?.();
      extraRef.current.onDiscarded?.();
      return refreshRun(qc, { steps: true });
    },
  });
  const { submit } = call;
  const sendIntent = useCallback(
    (intent: ClientIntent, expectedVersion: number, view?: StepScreenView) => {
      submit({ expectedVersion, intent, ...(viewStepKey ? { viewStepKey } : {}) }, describeIntent(intent, view));
    },
    [submit, viewStepKey],
  );
  return { ...call, send: sendIntent };
}

/** The refusal of the entry's last send, if any. */
export function refusalOf(call: PendingCall): RefusalEnvelope | null {
  return call.context.refusal;
}
