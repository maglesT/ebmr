/**
 * Specifications (Phase 4 slice 2c screens, on slice 2b's contract ns/specifications.ts): the specification versions of
 * the site per material, each test with its limits, the pharmacopoeia and edition the limit comes from (IN-33), whether
 * it is required for release and the sample one run takes; a new version drafted by QC and approved by another person
 * through the ceremony (LIMS_ACT SPECIFICATION_APPROVE); a pharmacopoeia edition marked effective by QA and the review
 * list of specifications citing an older edition. Limits are typed here only into a draft; a result never carries them
 * (they are the specification's). Every rule is the database's.
 *
 * Phase 7 slice 7p: a test may be a profile (e.g. the dissolution profile of a sustained-release tablet, or the acid and
 * buffer stages of a delayed-release one): its ordered time points each carry their own limits and, for a two-stage
 * test, the stage. A new version can start from an existing one (its tests copied into the draft form).
 */
import { useState } from 'react';
import { routes, SpecificationTestInput, type ProfilePointView, type SpecificationView } from '@ebmr/api-contract';
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
  // Slice 7p: the version a new draft starts from (its tests copied), and a counter that resets the form for it.
  const [seed, setSeed] = useState<{ spec: SpecificationView; n: number } | null>(null);
  return (
    <>
      <h1>Specifications</h1>
      <Field name="materialFilter" label="Material code" value={material} onChange={setMaterial} description="Show one material's versions (empty: all)" />
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.specifications.length === 0 ? <p>No specification recorded.</p> : null}
      {q.data?.specifications.map((s) => (
        <SpecificationCard key={s.specificationId} s={s} canApprove={qc || qa} onCopy={qc ? () => setSeed((x) => ({ spec: s, n: (x?.n ?? 0) + 1 })) : undefined} />
      ))}
      {qc ? <DraftForm key={seed ? `${seed.spec.specificationId}:${String(seed.n)}` : 'blank'} seed={seed?.spec ?? null} /> : null}
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

function limitsText(lower: string | null | undefined, upper: string | null | undefined): string {
  return [lower ? `from ${lower}` : '', upper ? `to ${upper}` : ''].filter(Boolean).join(' ') || 'none';
}

/** The time points of a profile test, in order, each with its own limits (and its stage in a two-stage test). */
function PointsTable({ testCode, unit, points }: { testCode: string; unit: string; points: readonly ProfilePointView[] }) {
  const staged = points.some((p) => p.stage);
  return (
    <table aria-label={`Time points of ${testCode}`} data-testid={`points-${testCode}`}>
      <thead>
        <tr>
          <th scope="col">Point</th>
          {staged ? <th scope="col">Stage</th> : null}
          <th scope="col">Time</th>
          <th scope="col">Limits</th>
        </tr>
      </thead>
      <tbody>
        {points.map((p) => (
          <tr key={p.pointNo}>
            <td>{p.label}</td>
            {staged ? <td>{p.stage ?? ''}</td> : null}
            <td>
              {p.timeValue} {p.timeUnit}
            </td>
            <td>
              {limitsText(p.lowerLimit, p.upperLimit)} {unit}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SpecificationCard({ s, canApprove, onCopy }: { s: SpecificationView; canApprove: boolean; onCopy?: (() => void) | undefined }) {
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
              <td>{t.points ? `profile of ${String(t.points.length)} time points (below)` : `${limitsText(t.lowerLimit, t.upperLimit)} ${t.unit}`}</td>
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
      {s.tests.map((t) => (t.points ? <PointsTable key={t.testCode} testCode={t.testCode} unit={t.unit} points={t.points} /> : null))}
      {onCopy ? <ActButton primary={false} label={`Start a new version from ${s.materialCode} version ${String(s.version)}`} onPress={onCopy} /> : null}
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

interface PointRow {
  label: string;
  stage: string;
  timeValue: string;
  timeUnit: 'min' | 'h' | null;
  lowerLimit: string;
  upperLimit: string;
}

const EMPTY_POINT: PointRow = { label: '', stage: '', timeValue: '', timeUnit: null, lowerLimit: '', upperLimit: '' };

interface TestRow {
  /** Slice 7p: a profile's limits are on its time points. */
  profile: boolean;
  points: PointRow[];
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

const EMPTY: TestRow = {
  profile: false, points: [EMPTY_POINT, EMPTY_POINT], testCode: '', methodReference: '', unit: '', lowerLimit: '', upperLimit: '', required: null, pharmacopoeia: null, edition: '',
  sampleQuantity: '', sampleUnit: '',
};

function pointInput(p: PointRow): Record<string, unknown> {
  return {
    label: p.label.trim(),
    ...(p.stage.trim() ? { stage: p.stage.trim() } : {}),
    timeValue: p.timeValue.trim(),
    timeUnit: p.timeUnit,
    ...(p.lowerLimit.trim() ? { lowerLimit: p.lowerLimit.trim() } : {}),
    ...(p.upperLimit.trim() ? { upperLimit: p.upperLimit.trim() } : {}),
  };
}

/** The draft rows of an existing version (slice 7p: a new version starts from it). */
function rowsOf(s: SpecificationView): TestRow[] {
  return s.tests.map((t) => ({
    profile: t.points !== undefined,
    points: t.points?.map((p) => ({ label: p.label, stage: p.stage ?? '', timeValue: p.timeValue, timeUnit: p.timeUnit, lowerLimit: p.lowerLimit ?? '', upperLimit: p.upperLimit ?? '' })) ?? [EMPTY_POINT, EMPTY_POINT],
    testCode: t.testCode,
    methodReference: t.methodReference,
    unit: t.unit,
    lowerLimit: t.lowerLimit ?? '',
    upperLimit: t.upperLimit ?? '',
    required: t.required ? 'YES' : 'NO',
    pharmacopoeia: t.pharmacopoeia,
    edition: t.edition,
    sampleQuantity: t.sampleQuantity,
    sampleUnit: t.sampleUnit,
  }));
}

function toInput(r: TestRow): Record<string, unknown> {
  return {
    testCode: r.testCode.trim().toUpperCase(),
    methodReference: r.methodReference.trim(),
    unit: r.unit.trim(),
    ...(!r.profile && r.lowerLimit.trim() ? { lowerLimit: r.lowerLimit.trim() } : {}),
    ...(!r.profile && r.upperLimit.trim() ? { upperLimit: r.upperLimit.trim() } : {}),
    ...(r.profile ? { points: r.points.map(pointInput) } : {}),
    required: r.required === 'YES',
    pharmacopoeia: r.pharmacopoeia,
    edition: r.edition.trim(),
    sampleQuantity: r.sampleQuantity.trim(),
    sampleUnit: r.sampleUnit.trim(),
  };
}

/** The time points of one profile test in the draft form. */
function PointRows({ i, r, setPoint, addPoint }: { i: number; r: TestRow; setPoint: (k: number, patch: Partial<PointRow>) => void; addPoint: () => void }) {
  return (
    <>
      {r.points.map((p, k) => {
        const n = `${String(k + 1)} of test ${String(i + 1)}`;
        return (
          <fieldset key={k} data-testid={`spec-test-${String(i)}-point-${String(k)}`}>
            <legend>Time point {n}</legend>
            <Field name={`pointLabel${String(i)}_${String(k)}`} label={`Label of point ${n}`} value={p.label} onChange={(v) => setPoint(k, { label: v })} description="e.g. 1 h" />
            <Field name={`pointStage${String(i)}_${String(k)}`} label={`Stage of point ${n}`} value={p.stage} onChange={(v) => setPoint(k, { stage: v })} description="two-stage tests only, e.g. Acid 0.1 M HCl; empty otherwise" />
            <Field name={`pointTime${String(i)}_${String(k)}`} label={`Time of point ${n}`} value={p.timeValue} onChange={(v) => setPoint(k, { timeValue: v })} inputMode="decimal" />
            <floor.ChoiceGroup
              label={`Time unit of point ${n}`}
              options={[
                { value: 'min', label: 'min' },
                { value: 'h', label: 'h' },
              ]}
              value={p.timeUnit}
              onChange={(v) => setPoint(k, { timeUnit: v === 'h' ? 'h' : 'min' })}
            />
            <Field name={`pointLower${String(i)}_${String(k)}`} label={`Lower limit of point ${n}`} value={p.lowerLimit} onChange={(v) => setPoint(k, { lowerLimit: v })} inputMode="decimal" description="optional" />
            <Field name={`pointUpper${String(i)}_${String(k)}`} label={`Upper limit of point ${n}`} value={p.upperLimit} onChange={(v) => setPoint(k, { upperLimit: v })} inputMode="decimal" description="optional" />
          </fieldset>
        );
      })}
      <ActButton primary={false} label={`Add a time point to test ${String(i + 1)}`} onPress={addPoint} />
    </>
  );
}

/** A new version of a material's specification (QC), checked against the contract before it is sent. */
function DraftForm({ seed }: { seed: SpecificationView | null }) {
  const [material, setMaterial] = useState(seed?.materialCode ?? '');
  const [title, setTitle] = useState(seed?.title ?? '');
  const [monograph, setMonograph] = useState(seed?.monographReference ?? '');
  const [rows, setRows] = useState<TestRow[]>(seed ? rowsOf(seed) : [EMPTY]);
  const draft = useCommand(routes.specifications.draft, READS, 'drafting a specification');
  const body = { materialCode: material.trim().toUpperCase(), title: title.trim(), monographReference: monograph.trim(), tests: rows.map(toInput) };
  const problems = SpecificationTestInput.array().min(1).safeParse(body.tests);
  const header = body.materialCode !== '' && body.title !== '' && body.monographReference !== '';
  const problem = !header ? 'material code, title and monograph reference are needed' : problems.success ? null : problems.error.issues.map((i) => `test ${i.path.join('.')}: ${i.message}`).join('; ');
  const set = (i: number, patch: Partial<TestRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setPoint = (i: number, k: number, patch: Partial<PointRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, points: r.points.map((p, m) => (m === k ? { ...p, ...patch } : p)) } : r)));
  const send = async () => {
    if (!problems.success) return;
    const r = await draft.run({ body: { ...body, tests: problems.data } });
    if (r) setRows([EMPTY]);
  };
  return (
    <Section title="Draft a specification version" testId="draft-specification">
      {seed ? <p>Starting from {seed.materialCode} version {seed.version}: change what the new version changes.</p> : null}
      <Field name="specMaterial" label="Material code" value={material} onChange={setMaterial} />
      <Field name="specTitle" label="Title" value={title} onChange={setTitle} />
      <Field name="specMonograph" label="Monograph reference" value={monograph} onChange={setMonograph} description="e.g. IP 2022 monograph, or the in-house document and version" />
      {rows.map((r, i) => (
        <fieldset key={i} data-testid={`spec-test-${String(i)}`}>
          <legend>Test {i + 1}</legend>
          <Field name={`testCode${String(i)}`} label={`Test code ${String(i + 1)}`} value={r.testCode} onChange={(v) => set(i, { testCode: v })} />
          <Field name={`method${String(i)}`} label={`Method ${String(i + 1)}`} value={r.methodReference} onChange={(v) => set(i, { methodReference: v })} />
          <Field name={`unit${String(i)}`} label={`Unit ${String(i + 1)}`} value={r.unit} onChange={(v) => set(i, { unit: v })} />
          <floor.ChoiceGroup
            label={`Kind of test ${String(i + 1)}`}
            options={[
              { value: 'SINGLE', label: 'One result' },
              { value: 'PROFILE', label: 'Profile (time points)' },
            ]}
            value={r.profile ? 'PROFILE' : 'SINGLE'}
            onChange={(v) => set(i, { profile: v === 'PROFILE' })}
          />
          {r.profile ? (
            <PointRows i={i} r={r} setPoint={(k, patch) => setPoint(i, k, patch)} addPoint={() => set(i, { points: [...r.points, EMPTY_POINT] })} />
          ) : (
            <>
              <Field name={`lower${String(i)}`} label={`Lower limit ${String(i + 1)}`} value={r.lowerLimit} onChange={(v) => set(i, { lowerLimit: v })} inputMode="decimal" description="optional" />
              <Field name={`upper${String(i)}`} label={`Upper limit ${String(i + 1)}`} value={r.upperLimit} onChange={(v) => set(i, { upperLimit: v })} inputMode="decimal" description="optional" />
            </>
          )}
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
      <h3>Master records citing an older edition</h3>
      {q.data && q.data.mbrs.length === 0 ? <p>No master record cites an edition older than the one effective now.</p> : null}
      <ul data-testid="edition-review-mbrs">
        {q.data?.mbrs.map((i) => (
          <li key={`${i.versionId}:${i.citedIn}:${i.pharmacopoeia}`}>
            {i.familyCode} version {i.versionNumber} ({i.state ?? 'no state'}), {i.citedIn}: cites {i.pharmacopoeia} {i.cited}; effective now {i.effective}
          </li>
        ))}
      </ul>
    </Section>
  );
}
