/**
 * Reagent and buffer lots (slice 7g-5, decision 0025; PR-29; routes plantRules.reagentLots, recordReagentLot,
 * withdrawReagentLot, recordReagentUse): the reagent, buffer, volumetric-solution and standard lots with their expiry and
 * state now; QC records a lot with its preparation and expiry and withdraws one early with the reason; at an in-process
 * control the operator records the lot the step used, and the database refuses an expired, withdrawn or unknown lot.
 */
import { useState } from 'react';
import { routes, type ReagentLotView } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { words } from './reads.ts';

const LOT = /^[A-Z0-9][A-Z0-9/._-]{0,39}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const KINDS = ['REAGENT', 'BUFFER', 'VOLUMETRIC_SOLUTION', 'STANDARD'] as const;
const READS: readonly string[] = [routes.plantRules.reagentLots.id];

export function ReagentLotsPage() {
  const q = useApiQuery(routes.plantRules.reagentLots);
  const qc = useOffered('QC');
  const floorRole = useOffered('PRODUCTION_FLOOR');
  return (
    <>
      <h1>Reagent and buffer lots</h1>
      <p>A lot is used at an in-process control only while it is in date and not withdrawn; the database checks it at the moment of use.</p>
      <Section title="Lots" testId="reagent-lots">
        {q.error ? <RefusalMessage error={q.error.error} /> : null}
        {q.data && q.data.lots.length === 0 ? <p>No lot is recorded.</p> : null}
        <ul>
          {q.data?.lots.map((l) => (
            <Lot key={l.lotCode} l={l} qc={qc} />
          ))}
        </ul>
      </Section>
      {qc ? <RecordLot /> : null}
      {floorRole || qc ? <RecordUse /> : null}
    </>
  );
}

function Lot({ l, qc }: { l: ReagentLotView; qc: boolean }) {
  const withdraw = useCommand(routes.plantRules.withdrawReagentLot, READS, 'the withdrawal of the lot');
  const [reason, setReason] = useState('');
  return (
    <li data-testid={`reagent-lot-${l.lotCode}`} data-state={l.state}>
      <strong>{l.lotCode}</strong> {words(l.kind)} {l.reagentCode} {l.name}
      {l.nominal ? ` (${l.nominal})` : ''}: prepared {l.preparedAt.text}, expires {l.expiresAt.text}{' '}
      <StatusChip tone={l.state === 'IN_DATE' ? 'ok' : 'error'} label={words(l.state)} />
      {l.withdrawalReason ? ` Withdrawn: ${l.withdrawalReason}.` : ''}
      {qc && l.state === 'IN_DATE' ? (
        <>
          <Field name={`withdraw-${l.lotCode}`} label={`Reason to withdraw ${l.lotCode}`} value={reason} onChange={setReason} />
          <ActButton primary={false} label={`Withdraw ${l.lotCode}`} disabled={reason.trim() === '' || withdraw.busy} onPress={() => withdraw.run({ params: { lotCode: l.lotCode }, body: { reason: reason.trim() } })} />
          <ActResult error={withdraw.error} done={withdraw.done} label="Withdrawn." />
        </>
      ) : null}
    </li>
  );
}

function RecordLot() {
  const record = useCommand(routes.plantRules.recordReagentLot, READS, 'the record of the lot');
  const [lot, setLot] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('REAGENT');
  const [reagent, setReagent] = useState('');
  const [name, setName] = useState('');
  const [nominal, setNominal] = useState('');
  const [prepared, setPrepared] = useState('');
  const [expires, setExpires] = useState('');
  const ok = LOT.test(lot.trim()) && LOT.test(reagent.trim()) && name.trim() !== '' && ISO_INSTANT.test(prepared.trim()) && ISO_INSTANT.test(expires.trim());
  return (
    <Section title="Record a lot" testId="reagent-lot-record">
      <Field name="rlLot" label="Lot code" value={lot} onChange={setLot} />
      <floor.ChoiceGroup label="Kind" options={KINDS.map((k) => ({ value: k, label: words(k) }))} value={kind} onChange={(v) => setKind(KINDS.find((k) => k === v) ?? 'REAGENT')} />
      <Field name="rlReagent" label="Reagent code" value={reagent} onChange={setReagent} />
      <Field name="rlName" label="Name" value={name} onChange={setName} />
      <Field name="rlNominal" label="Nominal strength (optional, e.g. 0.1 M)" value={nominal} onChange={setNominal} />
      <Field name="rlPrepared" label="Prepared at (e.g. 2026-10-18T09:00:00+05:30)" value={prepared} onChange={setPrepared} />
      <Field name="rlExpires" label="Expires at (e.g. 2026-11-18T09:00:00+05:30)" value={expires} onChange={setExpires} />
      <ActButton
        label="Record the lot"
        disabled={!ok || record.busy}
        onPress={() =>
          ok
            ? record.run({
                body: { lotCode: lot.trim(), kind, reagentCode: reagent.trim(), name: name.trim(), ...(nominal.trim() ? { nominal: nominal.trim() } : {}), preparedAt: prepared.trim(), expiresAt: expires.trim() },
              })
            : null
        }
      />
      <ActResult error={record.error} done={record.done} label="The lot is recorded." />
    </Section>
  );
}

function RecordUse() {
  const batches = useApiQuery(routes.batches.list);
  const use = useCommand(routes.plantRules.recordReagentUse, READS, 'the use of the lot');
  const [batchId, setBatchId] = useState('');
  const [step, setStep] = useState('');
  const [lot, setLot] = useState('');
  const [purpose, setPurpose] = useState('');
  const ok = batchId !== '' && step.trim() !== '' && LOT.test(lot.trim()) && purpose.trim() !== '';
  return (
    <Section title="Record the lot an in-process control used" testId="reagent-use">
      {batches.error ? <RefusalMessage error={batches.error.error} /> : null}
      <floor.ChoiceGroup label="Batch" options={(batches.data?.batches ?? []).map((b) => ({ value: b.runId, label: `${b.batchNumber} (${b.statusText})` }))} value={batchId} onChange={setBatchId} />
      <Field name="ruStep" label="Step (its key, e.g. p-ipc-1@)" value={step} onChange={setStep} />
      <Field name="ruLot" label="Lot code" value={lot} onChange={setLot} />
      <Field name="ruPurpose" label="Purpose (e.g. pH meter calibration buffer)" value={purpose} onChange={setPurpose} />
      <ActButton label="Record the use" disabled={!ok || use.busy} onPress={() => (ok ? use.run({ body: { batchId, step: step.trim(), lotCode: lot.trim(), purpose: purpose.trim() } }) : null)} />
      <ActResult error={use.error} done={use.done} label="The use is recorded." />
    </Section>
  );
}
