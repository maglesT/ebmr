/**
 * The dashboards (Phase 6 slice 6g; outline 7.3; D-P6g-0-3 to 7): right first time, exception Pareto, review cycle time,
 * deviation ageing, hold-time risk, overdue periodic reviews (PR-05), press OEE and the alarm trend (DI-49). Each tile
 * shows when its data was current and how old it is, refreshes every five minutes and on demand, and drills to the
 * record. The dashboards inform; they are never used for GMP decisions. Every value is the server's text.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes } from '@ebmr/api-contract';
import { Banner, Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, Section, useRefresh } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { ReportExport } from './ReportExport.tsx';

/** The reads of this page (route ids), refreshed together. */
export const DASHBOARD_READS: readonly string[] = [
  routes.dashboards.rightFirstTime.id, routes.dashboards.exceptionPareto.id, routes.dashboards.reviewCycleTime.id, routes.dashboards.deviationAgeing.id,
  routes.dashboards.holdTimeRisk.id, routes.dashboards.overdueReviews.id, routes.dashboards.pressOee.id, routes.dashboards.alarmTrend.id,
];

/** How often the tiles read again on their own. */
export const REFRESH_MS = 5 * 60 * 1000;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A drill path as a link (the server gives the path of the record screen). */
export function Drill({ to, children }: { to: string | null; children: React.ReactNode }) {
  return to === null ? <>{children}</> : <Link to={to}>{children}</Link>;
}

/** The data age line every tile shows. */
export function DataAgeLine({ v, testId }: { v: { dataAsOf: { text: string }; readAt: { text: string }; dataAgeSeconds: number }; testId: string }) {
  return (
    <p className="data-age" data-testid={`${testId}-age`}>
      Data as of {v.dataAsOf.text} (age {v.dataAgeSeconds.toString()} s); read {v.readAt.text}.
    </p>
  );
}

export function DashboardsPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [asked, setAsked] = useState<{ from?: string; to?: string }>({});
  const refresh = useRefresh(DASHBOARD_READS);
  const ok = (from === '' || DATE.test(from)) && (to === '' || DATE.test(to));
  return (
    <>
      <h1>Dashboards</h1>
      <Banner tone="info" title="For information only">
        These dashboards are never used for GMP decisions: decisions are taken on the batch records, deviations and reviews they link to.
      </Banner>
      <Section title="Period" testId="dashboards-period">
        <Field name="dashFrom" label="From (YYYY-MM-DD; empty: 90 days ago)" value={from} onChange={setFrom} />
        <Field name="dashTo" label="To (YYYY-MM-DD; empty: today)" value={to} onChange={setTo} />
        <ActButton label="Show" disabled={!ok} onPress={() => setAsked({ ...(from ? { from } : {}), ...(to ? { to } : {}) })} />
        <ActButton label="Refresh now" primary={false} onPress={() => refresh()} />
      </Section>
      <RightFirstTimeTile period={asked} />
      <ExceptionParetoTile period={asked} />
      <ReviewCycleTile period={asked} />
      <DeviationAgeingTile />
      <HoldTimeTile />
      <OverdueReviewsTile />
      <PressOeeTile period={asked} />
      <AlarmTrendTile period={asked} />
      <ReportExport />
    </>
  );
}

const live = { refetchInterval: REFRESH_MS } as const;

function RightFirstTimeTile({ period }: { period: { from?: string; to?: string } }) {
  const q = useApiQuery(routes.dashboards.rightFirstTime, { query: period }, live);
  if (q.error) return <RefusalMessage error={q.error.error} />;
  const v = q.data;
  if (!v) return <p>Reading right first time…</p>;
  return (
    <Section title="Right first time" testId="dash-rft">
      <DataAgeLine v={v} testId="dash-rft" />
      <p data-testid="dash-rft-summary">
        {v.period.from} to {v.period.to}: {v.summary.rightFirstTime.toString()} of {v.summary.batches.toString()} batch(es) right first time
        {v.summary.rate === null ? '' : ` (rate ${v.summary.rate})`}.
      </p>
      <table>
        <thead><tr><th>Day</th><th>QA reviewed</th><th>Right first time</th></tr></thead>
        <tbody>{v.runChart.map((d) => <tr key={d.day}><td>{d.day}</td><td>{d.batches.toString()}</td><td>{d.rightFirstTime.toString()}</td></tr>)}</tbody>
      </table>
      <ul>
        {v.batches.map((b) => (
          <li key={b.batchId} data-testid={`dash-rft-${b.batchNumber}`}>
            <Drill to={b.drill}>{b.batchNumber}</Drill> · {b.rightFirstTime ? <StatusChip tone="ok" label="Right first time" /> : <StatusChip tone="warning" label="Not right first time" />} ·{' '}
            {b.exceptionCount.toString()} exception(s), {b.deviationCount.toString()} deviation(s), {b.reviewCycles.toString()} review cycle(s)
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ExceptionParetoTile({ period }: { period: { from?: string; to?: string } }) {
  const q = useApiQuery(routes.dashboards.exceptionPareto, { query: period }, live);
  if (q.error) return <RefusalMessage error={q.error.error} />;
  const v = q.data;
  if (!v) return <p>Reading the exception Pareto…</p>;
  return (
    <Section title="Exception Pareto" testId="dash-pareto">
      <DataAgeLine v={v} testId="dash-pareto" />
      <table>
        <thead><tr><th>Category</th><th>Exceptions</th><th>Cumulative %</th><th>Batches</th></tr></thead>
        <tbody>
          {v.categories.map((c) => (
            <tr key={c.category} data-testid={`dash-pareto-${c.category}`}>
              <td>{c.category}</td><td>{c.count.toString()}</td><td>{c.cumulativePercent}</td>
              <td>{c.batches.map((b, i) => <span key={b.batchId}>{i > 0 ? ', ' : ''}<Drill to={b.drill}>{b.batchNumber}</Drill></span>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>Total: {v.total.toString()}</p>
    </Section>
  );
}

function ReviewCycleTile({ period }: { period: { from?: string; to?: string } }) {
  const q = useApiQuery(routes.dashboards.reviewCycleTime, { query: period }, live);
  if (q.error) return <RefusalMessage error={q.error.error} />;
  const v = q.data;
  if (!v) return <p>Reading review cycle times…</p>;
  return (
    <Section title="Review cycle time" testId="dash-cycle">
      <DataAgeLine v={v} testId="dash-cycle" />
      <p>{v.summary.batches.toString()} batch(es); median {v.summary.medianDays ?? '-'} day(s), longest {v.summary.maxDays ?? '-'} day(s).</p>
      <ul>
        {v.batches.map((b) => (
          <li key={b.batchId}><Drill to={b.drill}>{b.batchNumber}</Drill> · {b.cycleDays} day(s) from {b.completedAt.text} to {b.qaReviewedAt.text}</li>
        ))}
      </ul>
    </Section>
  );
}

function DeviationAgeingTile() {
  const q = useApiQuery(routes.dashboards.deviationAgeing, {}, live);
  if (q.error) return <RefusalMessage error={q.error.error} />;
  const v = q.data;
  if (!v) return <p>Reading deviation ageing…</p>;
  return (
    <Section title="Deviation ageing (open deviations)" testId="dash-ageing">
      <DataAgeLine v={v} testId="dash-ageing" />
      <p>{v.buckets.map((b) => `${b.bucket} days: ${b.count.toString()}`).join(' · ')}</p>
      <ul>
        {v.open.map((d) => (
          <li key={d.deviationId}><Drill to={d.drill}>{d.ref}</Drill> · {d.classification} · {d.state} · {d.ageDays.toString()} day(s)</li>
        ))}
      </ul>
    </Section>
  );
}

function HoldTimeTile() {
  const q = useApiQuery(routes.dashboards.holdTimeRisk, {}, live);
  if (q.error) return <RefusalMessage error={q.error.error} />;
  const v = q.data;
  if (!v) return <p>Reading hold times…</p>;
  return (
    <Section title="Hold-time risk (bright stock)" testId="dash-hold">
      <DataAgeLine v={v} testId="dash-hold" />
      <p>{v.summary.held.toString()} container(s) held; {v.summary.atRisk.toString()} at risk; {v.summary.over.toString()} over the maximum hold.</p>
      <ul>
        {v.containers.map((c) => (
          <li key={c.containerId}>
            <Drill to={c.drill}>{c.labelCode}</Drill> · {c.heldHours} of {c.maxHoldHours.toString()} h ({c.usedPercent} %) ·{' '}
            <StatusChip tone={c.risk === 'OK' ? 'ok' : c.risk === 'AT_RISK' ? 'warning' : 'error'} label={c.risk === 'OK' ? 'Within hold' : c.risk === 'AT_RISK' ? 'At risk' : 'Over the maximum hold'} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

function OverdueReviewsTile() {
  const q = useApiQuery(routes.dashboards.overdueReviews, {}, live);
  if (q.error) return <RefusalMessage error={q.error.error} />;
  const v = q.data;
  if (!v) return <p>Reading overdue reviews…</p>;
  return (
    <Section title="Overdue periodic reviews" testId="dash-overdue">
      <DataAgeLine v={v} testId="dash-overdue" />
      {v.versions.length === 0 ? <p>No MBR version is past its periodic review.</p> : null}
      <ul>
        {v.versions.map((r) => (
          <li key={r.versionId} data-testid={`dash-overdue-${r.documentId}`}>
            <Drill to={r.drill}>{r.documentId}</Drill> · due {r.reviewDue} · {r.daysOverdue.toString()} day(s) overdue · {r.inUse ? 'in use' : 'not in use'}
            {r.lastReviewAt ? ` · last reviewed ${r.lastReviewAt.text}` : ' · never reviewed'}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function PressOeeTile({ period }: { period: { from?: string; to?: string } }) {
  const q = useApiQuery(routes.dashboards.pressOee, { query: period }, live);
  if (q.error) return <RefusalMessage error={q.error.error} />;
  const v = q.data;
  if (!v) return <p>Reading press OEE…</p>;
  return (
    <Section title="Press OEE (availability × quality)" testId="dash-oee">
      <DataAgeLine v={v} testId="dash-oee" />
      <table>
        <thead><tr><th>Press</th><th>Batch</th><th>Availability</th><th>Quality</th><th>OEE</th><th>Tablets</th><th>Rejects</th></tr></thead>
        <tbody>
          {v.presses.map((p) => (
            <tr key={`${p.equipmentId}-${p.batchId}`}>
              <td>{p.equipmentCode}</td><td><Drill to={p.drill}>{p.batchNumber}</Drill></td><td>{p.availability ?? '-'}</td><td>{p.quality ?? '-'}</td>
              <td>{p.oee ?? '-'}</td><td>{p.tablets ?? '-'}</td><td>{p.rejects ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function AlarmTrendTile({ period }: { period: { from?: string; to?: string } }) {
  const q = useApiQuery(routes.dashboards.alarmTrend, { query: period }, live);
  if (q.error) return <RefusalMessage error={q.error.error} />;
  const v = q.data;
  if (!v) return <p>Reading the alarm trend…</p>;
  return (
    <Section title="Alarm trend across batches" testId="dash-alarms">
      <DataAgeLine v={v} testId="dash-alarms" />
      <p data-testid="dash-alarms-total">
        {v.period.from} to {v.period.to}: {v.total.toString()} alarm(s), {v.gmpCritical.toString()} GMP-critical.
      </p>
      <table>
        <thead><tr><th>Day</th><th>Alarms</th></tr></thead>
        <tbody>{v.byDay.map((d) => <tr key={d.day}><td>{d.day}</td><td>{d.count.toString()}</td></tr>)}</tbody>
      </table>
      <table>
        <thead><tr><th>Code</th><th>Alarms</th><th>GMP-critical</th><th>Batches</th></tr></thead>
        <tbody>
          {v.byCode.map((c) => (
            <tr key={c.alarmCode} data-testid={`dash-alarms-${c.alarmCode}`}><td>{c.alarmCode}</td><td>{c.count.toString()}</td><td>{c.gmpCritical.toString()}</td><td>{c.batches.toString()}</td></tr>
          ))}
        </tbody>
      </table>
      {v.listTruncated ? <p>Only the newest alarms are listed; the counts above hold every alarm of the period.</p> : null}
      <p><Link to="/alarms">Open the alarm log</Link></p>
    </Section>
  );
}
