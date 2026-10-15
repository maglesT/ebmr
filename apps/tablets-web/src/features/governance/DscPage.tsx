/**
 * The India DSC option (Phase 6 slice 6f; IN-10, decision 0001 item 3, D-P6f-4): its mode, the trust anchor DSC chains
 * must end at and the signature meanings that need a DSC while it is on. In v1 the anchor is a test certificate
 * authority, so every screen says the signatures are not legally valid; LICENSED is refused until a licensed CA or eSign
 * provider is configured after the legal opinion. Each change names an approved change record (DI-09), QA only.
 */
import { useState } from 'react';
import { routes } from '@ebmr/api-contract';
import { Banner, Field, floor } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { DSC_READS } from './reads.ts';

export function DscPage() {
  const q = useApiQuery(routes.esig.dscConfiguration);
  const qa = useOffered('QA');
  const c = q.data;
  return (
    <>
      <h1>India digital signature certificates</h1>
      <p>
        For the signature meanings configured below, a second signature with the signer&apos;s Class 3 certificate is made over the same content by the signer&apos;s token on
        this computer, and the server checks it against the certificate chain of the configured authority before anything is stored.
      </p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {c?.banner ? <Banner tone="test" title={c.banner} /> : null}
      {c ? (
        <Section title="Configuration" testId="dsc-configuration">
          <p data-testid="dsc-mode">Mode: {c.mode === 'OFF' ? 'off' : c.mode === 'TEST_CA' ? 'test certificate authority' : 'licensed provider'}</p>
          <ul>
            {c.anchors.map((a) => (
              <li key={a.anchorId}>
                {a.label} ({a.kind === 'TEST_CA' ? 'test certificate authority' : 'licensed'}, {a.live ? 'in use' : 'retired'}): {a.subject}, SHA-256 {a.rootSha256}
              </li>
            ))}
          </ul>
          <p>Needs a DSC while the option is on: {c.meanings.filter((m) => m.required).map((m) => m.meaning).join(', ') || 'no meaning'}.</p>
        </Section>
      ) : null}
      {qa ? <DscChanges meanings={c?.meanings.map((m) => m.meaning) ?? []} /> : null}
    </>
  );
}

function DscChanges({ meanings }: { meanings: readonly string[] }) {
  const mode = useCommand(routes.esig.setDscMode, DSC_READS);
  const anchor = useCommand(routes.esig.registerDscAnchor, DSC_READS);
  const meaning = useCommand(routes.esig.setDscMeaning, DSC_READS);
  const [changeRecord, setChangeRecord] = useState('');
  const [reason, setReason] = useState('');
  const [nextMode, setNextMode] = useState<'OFF' | 'TEST_CA' | 'LICENSED' | null>(null);
  const [label, setLabel] = useState('');
  const [root, setRoot] = useState('');
  const [which, setWhich] = useState<string | null>(null);
  const [required, setRequired] = useState(true);
  const base = changeRecord.trim() !== '' && reason.trim() !== '';
  const change = { changeRecord: changeRecord.trim(), reason: reason.trim() };
  return (
    <Section title="Change the DSC option (under a change record)" testId="dsc-changes">
      <Field name="dscChangeRecord" label="Change record" value={changeRecord} onChange={setChangeRecord} />
      <Field name="dscReason" label="Reason" value={reason} onChange={setReason} />
      <floor.ChoiceGroup
        label="Mode"
        options={[
          { value: 'OFF', label: 'Off' },
          { value: 'TEST_CA', label: 'Test certificate authority' },
          { value: 'LICENSED', label: 'Licensed provider' },
        ]}
        value={nextMode}
        onChange={(v) => setNextMode(v === 'OFF' || v === 'TEST_CA' || v === 'LICENSED' ? v : null)}
      />
      <ActButton label="Set the mode" onPress={() => (nextMode && base ? mode.run({ body: { mode: nextMode, ...change } }) : null)} disabled={!base || nextMode === null || mode.busy} />
      <ActResult error={mode.error} done={mode.done} label="The mode is set." />
      <Field name="dscAnchorLabel" label="Trust anchor name" value={label} onChange={setLabel} />
      <Field name="dscAnchorRoot" label="Root certificate (base64 DER)" value={root} onChange={setRoot} />
      <ActButton
        label="Register the test certificate authority"
        onPress={() => (base ? anchor.run({ body: { kind: 'TEST_CA', label: label.trim(), rootCertificate: root.trim(), ...change } }) : null)}
        disabled={!base || label.trim() === '' || root.trim() === '' || anchor.busy}
      />
      <ActResult error={anchor.error} done={anchor.done} label="The trust anchor is registered." />
      <floor.ChoiceGroup label="Signature meaning" options={meanings.map((m) => ({ value: m, label: m }))} value={which} onChange={setWhich} />
      <floor.ChoiceGroup
        label="Needs a DSC"
        options={[
          { value: 'YES', label: 'Yes' },
          { value: 'NO', label: 'No' },
        ]}
        value={required ? 'YES' : 'NO'}
        onChange={(v) => setRequired(v === 'YES')}
      />
      <ActButton label="Save for this meaning" onPress={() => (which && base ? meaning.run({ body: { meaning: which, required, ...change } }) : null)} disabled={!base || which === null || meaning.busy} />
      <ActResult error={meaning.error} done={meaning.done} label="Saved." />
    </Section>
  );
}
