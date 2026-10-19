/**
 * Market policies (slice 7g WP3; decision D-P7R-3: market policies stay in v1.0; INV-47, DI-09): each policy switch with
 * its versions, author and, for a loosening, approver. QA defines a policy and gives it new versions under an approved
 * change record that covers area MARKET_POLICY; a loosening needs another person's approval, signed before the change
 * through the ceremony (MARKET_LOOSENING). A batch pins the versions in force at its issue; a stricter version already in
 * force is applied to an issued batch with a change reference and a reason; a loosening never reaches an issued batch.
 */
import { useState } from 'react';
import { routes, type MarketPolicyView } from '@ebmr/api-contract';
import { Field, floor } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { isUuid, MARKET_READS, words } from './reads.ts';

export function PoliciesPage() {
  const q = useApiQuery(routes.marketConfig.policies, {});
  return (
    <>
      <h1>Market policies</h1>
      <p>
        A policy is a design-choice switch whose positions run from least to most strict. Each change is a new version that takes effect now or later, never in the past, under an
        approved change record. A loosening needs a second person&apos;s approval signature of exactly that version. A batch keeps the versions in force when it was issued.
      </p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.policies.length === 0 ? <p>No market policy is defined.</p> : null}
      {q.data?.policies.map((p) => <Policy key={p.code} p={p} />)}
      <DefinePolicy />
      <BatchPins policies={q.data?.policies ?? []} />
    </>
  );
}

function Policy({ p }: { p: MarketPolicyView }) {
  const setVersion = useCommand(routes.marketConfig.setPolicyVersion, MARKET_READS);
  const approve = useSignedAct(MARKET_READS);
  const [position, setPosition] = useState(p.current ?? p.defaultPosition);
  const [changeRef, setChangeRef] = useState('');
  const [changeRecord, setChangeRecord] = useState('');
  const [reason, setReason] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const looser = p.current !== null && p.positions.indexOf(position) < p.positions.indexOf(p.current);
  const ok = changeRef.trim() !== '' && changeRecord.trim() !== '' && reason.trim() !== '';
  return (
    <Section title={`${p.code}: ${p.title}`} testId={`policy-${p.code}`}>
      <p>
        Positions, least strict first: {p.positions.join(', ')}. In force now: <strong>{p.current ?? 'none'}</strong>. A loosening needs {words(p.looseningRequires).toLowerCase()}.
        {p.controls.length > 0 ? ` Controls: ${p.controls.join(', ')}.` : ''}
      </p>
      <ol>
        {p.versions.map((v) => (
          <li key={v.versionId}>
            Version {v.version}: {v.position} ({words(v.direction).toLowerCase()}) from {v.effectiveFrom.text}, by {v.author.legalName}
            {v.approver ? `, approved by ${v.approver.legalName}` : ''}
            {v.changeRef ? ` under ${v.changeRef}` : ''}: {v.reason}
          </li>
        ))}
      </ol>
      <floor.ChoiceGroup label={`New position for ${p.code}`} options={p.positions.map((x) => ({ value: x, label: x }))} value={position} onChange={setPosition} />
      {looser ? (
        <div data-testid={`policy-${p.code}-loosening`}>
          <p>This loosens the policy: another person approves this version with their signature first.</p>
          <ActButton
            primary={false}
            label={`Approve the loosening of ${p.code} to ${position}`}
            disabled={approve.busy}
            onPress={() => approve.sign({ kind: 'MARKET_LOOSENING', target: { subject: 'POLICY_VERSION', policy: p.code, position } }, `Approve the loosening of ${p.code} to ${position}`)}
          />
          <ActResult error={approve.error} outcome={approve.outcome} label="The loosening is approved." />
        </div>
      ) : null}
      <Field name={`changeRef-${p.code}`} label="Change reference" value={changeRef} onChange={setChangeRef} />
      <Field name={`changeRecord-${p.code}`} label="Change record (approved, area MARKET_POLICY)" value={changeRecord} onChange={setChangeRecord} />
      <Field name={`reason-${p.code}`} label="Reason" value={reason} onChange={setReason} />
      <Field name={`effectiveFrom-${p.code}`} label="Takes effect at (ISO instant with offset; empty for now)" value={effectiveFrom} onChange={setEffectiveFrom} />
      <ActButton
        label={`Set ${p.code} to ${position}`}
        disabled={setVersion.busy || !ok}
        onPress={() =>
          ok &&
          setVersion.run({
            params: { code: p.code },
            body: { position, changeRef: changeRef.trim(), changeRecord: changeRecord.trim(), reason: reason.trim(), ...(effectiveFrom.trim() ? { effectiveFrom: effectiveFrom.trim() } : {}) },
          })
        }
      />
      <ActResult error={setVersion.error} done={setVersion.done} label="The new version is recorded." />
    </Section>
  );
}

function DefinePolicy() {
  const define = useCommand(routes.marketConfig.definePolicy, MARKET_READS);
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [positions, setPositions] = useState('');
  const [defaultPosition, setDefaultPosition] = useState('');
  const [requires, setRequires] = useState<'QA_APPROVAL' | 'CHANGE_CONTROL'>('QA_APPROVAL');
  const [changeRecord, setChangeRecord] = useState('');
  const [reason, setReason] = useState('');
  const list = positions.split(',').map((x) => x.trim()).filter((x) => x !== '');
  const ok = code.trim() !== '' && title.trim() !== '' && list.length >= 2 && list.includes(defaultPosition.trim()) && changeRecord.trim() !== '' && reason.trim() !== '';
  return (
    <Section title="Define a policy (QA)" testId="policy-define">
      <Field name="policyCode" label="Policy code" value={code} onChange={setCode} />
      <Field name="policyTitle" label="Title" value={title} onChange={setTitle} />
      <Field name="policyPositions" label="Positions, least strict first, separated by commas" value={positions} onChange={setPositions} />
      <Field name="policyDefault" label="Default position" value={defaultPosition} onChange={setDefaultPosition} />
      <floor.ChoiceGroup
        label="A loosening needs"
        options={[{ value: 'QA_APPROVAL', label: 'QA approval' }, { value: 'CHANGE_CONTROL', label: 'Change control' }]}
        value={requires}
        onChange={(x) => setRequires(x as 'QA_APPROVAL' | 'CHANGE_CONTROL')}
      />
      <Field name="policyChangeRecord" label="Change record (approved, area MARKET_POLICY)" value={changeRecord} onChange={setChangeRecord} />
      <Field name="policyReason" label="Reason" value={reason} onChange={setReason} />
      <ActButton
        label="Define the policy"
        disabled={define.busy || !ok}
        onPress={() =>
          ok &&
          define.run({ body: { code: code.trim(), title: title.trim(), positions: list, defaultPosition: defaultPosition.trim(), looseningRequires: requires, controls: [], changeRecord: changeRecord.trim(), reason: reason.trim() } })
        }
      />
      <ActResult error={define.error} done={define.done} label="The policy is defined; version 1 is in force." />
    </Section>
  );
}

function BatchPins({ policies }: { policies: readonly MarketPolicyView[] }) {
  const [batchId, setBatchId] = useState('');
  const id = batchId.trim();
  const pins = useApiQuery(routes.marketConfig.batchPolicies, { params: { batchId: id } }, { enabled: isUuid(id) });
  const tighten = useCommand(routes.marketConfig.applyPolicyTightening, MARKET_READS);
  const [policy, setPolicy] = useState('');
  const [versionId, setVersionId] = useState('');
  const [changeRef, setChangeRef] = useState('');
  const [reason, setReason] = useState('');
  const versions = policies.find((p) => p.code === policy)?.versions ?? [];
  const ok = isUuid(id) && policy !== '' && versionId !== '' && changeRef.trim() !== '' && reason.trim() !== '';
  return (
    <Section title="A batch's policies" testId="batch-policies">
      <Field name="pinsBatchId" label="Batch id" value={batchId} onChange={setBatchId} />
      {pins.error ? <RefusalMessage error={pins.error.error} /> : null}
      {pins.data && pins.data.pins.length === 0 ? <p>This batch pinned no policy.</p> : null}
      <ul>
        {pins.data?.pins.map((x) => (
          <li key={`${x.policy}-${x.version}-${x.pinKind}`}>
            {x.policy}: version {x.version} ({x.position}), {x.pinKind === 'ISSUE' ? `pinned at issue ${x.issueInstant.text}` : `tightened ${x.recordedAt.text} under ${x.changeRef ?? ''}: ${x.reason ?? ''}`}
          </li>
        ))}
      </ul>
      <h3>Apply a stricter version already in force</h3>
      <floor.ChoiceGroup label="Policy" options={policies.map((p) => ({ value: p.code, label: p.code }))} value={policy} onChange={setPolicy} />
      {versions.length > 0 ? (
        <floor.ChoiceGroup label="Version" options={versions.map((v) => ({ value: v.versionId, label: `${String(v.version)}: ${v.position}` }))} value={versionId} onChange={setVersionId} />
      ) : null}
      <Field name="tightenChangeRef" label="Change reference" value={changeRef} onChange={setChangeRef} />
      <Field name="tightenReason" label="Reason" value={reason} onChange={setReason} />
      <ActButton
        label="Apply the tightening to the batch"
        disabled={tighten.busy || !ok}
        onPress={() => ok && tighten.run({ params: { batchId: id, code: policy }, body: { versionId, changeRef: changeRef.trim(), reason: reason.trim() } })}
      />
      <ActResult error={tighten.error} done={tighten.done} label="The tightening applies to the batch." />
    </Section>
  );
}
