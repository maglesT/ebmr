/**
 * The void of an attempt (Phase 3 slice 6; DI-24, DI-29): the only way an entry leaves the record's valid values. The
 * attempt stays in the record, marked void with the person's own reason; there is no delete anywhere on the floor and
 * no route that deletes one.
 *
 * On GMP the void is first proposed as an act (POST /api/batches/:batchId/acts), QA approves it with its signature on
 * the act (signable ACT_APPROVAL, meaning from the proposal, by a person other than the requester; S28), and the void is
 * then sent as a plain command naming the approval. On the sandbox the void is sent as a command and the server decides
 * whether it needs more. The form is mounted only while the dialog is open and is emptied on a session change.
 */
import { useState } from 'react';
import { routes, type ClientIntent, type ProposedActView, type StepScreenView } from '@ebmr/api-contract';
import { Banner, Button, Field, floor } from '@ebmr/ui-kit';
import { api } from '../../../api/client.ts';
import { RefusalMessage } from '../../../app/refusal.tsx';
import { useSignatureCeremony } from '../../../app/ports.tsx';
import { wcls } from '../classes.ts';
import { isGmpFloor } from '../family.ts';
import { useSessionChange } from '../session.tsx';
import { st } from '../text.ts';
import { CommandBody, CommandDialog } from './CommandDialog.tsx';
import { describeSignable } from '../../../api/signables.ts';

/** The batch state version an act was proposed at (`<batch>:act@<version>:<hash>`): the void is sent at that version. */
export function actVersion(actId: string): number | null {
  const m = /:act@([0-9]{1,10}):/.exec(actId);
  return m?.[1] !== undefined ? Number(m[1]) : null;
}

/** Recorded attempts of the step that can be named in a void (valid ones only). */
export function voidableAttempts(view: StepScreenView): { item: string; point: string; label: string }[] {
  return view.fields.flatMap((f) =>
    f.attempts.filter((a) => a.status === 'VALID').map((a) => ({ item: f.item, point: a.pointId, label: `${f.name}: ${a.echo} (attempt ${a.attempt}, ${floor.personLine(a.by)}, ${a.at.text})` })),
  );
}

export function VoidAttemptDialog({ isOpen, onClose, view }: { isOpen: boolean; onClose: () => void; view: StepScreenView }) {
  return (
    <CommandDialog title={st('void.title')} isOpen={isOpen}>
      <VoidAttemptForm onClose={onClose} view={view} />
    </CommandDialog>
  );
}

type CallErr = Parameters<typeof RefusalMessage>[0]['error'];

function VoidAttemptForm({ onClose, view }: { onClose: () => void; view: StepScreenView }) {
  const attempts = voidableAttempts(view);
  const ceremony = useSignatureCeremony();
  const gmp = isGmpFloor();
  const [choice, setChoice] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [act, setAct] = useState<ProposedActView | null>(null);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState<CallErr | null>(null);
  const [busy, setBusy] = useState(false);
  useSessionChange(() => {
    setChoice(null);
    setReason('');
    setAct(null);
    setApproved(false);
    setError(null);
  });
  const chosen = attempts.find((a) => a.point === choice) ?? null;
  const reasonGiven = reason.trim().length > 0;
  const base = chosen && reasonGiven ? { type: 'VOID_ATTEMPT' as const, stepKey: view.step.stepKey, item: chosen.item, point: chosen.point, reason: reason.trim() } : null;
  const intent: ClientIntent | null = base ? (gmp ? (act && approved ? { ...base, approvalActId: act.actId } : null) : base) : null;

  const propose = async () => {
    if (!base) return;
    setBusy(true);
    setError(null);
    try {
      const { type, stepKey, item, point, reason: why } = base;
      const r = await api.call(routes.batches.proposeAct, { params: { batchId: view.run.runId }, body: { intent: { type, stepKey, item, point, reason: why } } });
      if (r.ok) setAct(r.value);
      else setError(r.error);
    } finally {
      setBusy(false);
    }
  };
  const approve = async () => {
    if (!act || !base) return;
    const action = { kind: 'ACT_APPROVAL' as const, batchId: act.batchId, actId: act.actId };
    const described = await describeSignable(action);
    if (!described.ok) {
      setError(described.error);
      return;
    }
    const o = await ceremony.sign({ ...described.subject, action, title: st('void.signTitle', { item: chosen?.label ?? base.item, reason: base.reason }) });
    if (o.status === 'SIGNED') setApproved(true);
    if (o.status === 'REFUSED') setError({ kind: 'REFUSAL', status: 409, envelope: o.refusal });
  };

  if (attempts.length === 0) {
    return (
      <div className={wcls('dialogBody')}>
        <p>{st('void.none')}</p>
        <Button onPress={onClose}>{st('void.cancel')}</Button>
      </div>
    );
  }
  const locked = act !== null;
  return (
    <CommandBody onClose={onClose} runId={view.run.runId} viewStepKey={view.step.stepKey} reason={st('void.tap')} intent={intent} expectedVersion={act ? actVersion(act.actId) ?? view.run.version : view.run.version} view={view} draft={choice !== null || reason !== ''}>
      <p>{st('void.intro')}</p>
      <floor.ChoiceGroup label={st('void.attempt')} options={attempts.map((a) => ({ value: a.point, label: a.label }))} value={choice} onChange={setChoice} isDisabled={locked} />
      <Field name="void-reason" label={st('void.reason')} value={reason} onChange={setReason} isDisabled={locked} autoComplete="off" isRequired />
      {gmp ? (
        <div className={wcls('section')}>
          {act ? <Banner tone="info" title={st('void.proposed', { name: floor.personLine(act.proposedBy), meaning: act.meaning })} /> : null}
          {!act ? (
            <Button onPress={() => void propose()} isDisabled={!base || busy}>
              {st('void.propose')}
            </Button>
          ) : !approved ? (
            <Button onPress={() => void approve()}>{st('void.approve')}</Button>
          ) : (
            <p>{st('void.approved')}</p>
          )}
        </div>
      ) : null}
      {error ? <RefusalMessage error={error} /> : null}
    </CommandBody>
  );
}
