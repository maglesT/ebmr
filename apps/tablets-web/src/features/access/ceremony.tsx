/**
 * The e-signature ceremony of the web app (module C1; plan section 6): the SignatureCeremonyPort. One signing at a
 * time runs the ui-kit ceremony machine and renders its SignatureDialog.
 *
 *  1. content: GET /api/esig/content (intent = the meaning code; for an exception disposition also the proposal,
 *     from the action: see previewIntent); the machine refuses text whose SHA-256 is not the server's hash;
 *  2. kiosk: the signer taps (and, on TAP_PIN classes, enters the PIN): the challenge request carries that
 *     attribution; office: no tap;
 *  3. challenge: POST /api/esig/challenges with the client's hash of the text it showed (EBMR-ESIG-013 when the
 *     record changed meanwhile); a badge of another person offers "Switch to <name>?". Once switched, the signing
 *     ends with nothing signed (CANCELLED): the request and any decision in it were made by the previous person, so
 *     the caller asks the new person for their own (INV-40, DI-38);
 *  4. secret: the PIN (kiosk) or user ID and password (office), within the 120 s countdown, sent once with a
 *     fresh device proof; a wrong one returns to the entry (the kernel counts it toward lockout);
 *  5. a lost answer never re-sends the credentials: the dialog reloads the record's signatures and reports
 *     SIGNED only when a matching signature is found, otherwise NOT_CONFIRMED.
 * Secrets live in refs until the request is built, then are wiped; they never enter machine context, React
 * state, query caches or storage.
 */
import { useCallback, useEffect, useState } from 'react';
import { useMachine } from '@xstate/react';
import { fromPromise } from 'xstate';
import { sha256Hex } from '@ebmr/expr';
import { routes, type RefusalEnvelope, type SignatureCredentials } from '@ebmr/api-contract';
import { identity, machines } from '@ebmr/ui-kit';
import { api, deviceProof } from '../../api/client.ts';
import { useBoot } from '../../app/boot.tsx';
import { secondsUntil } from '../../app/clock.ts';
import type { SignOutcome, SignRequest } from '../../app/ports.tsx';
import { buildAttribution, failureOf, frozenRequest, previewIntent } from './calls.ts';
import type { AccessController } from './controller.tsx';
import { Latest, Vault } from './holders.ts';
import type { Boot } from '../../app/boot.tsx';

export interface SignJob {
  id: number;
  request: SignRequest;
  kiosk: boolean;
  tapPin: boolean;
}

const localError = (message: string): Error => machines.ceremonyError({ kind: 'ERROR', message });
const callError = (e: Parameters<typeof failureOf>[0]): Error => machines.ceremonyError(failureOf(e));

export function CeremonyHost({ job, ctl, onFinish }: { job: SignJob; ctl: AccessController; onFinish: (o: SignOutcome) => void }) {
  const boot = useBoot();
  const [latestBoot] = useState(() => new Latest<Boot>(boot));
  useEffect(() => {
    latestBoot.set(boot);
  });
  const [tapUid] = useState(() => new Vault<string>());
  const [tapPin] = useState(() => new Vault<string>());
  const [secret] = useState(() => new Vault<SignatureCredentials>());
  const [tapStage, setTapStage] = useState<'badge' | 'pin'>('badge');
  const [switchError, setSwitchError] = useState<RefusalEnvelope | null>(null);
  const [switching, setSwitching] = useState(false);
  // One frozen copy of the request for the whole ceremony: preview, challenge and sign carry the same action.
  const [req] = useState(() => frozenRequest(job.request));

  const [machine] = useState(() =>
      machines.ceremonyMachine.provide({
        actors: {
          loadContent: fromPromise(async () => {
            const r = await api.call(routes.esig.content, { query: { aggregateType: req.aggregateType, aggregateId: req.aggregateId, intent: previewIntent(req.meaning, req.action) } });
            if (!r.ok) throw callError(r.error);
            return r.value;
          }),
          createChallenge: fromPromise(async ({ input }) => {
            const c = input.content;
            const body = {
              aggregateType: req.aggregateType,
              aggregateId: req.aggregateId,
              contentVersion: c.contentVersion,
              meaning: req.meaning,
              clientContentHash: sha256Hex(c.canonicalText),
              action: req.action,
            };
            let attribution;
            if (job.kiosk) {
              const uid = tapUid.peek();
              const pin = tapPin.take();
              const key = latestBoot.get().deviceKey;
              if (!uid || !key) throw localError('no badge was tapped');
              attribution = await buildAttribution(key, uid, pin ?? undefined, { method: 'POST', path: '/api/esig/challenges', body });
            }
            const r = await api.call(routes.esig.createChallenge, { body, ...(attribution ? { attribution } : {}) });
            if (!r.ok) {
              const f = failureOf(r.error);
              // Another person's badge: kept (only) for the "Switch to <name>?" PIN step.
              if (!(f.kind === 'REFUSAL' && f.envelope.refusal.kind === 'SWITCH_USER')) tapUid.clear();
              throw machines.ceremonyError(f);
            }
            tapUid.clear();
            return r.value;
          }),
          sign: fromPromise(async ({ input }) => {
            const credentials = secret.take();
            const key = latestBoot.get().deviceKey;
            if (!credentials || !key) throw localError('no credentials were entered');
            const body = { challengeId: input.challenge.challengeId, credentials, action: req.action };
            const proof = await deviceProof(key, 'POST', '/api/esig/sign', body);
            const r = await api.call(routes.esig.sign, { body: { ...body, proof } });
            if (!r.ok) throw callError(r.error);
            return r.value;
          }),
          reconcile: fromPromise(async ({ input }) => {
            const r = await api.call(routes.esig.signatures, { query: { aggregateType: req.aggregateType, aggregateId: req.aggregateId } });
            if (!r.ok) throw callError(r.error);
            const me = latestBoot.get().session?.person.personId;
            return r.value.signatures.find((m) => m.valid && m.meaning === input.challenge.meaning && m.contentHash === input.challenge.contentHash && m.signer.personId === me) ?? null;
          }),
        },
      }),
  );
  const [snap, send] = useMachine(machine, { input: { kiosk: job.kiosk } });
  const state = snap.value;

  // Display countdown of the challenge from the server-anchored clock; at zero the entry expires (the server
  // decides for a signature already on its way).
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const challenge = snap.context.challenge;
  const counting = state === 'awaitingSecret' || state === 'signing';
  useEffect(() => {
    if (!challenge || !counting) return;
    const tick = () => {
      const s = secondsUntil(challenge.expiresAt.us);
      setSecondsLeft(s ?? challenge.expiresInSeconds);
      if (s !== null && s <= 0) send({ type: 'EXPIRE' });
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [challenge, counting, send]);

  const finish = useCallback(() => {
    tapUid.clear();
    tapPin.clear();
    secret.clear();
    const outcome = machines.ceremonyOutcome(state, snap.context);
    if (outcome?.status === 'REFUSED' && ['NO_SESSION', 'AUTH_LOCKED', 'SESSION_LOCKED'].includes(outcome.refusal.refusal.code)) ctl.checkSession();
    onFinish(outcome ?? { status: 'CANCELLED' });
  }, [state, snap.context, ctl, onFinish, tapUid, tapPin, secret]);

  useEffect(() => {
    if (state === 'cancelled' || state === 'closed') finish();
  }, [state, finish]);

  const s = boot.session;
  return (
    <identity.SignatureDialog
      state={state}
      context={snap.context}
      title={req.title}
      secondsLeft={counting ? secondsLeft : null}
      signerName={s ? `${s.person.legalName} (${s.person.loginName})` : 'you'}
      demoBadges={ctl.demoBadges}
      tapStage={tapStage}
      switchError={switchError}
      onSign={() => send({ type: 'SIGN' })}
      onCancel={() => {
        tapUid.clear();
        tapPin.clear();
        send({ type: 'CANCEL' });
      }}
      onRestart={() => {
        setTapStage('badge');
        send({ type: 'RESTART' });
      }}
      onClose={() => {
        if (state === 'expired' || state === 'changed') send({ type: 'CLOSE' });
        else finish();
      }}
      onTap={(uid) => {
        tapUid.put(uid);
        if (job.tapPin) setTapStage('pin');
        else send({ type: 'TAPPED' });
      }}
      onTapPin={(pin) => {
        tapPin.put(pin);
        setTapStage('badge');
        send({ type: 'TAPPED' });
      }}
      onTapTimeout={() => {
        tapUid.clear();
        send({ type: 'TAP_TIMEOUT' });
      }}
      onPin={(pin) => {
        secret.put({ kind: 'PIN', pin });
        send({ type: 'SUBMIT' });
      }}
      onPassword={(loginName, password) => {
        secret.put({ kind: 'PASSWORD', loginName, password });
        send({ type: 'SUBMIT' });
      }}
      onSwitchPin={(pin) => {
        const uid = tapUid.peek();
        if (!uid || switching) return;
        setSwitching(true);
        setSwitchError(null);
        void ctl.switchTo(uid, pin).then((r) => {
          setSwitching(false);
          if (r.ok) {
            tapUid.clear();
            setTapStage('badge');
            send({ type: 'SWITCHED' });
          } else {
            setSwitchError(machines.refusalOfFailure(r.failure));
          }
        });
      }}
    />
  );
}
