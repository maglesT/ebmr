/**
 * usePendingCall and useRunCommand (module C4): drive one entry through the pendingEntry machine
 * (plan section 9; decision D1; DI-28; INV-40).
 *
 * - SUBMIT fixes the body and a new Idempotency-Key. On a kiosk the entry waits for a badge tap of the
 *   signed-in person; the tap's proof is bound to exactly this request (method, path, body without
 *   attribution), and a tap is single use, so every send (a resend too) asks for a fresh one.
 * - The attribution lives only in a local variable of the one send it belongs to: never in React state, the
 *   machine, a query cache, browser storage or a log.
 * - A lost answer leaves the entry NOT SAVED; the resend uses the same key and the same body. A send with no answer
 *   within SEND_DEADLINE_MS is aborted and counts as lost (review F60). The entry stays NOT
 *   SAVED, under that key, until an answer speaks for the key itself (outcome.ts answersForEntry: a commit, or on
 *   the run command the engine's own refusal): any other refusal (a PIN not accepted, a locked session, another
 *   person's badge...) is shown inside the NOT SAVED notice and settles nothing.
 * - A session change discards what is pending; before any send the signed-in person is checked against the
 *   person who made the entry, so an entry is never sent under someone else. An entry discarded after it was
 *   sent (on its way, or NOT SAVED) may be in the record: the notice says so, the screen reloads what the record
 *   holds, and a late answer for it reloads again (the reload at the change may run before the commit), never
 *   putting back a step view older than the one on show.
 * - The step view in an answer was computed for the person who sent the entry: it is put in place only while they
 *   are the one signed in (queries.ts applyStepView); otherwise the step is read again.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useMachine } from '@xstate/react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  buildPath,
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
import { callWithDeadline, SEND_DEADLINE_MS } from '../../api/deadline.ts';
import { useBadgeTap } from '../../app/ports.tsx';
import { describeChanges, describeIntent } from './describe.ts';
import { answersForEntry, classifyOutcome, type CommandOutcome } from './outcome.ts';
import { commandRoute } from './family.ts';
import { applyStepView, refreshRun, runQueryKey, stepQueryKey } from './queries.ts';
import { useFloorSession, useSessionChange, useSignedInNow } from './session.tsx';
import { markUnsettled } from './unsettled.ts';

/**
 * What is known of a discarded entry that had been sent (on its way, or NOT SAVED): UNKNOWN until an answer for its
 * key arrives; RECORDED when that answer was a commit; NOT_RECORDED when the engine refused it.
 */
export type DiscardedSent = 'UNKNOWN' | 'RECORDED' | 'NOT_RECORDED';

export interface PendingCall {
  state: floor.PendingEntryState;
  context: floor.PendingEntryContext;
  /** A tap is awaited or the request is on its way: other actions wait. */
  busy: boolean;
  tapRequired: boolean;
  /**
   * NOT SAVED only: the refusal of the last resend when the server gave it before it looked at the entry's key
   * (for example a PIN not accepted). Whether the first send was recorded is still unknown.
   */
  resendRefusal: RefusalEnvelope | null;
  /** discarded only: the entry had been sent before it was discarded, so it may be in the record. */
  discardedSent: DiscardedSent | null;
  /**
   * saved only: the step on show has moved past the run version the save produced, so a "Saved" note under a step form
   * no longer speaks for it. Only the note goes: the entry stays saved (F57: a dialog that took 'saved' for done must not
   * come back with the same words and Send enabled).
   */
  savedNoteExpired: boolean;
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
  /** After an entry that may have reached the server is discarded (by the person or a session change): reload what the record holds. */
  onDiscard?: () => void | Promise<void>;
  /**
   * An answer arrived for an entry discarded while it was on its way: reload what the record holds. `saved` is the
   * server's answer when the entry was committed; `samePerson` says whether the person who made the entry is still
   * the one signed in (only then is the server's post-commit view, computed for that person, theirs to see).
   */
  onLateAnswer?: (saved: RouteResponse<R> | null, samePerson: boolean) => void | Promise<void>;
  /**
   * A definite answer that nothing was applied (refused, another person's badge), with its refusal; null when the entry
   * was discarded after it may have reached the server. A form decides from the refusal what it keeps for the retry: a
   * scale reading is spent only when a command naming it commits, which an engine refusal does (the server names the
   * readings it used, details.readingsUsed), and a refusal given before the command, or thrown while it was resolved,
   * spends none (Phase 2 exit review F59). Not called for a stale answer, which uses no reading: the engine's stale
   * refusal is recorded but names its readings without claiming them, and any other stale answer came before anything
   * was written, so they stay usable for the resend from the reloaded screen (F58, F58.1).
   */
  onNotApplied?: (refusal: RefusalEnvelope | null) => void;
  /** The entry was discarded because another person's badge was tapped: forms clear what was typed. */
  onDiscarded?: () => void;
  /**
   * The server runs the engine on this route only after it has claimed the idempotency key, so after a lost answer
   * an engine refusal (ENG-...) speaks for the key (outcome.ts answersForEntry). Default false: then only SAVED
   * settles an entry whose first answer was lost (issuing a test batch checks the request with the engine before
   * the claim).
   */
  engineAfterClaim?: boolean;
}

const newKey = (): string => globalThis.crypto.randomUUID();

/** A refusal envelope of an outcome, if it has one. */
function envelopeOf(outcome: CommandOutcome<unknown>): RefusalEnvelope | null {
  return outcome.kind === 'SAVED' || outcome.kind === 'LOST' ? null : outcome.envelope;
}

export function usePendingCall<R extends AnyRoute>(route: R, params: RouteParamsInput<R>, options: PendingCallOptions<R>): PendingCall {
  const session = useFloorSession();
  const tap = useBadgeTap();
  const tapRequired = session.attribution !== 'NONE';
  const [snapshot, send, actorRef] = useMachine(floor.pendingEntryMachine, { input: { tapRequired, newKey } });
  const [resendRefusal, setResendRefusal] = useState<RefusalEnvelope | null>(null);
  const [discarded, setDiscarded] = useState<{ key: string; sent: DiscardedSent } | null>(null);

  const id = useId();
  const idRef = useRef(id);
  const live = useRef({ session, options, params, tap });
  useEffect(() => {
    live.current = { session, options, params, tap };
  });
  /** The key whose answer was lost: its outcome stays unknown until an answer speaks for it (D1). */
  const lostKey = useRef<string | null>(null);
  /** Keys discarded while their request was on its way: their answer still comes, and reloads the record. */
  const lateKeys = useRef(new Set<string>());

  /**
   * A session change (or the person no longer being the entry's owner) discards what is pending. An entry that was
   * sent and not settled may be in the record: say so and reload what the record holds. `beforeSend` is set when
   * the check runs just before this send goes out (so only an earlier, lost send can have reached the server).
   */
  const discardForSession = useCallback(
    (beforeSend: boolean) => {
      const { value: was, context } = actorRef.getSnapshot();
      const key = context.key;
      const onTheWire = was === 'sending' && !beforeSend;
      const sent = key !== null && (onTheWire || was === 'notSaved' || lostKey.current === key);
      if (onTheWire && key) lateKeys.current.add(key);
      setResendRefusal(null);
      if (sent) setDiscarded({ key, sent: 'UNKNOWN' });
      send({ type: 'SESSION_CHANGED' });
      if (sent) void live.current.options.onDiscard?.();
    },
    [actorRef, send],
  );

  useSessionChange(() => discardForSession(false));

  /** The answer to a request whose entry was discarded while it was on its way. */
  const settleLate = useCallback(async (key: string, owner: string | null, outcome: CommandOutcome<RouteResponse<R>>, afterLoss: boolean) => {
    const samePerson = owner !== null && live.current.session.personId === owner;
    // A first send's refusal is definite; after a lost answer only an answer for the key itself is (answersForEntry).
    const definite = outcome.kind !== 'LOST' && (!afterLoss || answersForEntry(outcome, live.current.options.engineAfterClaim === true));
    const known: DiscardedSent | null = outcome.kind === 'SAVED' ? 'RECORDED' : definite ? 'NOT_RECORDED' : null;
    if (known) setDiscarded((cur) => (cur && cur.key === key ? { key, sent: known } : cur));
    await live.current.options.onLateAnswer?.(outcome.kind === 'SAVED' ? outcome.value : null, samePerson);
  }, []);

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
        discardForSession(true);
        return;
      }
      send({ type: 'TAPPED' });
    }
    if (actorRef.getSnapshot().value !== 'sending') return;
    if (live.current.session.personId !== owner) {
      discardForSession(true);
      return;
    }
    // A resend of an entry whose answer was lost: the first send may have committed.
    const outcomeUnknown = lostKey.current === key;
    // A send the server has not answered within the deadline is given up and aborted: a lost answer, so the entry is
    // NOT SAVED with Resend under the same key and Discard, never "Saving..." without end (review F60; D1, DI-28).
    const result = await callWithDeadline(SEND_DEADLINE_MS, (signal) =>
      api.call(route, { params: p, body, idempotencyKey: key, signal, ...(attribution ? { attribution } : {}) } as unknown as CallInput<R>),
    );
    const outcome = classifyOutcome(result);
    const now = actorRef.getSnapshot();
    if (now.value !== 'sending' || now.context.key !== key) {
      if (lateKeys.current.delete(key)) await settleLate(key, owner, outcome, outcomeUnknown);
      return;
    }
    if (outcomeUnknown && !answersForEntry(outcome, live.current.options.engineAfterClaim === true)) {
      // Refused before the server looked at the key (or lost again): nothing is known about the first send. The
      // entry stays NOT SAVED with the same key and payload; the refusal is shown inside the notice (D1; DI-28).
      setResendRefusal(envelopeOf(outcome));
      send({ type: 'LOST' });
      return;
    }
    switch (outcome.kind) {
      case 'SAVED':
        // Settled first, so an onSaved that navigates (issue -> run overview) is not held back by the leave guard.
        lostKey.current = null;
        send({ type: 'SAVED' });
        markUnsettled(idRef.current, false);
        await live.current.options.onSaved?.(outcome.value);
        return;
      case 'LOST':
        lostKey.current = key;
        send({ type: 'LOST' });
        return;
      case 'SWITCH_USER':
        // Another person's badge: the entry is discarded and never sent under that person; C1 then offers the
        // switch ("Switch to <name>?" + PIN). If they switch, they enter their own values themselves.
        live.current.options.onNotApplied?.(outcome.envelope);
        live.current.options.onDiscarded?.();
        send({ type: 'SWITCH_USER', refusal: outcome.envelope });
        await live.current.tap.offerSwitch(outcome.envelope);
        return;
      case 'REFUSED':
        lostKey.current = null;
        live.current.options.onNotApplied?.(outcome.envelope);
        send({ type: 'REFUSED', refusal: outcome.envelope });
        return;
      case 'STALE': {
        // No reading was used: the engine's stale refusal (ENG-STALE) is recorded but names its readings without
        // claiming them, and any other stale answer came before anything was written. The form keeps what was
        // captured for the resend (F58, F58.1); EntryStatus says which of the two it was.
        lostKey.current = null;
        const changes = (await live.current.options.onStale?.()) ?? [];
        send({ type: 'STALE', refusal: outcome.envelope, changes });
        return;
      }
    }
  }, [actorRef, route, send, discardForSession, settleLate]);

  const submit = useCallback(
    (body: Record<string, unknown>, summary: string) => {
      const owner = live.current.session.personId;
      if (!owner) return;
      const before = actorRef.getSnapshot().context.key;
      send({ type: 'SUBMIT', payload: body, summary, owner });
      // Only a SUBMIT the machine took (a new key) sends: a second press while one is under way does nothing.
      if (actorRef.getSnapshot().context.key !== before) {
        setResendRefusal(null);
        setDiscarded(null);
        void transmit();
      }
    },
    [actorRef, send, transmit],
  );
  const resend = useCallback(() => {
    if (actorRef.getSnapshot().value !== 'notSaved') return;
    setResendRefusal(null);
    send({ type: 'RESEND' });
    void transmit();
  }, [actorRef, send, transmit]);
  const discard = useCallback(() => {
    const { value, context } = actorRef.getSnapshot();
    if (value !== 'notSaved' || !context.key) return;
    // The entry was sent at least once and its answer lost: it may be in the record.
    setResendRefusal(null);
    setDiscarded({ key: context.key, sent: 'UNKNOWN' });
    send({ type: 'DISCARD' });
    void live.current.options.onDiscard?.();
  }, [actorRef, send]);
  const reset = useCallback(() => send({ type: 'RESET' }), [send]);

  const state: floor.PendingEntryState = snapshot.value;
  const unsettled = state === 'awaitingTap' || state === 'sending' || state === 'notSaved';
  useEffect(() => {
    markUnsettled(id, unsettled);
    return () => markUnsettled(id, false);
  }, [id, unsettled]);
  return {
    state,
    context: snapshot.context,
    busy: state === 'awaitingTap' || state === 'sending',
    tapRequired,
    resendRefusal: state === 'notSaved' ? resendRefusal : null,
    discardedSent: state === 'discarded' && discarded ? discarded.sent : null,
    savedNoteExpired: false,
    submit,
    resend,
    discard,
    reset,
  };
}

export interface RunCommand extends PendingCall {
  /** Sends a plain intent against the run version the person is looking at. */
  send: (intent: ClientIntent, expectedVersion: number, view?: StepScreenView) => void;
}

/**
 * A plain engine intent on a test run (POST /api/test-runs/:runId/commands). `viewStepKey` names the step whose
 * view comes back (and is reloaded when the entry arrives stale).
 */
export function useRunCommand(
  runId: string,
  viewStepKey: string | null,
  reason: string,
  extra: { onSaved?: () => void; onNotApplied?: (refusal: RefusalEnvelope | null) => void; onDiscarded?: () => void } = {},
): RunCommand {
  const qc = useQueryClient();
  const signedInNow = useSignedInNow();
  const extraRef = useRef(extra);
  useEffect(() => {
    extraRef.current = extra;
  });
  /** The run version the last saved command produced. */
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  const target = commandRoute(runId);
  const call = usePendingCall(target.route, target.params, {
    reason,
    // POST /api/test-runs/:runId/commands: the engine runs inside the command, after the key is claimed.
    engineAfterClaim: true,
    onSaved: async (value) => {
      setSavedVersion(value.version);
      // The form's own reaction (cleared, closed with "Add another") comes in the same render as "Saved", before the
      // view is read again: otherwise the filled form showed "Saved" until the read came back, and a person (or a
      // browser test) acting in that moment met the form closing under them (fcv journey, slice 7k).
      extraRef.current.onSaved?.();
      // The server's post-commit view (a newer one already on show is kept, and so is the screen when the person signed
      // in is no longer the sender; then the step is read again).
      const put = value.step ? await applyStepView(qc, value.step, signedInNow) : false;
      await refreshRun(qc, { steps: !put });
    },
    onNotApplied: (refusal) => extraRef.current.onNotApplied?.(refusal),
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
      extraRef.current.onNotApplied?.(null);
      extraRef.current.onDiscarded?.();
      return refreshRun(qc, { steps: true });
    },
    onLateAnswer: async (saved, samePerson) => {
      // The server's post-commit view is computed for the person who sent the entry: put in place only for them, and
      // only when it is not older than the view on show (a reload after the session change, or another terminal's
      // entry, may already have brought a newer one). Then the step is read again in every case: a late answer can
      // arrive long after it was computed, and any read begun before the commit is replaced by this one.
      const view = samePerson ? (saved?.step ?? null) : null;
      if (view) await applyStepView(qc, view, signedInNow);
      await refreshRun(qc, { steps: true });
    },
  });
  // A "Saved" note speaks for the moment of the save. Once the step on show is past the version the save produced (a
  // signature, another entry, another person's action), the note goes: found in the owner's demo run, where "Saved:
  // Start step" stayed under the step after it had been signed. Only the note goes; the entry stays saved, so a dialog
  // that is done stays done (F57).
  const shownVersion = viewStepKey ? qc.getQueryData<StepScreenView>(stepQueryKey(runId, viewStepKey))?.run.version : undefined;
  const { state, submit } = call;
  const savedNoteExpired = state === 'saved' && savedVersion !== null && shownVersion !== undefined && shownVersion > savedVersion;
  const sendIntent = useCallback(
    (intent: ClientIntent, expectedVersion: number, view?: StepScreenView) => {
      setSavedVersion(null);
      submit({ expectedVersion, intent, ...(viewStepKey ? { viewStepKey } : {}) }, describeIntent(intent, view));
    },
    [submit, viewStepKey],
  );
  return { ...call, savedNoteExpired, send: sendIntent };
}

/** The refusal of the entry's last send, if any. */
export function refusalOf(call: PendingCall): RefusalEnvelope | null {
  return call.context.refusal;
}
