/**
 * Compendial rule sets (slice 7g WP3; tablets 1161; IN-34): each rule set version as shipped, with QA's verification
 * against the official pharmacopoeia text. QA records the document reference and what was checked, and the same person
 * signs it through the ceremony (RULE_SET_VERIFY, meaning COMPENDIAL_RULE_SET_VERIFIED). The release gate waits for a
 * signed, valid verification of every rule set a batch's checks cite; the database decides.
 */
import { useState } from 'react';
import { routes, type RuleSetVerificationView } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { RULE_SET_READS, words } from './reads.ts';

export function RuleSetsPage() {
  const q = useApiQuery(routes.marketConfig.ruleSets, {});
  return (
    <>
      <h1>Compendial rule sets</h1>
      <p>The rule sets were taken from secondary sources. Each version needs QA&apos;s verification against the official text, signed by the person who recorded it.</p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data?.ruleSets.map((r) => <RuleSet key={`${r.code}-${String(r.version)}`} r={r} />)}
    </>
  );
}

function RuleSet({ r }: { r: RuleSetVerificationView }) {
  const record = useCommand(routes.marketConfig.recordRuleSetVerification, RULE_SET_READS);
  const signed = useSignedAct(RULE_SET_READS);
  const [documentRef, setDocumentRef] = useState('');
  const [note, setNote] = useState('');
  const v = r.verification;
  const label = `${r.code} version ${String(r.version)}`;
  return (
    <Section title={label} testId={`rule-set-${r.code}-${String(r.version)}`}>
      <p>
        {words(r.test)}, {r.pharmacopoeia} for {r.markets.join(', ') || 'in-house use'}; confidence {words(r.confidence).toLowerCase()}; source {r.source}.{' '}
        <StatusChip tone={r.problem ? 'pending' : 'ok'} label={r.problem ? 'Not verified' : 'Verified'} />
      </p>
      {r.problem ? <p>{r.problem}.</p> : null}
      {v ? (
        <p>
          Checked against {v.documentRef}: {v.note}. Recorded by {v.recordedBy.legalName} {v.recordedAt.text}.
          {v.signedBy && v.signedAt ? ` Signed by ${v.signedBy.legalName} ${v.signedAt.text}.` : ' Not signed yet.'}
        </p>
      ) : null}
      {v && !v.signedBy ? (
        <>
          <ActButton label={`Sign the verification of ${label}`} disabled={signed.busy} onPress={() => signed.sign({ kind: 'RULE_SET_VERIFY', code: r.code, version: r.version }, `Verification of ${label} against ${v.documentRef}`)} />
          <ActResult error={signed.error} outcome={signed.outcome} label="The verification is signed." />
        </>
      ) : null}
      <Field name={`rsDoc-${r.code}-${String(r.version)}`} label="Official text checked against (document reference)" value={documentRef} onChange={setDocumentRef} />
      <Field name={`rsNote-${r.code}-${String(r.version)}`} label="What was checked" value={note} onChange={setNote} />
      <ActButton
        primary={false}
        label={`Record the verification of ${label}`}
        disabled={record.busy || documentRef.trim() === '' || note.trim() === ''}
        onPress={() => documentRef.trim() && note.trim() && record.run({ params: { code: r.code, version: String(r.version) }, body: { documentRef: documentRef.trim(), note: note.trim() } })}
      />
      <ActResult error={record.error} done={record.done} label="The verification is recorded; sign it next." />
    </Section>
  );
}
