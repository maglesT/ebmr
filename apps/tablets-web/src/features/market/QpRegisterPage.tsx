/**
 * The EU qualified-person register (slice 7g WP3; recipe-core 0824; ST-10): QA registers a person who holds the EU QP
 * role on a registered importer's authorisation (its MIA number), or withdraws the registration, with a signature
 * through the ceremony (QP_REGISTER, meaning QP_REGISTERED). Nobody registers themselves; the database decides. Slice 7h
 * (gap C3): the registered importers, and QA's signed registration of a new one (EuImporterForm, EU_IMPORTER_REGISTER).
 */
import { useState } from 'react';
import { routes } from '@ebmr/api-contract';
import { floor } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { EuImporterForm } from './EuImporterForm.tsx';
import { QP_READS, words } from './reads.ts';

export function QpRegisterPage() {
  const q = useApiQuery(routes.marketConfig.qpRegister, {});
  const signed = useSignedAct(QP_READS);
  const [personId, setPersonId] = useState('');
  const [importer, setImporter] = useState('');
  const [action, setAction] = useState<'REGISTER' | 'WITHDRAW'>('REGISTER');
  if (q.error) return <RefusalMessage error={q.error.error} />;
  if (!q.data) return <p>Loading…</p>;
  const reg = q.data;
  const imp = reg.importers.find((i) => i.code === importer);
  const person = reg.candidates.find((c) => c.personId === personId);
  return (
    <>
      <h1>EU qualified-person register</h1>
      <p>A qualified person certifies EU batches only while registered on the authorisation of the importer named. QA registers or withdraws, never for themselves.</p>
      <Section title="Register entries" testId="qp-register">
        {reg.entries.length === 0 ? <p>No entry yet.</p> : null}
        <ul>
          {reg.entries.map((e) => (
            <li key={e.entryId}>
              {words(e.action)}: {e.person.legalName} on {e.importerCode} ({e.miaNumber}), by {e.by.legalName} {e.recordedAt.text}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Register or withdraw a qualified person (QA)" testId="qp-register-act">
        <floor.ChoiceGroup label="Person" options={reg.candidates.map((c) => ({ value: c.personId, label: `${c.legalName} (${c.loginName})` }))} value={personId} onChange={setPersonId} />
        <floor.ChoiceGroup label="Importer" options={reg.importers.map((i) => ({ value: i.code, label: `${i.code}: ${i.name} (${i.miaNumber})` }))} value={importer} onChange={setImporter} />
        <floor.ChoiceGroup label="Action" options={[{ value: 'REGISTER', label: 'Register' }, { value: 'WITHDRAW', label: 'Withdraw' }]} value={action} onChange={(x) => setAction(x as 'REGISTER' | 'WITHDRAW')} />
        <ActButton
          label="Sign the register entry"
          disabled={signed.busy || !person || !imp}
          onPress={() =>
            person &&
            imp &&
            signed.sign({ kind: 'QP_REGISTER', personId: person.personId, action, importerCode: imp.code, miaNumber: imp.miaNumber }, `${words(action)} ${person.legalName} as qualified person on ${imp.code}`)
          }
        />
        <ActResult error={signed.error} outcome={signed.outcome} label="The register entry is signed." />
      </Section>
      <Section title="Registered EU importers" testId="eu-importers">
        {reg.importers.length === 0 ? <p>No importer is registered yet: register one below before a qualified person can be registered.</p> : null}
        <ul>
          {reg.importers.map((i) => (
            <li key={i.code}>
              {i.code}: {i.name} ({i.miaNumber})
            </li>
          ))}
        </ul>
      </Section>
      <EuImporterForm />
    </>
  );
}
