/**
 * useSignedAction (module C4): Sign as performed, Verify, Dispose hold point, Sign off stage and QA
 * disposition of an exception go through the signature ceremony port (C1) as ENGINE_COMMAND actions. The
 * ceremony handles the tap, the PIN or password, the content review and a lost answer (it reloads the
 * signatures and reports NOT_CONFIRMED; credentials are never re-sent). This hook only asks for the signature
 * and puts the server's resulting view in place, while the person who signed is still the one signed in: the view
 * was computed for them, and an answer that arrives after a kiosk switch or lock is not the next person's to see
 * (then the step is read again; INV-40, DI-34).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { StepScreenView, type ManifestationView, type RefusalEnvelope, type SignedIntent } from '@ebmr/api-contract';
import { useSignatureCeremony } from '../../app/ports.tsx';
import { applyStepView, refreshRun } from './queries.ts';
import { useSignedInNow } from './session.tsx';

export interface SignedActionRequest {
  aggregateType: string;
  aggregateId: string;
  meaning: string;
  intent: SignedIntent;
  expectedVersion: number;
  title: string;
}

export type SignedActionResult =
  | { status: 'SIGNED'; manifestation: ManifestationView }
  | { status: 'REFUSED'; refusal: RefusalEnvelope }
  | { status: 'NOT_CONFIRMED' }
  | null;

export function useSignedAction(runId: string) {
  const ceremony = useSignatureCeremony();
  const qc = useQueryClient();
  const signedInNow = useSignedInNow();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SignedActionResult>(null);

  const sign = useCallback(
    async (req: SignedActionRequest) => {
      setBusy(true);
      setResult(null);
      try {
        const outcome = await ceremony.sign({
          aggregateType: req.aggregateType,
          aggregateId: req.aggregateId,
          meaning: req.meaning,
          title: req.title,
          action: { kind: 'ENGINE_COMMAND', runId, expectedVersion: req.expectedVersion, intent: req.intent },
        });
        switch (outcome.status) {
          case 'SIGNED': {
            const view = StepScreenView.safeParse(outcome.result);
            // The server's post-commit view, unless a newer one is on show or it is not the view of the person signed
            // in now (then the step is read again).
            const put = view.success ? await applyStepView(qc, view.data, signedInNow) : false;
            await refreshRun(qc, { steps: !put });
            setResult({ status: 'SIGNED', manifestation: outcome.manifestation });
            return;
          }
          case 'REFUSED':
            await refreshRun(qc, { steps: true });
            setResult({ status: 'REFUSED', refusal: outcome.refusal });
            return;
          case 'NOT_CONFIRMED':
            await refreshRun(qc, { steps: true });
            setResult({ status: 'NOT_CONFIRMED' });
            return;
          case 'CANCELLED':
            return;
        }
      } finally {
        setBusy(false);
      }
    },
    [ceremony, qc, runId, signedInNow],
  );

  return { sign, busy, result, clear: () => setResult(null) };
}
