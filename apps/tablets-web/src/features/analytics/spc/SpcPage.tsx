/**
 * The control chart screen (Phase 6A slice 6A-2; /analytics/spc?product&family&item; D-6A-7, D-6A-8): the chart of a
 * critical item of a product and MBR family as the last run recorded it, with where its limits come from (Phase I or an
 * approved reference set), the master's specification limits as their decimal text, each point's recorded value, the
 * run-rule hits and drift flags with their reasons, and the capability panel (Cpk and Ppk with intervals, shown from 25
 * batches, with the normality note). Advisory only: a point links to its batch's record, where decisions are taken.
 */
import { useState } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import { routes, type CapabilityView, type SpcChartView } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../../app/acts.tsx';
import { RefusalMessage } from '../../../app/refusal.tsx';
import { useOffered } from '../../../app/roles.ts';
import { ANALYTICS_READS, AdvisoryBand, Stat } from '../shared.tsx';
import { ControlPlot, type ChartLine } from './charts.tsx';

type Query = { product: string; family: string; item: string };

function searchOf(search: unknown): Query {
  const s = (typeof search === 'object' && search !== null ? search : {}) as Record<string, unknown>;
  const t = (k: string): string => (typeof s[k] === 'string' ? s[k] : '');
  return { product: t('product'), family: t('family'), item: t('item') };
}

const SOURCE = { PHASE_I: 'Phase I limits from the first batches (no approved reference set)', REFERENCE_SET: 'Limits from the approved reference set' } as const;

function specLines(v: SpcChartView): ChartLine[] {
  const out: ChartLine[] = [];
  // The master's limits are drawn where they are stated: the text is parsed only to place the line (a screen
  // coordinate); the label and every echo show the master's own decimal text.
  if (v.specification.lower !== null) out.push({ value: Number(v.specification.lower), label: `LSL ${v.specification.lower}`, kind: 'specification' });
  if (v.specification.upper !== null) out.push({ value: Number(v.specification.upper), label: `USL ${v.specification.upper}`, kind: 'specification' });
  return out;
}

/**
 * Slice 6A-3 (D-6A-3-7): the reference set the limits come from, or, with Phase I limits, QA makes them the chart's
 * reference set under a change record approved for ANALYTICS_REFERENCE; the next run then charts against it.
 */
function ReferenceLimits({ v }: { v: SpcChartView }) {
  const qa = useOffered('QA');
  const set = useCommand(routes.analyticsConfig.setReferenceSet, [...ANALYTICS_READS, routes.analyticsSpc.chart.id]);
  const [cr, setCr] = useState('');
  const [reason, setReason] = useState('');
  if (v.referenceSet) return <p data-testid="analytics-spc-reference-set">Reference set {v.referenceSet} in force.</p>;
  const c = v.candidate;
  if (!c) return null;
  const ok = cr.trim() !== '' && reason.trim() !== '';
  return (
    <Section title="Reference limits" testId="analytics-spc-candidate">
      <p>The Phase I limits of the first {c.batches.toString()} batches (model {c.modelSha256.slice(0, 12)}…) can become this chart&apos;s reference set.</p>
      {qa ? (
        <div>
          <Field name="spcCr" label="Change-record number (ANALYTICS_REFERENCE)" value={cr} onChange={setCr} />
          <Field name="spcReason" label="Reason" value={reason} onChange={setReason} />
          <ActButton
            label="Make these limits the reference set"
            disabled={!ok || set.busy}
            onPress={() => (ok ? set.run({
              body: {
                method: v.chart === 'IMR' ? 'SPC.IMR' : 'SPC.XBAR_S', scope: { product: v.product, family: v.family, item: v.item, chart: v.chart }, batchIds: c.batchIds,
                candidateOutput: c.outputId, status: 'EFFECTIVE', changeRecord: cr.trim(), reason: reason.trim(),
              },
            }) : undefined)}
          />
          <ActResult error={set.error} done={set.done} label="The reference set is in force under the change record; the next run charts against it." />
        </div>
      ) : null}
    </Section>
  );
}

function Chart({ v }: { v: SpcChartView }) {
  const marked = v.points.map((p) => p.rules.length > 0);
  const spreads = v.points.flatMap((p) => (p.spread === null ? [] : [p.spread]));
  return (
    <>
      <AdvisoryBand v={v} />
      <p data-testid="analytics-spc-source">
        <StatusChip tone={v.limitsSource === 'PHASE_I' ? 'pending' : 'ok'} label={SOURCE[v.limitsSource]} /> {v.chart === 'IMR' ? 'Individuals and moving range' : 'Mean and standard deviation'} chart of{' '}
        {v.points.length.toString()} batches.
      </p>
      <ReferenceLimits v={v} />
      <p data-testid="analytics-spc-specification">
        Master&apos;s specification ({v.specification.unit}): lower {v.specification.lower ?? 'none'}, target {v.specification.target ?? 'none'}, upper {v.specification.upper ?? 'none'}.
      </p>
      <ControlPlot
        testId="analytics-spc-chart"
        title={`${v.item}: ${v.chart === 'IMR' ? 'individual values' : 'subgroup means'} (advisory)`}
        values={v.points.map((p) => p.plotted)}
        marked={marked}
        lines={[
          { value: v.centre, label: 'centre', kind: 'centre' },
          { value: v.upperControl, label: 'UCL', kind: 'control' },
          { value: v.lowerControl, label: 'LCL', kind: 'control' },
          ...specLines(v),
        ]}
      />
      {v.spreadChart && spreads.length > 0 ? (
        <ControlPlot
          title={`${v.spreadChart.kind === 'MR' ? 'Moving range' : 'Subgroup standard deviation'} (advisory)`}
          values={spreads}
          marked={spreads.map(() => false)}
          lines={[{ value: v.spreadChart.centre, label: 'centre', kind: 'centre' }, { value: v.spreadChart.upper, label: 'UCL', kind: 'control' }, ...(v.spreadChart.lower > 0 ? [{ value: v.spreadChart.lower, label: 'LCL', kind: 'control' as const }] : [])]}
        />
      ) : null}
      <Section title="Rule hits and drift alerts" testId="analytics-spc-flags">
        {v.flags.length === 0 ? <p>No run rule or drift alert.</p> : (
          <ul>
            {v.flags.map((f) => (
              <li key={f.flagId} data-testid={`analytics-spc-flag-${f.rule}`}>
                <strong>{f.rule}</strong> ({f.method.id} version {f.method.version.toString()}){f.disposition ? ` · dispositioned: ${f.disposition.verdict}` : ' · open'}
                <ul>{f.reasons.map((r, k) => <li key={k}>{r.text}</li>)}</ul>
              </li>
            ))}
          </ul>
        )}
        <p><Link to="/analytics/flags">Disposition the open flags</Link></p>
      </Section>
      <Section title="Points" testId="analytics-spc-points">
        <table>
          <thead><tr><th>Batch</th><th>Completed</th><th>Recorded value</th><th>Plotted</th><th>Spread</th><th>Rules</th></tr></thead>
          <tbody>
            {v.points.map((p) => (
              <tr key={p.batchId}>
                <td>{p.drill ? <a href={p.drill}>{p.batchNumber}</a> : p.batchNumber}</td>
                <td>{p.completedAt.text}</td>
                <td>{p.value ?? 'subgroup'}</td>
                <td><Stat value={p.plotted} /></td>
                <td><Stat value={p.spread} /></td>
                <td>{p.rules.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </>
  );
}

function Capability({ c }: { c: CapabilityView }) {
  return (
    <Section title="Capability" testId="analytics-spc-capability">
      {!c.shown ? <p>Not shown: {c.notShownReason}</p> : (
        <>
          <p>
            Cpk <Stat value={c.cpk?.value ?? null} />, interval <Stat value={c.cpk?.lower ?? null} /> to <Stat value={c.cpk?.upper ?? null} />; Ppk <Stat value={c.ppk?.value ?? null} />, interval{' '}
            <Stat value={c.ppk?.lower ?? null} /> to <Stat value={c.ppk?.upper ?? null} /> ({((c.cpk?.confidence ?? 0) * 100).toPrecision(3)} %, Bissell), from {c.batches.toString()} batches.
          </p>
          {c.normality ? <p data-testid="analytics-spc-normality">{c.normality.note} (Anderson-Darling <Stat value={c.normality.andersonDarling} />)</p> : null}
        </>
      )}
    </Section>
  );
}

export function SpcPage() {
  const initial = searchOf(useSearch({ strict: false }));
  const [form, setForm] = useState<Query>(initial);
  const [asked, setAsked] = useState<Query | null>(initial.product && initial.family && initial.item ? initial : null);
  const chart = useApiQuery(routes.analyticsSpc.chart, { query: asked ?? { product: '-', family: '-', item: '-' } }, { enabled: asked !== null });
  const cap = useApiQuery(routes.analyticsSpc.capability, { query: asked ?? { product: '-', family: '-', item: '-' } }, { enabled: asked !== null });
  const ok = form.product.trim() !== '' && form.family.trim() !== '' && form.item.trim() !== '';
  return (
    <>
      <h1>Control charts</h1>
      {asked === null ? <AdvisoryBand v={{ method: null, dataAgeSeconds: 0 }} /> : null}
      <Section title="Which item" testId="analytics-spc-filter">
        <Field name="spcProduct" label="Product code" value={form.product} onChange={(product) => setForm({ ...form, product })} />
        <Field name="spcFamily" label="MBR family" value={form.family} onChange={(family) => setForm({ ...form, family })} />
        <Field name="spcItem" label="Critical item" value={form.item} onChange={(item) => setForm({ ...form, item })} />
        <ActButton label="Show" disabled={!ok} onPress={() => setAsked({ product: form.product.trim(), family: form.family.trim(), item: form.item.trim() })} />
        <p><Link to="/analytics/rates">Deviation rates</Link></p>
      </Section>
      {chart.error ? <RefusalMessage error={chart.error.error} /> : null}
      {chart.data ? <Chart v={chart.data} /> : null}
      {cap.data ? <Capability c={cap.data} /> : null}
    </>
  );
}
