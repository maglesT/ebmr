/**
 * One formula with its versions (Phase 3 slice 6, D-S6-3, D-S6-4). The composition is shown only to a reader holding
 * FORMULA.READ (DI-13: the server sends no lines otherwise, and the screen says so instead of showing them). Batch
 * quantities are the database's, computed from the per-unit composition and the batch size (INV-25): shown, never
 * typed. A new version is written as DRAFT; a second person approves it with FORMULA_APPROVED through the ceremony.
 */
import { useState } from 'react';
import { FormulaLineInput, routes, type FormulaLineView, type FormulaVersionView } from '@ebmr/api-contract';
import { Banner, Button, Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { FieldInput, type FormField } from '../../app/define-form.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { useRouteParams } from '../floor/params.ts';

/** What the screen says in place of the composition for a reader without FORMULA.READ. */
export const COMPOSITION_REFUSED = 'The composition is not shown: reading a formula needs the FORMULA.READ permission, which your role does not hold. The formula\'s identity and version states are shown.';

const REFRESH = [routes.masterData.formula.id, routes.masterData.formulas.id];

export function FormulaPage() {
  const formulaId = useRouteParams()['formulaId'] ?? '';
  const q = useApiQuery(routes.masterData.formula, { params: { formulaId } });
  const author = useOffered('FORMULA_AUTHOR');
  if (q.isPending) return <p>Loading the formula…</p>;
  if (!q.data) return q.error ? <RefusalMessage error={q.error.error} /> : null;
  const { formula, versions, compositionReadable } = q.data;
  return (
    <>
      <h1>
        Formula {formula.productName ?? formula.productCode} {formula.strength}
      </h1>
      <p>
        Product {formula.productCode}, batch size {formula.batchSizeUnits} units; latest version {formula.latestVersion}, approved version {formula.approvedVersion ?? 'none'}.
      </p>
      {!compositionReadable ? (
        <Banner tone="info" title={COMPOSITION_REFUSED} />
      ) : null}
      {versions.map((v) => (
        <VersionCard key={v.versionId} version={v} readable={compositionReadable} />
      ))}
      {author && compositionReadable ? <NewVersionForm formulaId={formula.formulaId} /> : null}
    </>
  );
}

function VersionCard({ version, readable }: { version: FormulaVersionView; readable: boolean }) {
  const approver = useOffered('FORMULA_APPROVER');
  const signed = useSignedAct(REFRESH);
  return (
    <Section title={`Version ${version.versionNumber}`} testId={`formula-version-${version.versionNumber}`}>
      <p>
        <StatusChip tone={version.state === 'APPROVED' ? 'ok' : 'neutral'} label={version.state} /> {version.changeReason} · written by {version.authoredBy.legalName}, {version.authoredAt.text}
        {version.approvedBy ? ` · approved by ${version.approvedBy.legalName}, ${version.approvedAt?.text ?? ''}` : ''}
      </p>
      {version.target ? (
        <p data-testid="formula-target">
          Target unit weight {version.target.targetUnitMassMg} mg; batch sizes {version.target.batchSizesUnits.join(', ')} units.
        </p>
      ) : null}
      {readable && version.lines ? (
        <table aria-label={`Composition of version ${version.versionNumber}`} data-testid="composition">
          <thead>
            <tr>
              <th scope="col">Line</th>
              <th scope="col">Material</th>
              <th scope="col">Role</th>
              <th scope="col">Per unit or batch</th>
              <th scope="col">Overage, salt factor</th>
              <th scope="col">Batch quantity (computed)</th>
            </tr>
          </thead>
          <tbody>
            {version.lines.map((l) => (
              <tr key={l.lineId}>
                <td>{l.lineId}</td>
                <td>
                  {l.materialName ?? ''} ({l.materialCode})
                </td>
                <td>
                  {l.role}
                  {l.potencyAdjusted ? ', potency adjusted' : ''}
                  {l.compensating ? ', compensating' : ''}
                </td>
                <td>
                  {l.quantity} {l.quantityUnit} {l.basis === 'PER_UNIT' ? 'per unit' : 'per batch'}
                </td>
                <td>{[overageWords(l), l.saltFactor ? `salt factor ${l.saltFactor}` : ''].filter(Boolean).join(', ') || '-'}</td>
                <td>
                  {l.batchQuantity} {l.batchUnit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {version.state === 'DRAFT' && approver ? (
        <>
          <ActButton
            label={`Approve version ${version.versionNumber}`}
            onPress={() => signed.sign({ kind: 'MASTER_DATA_APPROVE', masterKind: 'FORMULA', versionId: version.versionId }, `Approve formula version ${version.versionNumber}: ${version.changeReason}`)}
            disabled={signed.busy}
          />
          <ActResult error={signed.error} outcome={signed.outcome} />
        </>
      ) : null}
    </Section>
  );
}

const LINE_FIELDS: readonly FormField[] = [
  { name: 'lineId', label: 'Line id', kind: 'text' },
  { name: 'materialCode', label: 'Material code', kind: 'text', description: 'A material of Products and materials, in effect' },
  { name: 'role', label: 'Role', kind: 'choice', options: FormulaLineInput.shape.role.options },
  { name: 'basis', label: 'Basis', kind: 'choice', options: ['PER_UNIT', 'PER_BATCH'], description: 'PER_UNIT: mg in one unit (tablet or capsule); PER_BATCH: kg for the batch' },
  { name: 'quantity', label: 'Quantity', kind: 'decimal' },
  { name: 'overagePercent', label: 'Overage %', kind: 'decimal', optional: true, description: 'a deliberate excess over the label claim; the label claim stays the quantity' },
  { name: 'overageQuantity', label: 'Overage amount', kind: 'decimal', optional: true, description: 'or the excess in the line\'s unit (mg per tablet, kg per batch); not with a percent' },
  { name: 'overageReason', label: 'Reason for the overage', kind: 'text', optional: true, description: 'required with an overage, e.g. loss on storage over the shelf life' },
  { name: 'saltFactor', label: 'Salt factor', kind: 'decimal', optional: true },
  { name: 'potencyAdjusted', label: 'Potency adjusted at dispensing', kind: 'yesno', description: 'assay and LOD of the lot (TB-01); needs a compensating excipient' },
  { name: 'compensating', label: 'Compensating excipient', kind: 'yesno' },
];

/** A line's overage as the composition shows it (slice 7q, C1): percent or quantity, with its reason. */
export function overageWords(l: FormulaLineView): string {
  const pct = l.overagePercent && l.overagePercent !== '0' ? `${l.overagePercent} % overage` : '';
  const qty = l.overageQuantity ? `overage ${l.overageQuantity} ${l.quantityUnit}${l.basis === 'PER_UNIT' ? ' per unit' : ''}` : '';
  const what = pct || qty;
  return what && l.overageReason ? `${what} (${l.overageReason})` : what;
}

type Row = Record<string, string>;

function lineOf(row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of LINE_FIELDS) {
    const v = (row[f.name] ?? '').trim();
    if (v === '') continue;
    out[f.name] = f.kind === 'yesno' ? v === 'YES' : v;
  }
  return out;
}

/** The further batch sizes as typed ("50000, 150000"), as the contract's list of whole numbers. */
export function sizesOf(text: string): string[] {
  return text
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter((x) => x !== '');
}

function NewVersionForm({ formulaId }: { formulaId: string }) {
  const [rows, setRows] = useState<Row[]>([{}]);
  const [reason, setReason] = useState('');
  const [weight, setWeight] = useState('');
  const [sizes, setSizes] = useState('');
  const cmd = useCommand(routes.masterData.addFormulaVersion, REFRESH);
  const target = weight.trim() === '' ? {} : { target: { targetUnitMassMg: weight.trim(), otherBatchSizesUnits: sizesOf(sizes) } };
  const body = { changeReason: reason.trim(), lines: rows.map(lineOf), ...target };
  const parsed = routes.masterData.addFormulaVersion.body?.safeParse(body);
  const problem = !parsed ? null : parsed.success ? null : parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  const ready = parsed?.success === true;
  const send = async () => {
    if (!parsed?.success) return;
    const r = await cmd.run({ params: { formulaId }, body: parsed.data });
    if (r) {
      setRows([{}]);
      setReason('');
      setWeight('');
      setSizes('');
    }
  };
  return (
    <Section title="Write a new version" testId="new-formula-version">
      <p>Per-unit composition only: the batch quantities are computed by the database from it and the batch size, never typed.</p>
      {rows.map((row, i) => (
        <fieldset key={i} aria-label={`Line ${i + 1}`}>
          <legend>Line {i + 1}</legend>
          {LINE_FIELDS.map((f) => (
            <FieldInput key={f.name} field={{ ...f, name: `${f.name}-${i}` }} value={row[f.name] ?? ''} onChange={(v) => setRows((all) => all.map((r, j) => (j === i ? { ...r, [f.name]: v } : r)))} />
          ))}
          {rows.length > 1 ? <Button onPress={() => setRows((all) => all.filter((_, j) => j !== i))}>Remove line {i + 1}</Button> : null}
        </fieldset>
      ))}
      <Button onPress={() => setRows((all) => [...all, {}])}>Add a line</Button>
      <Field name="targetUnitMassMg" label="Target unit weight (mg)" description="optional · the target mass of one unit (a tablet's compression target, a capsule's fill)" value={weight} onChange={setWeight} inputMode="decimal" />
      <Field name="otherBatchSizes" label="Further batch sizes (units)" description="optional · besides the formula's own, separated by commas" value={sizes} onChange={setSizes} />
      <Field name="changeReason" label="Reason for the new version" value={reason} onChange={setReason} />
      {problem ? <p>Not complete yet: {problem}</p> : null}
      <ActButton label="Write the draft version" onPress={send} disabled={!ready || cmd.busy} />
      <ActResult error={cmd.error} done={cmd.done} label="Draft version written." />
    </Section>
  );
}
