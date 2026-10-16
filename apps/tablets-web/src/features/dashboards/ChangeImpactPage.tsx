/**
 * The change-impact explorer (Phase 6 slice 6g; extra rank 9; D-P6g-0-8): for a proposed change of a material,
 * specification, equipment, MBR version, rule-table site value or supplier, the MBR versions, open batches, released
 * lots, markets and configuration history it reaches, read-only, with an export (JSON with the server's content hash)
 * for the change record. Every row is the database's (recipe.change_impact).
 */
import { useState } from 'react';
import { routes, type ChangeImpactItem, type ChangeImpactKind, type ChangeImpactView } from '@ebmr/api-contract';
import { Field, floor } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, Section } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { Drill } from './DashboardsPage.tsx';

const KINDS: readonly { value: ChangeImpactKind; label: string; hint: string }[] = [
  { value: 'MATERIAL', label: 'Material', hint: 'Material code' },
  { value: 'SPECIFICATION', label: 'Specification', hint: 'Specification id' },
  { value: 'EQUIPMENT', label: 'Equipment', hint: 'Equipment code' },
  { value: 'MBR_VERSION', label: 'MBR version', hint: 'MBR version id' },
  { value: 'SITE_VALUE', label: 'Rule-table site value', hint: 'Site value key' },
  { value: 'SUPPLIER', label: 'Supplier', hint: 'Manufacturer code' },
];

/** The export of an impact for the change record: the server's view as JSON (its content hash included). */
export function impactExportHref(v: ChangeImpactView): string {
  return `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(v, null, 2))}`;
}

export function ChangeImpactPage() {
  const [kind, setKind] = useState<ChangeImpactKind>('MATERIAL');
  const [ref, setRef] = useState('');
  const [asked, setAsked] = useState<{ kind: ChangeImpactKind; ref: string } | null>(null);
  const hint = KINDS.find((k) => k.value === kind)?.hint ?? 'Code';
  return (
    <>
      <h1>Change impact</h1>
      <p>What a proposed change would reach: MBR versions, open batches, released lots and markets. Read-only; export it for the change record.</p>
      <Section title="Proposed change" testId="impact-ask">
        <floor.ChoiceGroup label="What changes" options={KINDS.map((k) => ({ value: k.value, label: k.label }))} value={kind} onChange={(v) => setKind(KINDS.find((k) => k.value === v)?.value ?? 'MATERIAL')} />
        <Field name="impactRef" label={hint} value={ref} onChange={setRef} />
        <ActButton label="Show impact" disabled={ref.trim() === ''} onPress={() => setAsked({ kind, ref: ref.trim() })} />
      </Section>
      {asked ? <ImpactResult asked={asked} /> : null}
    </>
  );
}

function ImpactResult({ asked }: { asked: { kind: ChangeImpactKind; ref: string } }) {
  const q = useApiQuery(routes.changeImpact.query, { query: asked });
  if (q.error) return <RefusalMessage error={q.error.error} />;
  const v = q.data;
  if (!v) return <p>Working out the impact…</p>;
  return (
    <Section title={`Impact of a change to ${v.ref}`} testId="impact-result">
      <p data-testid="impact-summary">
        As of {v.generatedAt.text}: {v.counts.versions.toString()} MBR version(s), {v.counts.openBatches.toString()} open batch(es), {v.counts.releasedLots.toString()} released lot(s),{' '}
        {v.counts.markets.toString()} market(s). Content hash {v.contentHash}.
      </p>
      <p>
        <a href={impactExportHref(v)} download={`change-impact-${v.kind.toLowerCase()}-${v.contentHash.slice(0, 12)}.json`} data-testid="impact-export">
          Export for the change record
        </a>
      </p>
      <ImpactList title="MBR versions" items={v.versions} testId="impact-versions" />
      <ImpactList title="Open batches" items={v.openBatches} testId="impact-batches" />
      <ImpactList title="Released lots" items={v.releasedLots} testId="impact-lots" />
      <ImpactList title="Markets" items={v.markets} testId="impact-markets" />
      {v.configHistory.length > 0 ? <ImpactList title="Configuration history" items={v.configHistory} testId="impact-config" /> : null}
    </Section>
  );
}

function ImpactList({ title, items, testId }: { title: string; items: readonly ChangeImpactItem[]; testId: string }) {
  return (
    <>
      <h3>{title}</h3>
      {items.length === 0 ? <p data-testid={`${testId}-none`}>None.</p> : null}
      <ul data-testid={testId}>
        {items.map((i) => (
          <li key={`${i.id ?? ''}-${i.label}`}>
            <Drill to={i.drill}>{i.label}</Drill>
            {i.detail ? ` · ${i.detail}` : ''}
            {i.via ? ` · via ${i.via}` : ''}
          </li>
        ))}
      </ul>
    </>
  );
}
