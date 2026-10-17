/**
 * The deviation-rate screen (Phase 6A slice 6A-2; /analytics/rates?product&by&from&to; D-6A-10): the share of a
 * product's batches with a deviation per step, unit, room, material lot, supplier or shift, each with its Wilson interval,
 * the deviations per 100 batches with their exact Poisson interval, the comparison with the rest (one-sided Fisher p,
 * Benjamini-Hochberg q at 10 %), the funnel against the comparison limits, and the groups not compared with why.
 * Advisory only: a group above the rest is a pointer for QA, not a finding.
 */
import { useState } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import { routes, type RatesView } from '@ebmr/api-contract';
import { Field, StatusChip, floor } from '@ebmr/ui-kit';
import { useApiQuery } from '../../../api/hooks.ts';
import { ActButton, Section } from '../../../app/acts.tsx';
import { RefusalMessage } from '../../../app/refusal.tsx';
import { AdvisoryBand, Stat } from '../shared.tsx';
import { FunnelPlot } from './charts.tsx';

const BY = ['ROOM', 'EQUIPMENT', 'STEP', 'MATERIAL_LOT', 'SUPPLIER', 'SHIFT'] as const;
type By = (typeof BY)[number];
const LABEL: Readonly<Record<By, string>> = { ROOM: 'Room', EQUIPMENT: 'Equipment', STEP: 'Step', MATERIAL_LOT: 'Material lot', SUPPLIER: 'Supplier', SHIFT: 'Shift' };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const pct = (x: number): string => `${(x * 100).toPrecision(3)} %`;

type Query = { product: string; by: By; from?: string; to?: string };

function Rates({ v }: { v: RatesView }) {
  return (
    <>
      <AdvisoryBand v={v} />
      <p data-testid="analytics-rates-overall">
        {LABEL[v.by]} groups of {v.product}, batches completed {v.period.from} to {v.period.to}: a deviation attributed within the grouping on {v.overall.withDeviation.toString()} of{' '}
        {v.overall.batches.toString()} batches ({pct(v.overall.share)}).
        {v.overall.unattributedDeviations ? ` ${v.overall.unattributedDeviations.toString()} deviation(s) linked to a batch only are not attributed to a group.` : ''}
      </p>
      <FunnelPlot
        title="Share of batches with a deviation against the group's size, with the comparison limits (advisory)"
        overall={v.overall.share}
        groups={v.groups.map((g) => ({ group: g.group, batches: g.batches, share: g.share.value, above: g.above, lower: g.funnel?.lower ?? 0, upper: g.funnel?.upper ?? 1 }))}
      />
      <Section title="Groups" testId="analytics-rates-groups">
        <table>
          <thead><tr><th>{LABEL[v.by]}</th><th>Batches</th><th>With a deviation</th><th>Share (interval)</th><th>Per 100 batches (interval)</th><th>p</th><th>q</th><th /></tr></thead>
          <tbody>
            {v.groups.map((g) => (
              <tr key={g.group} data-testid={`analytics-rate-${g.group}`}>
                <td>{g.group}</td>
                <td>{g.batches.toString()}</td>
                <td>{g.withDeviation.toString()}</td>
                <td><Stat value={g.share.value} /> (<Stat value={g.share.lower} /> to <Stat value={g.share.upper} />)</td>
                <td><Stat value={g.per100.value} /> (<Stat value={g.per100.lower} /> to <Stat value={g.per100.upper} />)</td>
                <td><Stat value={g.pValue} /></td>
                <td><Stat value={g.qValue} /></td>
                <td>{g.above ? <StatusChip tone="warning" label="Above the rest" /> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {v.skipped.length > 0 ? <p data-testid="analytics-rates-skipped">Not compared: {v.skipped.map((s) => `${s.subject} (${s.reason})`).join('; ')}.</p> : null}
      </Section>
      <Section title="Flags" testId="analytics-rates-flags">
        {v.flags.length === 0 ? <p>No group above the rest.</p> : <ul>{v.flags.map((f) => <li key={f.flagId}>{f.reasons.map((r) => r.text).join(' ')}</li>)}</ul>}
        <p><Link to="/analytics/flags">Disposition the open flags</Link></p>
      </Section>
    </>
  );
}

export function RatesPage() {
  const raw: unknown = useSearch({ strict: false });
  const search: Record<string, unknown> = typeof raw === 'object' && raw !== null ? { ...raw } : {};
  const initialBy = BY.find((b) => b === search['by']) ?? 'ROOM';
  const [product, setProduct] = useState(typeof search['product'] === 'string' ? search['product'] : '');
  const [by, setBy] = useState<By>(initialBy);
  const day = (k: string): string => (typeof search[k] === 'string' && DATE.test(search[k]) ? search[k] : '');
  const [from, setFrom] = useState(day('from'));
  const [to, setTo] = useState(day('to'));
  const [asked, setAsked] = useState<Query | null>(typeof search['product'] === 'string' && search['product'] !== ''
    ? { product: search['product'], by: initialBy, ...(day('from') ? { from: day('from') } : {}), ...(day('to') ? { to: day('to') } : {}) }
    : null);
  const q = useApiQuery(routes.analyticsSpc.rates, { query: asked ?? { product: '-', by: 'ROOM' } }, { enabled: asked !== null });
  const ok = product.trim() !== '' && (from === '' || DATE.test(from)) && (to === '' || DATE.test(to));
  return (
    <>
      <h1>Deviation rates</h1>
      {asked === null ? <AdvisoryBand v={{ method: null, dataAgeSeconds: 0 }} /> : null}
      <Section title="Which product and grouping" testId="analytics-rates-filter">
        <Field name="ratesProduct" label="Product code" value={product} onChange={setProduct} />
        <floor.ChoiceGroup label="Grouping" options={BY.map((b) => ({ value: b, label: LABEL[b] }))} value={by} onChange={(x) => setBy(BY.find((b) => b === x) ?? 'ROOM')} />
        <Field name="ratesFrom" label="Completed from (YYYY-MM-DD; empty: the newest comparison)" value={from} onChange={setFrom} />
        <Field name="ratesTo" label="Completed to (YYYY-MM-DD)" value={to} onChange={setTo} />
        <ActButton label="Show" disabled={!ok} onPress={() => setAsked({ product: product.trim(), by, ...(from ? { from } : {}), ...(to ? { to } : {}) })} />
        <p><Link to="/analytics/spc">Control charts</Link></p>
      </Section>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data ? <Rates v={q.data} /> : null}
    </>
  );
}
