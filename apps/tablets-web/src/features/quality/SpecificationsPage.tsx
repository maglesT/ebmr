/**
 * Specifications (Phase 4 slice 2c screens, on slice 2b's contract ns/specifications.ts): the specification versions of
 * the site per material, each test with its limits, the pharmacopoeia and edition the limit comes from (IN-33), whether
 * it is required for release and the sample one run takes; a new version drafted by QC and approved by another person
 * through the ceremony (LIMS_ACT SPECIFICATION_APPROVE); a pharmacopoeia edition marked effective by QA and the review
 * list of specifications citing an older edition. Limits are typed here only into a draft; a result never carries them
 * (they are the specification's). Every rule is the database's.
 */
import { useState } from 'react';
import { routes, SpecificationTestInput, type SpecificationView } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { DefineForm } from '../../app/define-form.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';

const READS = [routes.specifications.list.id, routes.specifications.editionReview.id];
const PHARMACOPOEIAS = ['IP', 'BP', 'PH_EUR', 'USP', 'IN_HOUSE'] as const;

export function SpecificationsPage() {
  const [material, setMaterial] = useState('');
  const filter = material.trim().toUpperCase();
  const q = useApiQuery(routes.specifications.list, filter ? { query: { materialCode: filter } } : {});
  const qc = useOffered('QC');
  const qa = useOffered('QA');
  return (
    <>
      <h1>Specifications</h1>
      <Field name="materialFilter" label="Material code" value={material} onChange={setMaterial} description="Show one material's versions (empty: all)" />
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.specifications.length === 0 ? <p>No specification recorded.</p> : null}
      {q.data?.specifications.map((s) => (
        <SpecificationCard key={s.specificationId} s={s} canApprove={qc || qa} />
      ))}
      {qc ? <DraftForm /> : null}
      <EditionReview />
      {qa ? (
        <Section title="Pharmacopoeia edition" testId="mark-edition">
          <DefineForm
            title="Mark an edition effective"
            route={routes.specifications.markEdition}
            refresh={READS}
            submitLabel="Mark it effective"
            fields={[
              { name: 'pharmacopoeia', label: 'Pharmacopoeia', kind: 'choice', options: ['IP', 'BP', 'PH_EUR', 'USP'] },
              { name: 'edition', label: 'Edition', kind: 'text', description: 'e.g. 2026' },
              { name: 'effectiveFrom', label: 'Effective from', kind: 'instant', description: 'ISO-8601 with offset, e.g. 2026-12-01T00:00:00+05:30' },
            ]}
          />
        </Section>
      ) : null}
    </>
  );
}

function SpecificationCard({ s, canApprove }: { s: SpecificationView; canApprove: boolean }) {
  const signed = useSignedAct(READS);
  return (
    <Section title={`${s.materialCode} version ${String(s.version)}: ${s.title}`} testId={`spec-${s.materialCode}-${String(s.version)}`}>
      <p>
        <StatusChip tone={s.state === 'APPROVED' ? 'ok' : s.state === 'DRAFT' ? 'warning' : 'neutral'} label={s.state} /> {s.monographReference} · drafted by {s.draftedBy.legalName}, {s.draftedAt.text}
        {s.approvedBy ? ` · approved by ${s.approvedBy.legalName}, ${s.approvedAt?.text ?? ''}` : ''}
      </p>
      <table aria-label={`Tests of ${s.materialCode} version ${String(s.version)}`}>
        <thead>
          <tr>
            <th scope="col">Test</th>
            <th scope="col">Method</th>
            <th scope="col">Limits</th>
            <th scope="col">Source</th>
            <th scope="col">Release</th>
            <th scope="col">Sample per run</th>
          </tr>
        </thead>
        <tbody>
          {s.tests.map((t) => (
            <tr key={t.testCode}>
              <td>{t.testCode}</td>
              <td>{t.methodReference}</td>
              <td>
                {[t.lowerLimit ? `from ${t.lowerLimit}` : '', t.upperLimit ? `to ${t.upperLimit}` : ''].filter(Boolean).join(' ') || 'none'} {t.unit}
              </td>
              <td>
                {t.pharmacopoeia} {t.edition}
              </td>
              <td>{t.required ? 'required' : 'optional'}</td>
              <td>
                {t.sampleQuantity} {t.sampleUnit}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canApprove && s.state === 'DRAFT' ? (
        <ActButton
          label={`Approve ${s.materialCode} version ${String(s.version)} (signature)`}
          onPress={() => signed.sign({ kind: 'LIMS_ACT', act: 'SPECIFICATION_APPROVE', subjectId: s.specificationId }, `Approve the specification of ${s.materialCode}, version ${String(s.version)}`)}
          disabled={signed.busy || signed.outcome === 'SIGNED'}
        />
      ) : null}
      <ActResult error={signed.error} outcome={signed.outcome} />
    </Section>
  );
}

interface TestRow {
  testCode: string;
  methodReference: string;
  unit: string;
  lowerLimit: string;
  upperLimit: string;
  required: 'YES' | 'NO' | null;
  pharmacopoeia: (typeof PHARMACOPOEIAS)[number] | null;
  edition: string;
  sampleQuantity: string;
  sampleUnit: string;
}

const EMPTY: TestRow = { testCode: '', methodReference: '', unit: '', lowerLimit: '', upperLimit: '', required: null, pharmacopoeia: null, edition: '', sampleQuantity: '', sampleUnit: '' };

function toInput(r: TestRow): Record<string, unknown> {
  return {
    testCode: r.testCode.trim().toUpperCase(),
    methodReference: r.methodReference.trim(),
    unit: r.unit.trim(),
    ...(r.lowerLimit.trim() ? { lowerLimit: r.lowerLimit.trim() } : {}),
    ...(r.upperLimit.trim() ? { upperLimit: r.upperLimit.trim() } : {}),
    required: r.required === 'YES',
    pharmacopoeia: r.pharmacopoeia,
    edition: r.edition.trim(),
    sampleQuantity: r.sampleQuantity.trim(),
    sampleUnit: r.sampleUnit.trim(),
  };
}

/** A new version of a material's specification (QC), checked against the contract before it is sent. */
function DraftForm() {
  const [material, setMaterial] = useState('');
  const [title, setTitle] = useState('');
  const [monograph, setMonograph] = useState('');
  const [rows, setRows] = useState<TestRow[]>([EMPTY]);
  const draft = useCommand(routes.specifications.draft, READS, 'drafting a specification');
  const body = { materialCode: material.trim().toUpperCase(), title: title.trim(), monographReference: monograph.trim(), tests: rows.map(toInput) };
  const problems = SpecificationTestInput.array().min(1).safeParse(body.tests);
  const header = body.materialCode !== '' && body.title !== '' && body.monographReference !== '';
  const problem = !header ? 'material code, title and monograph reference are needed' : problems.success ? null : problems.error.issues.map((i) => `test ${i.path.join('.')}: ${i.message}`).join('; ');
  const set = (i: number, patch: Partial<TestRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const send = async () => {
    if (!problems.success) return;
    const r = await draft.run({ body: { ...body, tests: problems.data } });
    if (r) setRows([EMPTY]);
  };
  return (
    <Section title="Draft a specification version" testId="draft-specification">
      <Field name="specMaterial" label="Material code" value={material} onChange={setMaterial} />
      <Field name="specTitle" label="Title" value={title} onChange={setTitle} />
      <Field name="specMonograph" label="Monograph reference" value={monograph} onChange={setMonograph} description="e.g. IP 2022 monograph, or the in-house document and version" />
      {rows.map((r, i) => (
        <fieldset key={i} data-testid={`spec-test-${String(i)}`}>
          <legend>Test {i + 1}</legend>
          <Field name={`testCode${String(i)}`} label={`Test code ${String(i + 1)}`} value={r.testCode} onChange={(v) => set(i, { testCode: v })} />
          <Field name={`method${String(i)}`} label={`Method ${String(i + 1)}`} value={r.methodReference} onChange={(v) => set(i, { methodReference: v })} />
          <Field name={`unit${String(i)}`} label={`Unit ${String(i + 1)}`} value={r.unit} onChange={(v) => set(i, { unit: v })} />
          <Field name={`lower${String(i)}`} label={`Lower limit ${String(i + 1)}`} value={r.lowerLimit} onChange={(v) => set(i, { lowerLimit: v })} inputMode="decimal" description="optional" />
          <Field name={`upper${String(i)}`} label={`Upper limit ${String(i + 1)}`} value={r.upperLimit} onChange={(v) => set(i, { upperLimit: v })} inputMode="decimal" description="optional" />
          <floor.ChoiceGroup
            label={`Required for release ${String(i + 1)}`}
            options={[
              { value: 'YES', label: 'Yes' },
              { value: 'NO', label: 'No' },
            ]}
            value={r.required}
            onChange={(v) => set(i, { required: v === 'YES' ? 'YES' : 'NO' })}
          />
          <floor.ChoiceGroup
            label={`Source of the limit ${String(i + 1)}`}
            options={PHARMACOPOEIAS.map((p) => ({ value: p, label: p }))}
            value={r.pharmacopoeia}
            onChange={(v) => set(i, { pharmacopoeia: PHARMACOPOEIAS.find((p) => p === v) ?? null })}
          />
          <Field name={`edition${String(i)}`} label={`Edition ${String(i + 1)}`} value={r.edition} onChange={(v) => set(i, { edition: v })} />
          <Field name={`sampleQty${String(i)}`} label={`Sample per run ${String(i + 1)}`} value={r.sampleQuantity} onChange={(v) => set(i, { sampleQuantity: v })} inputMode="decimal" />
          <Field name={`sampleUnit${String(i)}`} label={`Sample unit ${String(i + 1)}`} value={r.sampleUnit} onChange={(v) => set(i, { sampleUnit: v })} />
        </fieldset>
      ))}
      <ActButton primary={false} label="Add a test" onPress={() => setRows((rs) => [...rs, EMPTY])} />
      {problem ? <p role="alert">Not complete yet: {problem}</p> : null}
      <ActButton label="Draft the version" onPress={send} disabled={problem !== null || draft.busy} />
      <ActResult error={draft.error} done={draft.done} label="Drafted; another person approves it." />
    </Section>
  );
}

function EditionReview() {
  const q = useApiQuery(routes.specifications.editionReview);
  return (
    <Section title="Specifications citing an older edition" testId="edition-review">
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.items.length === 0 ? <p>Every specification in effect cites the edition effective now.</p> : null}
      <ul>
        {q.data?.items.map((i) => (
          <li key={`${i.specificationId}:${i.testCode}`}>
            {i.materialCode} version {i.version}, {i.testCode}: cites {i.pharmacopoeia} {i.cited}; effective now {i.effective}
          </li>
        ))}
      </ul>
    </Section>
  );
}
