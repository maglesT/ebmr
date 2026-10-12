/**
 * The correction of a recorded value (Phase 4 slice 1a and 1c; outline 5.2.3, DI-24, S25): the signed intent
 * CORRECT_ENTRY names the data point, the corrected value, the person's own reason, and when the rules ask for them the
 * evidence document (its SHA-256: a device raw file, a printout or a photo) and the approval (the approver's
 * CORRECTION_APPROVED signature on the point, signable action CORRECTION_APPROVAL, given first through the ceremony).
 * The original value stays in the record. What each signature signs (aggregate, meaning) is the server's
 * (esig.describe); the engine and the database decide whether evidence or an approval is needed and refuse otherwise,
 * in their own words.
 */
import { useState } from 'react';
import { type DataValueWire, type SignableAction, type SignedIntent, type StepScreenView } from '@ebmr/api-contract';
import { Banner, Button, decimalProblem, Field, floor } from '@ebmr/ui-kit';
import { describeSignable } from '../../../api/signables.ts';
import { useSignatureCeremony } from '../../../app/ports.tsx';
import { RefusalMessage } from '../../../app/refusal.tsx';
import { wcls } from '../classes.ts';
import { useSessionChange } from '../session.tsx';
import { st } from '../text.ts';
import type { useSignedAction } from '../useSignedAction.ts';
import { CommandDialog } from './CommandDialog.tsx';

type Signed = ReturnType<typeof useSignedAction>;
type CallErr = Parameters<typeof RefusalMessage>[0]['error'];
type EvidenceKind = 'DEVICE_RAW' | 'PRINTOUT' | 'PHOTO';

export interface Correctable {
  point: string;
  label: string;
  value: DataValueWire;
}

/** Valid recorded values of the step that a correction can name (a value of a kind the dialog can take). */
export function correctableAttempts(view: StepScreenView): Correctable[] {
  return view.fields.flatMap((f) =>
    f.attempts
      .filter((a) => a.status === 'VALID' && a.value !== null && ['DECIMAL', 'COUNT', 'TEXT', 'CATEGORY', 'BOOLEAN'].includes(a.value.kind))
      .map((a) => ({ point: a.pointId, label: `${f.name}: ${a.echo} (attempt ${a.attempt}, ${floor.personLine(a.by)}, ${a.at.text})`, value: a.value as DataValueWire })),
  );
}

/** The corrected value in the original value's kind, or a problem; text as typed, never a JavaScript number. */
export function correctedValue(original: DataValueWire, text: string): { value: DataValueWire | null; problem: string | null } {
  const t = text.trim();
  if (t === '') return { value: null, problem: null };
  switch (original.kind) {
    case 'DECIMAL': {
      const p = decimalProblem(t, { allowNegative: true });
      return p ? { value: null, problem: p } : { value: { kind: 'DECIMAL', value: t, unit: original.unit }, problem: null };
    }
    case 'COUNT':
      return /^(0|[1-9][0-9]*)$/.test(t) ? { value: { kind: 'COUNT', value: t }, problem: null } : { value: null, problem: 'a whole number is needed' };
    case 'TEXT':
      return { value: { kind: 'TEXT', value: t }, problem: null };
    case 'CATEGORY':
      return { value: { kind: 'CATEGORY', value: t }, problem: null };
    case 'BOOLEAN':
      return t === 'YES' || t === 'NO' ? { value: { kind: 'BOOLEAN', value: t === 'YES' }, problem: null } : { value: null, problem: 'choose yes or no' };
    default:
      return { value: null, problem: 'this kind of value is not corrected here' };
  }
}

async function sha256File(file: File): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function CorrectEntryDialog({ isOpen, onClose, view, signed }: { isOpen: boolean; onClose: () => void; view: StepScreenView; signed: Signed }) {
  return (
    <CommandDialog title={st('correct.title')} isOpen={isOpen}>
      <CorrectEntryForm onClose={onClose} view={view} signed={signed} />
    </CommandDialog>
  );
}

function CorrectEntryForm({ onClose, view, signed }: { onClose: () => void; view: StepScreenView; signed: Signed }) {
  const attempts = correctableAttempts(view);
  const ceremony = useSignatureCeremony();
  const [choice, setChoice] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [evidenceKind, setEvidenceKind] = useState<EvidenceKind | 'NONE'>('NONE');
  const [hash, setHash] = useState<string | null>(null);
  const [approval, setApproval] = useState<{ signatureId: string; name: string; at: string } | null>(null);
  const [error, setError] = useState<CallErr | null>(null);
  const [busy, setBusy] = useState(false);
  const reset = () => {
    setChoice(null);
    setText('');
    setReason('');
    setEvidenceKind('NONE');
    setHash(null);
    setApproval(null);
    setError(null);
  };
  useSessionChange(reset);
  const chosen = attempts.find((a) => a.point === choice) ?? null;
  const corrected = chosen ? correctedValue(chosen.value, text) : { value: null, problem: null };
  const why = reason.trim();
  const shown = chosen && corrected.value ? floor.valueText(corrected.value, '') : '';
  const intent: SignedIntent | null =
    chosen && corrected.value && why !== '' && (evidenceKind === 'NONE' || hash !== null)
      ? {
          type: 'CORRECT_ENTRY',
          point: chosen.point,
          value: corrected.value,
          reason: why,
          ...(evidenceKind !== 'NONE' && hash ? { evidence: { kind: evidenceKind, sha256: hash } } : {}),
          ...(approval ? { approvalSignatureId: approval.signatureId } : {}),
        }
      : null;

  // The approval is the approver's own signature on the point (CORRECTION_APPROVAL), given before the correction.
  const approve = async () => {
    if (!chosen || !corrected.value || why === '') return;
    setBusy(true);
    setError(null);
    try {
      const action: SignableAction = { kind: 'CORRECTION_APPROVAL', batchId: view.run.runId, point: chosen.point };
      const described = await describeSignable(action);
      if (!described.ok) return setError(described.error);
      const o = await ceremony.sign({ ...described.subject, action, title: st('correct.approveTitle', { item: chosen.label, value: shown, reason: why }) });
      if (o.status === 'SIGNED') setApproval({ signatureId: o.manifestation.signatureId, name: o.manifestation.signer.legalName, at: o.manifestation.signedAt.text });
      if (o.status === 'REFUSED') setError({ kind: 'REFUSAL', status: 409, envelope: o.refusal });
    } finally {
      setBusy(false);
    }
  };
  const sign = async () => {
    if (!intent || !chosen) return;
    setBusy(true);
    setError(null);
    try {
      const described = await describeSignable({ kind: 'ENGINE_COMMAND', runId: view.run.runId, expectedVersion: view.run.version, intent });
      if (!described.ok) return setError(described.error);
      onClose();
      await signed.sign({ ...described.subject, intent, expectedVersion: view.run.version, title: st('correct.signTitle', { item: chosen.label, value: shown, reason: why }) });
    } finally {
      setBusy(false);
    }
  };

  if (attempts.length === 0) {
    return (
      <div className={wcls('dialogBody')}>
        <p>{st('correct.none')}</p>
        <Button onPress={onClose}>{st('correct.close')}</Button>
      </div>
    );
  }
  const locked = approval !== null;
  return (
    <div className={wcls('dialogBody')} data-testid="correct-entry">
      <p>{st('correct.intro')}</p>
      <floor.ChoiceGroup label={st('correct.attempt')} options={attempts.map((a) => ({ value: a.point, label: a.label }))} value={choice} onChange={setChoice} isDisabled={locked} />
      {chosen?.value.kind === 'BOOLEAN' ? (
        <floor.ChoiceGroup
          label={st('correct.value')}
          options={[
            { value: 'YES', label: 'Yes' },
            { value: 'NO', label: 'No' },
          ]}
          value={text === '' ? null : text}
          onChange={setText}
          isDisabled={locked}
        />
      ) : (
        <Field
          name="correct-value"
          label={chosen?.value.kind === 'DECIMAL' ? `${st('correct.value')} (${chosen.value.unit})` : st('correct.value')}
          value={text}
          onChange={setText}
          isDisabled={locked || chosen === null}
          autoComplete="off"
          {...(corrected.problem ? { errorMessage: corrected.problem } : {})}
        />
      )}
      <Field name="correct-reason" label={st('correct.reason')} value={reason} onChange={setReason} isDisabled={locked} autoComplete="off" isRequired />
      <floor.ChoiceGroup
        label={st('correct.evidenceKind')}
        options={[
          { value: 'NONE', label: st('correct.evidenceNone') },
          { value: 'DEVICE_RAW', label: 'Device raw data' },
          { value: 'PRINTOUT', label: 'Printout' },
          { value: 'PHOTO', label: 'Photo' },
        ]}
        value={evidenceKind}
        onChange={(v) => {
          setEvidenceKind(v === 'DEVICE_RAW' || v === 'PRINTOUT' || v === 'PHOTO' ? v : 'NONE');
          setHash(null);
        }}
        isDisabled={locked}
      />
      {evidenceKind !== 'NONE' ? (
        <label className={wcls('section')}>
          {st('correct.evidenceFile')}{' '}
          <input
            type="file"
            disabled={locked}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void sha256File(f).then(setHash);
            }}
          />
        </label>
      ) : null}
      {hash ? <p data-testid="evidence-hash">{st('correct.evidenceHash', { hash })}</p> : null}
      {approval ? (
        <Banner tone="info" title={st('correct.approved', { name: approval.name, at: approval.at })} />
      ) : (
        <Button onPress={() => void approve()} isDisabled={!chosen || !corrected.value || why === '' || busy}>
          {st('correct.approve')}
        </Button>
      )}
      {error ? <RefusalMessage error={error} /> : null}
      <div className={wcls('row')}>
        <Button onPress={onClose} isDisabled={busy}>
          {st('correct.close')}
        </Button>
        <Button variant="primary" onPress={() => void sign()} isDisabled={intent === null || busy}>
          {st('correct.sign')}
        </Button>
      </div>
    </div>
  );
}
