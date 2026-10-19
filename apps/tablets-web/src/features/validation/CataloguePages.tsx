/**
 * The signature catalogue and the record-seal keys (Phase 7 slice 7g-3; kernel 0210, 0220, 1195): a customer signature
 * point and a new version of a meaning type, each under an approved change record covering ESIG_MEANING (the database
 * refuses a catalogue change without one, and never loosens a minimum type), and the retirement of a seal key with the
 * reason and its change record.
 */
import { useState } from 'react';
import { routes, type RouteBodyInput, type RouteResponse } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { Choice, ESIG_CATALOGUE_READS, words } from './shared.tsx';

type Definition = RouteBodyInput<typeof routes.esig.addMeaningType>['definition'];
type MeaningType = RouteResponse<typeof routes.esig.meaningTypes>['meaningTypes'][number];
const CATEGORIES = ['MASTER_RECORD', 'BATCH_RECORD', 'EXECUTION', 'VERIFICATION', 'EXCEPTION', 'LOGBOOK', 'LABORATORY', 'REVIEW', 'RELEASE', 'RECORDS'] as const;
const ROLE_CLASSES = ['PERFORMER', 'VERIFIER', 'WITNESS', 'SUPERVISOR', 'AUTHORISER', 'APPROVER', 'REVIEWER', 'RELEASE'] as const;
const list = (s: string): string[] => s.split(',').map((x) => x.trim()).filter((x) => x !== '');

export function MeaningTypesPage() {
  const q = useApiQuery(routes.esig.meaningTypes);
  const add = useCommand(routes.esig.addMeaningType, ESIG_CATALOGUE_READS);
  const [code, setCode] = useState('');
  const [category, setCategory] = useState<Definition['category']>('RECORDS');
  const [roleClass, setRoleClass] = useState<Definition['roleClass']>('APPROVER');
  const [title, setTitle] = useState('');
  const [meaningText, setMeaningText] = useState('');
  const [permissions, setPermissions] = useState('');
  const [changeRecord, setChangeRecord] = useState('');
  const [reason, setReason] = useState('');
  const ok = /^[A-Z][A-Z0-9_]{1,63}$/.test(code) && title.trim() !== '' && meaningText.trim() !== '' && list(permissions).length > 0 && changeRecord.trim() !== '' && reason.trim() !== '';
  return (
    <>
      <h1>Signature catalogue</h1>
      <p>The meaning of every electronic signature: who may sign it, whom it must be independent of and how the signer re-authenticates. The minimum set comes with the release and is never loosened; a company adds its own signature points.</p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      <Section title="Meaning types" testId="meaning-types">
        {q.data?.meaningTypes.map((m) => <MeaningRow key={m.code} m={m} />)}
      </Section>
      <Section title="Add a customer signature point" testId="add-meaning-type">
        <Field name="code" label="Code" value={code} onChange={setCode} />
        <Choice name="category" label="Category" value={category} options={CATEGORIES} onChange={setCategory} />
        <Choice name="roleClass" label="Role class" value={roleClass} options={ROLE_CLASSES} onChange={setRoleClass} />
        <Field name="title" label="Title" value={title} onChange={setTitle} />
        <Field name="meaningText" label="Meaning as the manifestation shows it" value={meaningText} onChange={setMeaningText} />
        <Field name="permissions" label="Permissions that may sign it (comma-separated)" value={permissions} onChange={setPermissions} />
        <Field name="mt-change-record" label="Approved change record (number)" value={changeRecord} onChange={setChangeRecord} />
        <Field name="mt-reason" label="Reason" value={reason} onChange={setReason} />
        <ActButton
          label="Add the signature point"
          disabled={!ok || add.busy}
          onPress={() => add.run({ body: { code, definition: { category, roleClass, title: title.trim(), meaningText: meaningText.trim(), permissions: list(permissions) }, changeRecord: changeRecord.trim(), reason: reason.trim() } })}
        />
        <ActResult error={add.error} done={add.done} label="Added to the catalogue." />
      </Section>
    </>
  );
}

function MeaningRow({ m }: { m: MeaningType }) {
  const configure = useCommand(routes.esig.configureMeaningType, ESIG_CATALOGUE_READS);
  const [permissions, setPermissions] = useState('');
  const [independentOf, setIndependentOf] = useState('');
  const [retire, setRetire] = useState(false);
  const [changeRecord, setChangeRecord] = useState('');
  const [reason, setReason] = useState('');
  const changes = {
    ...(list(permissions).length > 0 ? { permissions: list(permissions) } : {}),
    ...(independentOf.trim() !== '' ? { independentOf: list(independentOf) } : {}),
    ...(retire ? { status: 'RETIRED' as const } : {}),
  };
  const ok = Object.keys(changes).length > 0 && changeRecord.trim() !== '' && reason.trim() !== '';
  return (
    <details data-testid={`meaning-${m.code}`} data-status={m.status}>
      <summary>
        {m.code} v{m.version}: {m.title} <StatusChip tone={m.status === 'ACTIVE' ? 'ok' : 'neutral'} label={words(m.status)} /> {m.origin === 'VENDOR' ? '(minimum set)' : '(customer)'}
      </summary>
      <p>
        {m.meaningText}. {words(m.category)}, {words(m.roleClass)}; signed with {m.permissions.join(', ')}
        {m.independentOf.length > 0 ? `; independent of ${m.independentOf.join(', ')}` : ''}; re-authentication {words(m.reauth)}.
      </p>
      <Field name={`perm-${m.code}`} label="New permissions (comma-separated; empty keeps them)" value={permissions} onChange={setPermissions} />
      <Field name={`indep-${m.code}`} label="Independent of (comma-separated; empty keeps it)" value={independentOf} onChange={setIndependentOf} />
      {m.origin === 'CUSTOMER' && m.status === 'ACTIVE' ? (
        <label style={{ display: 'block' }}>
          <input type="checkbox" name={`retire-${m.code}`} checked={retire} onChange={(e) => setRetire(e.target.checked)} /> Retire it
        </label>
      ) : null}
      <Field name={`cr-${m.code}`} label="Approved change record (number)" value={changeRecord} onChange={setChangeRecord} />
      <Field name={`reason-${m.code}`} label="Reason" value={reason} onChange={setReason} />
      <ActButton
        label={`Save a new version of ${m.code}`}
        primary={false}
        disabled={!ok || configure.busy}
        onPress={() => configure.run({ params: { code: m.code }, body: { changes, changeRecord: changeRecord.trim(), reason: reason.trim() } })}
      />
      <ActResult error={configure.error} done={configure.done} label="Saved as a new version." />
    </details>
  );
}

export function SealKeysPage() {
  const q = useApiQuery(routes.esig.sealKeys);
  return (
    <>
      <h1>Record-seal keys</h1>
      <p>Every signature is sealed with a key of the installation. A retired key seals nothing more; the seals it made stay verifiable.</p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      <Section title="Seal keys" testId="seal-keys">
        {q.data?.sealKeys.map((k) => <SealKeyRow key={k.keyId} k={k} />)}
      </Section>
    </>
  );
}

function SealKeyRow({ k }: { k: RouteResponse<typeof routes.esig.sealKeys>['sealKeys'][number] }) {
  const retire = useCommand(routes.esig.retireSealKey, ESIG_CATALOGUE_READS);
  const [changeRecord, setChangeRecord] = useState('');
  const [reason, setReason] = useState('');
  return (
    <article data-testid={`seal-key-${k.keyId}`} data-retired={String(k.retired !== null)}>
      <p>
        <strong>{k.keyId}</strong> ({k.algorithm}): {k.description}, registered {k.registeredAt.text}
        {k.retired ? `; retired ${k.retired.at.text}: ${k.retired.reason}` : ''}
      </p>
      {k.retired ? null : (
        <>
          <Field name={`sk-cr-${k.keyId}`} label="Change record (number)" value={changeRecord} onChange={setChangeRecord} />
          <Field name={`sk-reason-${k.keyId}`} label="Reason" value={reason} onChange={setReason} />
          <ActButton
            label={`Retire ${k.keyId}`}
            primary={false}
            disabled={changeRecord.trim() === '' || reason.trim() === '' || retire.busy}
            onPress={() => retire.run({ params: { keyId: k.keyId }, body: { changeRecord: changeRecord.trim(), reason: reason.trim() } })}
          />
          <ActResult error={retire.error} done={retire.done} label="Retired." />
        </>
      )}
    </article>
  );
}
