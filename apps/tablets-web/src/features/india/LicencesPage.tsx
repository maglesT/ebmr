/**
 * Licences and export permissions (Phase 4 slice 6a; IN-30, D-6-1, D-6-2): the site's manufacturing and loan licences
 * with their endorsed products and validity, and the export permissions per product, strength and destination. The
 * regulatory signer records them as granted; QA approves each under its own signature (INDIA_ACT) and records a
 * suspension. Whether a licence counts now, and what the issue gate says for a product, are the server's words.
 */
import { useState } from 'react';
import { routes, type ExportPermissionView, type LicenceView } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered, useSessionRole } from '../../app/roles.ts';
import { dateInstant, INDIA_READS, licenceTone, words } from './reads.ts';

const PRODUCT = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;

export function LicencesPage() {
  const role = useSessionRole();
  const regulatory = role === 'REGULATORY_SIGNER';
  return (
    <>
      <h1>Licences and export permissions</h1>
      <p>
        A GMP batch is issued only under a current manufacturing licence endorsing its product and strength, or a loan licence naming them with its host licence; an export market needs a
        current export permission. A licence counts once QA has approved it, until it lapses or is suspended.
      </p>
      <ProductCheck />
      <Licences />
      {regulatory ? <RecordLicence /> : null}
      <Permissions />
      {regulatory ? <RecordPermission /> : null}
    </>
  );
}

function ProductCheck() {
  const [product, setProduct] = useState('');
  const [strength, setStrength] = useState('');
  const [destinations, setDestinations] = useState('');
  const ok = PRODUCT.test(product.trim()) && strength.trim() !== '' && /^([A-Z]{2}(,[A-Z]{2})*)?$/.test(destinations.trim());
  const q = useApiQuery(
    routes.india.check,
    { query: { productCode: product.trim(), strength: strength.trim(), ...(destinations.trim() ? { destinations: destinations.trim() } : {}) } },
    { enabled: ok },
  );
  return (
    <Section title="What the issue gate says for a product" testId="india-check">
      <Field name="checkProduct" label="Product code" value={product} onChange={setProduct} />
      <Field name="checkStrength" label="Strength" value={strength} onChange={setStrength} />
      <Field name="checkDestinations" label="Export destinations (e.g. US,EU)" value={destinations} onChange={setDestinations} />
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {ok && q.data ? (
        <ul data-testid="india-check-result">
          <li data-testid="india-check-licence">{q.data.licenceProblem ?? `Licence ${q.data.licenceNumber ?? ''}${q.data.loanLicenceNumber ? `, loan licence ${q.data.loanLicenceNumber}` : ''}: may be issued.`}</li>
          {q.data.exportProblems.map((e) => (
            <li key={e.destination}>
              {e.destination}: {e.problem ?? 'export permission in force.'}
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

function Licences() {
  const q = useApiQuery(routes.india.licences, {});
  return (
    <Section title="Licences" testId="india-licences">
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.licences.length === 0 ? <p>No licence is recorded.</p> : null}
      <ul>
        {q.data?.licences.map((l) => <LicenceItem key={l.licenceId} l={l} />)}
      </ul>
    </Section>
  );
}

function LicenceItem({ l }: { l: LicenceView }) {
  const qa = useOffered('QA');
  const signed = useSignedAct(INDIA_READS);
  const suspend = useCommand(routes.india.suspendLicence, INDIA_READS);
  const [reason, setReason] = useState('');
  return (
    <li data-testid={`licence-${l.licenceNumber}`} data-state={l.state}>
      <strong>{l.licenceNumber}</strong> Form {l.form} ({words(l.licenceKind)}) {l.holderName}, {l.holderAddress} <StatusChip tone={licenceTone(l.state, l.current)} label={l.current ? 'Current' : words(l.state)} />
      <br />
      Endorses {l.products.map((p) => `${p.productCode} ${p.strength}`).join(', ')}; valid from {l.validFrom.text}
      {l.validUntil ? ` until ${l.validUntil.text}` : ' (no end date)'}
      {l.hostLicenceNumber ? `; host licence ${l.hostLicenceNumber}, technical agreement ${l.technicalAgreement ?? ''}` : ''}
      {l.approvedBy ? `; approved by ${l.approvedBy.legalName} ${l.approvedAt?.text ?? ''}` : ''}
      {l.suspension ? `; suspended ${l.suspension.suspendedAt.text}: ${l.suspension.reason}` : ''}
      {qa && l.state === 'DRAFT' ? (
        <>
          <ActButton
            label={`Approve licence ${l.licenceNumber}`}
            onPress={() => signed.sign({ kind: 'INDIA_ACT', act: 'LICENCE_APPROVE', subjectId: l.licenceId }, `Approve licence ${l.licenceNumber} (Form ${l.form}) of ${l.holderName}`)}
            disabled={signed.busy}
          />
          <ActResult error={signed.error} outcome={signed.outcome} />
        </>
      ) : null}
      {qa && l.state === 'APPROVED' ? (
        <>
          <Field name={`suspendReason-${l.licenceId}`} label="Suspension (the authority's order)" value={reason} onChange={setReason} />
          <ActButton primary={false} label="Record the suspension" onPress={() => reason.trim() && suspend.run({ params: { licenceId: l.licenceId }, body: { reason: reason.trim() } })} disabled={!reason.trim() || suspend.busy} />
          <ActResult error={suspend.error} done={suspend.done} label="The suspension is recorded." />
        </>
      ) : null}
    </li>
  );
}

function RecordLicence() {
  const record = useCommand(routes.india.recordLicence, INDIA_READS);
  const [kind, setKind] = useState<'MANUFACTURING' | 'LOAN'>('MANUFACTURING');
  const [form, setForm] = useState('25');
  const [number, setNumber] = useState('');
  const [holder, setHolder] = useState('');
  const [address, setAddress] = useState('');
  const [host, setHost] = useState('');
  const [agreement, setAgreement] = useState('');
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const [products, setProducts] = useState('');
  const list = products
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [code, ...rest] = x.split(' ');
      return { productCode: (code ?? '').trim(), strength: rest.join(' ').trim() };
    });
  const forms = kind === 'LOAN' ? ['25A', '28A'] : ['25', '28'];
  const validFrom = dateInstant(from.trim());
  const validUntil = until.trim() ? dateInstant(until.trim()) : undefined;
  const ok =
    forms.includes(form) && number.trim() !== '' && holder.trim() !== '' && address.trim() !== '' && validFrom !== null && validUntil !== null &&
    list.length > 0 && list.every((p) => PRODUCT.test(p.productCode) && p.strength !== '') && (kind === 'MANUFACTURING' || (host.trim() !== '' && agreement.trim() !== ''));
  return (
    <Section title="Record a licence" testId="india-record-licence">
      <floor.ChoiceGroup
        label="Kind"
        options={[
          { value: 'MANUFACTURING', label: 'Manufacturing licence (Form 25 or 28)' },
          { value: 'LOAN', label: 'Loan licence (Form 25A or 28A)' },
        ]}
        value={kind}
        onChange={(v) => {
          setKind(v === 'LOAN' ? 'LOAN' : 'MANUFACTURING');
          setForm(v === 'LOAN' ? '25A' : '25');
        }}
      />
      <floor.ChoiceGroup label="Form" options={forms.map((f) => ({ value: f, label: `Form ${f}` }))} value={form} onChange={setForm} />
      <Field name="licenceNumber" label="Licence number" value={number} onChange={setNumber} />
      <Field name="holderName" label="Holder name" value={holder} onChange={setHolder} />
      <Field name="holderAddress" label="Holder address" value={address} onChange={setAddress} />
      {kind === 'LOAN' ? (
        <>
          <Field name="hostLicenceId" label="Host manufacturing licence (id)" value={host} onChange={setHost} />
          <Field name="technicalAgreement" label="Technical agreement with the host" value={agreement} onChange={setAgreement} />
        </>
      ) : null}
      <Field name="validFrom" label="Valid from (YYYY-MM-DD)" value={from} onChange={setFrom} />
      <Field name="validUntil" label="Valid until (YYYY-MM-DD, empty when no end date)" value={until} onChange={setUntil} />
      <Field name="endorsedProducts" label="Endorsed products (code and strength, separated by ;)" value={products} onChange={setProducts} />
      <ActButton
        label="Record the licence"
        onPress={() =>
          ok &&
          validFrom &&
          record.run({
            body: {
              licenceKind: kind, form: form as '25' | '28' | '25A' | '28A', licenceNumber: number.trim(), holderName: holder.trim(), holderAddress: address.trim(),
              ...(kind === 'LOAN' ? { hostLicenceId: host.trim(), technicalAgreement: agreement.trim() } : {}), validFrom, ...(validUntil ? { validUntil } : {}), products: list,
            },
          })
        }
        disabled={!ok || record.busy}
      />
      <ActResult error={record.error} done={record.done} label="The licence is recorded; it counts once QA approves it." />
    </Section>
  );
}

function Permissions() {
  const q = useApiQuery(routes.india.exportPermissions, {});
  return (
    <Section title="Export permissions" testId="india-export-permissions">
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.permissions.length === 0 ? <p>No export permission is recorded.</p> : null}
      <ul>
        {q.data?.permissions.map((p) => <PermissionItem key={p.permissionId} p={p} />)}
      </ul>
    </Section>
  );
}

function PermissionItem({ p }: { p: ExportPermissionView }) {
  const qa = useOffered('QA');
  const signed = useSignedAct(INDIA_READS);
  const suspend = useCommand(routes.india.suspendExportPermission, INDIA_READS);
  const [reason, setReason] = useState('');
  return (
    <li data-testid={`permission-${p.permissionNumber}`} data-state={p.state}>
      <strong>{p.permissionNumber}</strong> {p.productCode} {p.strength} to {p.destination} ({p.issuingAuthority}), valid {p.validFrom.text} to {p.validUntil.text}{' '}
      <StatusChip tone={licenceTone(p.state, p.current)} label={p.current ? 'In force' : words(p.state)} />
      {qa && p.state === 'DRAFT' ? (
        <>
          <ActButton
            label={`Approve export permission ${p.permissionNumber}`}
            onPress={() => signed.sign({ kind: 'INDIA_ACT', act: 'EXPORT_PERMISSION_APPROVE', subjectId: p.permissionId }, `Approve export permission ${p.permissionNumber} for ${p.productCode} ${p.strength} to ${p.destination}`)}
            disabled={signed.busy}
          />
          <ActResult error={signed.error} outcome={signed.outcome} />
        </>
      ) : null}
      {qa && p.state === 'APPROVED' ? (
        <>
          <Field name={`permissionSuspend-${p.permissionId}`} label="Suspension or withdrawal (reason)" value={reason} onChange={setReason} />
          <ActButton primary={false} label="Record the suspension" onPress={() => reason.trim() && suspend.run({ params: { permissionId: p.permissionId }, body: { reason: reason.trim() } })} disabled={!reason.trim() || suspend.busy} />
          <ActResult error={suspend.error} done={suspend.done} label="The suspension is recorded." />
        </>
      ) : null}
    </li>
  );
}

function RecordPermission() {
  const record = useCommand(routes.india.recordExportPermission, INDIA_READS);
  const [product, setProduct] = useState('');
  const [strength, setStrength] = useState('');
  const [destination, setDestination] = useState('');
  const [number, setNumber] = useState('');
  const [authority, setAuthority] = useState('');
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const validFrom = dateInstant(from.trim());
  const validUntil = dateInstant(until.trim());
  const ok = PRODUCT.test(product.trim()) && strength.trim() !== '' && /^[A-Z]{2}$/.test(destination.trim()) && destination.trim() !== 'IN' && number.trim() !== '' && authority.trim() !== '' && validFrom !== null && validUntil !== null;
  return (
    <Section title="Record an export permission" testId="india-record-permission">
      <Field name="permissionProduct" label="Product code" value={product} onChange={setProduct} />
      <Field name="permissionStrength" label="Strength" value={strength} onChange={setStrength} />
      <Field name="permissionDestination" label="Destination (market or country code, e.g. US)" value={destination} onChange={setDestination} />
      <Field name="permissionNumber" label="Permission number" value={number} onChange={setNumber} />
      <Field name="permissionAuthority" label="Issuing authority" value={authority} onChange={setAuthority} />
      <Field name="permissionFrom" label="Valid from (YYYY-MM-DD)" value={from} onChange={setFrom} />
      <Field name="permissionUntil" label="Valid until (YYYY-MM-DD)" value={until} onChange={setUntil} />
      <ActButton
        label="Record the export permission"
        onPress={() =>
          ok &&
          validFrom &&
          validUntil &&
          record.run({ body: { productCode: product.trim(), strength: strength.trim(), destination: destination.trim(), permissionNumber: number.trim(), issuingAuthority: authority.trim(), validFrom, validUntil } })
        }
        disabled={!ok || record.busy}
      />
      <ActResult error={record.error} done={record.done} label="The export permission is recorded; it counts once QA approves it." />
    </Section>
  );
}
