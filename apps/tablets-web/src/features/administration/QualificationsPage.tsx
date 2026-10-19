/**
 * The qualification matrix (Phase 7 slice 7g, work package 2; kernel 0130; DI-17): the qualification types and the
 * qualifications a role or a permission requires, optionally in a site, area or product. The training coordinator
 * (TRAINING.MANAGE) adds a type, adds a requirement with its reason and ends one; from then on the database's authority
 * check refuses an act to a person without a live, fresh record of each qualification it requires. Area authorisations
 * have their own route (the training screens).
 */
import { useState } from 'react';
import { routes, type QualificationRequirementView, type QualificationsView } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useSessionRole } from '../../app/roles.ts';
import { offeredTo, QUALIFICATION_READS, Row, Select, TRAINING_COORDINATORS } from './shared.tsx';

const CODE = /^[A-Z0-9][A-Z0-9_.-]{0,63}$/;
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function QualificationsPage() {
  const q = useApiQuery(routes.people.qualifications);
  const role = useSessionRole();
  const coordinator = offeredTo(role, TRAINING_COORDINATORS);
  const v = q.data;
  return (
    <>
      <h1>Qualification matrix</h1>
      <p>Which qualifications a role or a permission requires. The database refuses an act to a person without a live record of each qualification it requires.</p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {coordinator ? <AddType /> : null}
      {coordinator && v ? <AddRequirement v={v} /> : null}
      <Section title="Qualification types" testId="qualification-types">
        <ul>
          {v?.types.map((t) => (
            <li key={t.code}>
              <strong>{t.code}</strong> {t.name}: {t.description}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Requirements" testId="qualification-requirements">
        {v && v.requirements.length === 0 ? <p>No qualification is required yet.</p> : null}
        <ul>
          {v?.requirements.map((r) => (
            <Requirement key={r.requirementId} r={r} coordinator={coordinator} />
          ))}
        </ul>
      </Section>
    </>
  );
}

function AddType() {
  const add = useCommand(routes.people.createQualificationType, QUALIFICATION_READS, 'adding a qualification type');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  return (
    <Section title="Add a qualification type" testId="qualification-type-add">
      <Row>
        <Field name="qtype-code" label="Code (e.g. GMP.BASIC)" value={code} onChange={(x) => setCode(x.toUpperCase())} />
        <Field name="qtype-name" label="Name" value={name} onChange={setName} />
      </Row>
      <Field name="qtype-description" label="Description" value={description} onChange={setDescription} />
      <ActButton
        label="Add the qualification type"
        disabled={!CODE.test(code.trim()) || name.trim() === '' || description.trim() === '' || add.busy}
        onPress={() => add.run({ body: { code: code.trim(), name: name.trim(), description: description.trim() } })}
      />
      <ActResult error={add.error} done={add.done} label="Added." />
    </Section>
  );
}

function AddRequirement({ v }: { v: QualificationsView }) {
  const add = useCommand(routes.people.addQualificationRequirement, QUALIFICATION_READS, 'adding a qualification requirement');
  const [qualification, setQualification] = useState('');
  const [target, setTarget] = useState<'ROLE' | 'PERMISSION'>('ROLE');
  const [code, setCode] = useState('');
  const [site, setSite] = useState('');
  const [area, setArea] = useState('');
  const [product, setProduct] = useState('');
  const [reason, setReason] = useState('');
  const scopeOk = [site, area, product].every((x) => x.trim() === '' || SCOPE.test(x.trim()));
  const ok = qualification !== '' && code !== '' && reason.trim() !== '' && scopeOk;
  const scope = { ...(site.trim() ? { site: site.trim() } : {}), ...(area.trim() ? { area: area.trim() } : {}), ...(product.trim() ? { product: product.trim() } : {}) };
  return (
    <Section title="Require a qualification" testId="qualification-requirement-add">
      <Select name="req-qualification" label="Qualification" value={qualification} onChange={setQualification} options={v.types.map((t) => ({ value: t.code, label: `${t.code} ${t.name}` }))} />
      <Select
        name="req-target"
        label="For"
        value={target}
        onChange={(x) => {
          setTarget(x === 'PERMISSION' ? 'PERMISSION' : 'ROLE');
          setCode('');
        }}
        options={[
          { value: 'ROLE', label: 'A role' },
          { value: 'PERMISSION', label: 'A permission' },
        ]}
      />
      {target === 'ROLE' ? (
        <Select name="req-role" label="Role" value={code} onChange={setCode} options={v.roles.map((r) => ({ value: r.code, label: `${r.code} ${r.name}` }))} />
      ) : (
        <Select name="req-permission" label="Permission" value={code} onChange={setCode} options={v.permissions.map((p) => ({ value: p, label: p }))} />
      )}
      <Row>
        <Field name="req-site" label="Site (optional)" value={site} onChange={setSite} />
        <Field name="req-area" label="Area (optional)" value={area} onChange={setArea} />
        <Field name="req-product" label="Product (optional)" value={product} onChange={setProduct} />
      </Row>
      <Field name="req-reason" label="Reason" value={reason} onChange={setReason} />
      <ActButton
        label="Add the requirement"
        disabled={!ok || add.busy}
        onPress={() =>
          add.run({ body: { qualificationCode: qualification, ...(target === 'ROLE' ? { roleCode: code } : { permissionCode: code }), scope, reason: reason.trim() } })
        }
      />
      <ActResult error={add.error} done={add.done} label="The requirement is in force." />
    </Section>
  );
}

function Requirement({ r, coordinator }: { r: QualificationRequirementView; coordinator: boolean }) {
  const end = useCommand(routes.people.endQualificationRequirement, QUALIFICATION_READS, 'ending a qualification requirement');
  const [reason, setReason] = useState('');
  const scope = [r.scope.site, r.scope.area, r.scope.product].filter((x) => x !== null).join(' / ');
  return (
    <li data-testid={`requirement-${r.requirementId}`}>
      <p>
        <strong>{r.qualificationCode}</strong> for {r.roleCode ? `role ${r.roleCode}` : `permission ${r.permissionCode ?? ''}`}
        {scope ? `, in ${scope}` : ''}, from {r.effectiveFrom.text}
        {r.effectiveTo ? ` to ${r.effectiveTo.text}` : ''} ({r.createdBy.legalName}: {r.reason}).{' '}
        <StatusChip tone={r.effectiveTo ? 'neutral' : 'ok'} label={r.effectiveTo ? 'Ended' : 'In force'} />
      </p>
      {coordinator && !r.effectiveTo ? (
        <Row>
          <Field name={`req-end-${r.requirementId}`} label={`Reason to end (${r.qualificationCode})`} value={reason} onChange={setReason} />
          <ActButton label="End the requirement" primary={false} disabled={reason.trim() === '' || end.busy} onPress={() => end.run({ params: { requirementId: r.requirementId }, body: { reason: reason.trim() } })} />
        </Row>
      ) : null}
      <ActResult error={end.error} done={end.done} label="Ended." />
    </li>
  );
}
