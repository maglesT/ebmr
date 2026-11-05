/**
 * The completion evidence of a packaging order (Phase 6 slice 6c; IN-16, PR-16, PR-34, PR-36, PR-39): for each
 * printed-materials step, the start, middle and end coding specimens (the operator types what the specimen shows; the
 * database compares it with the record's coding, which the capture form does not show so it is read off the specimen,
 * not copied), a label specimen of each printed item, the line stops a vision
 * rejection opened (QA resolves them), the reconciliation waiver (QA, with a qualifying device); then the post-use
 * inspection of the line, verified by a second person. The gap that blocks the step's close or the order's completion
 * is the database's words.
 */
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { routes, type PackagingCompletionView } from '@ebmr/api-contract';
import { Banner, Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { useRouteParams } from '../floor/params.ts';
import { LABEL_READS, words } from './reads.ts';
import { useScreensOff } from '../../app/disconnected.tsx';

type Step = PackagingCompletionView['steps'][number];
const POSITIONS = ['START', 'MIDDLE', 'END'] as const;
const CHECKS = [
  ['noPrintedMaterial', 'No printed material of the order is left on the line'],
  ['noProduct', 'No product of the order is left on the line'],
  ['noDocuments', 'No documents of the order are left on the line'],
  ['lineClean', 'The line is clean'],
] as const;
type CheckKey = (typeof CHECKS)[number][0];

export function PackagingCompletionPage() {
  const off = useScreensOff();
  const batchId = useRouteParams()['batchId'] ?? '';
  const q = useApiQuery(routes.labels.packaging, { params: { batchId } });
  if (q.error) return <RefusalMessage error={q.error.error} />;
  if (!q.data) return <p>Loading the packaging order.</p>;
  const v = q.data;
  return (
    <>
      <h1>Packaging completion of {v.batchNumber}</h1>
      <p>
        <Link to="/planning/packaging/$batchId" params={{ batchId: v.batchId }}>The packaging order and its bulk</Link>
        {off('/serialisation') ? null : (
          <>
            {' '}
            · <Link to="/serialisation/batches/$batchId" params={{ batchId: v.batchId }}>Serial pools of {v.batchNumber}</Link>
          </>
        )}
      </p>
      {v.completionProblem ? (
        <Banner tone="warning" title={`The order cannot complete yet: ${v.completionProblem}`} />
      ) : (
        <Banner tone="ok" title="Nothing on this page blocks the order's completion." />
      )}
      <div data-testid="packaging-completion-problem" hidden>{v.completionProblem ?? ''}</div>
      {v.steps.map((s) => (
        <StepPanel key={s.stepKey} batchId={v.batchId} s={s} />
      ))}
      <LineStops v={v} />
      <Inspection v={v} />
    </>
  );
}

function StepPanel({ batchId, s }: { batchId: string; s: Step }) {
  const floorActs = useOffered('PRODUCTION_FLOOR');
  const qa = useOffered('QA');
  const running = s.status === 'IN_PROGRESS';
  const recorded = new Set(s.codingSpecimens.map((c) => c.position));
  const next = POSITIONS.find((p) => !recorded.has(p)) ?? null;
  return (
    <Section title={`Printed materials: step ${s.stepText ?? s.stepKey}`} testId={`packaging-step-${s.stepKey}`}>
      <p>
        Status: {words(s.status)}.{' '}
        {s.problem ? <StatusChip tone="warning" label={s.problem} /> : <StatusChip tone="ok" label="Specimens complete" />}
      </p>
      {s.coding ? (
        <>
          <h3>Coding specimens</h3>
          <p data-testid="packaging-coding-hint">
            {s.expectedCoding
              ? 'Type exactly what each specimen shows: the system compares it with the record\'s coding and refuses a specimen that differs.'
              : 'The record gives no coding for this step yet: record the batch data first.'}
          </p>
          <ul>
            {s.codingSpecimens.map((c) => (
              <li key={c.specimenId} data-testid={`coding-specimen-${c.position}`}>
                {words(c.position)}: {c.coded.batch}, {c.coded.mfgDate}, {c.coded.expiryDate} by {c.by}
                <Withdraw specimenId={c.specimenId} disabled={!running || !floorActs} />
              </li>
            ))}
          </ul>
          {running && floorActs && next ? <CodingForm batchId={batchId} stepKey={s.stepKey} position={next} /> : null}
        </>
      ) : null}
      <h3>Label specimens</h3>
      <ul>
        {s.items.map((item) => {
          const sp = s.labelSpecimens.find((l) => l.item === item);
          return (
            <li key={item} data-testid={`label-specimen-${item}`}>
              {item}: {sp ? `attached by ${sp.by}${sp.note ? ` (${sp.note})` : ''}` : 'missing'}
              {sp ? <Withdraw specimenId={sp.specimenId} disabled={!running || !floorActs} /> : running && floorActs ? <LabelForm batchId={batchId} stepKey={s.stepKey} item={item} /> : null}
            </li>
          );
        })}
      </ul>
      {s.waivers.length > 0 ? (
        <p data-testid="packaging-waivers">
          Reconciliation waivers (the reconciliation still runs): {s.waivers.map((w) => `${w.item} with ${w.device} by ${w.by}`).join('; ')}
        </p>
      ) : null}
      {qa && running ? <WaiverForm batchId={batchId} stepKey={s.stepKey} items={s.items} /> : null}
    </Section>
  );
}

function CodingForm({ batchId, stepKey, position }: { batchId: string; stepKey: string; position: (typeof POSITIONS)[number] }) {
  const record = useCommand(routes.labels.recordCodingSpecimen, LABEL_READS, 'the coding specimen');
  const [batch, setBatch] = useState('');
  const [mfg, setMfg] = useState('');
  const [exp, setExp] = useState('');
  const [mrp, setMrp] = useState('');
  const ok = batch.trim() !== '' && /^\d{4}-\d{2}-\d{2}$/.test(mfg.trim()) && /^\d{4}-(0[1-9]|1[0-2])$/.test(exp.trim()) && (mrp.trim() === '' || /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$/.test(mrp.trim()));
  return (
    <div data-testid="coding-specimen-form">
      <p>Read the {words(position).toLowerCase()} specimen and type what it shows.</p>
      <Field name="codedBatch" label="Batch number on the specimen" value={batch} onChange={setBatch} />
      <Field name="codedMfg" label="Manufacture date on the specimen (YYYY-MM-DD)" value={mfg} onChange={setMfg} />
      <Field name="codedExp" label="Expiry on the specimen (YYYY-MM)" value={exp} onChange={setExp} />
      <Field name="codedMrp" label="MRP on the specimen (if printed)" value={mrp} onChange={setMrp} />
      <ActButton
        label={`Record the ${words(position).toLowerCase()} specimen`}
        onPress={() => (ok ? record.run({ params: { batchId, stepKey }, body: { position, coded: { batch: batch.trim(), mfgDate: mfg.trim(), expiryDate: exp.trim(), ...(mrp.trim() ? { mrp: mrp.trim() } : {}) } } }) : undefined)}
        disabled={!ok || record.busy}
      />
      <ActResult error={record.error} done={record.done} label="The specimen is recorded." />
    </div>
  );
}

function LabelForm({ batchId, stepKey, item }: { batchId: string; stepKey: string; item: string }) {
  const record = useCommand(routes.labels.recordLabelSpecimen, LABEL_READS, 'the label specimen');
  return (
    <>
      <ActButton label={`Attach the ${item} specimen`} onPress={() => record.run({ params: { batchId, stepKey }, body: { item } })} disabled={record.busy} />
      <ActResult error={record.error} done={record.done} label="The specimen is attached." />
    </>
  );
}

function Withdraw({ specimenId, disabled }: { specimenId: string; disabled: boolean }) {
  const withdraw = useCommand(routes.labels.voidSpecimen, LABEL_READS, 'the withdrawal');
  const [reason, setReason] = useState('');
  if (disabled) return null;
  return (
    <span>
      <Field name={`void-${specimenId}`} label="Reason to withdraw" value={reason} onChange={setReason} />
      <ActButton label="Withdraw" primary={false} onPress={() => (reason.trim() ? withdraw.run({ params: { specimenId }, body: { reason: reason.trim() } }) : undefined)} disabled={reason.trim() === '' || withdraw.busy} />
      <ActResult error={withdraw.error} done={withdraw.done} label="Withdrawn." />
    </span>
  );
}

function WaiverForm({ batchId, stepKey, items }: { batchId: string; stepKey: string; items: readonly string[] }) {
  const enable = useCommand(routes.labels.enableWaiver, LABEL_READS, 'the waiver');
  const [item, setItem] = useState<string | null>(null);
  const [device, setDevice] = useState('');
  return (
    <div data-testid="waiver-form">
      <h3>Reconciliation waiver (100 % electronic inspection)</h3>
      <floor.ChoiceGroup label="Printed item" options={items.map((i) => ({ value: i, label: i }))} value={item} onChange={setItem} />
      <Field name="waiverDevice" label="Inspection device of the step" value={device} onChange={(v) => setDevice(v.toUpperCase())} />
      <ActButton label="Record the waiver" onPress={() => (item && device ? enable.run({ params: { batchId, stepKey }, body: { item, device } }) : undefined)} disabled={!item || device === '' || enable.busy} />
      <ActResult error={enable.error} done={enable.done} label="The waiver is recorded; the reconciliation still runs." />
    </div>
  );
}

function LineStops({ v }: { v: PackagingCompletionView }) {
  const qa = useOffered('QA');
  if (v.lineStops.length === 0) return null;
  return (
    <Section title="Line stops" testId="line-stops">
      <ul>
        {v.lineStops.map((s) => (
          <li key={s.stopId} data-testid={`line-stop-${s.stopId}`} data-open={String(s.resolvedBy === null)}>
            {words(s.cause)} on job {s.jobId} ({s.stepKey}) at {s.openedAt}:{' '}
            {s.resolvedBy ? `resolved by ${s.resolvedBy}: ${s.resolution ?? ''}` : <StatusChip tone="error" label="Line stopped" />}
            {!s.resolvedBy && qa ? <Resolve stopId={s.stopId} /> : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Resolve({ stopId }: { stopId: string }) {
  const resolve = useCommand(routes.labels.resolveLineStop, LABEL_READS, 'the resolution');
  const [reason, setReason] = useState('');
  return (
    <span>
      <Field name={`resolve-${stopId}`} label="What was found and corrected" value={reason} onChange={setReason} />
      <ActButton label="Resolve the line stop" onPress={() => (reason.trim() ? resolve.run({ params: { stopId }, body: { reason: reason.trim() } }) : undefined)} disabled={reason.trim() === '' || resolve.busy} />
      <ActResult error={resolve.error} done={resolve.done} label="The line stop is resolved." />
    </span>
  );
}

function Inspection({ v }: { v: PackagingCompletionView }) {
  const floorActs = useOffered('PRODUCTION_FLOOR');
  const record = useCommand(routes.labels.recordPostUseInspection, LABEL_READS, 'the post-use inspection');
  const verify = useCommand(routes.labels.verifyPostUseInspection, LABEL_READS, 'the verification');
  const [checks, setChecks] = useState<Record<CheckKey, boolean | null>>({ noPrintedMaterial: null, noProduct: null, noDocuments: null, lineClean: null });
  const latest = v.inspections.at(-1);
  const answered = CHECKS.every(([k]) => checks[k] !== null);
  return (
    <Section title="Post-use inspection of the line" testId="post-use-inspection">
      {v.inspections.map((i) => (
        <p key={i.inspectionId} data-testid={`inspection-${i.inspectionId}`} data-result={i.result}>
          {i.result === 'PASS' ? 'Passed' : 'Failed'}, by {i.by}, {i.verifiedBy ? `verified by ${i.verifiedBy}` : 'not verified yet'}
        </p>
      ))}
      {latest && !latest.verifiedBy && floorActs ? (
        <>
          <ActButton label="Verify the inspection" onPress={() => verify.run({ params: { inspectionId: latest.inspectionId }, body: {} })} disabled={verify.busy} />
          <ActResult error={verify.error} done={verify.done} label="The inspection is verified." />
        </>
      ) : null}
      {floorActs ? (
        <div data-testid="post-use-form">
          {CHECKS.map(([k, label]) => (
            <floor.ChoiceGroup
              key={k}
              label={label}
              options={[{ value: 'YES', label: 'Yes' }, { value: 'NO', label: 'No' }]}
              value={checks[k] === null ? null : checks[k] ? 'YES' : 'NO'}
              onChange={(x) => setChecks({ ...checks, [k]: x === 'YES' })}
            />
          ))}
          <ActButton
            label="Record the post-use inspection"
            onPress={() =>
              answered
                ? record.run({ params: { batchId: v.batchId }, body: { checks: { noPrintedMaterial: checks.noPrintedMaterial === true, noProduct: checks.noProduct === true, noDocuments: checks.noDocuments === true, lineClean: checks.lineClean === true } } })
                : undefined
            }
            disabled={!answered || record.busy}
          />
          <ActResult error={record.error} done={record.done} label="The inspection is recorded." />
        </div>
      ) : null}
    </Section>
  );
}
