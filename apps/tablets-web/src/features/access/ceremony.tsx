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
 *     the caller asks the new person for their own (INV-40, DI-38). The same holds whatever path signs another person
 *     in ("Switch user" on the lock screen, a switch the session poll finds) and when the session ends: the ceremony
 *     service ends the signing (index.tsx; Phase 2 exit review F39);
 *  4. secret: the PIN (kiosk) or user ID and password (office), within the 120 s countdown, sent once with a
 *     fresh device proof; a wrong one returns to the entry (the kernel counts it toward lockout);
 *  5. a lost answer never re-sends the credentials: the dialog reloads the record's signatures and reports
 *     SIGNED only when a matching signature is found, otherwise NOT_CONFIRMED.
 * A two-row act (D-P4-5, Phase 4 slice 4: the manufacturer and US release in one ceremony) names a companion record and
 * meaning: its content is loaded and checked against its hash too and shown with the first (meaning and title), a
 * challenge is opened for each (on a kiosk each with its own attribution from the one tap), and the credentials are
 * sent once with `companionChallengeId`; the server writes both rows in one command or neither.
 * Secrets live in refs until the request is built, then are wiped; they never enter machine context, React
 * state, query caches or storage.
 */
import { useCallback, useEffect, useState } from 'react';
import { useMachine } from '@xstate/react';
import { fromPromise } from 'xstate';
import { sha256Hex } from '@ebmr/expr';
import { routes, type DscSubmission, type RefusalEnvelope, type SignableContentView, type SignatureCredentials } from '@ebmr/api-contract';
import { identity, machines } from '@ebmr/ui-kit';
import { api, deviceProof } from '../../api/client.ts';
import { callWithDeadline, SEND_DEADLINE_MS } from '../../api/deadline.ts';
import { useBoot } from '../../app/boot.tsx';
import { secondsUntil } from '../../app/clock.ts';
import type { SignOutcome, SignRequest } from '../../app/ports.tsx';
import { buildAttribution, failureOf, frozenRequest, previewIntent } from './calls.ts';
import type { AccessController } from './controller.tsx';
import { dscBridge } from './dsc-bridge.ts';
import { Latest, Vault } from './holders.ts';
import type { Boot } from '../../app/boot.tsx';

export interface SignJob {
  id: number;
  request: SignRequest;
  kiosk: boolean;
  tapPin: boolean;
  /** The person who started the signing: the ceremony ends when another person is signed in (index.tsx; F39). */
  personId: string;
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
  // The companion's verified content and its open challenge (a two-row act only).
  const [companionContent] = useState(() => new Latest<SignableContentView | null>(null));
  const [companionChallenge] = useState(() => new Latest<string | null>(null));

  const [machine] = useState(() =>
      machines.ceremonyMachine.provide({
        actors: {
          loadContent: fromPromise(async () => {
            const r = await api.call(routes.esig.content, { query: { aggregateType: req.aggregateType, aggregateId: req.aggregateId, intent: previewIntent(req.meaning, req.action) } });
            if (!r.ok) throw callError(r.error);
            const comp = req.companion;
            if (!comp) return r.value;
            const c = await api.call(routes.esig.content, { query: { aggregateType: comp.aggregateType, aggregateId: comp.aggregateId, intent: comp.meaning } });
            if (!c.ok) throw callError(c.error);
            // The second text is checked as the first is (the machine checks the first): never challenged unverified.
            if (sha256Hex(c.value.canonicalText) !== c.value.contentHash) throw localError('the text of the second signature does not match its hash');
            companionContent.set(c.value);
            // Shown with the first: the signer sees both meanings before anything is challenged (display only; the
            // first text and its hash are unchanged).
            return { ...r.value, meaningText: `${r.value.meaningText} In the same ceremony you also sign ${c.value.title}: ${c.value.meaning}: ${c.value.meaningText}` };
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
            const cc = companionContent.get();
            const companionBody = cc
              ? { aggregateType: cc.aggregateType, aggregateId: cc.aggregateId, contentVersion: cc.contentVersion, meaning: cc.meaning, clientContentHash: sha256Hex(cc.canonicalText), action: req.action }
              : null;
            let attribution;
            let companionAttribution;
            if (job.kiosk) {
              const uid = tapUid.peek();
              const pin = tapPin.take();
              const key = latestBoot.get().deviceKey;
              if (!uid || !key) throw localError('no badge was tapped');
              const built = await buildAttribution(key, uid, pin ?? undefined, { method: 'POST', path: '/api/esig/challenges', body });
              if (!built.ok) {
                tapUid.clear();
                throw machines.ceremonyError(built.failure);
              }
              attribution = built.value;
              if (companionBody) {
                // The same tap confirms the second challenge, with a proof over its own request.
                const second = await buildAttribution(key, uid, pin ?? undefined, { method: 'POST', path: '/api/esig/challenges', body: companionBody });
                if (!second.ok) {
                  tapUid.clear();
                  throw machines.ceremonyError(second.failure);
                }
                companionAttribution = second.value;
              }
            }
            const r = await api.call(routes.esig.createChallenge, { body, ...(attribution ? { attribution } : {}) });
            if (!r.ok) {
              const f = failureOf(r.error);
              // Another person's badge: kept (only) for the "Switch to <name>?" PIN step.
              if (!(f.kind === 'REFUSAL' && f.envelope.refusal.kind === 'SWITCH_USER')) tapUid.clear();
              throw machines.ceremonyError(f);
            }
            tapUid.clear();
            companionChallenge.set(null);
            if (companionBody) {
              const c = await api.call(routes.esig.createChallenge, { body: companionBody, ...(companionAttribution ? { attribution: companionAttribution } : {}) });
              if (!c.ok) throw callError(c.error);
              companionChallenge.set(c.value.challengeId);
            }
            return r.value;
          }),
          sign: fromPromise(async ({ input }) => {
            const credentials = secret.take();
            const key = latestBoot.get().deviceKey;
            if (!credentials || !key) throw localError('no credentials were entered');
            const second = companionChallenge.get();
            // IN-10 (D-P6f-3): the signer's Class 3 token signs the challenge's statement through the local signing bridge.
            let dsc: DscSubmission | undefined;
            if (input.challenge.dsc) {
              try {
                dsc = await dscBridge().sign(input.challenge.dsc.statement);
              } catch (error) {
                throw localError(`the digital signature token did not sign (${error instanceof Error ? error.message : String(error)}); nothing was sent`);
              }
            }
            const body = { challengeId: input.challenge.challengeId, credentials, action: req.action, ...(second ? { companionChallengeId: second } : {}), ...(dsc ? { dsc } : {}) };
            const proof = await deviceProof(key, 'POST', '/api/esig/sign', body);
            // No proof: nothing was sent, so the answer is a refusal, never a lost answer to reconcile (F08).
            if (!proof.ok) throw callError(proof.error);
            // No answer within the deadline: aborted and lost, so the signatures are read again (reconcile), never the
            // credentials sent again; nor "Signing..." without end, where EXPIRE and CANCEL wait for the answer (F60).
            const r = await callWithDeadline(SEND_DEADLINE_MS, (signal) => api.call(routes.esig.sign, { body: { ...body, proof: proof.proof }, signal }));
            if (!r.ok) throw callError(r.error);
            return r.value;
          }),
          reconcile: fromPromise(async ({ input }) => {
            const r = await callWithDeadline(SEND_DEADLINE_MS, (signal) => api.call(routes.esig.signatures, { query: { aggregateType: req.aggregateType, aggregateId: req.aggregateId }, signal }));
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
  // Ended from outside (another person signed in, the session ended: index.tsx, F39): nothing of the previous person's
  // badge, PIN or secret outlives the dialog.
  useEffect(
    () => () => {
      tapUid.clear();
      tapPin.clear();
      secret.clear();
    },
    [tapUid, tapPin, secret],
  );

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
