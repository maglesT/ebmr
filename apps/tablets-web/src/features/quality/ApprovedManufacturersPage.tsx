/**
 * The approved-manufacturer register (Phase 6 slice 6a, builder A; PR-17 clause 3; site services 0910): per material, the
 * manufacturers QA approved with the basis of the approval. QA proposes a row and approves it with its own signature
 * (MANUFACTURER_APPROVED through the ceremony, MATERIAL_SOURCE_ACT); a withdrawn approval stays listed with its reason.
 * A lot whose receipt names a manufacturer not approved now is neither released nor issued (the database decides).
 */
import { useState } from 'react';
import { routes, type ApprovedManufacturerView } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';

const READS = [routes.quality.approvedManufacturers.id, routes.quality.lotReceipt.id];
const MATERIAL = /^[A-Z0-9][A-Z0-9/._-]{0,39}$/;
const CODE = /^[!-~]{1,64}$/;

export function ApprovedManufacturersPage() {
  const [material, setMaterial] = useState('');
  const filter = MATERIAL.test(material.trim()) ? { materialCode: material.trim() } : {};
  const q = useApiQuery(routes.quality.approvedManufacturers, { query: filter });
  const qa = useOffered('QA');
  return (
    <>
      <h1>Approved manufacturers</h1>
      <p>
        A lot is accepted only from a manufacturer QA approved for its material. A supplier label naming any other manufacturer blocks the lot: it is not released
        and not issued until QA decides.
      </p>
      <Field name="materialFilter" label="Material code (filter)" value={material} onChange={setMaterial} />
      {qa ? <ProposeManufacturer /> : null}
      <Section title="Register" testId="approved-manufacturers">
        {q.error ? <RefusalMessage error={q.error.error} /> : null}
        {q.data && q.data.manufacturers.length === 0 ? <p>No manufacturer is on the register.</p> : null}
        <table>
          <thead>
            <tr>
              <th scope="col">Material</th>
              <th scope="col">Manufacturer</th>
              <th scope="col">Basis</th>
              <th scope="col">State</th>
              <th scope="col">Act</th>
            </tr>
          </thead>
          <tbody>{q.data?.manufacturers.map((m) => <Row key={m.approvedManufacturerId} m={m} qa={qa} />)}</tbody>
        </table>
      </Section>
    </>
  );
}

function Row({ m, qa }: { m: ApprovedManufacturerView; qa: boolean }) {
  const signed = useSignedAct(READS);
  const withdraw = useCommand(routes.quality.withdrawManufacturerApproval, READS, 'the withdrawal of the approval');
  const [reason, setReason] = useState('');
  const tone = m.state === 'APPROVED' ? 'ok' : m.state === 'WITHDRAWN' ? 'error' : 'pending';
  return (
    <tr data-testid={`manufacturer-${m.approvedManufacturerId}`} data-state={m.state}>
      <th scope="row">{m.materialCode}</th>
      <td>
        {m.manufacturerCode} {m.manufacturerName}
        {m.manufacturingSite ? `, ${m.manufacturingSite}` : ''}
      </td>
      <td>{m.basis}</td>
      <td>
        <StatusChip tone={tone} label={m.state === 'APPROVED' ? 'Approved' : m.state === 'WITHDRAWN' ? 'Withdrawn' : 'Proposed, not yet approved'} />
        {m.approvedBy && m.approvedAt ? ` by ${m.approvedBy.legalName} at ${m.approvedAt.text}` : ''}
        {m.withdrawal ? ` Withdrawn by ${m.withdrawal.by.legalName} at ${m.withdrawal.at.text}: ${m.withdrawal.reason}` : ''}
      </td>
      <td>
        {qa && m.state === 'PROPOSED' ? (
          <>
            <ActButton
              label={`Approve ${m.manufacturerCode}`}
              disabled={signed.busy}
              onPress={() => signed.sign({ kind: 'MATERIAL_SOURCE_ACT', act: 'MANUFACTURER_APPROVE', approvedManufacturerId: m.approvedManufacturerId }, `Approve ${m.manufacturerName} for ${m.materialCode}`)}
            />
            <ActResult error={signed.error} outcome={signed.outcome} />
          </>
        ) : null}
        {qa && m.state === 'APPROVED' ? (
          <>
            <Field name={`withdraw-${m.approvedManufacturerId}`} label="Reason for withdrawing" value={reason} onChange={setReason} />
            <ActButton
              label={`Withdraw ${m.manufacturerCode}`}
              primary={false}
              disabled={reason.trim().length < 3 || withdraw.busy}
              onPress={() => withdraw.run({ params: { approvedManufacturerId: m.approvedManufacturerId }, body: { reason: reason.trim() } })}
            />
            <ActResult error={withdraw.error} done={withdraw.done} label="The approval is withdrawn." />
          </>
        ) : null}
      </td>
    </tr>
  );
}

function ProposeManufacturer() {
  const propose = useCommand(routes.quality.proposeApprovedManufacturer, READS, 'the proposal');
  const [materialCode, setMaterialCode] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [site, setSite] = useState('');
  const [basis, setBasis] = useState('');
  const ok = MATERIAL.test(materialCode.trim()) && CODE.test(code.trim()) && name.trim() !== '' && basis.trim().length >= 10;
  return (
    <Section title="Propose a manufacturer" testId="propose-manufacturer">
      <Field name="amMaterial" label="Material code" value={materialCode} onChange={setMaterialCode} />
      <Field name="amCode" label="Manufacturer code" value={code} onChange={setCode} />
      <Field name="amName" label="Manufacturer name" value={name} onChange={setName} />
      <Field name="amSite" label="Manufacturing site (optional)" value={site} onChange={setSite} />
      <Field name="amBasis" label="Basis of the approval (qualification or audit reference)" value={basis} onChange={setBasis} />
      <ActButton
        label="Propose the manufacturer"
        disabled={!ok || propose.busy}
        onPress={() =>
          propose.run({
            body: { materialCode: materialCode.trim(), manufacturerCode: code.trim(), manufacturerName: name.trim(), basis: basis.trim(), ...(site.trim() ? { manufacturingSite: site.trim() } : {}) },
          })
        }
      />
      <ActResult error={propose.error} done={propose.done} label="Proposed. It takes effect once QA signs the approval." />
    </Section>
  );
}
