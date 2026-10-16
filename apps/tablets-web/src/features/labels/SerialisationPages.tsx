/**
 * Serialisation L3/L4 (Phase 6 slice 6c; PR-42): the serial lookup (the L3 is asked live; the lot and expiry shown are
 * the record's, an L3 answer that differs is listed as a problem) and the pools of a packaging order with their reports,
 * aggregations, decommissioning tasks, the L3 mirror's freshness and why release waits; QA rejects a pool.
 */
import { useState } from 'react';
import { routes, type SerialLookupView } from '@ebmr/api-contract';
import { Banner, Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { useRouteParams } from '../floor/params.ts';
import { SERIAL_READS, words } from './reads.ts';

const SERIAL = /^[A-Za-z0-9/.-]{1,20}$/;

function Mirror({ m }: { m: SerialLookupView['mirror'] }) {
  if (m.mode === 'STAND_IN') return <p data-testid="l3-mirror">The L3 system is asked directly (no mirror).</p>;
  return (
    <p data-testid="l3-mirror" data-stale={String(m.stale)}>
      L3 mirror: {m.stale ? <StatusChip tone="error" label="Stale" /> : <StatusChip tone="ok" label="Fresh" />} last synchronised{' '}
      {m.ageSeconds === null ? 'never' : `${m.ageSeconds.toString()} s ago`} (bound {m.boundSeconds.toString()} s).
    </p>
  );
}

export function SerialLookupPage() {
  const [text, setText] = useState('');
  const [serial, setSerial] = useState<string | null>(null);
  return (
    <>
      <h1>Serial lookup</h1>
      <Field name="serial" label="Serial number" value={text} onChange={setText} />
      <ActButton label="Look up" onPress={() => setSerial(SERIAL.test(text.trim()) ? text.trim() : null)} disabled={!SERIAL.test(text.trim())} />
      {serial ? <Lookup serial={serial} /> : null}
    </>
  );
}

function Lookup({ serial }: { serial: string }) {
  const q = useApiQuery(routes.serialisation.serial, { params: { serial } });
  if (q.error) return <RefusalMessage error={q.error.error} />;
  if (!q.data) return <p>Asking the L3 system.</p>;
  const v = q.data;
  return (
    <Section title={`Serial ${v.serial}`} testId="serial-lookup">
      <dl>
        <dt>Lot</dt>
        <dd data-testid="serial-lot">{v.lot}</dd>
        <dt>Expiry</dt>
        <dd data-testid="serial-expiry">{v.expiry ?? 'not computed'}</dd>
        <dt>Status</dt>
        <dd data-testid="serial-status">{words(v.status)}</dd>
        <dt>Pool and GTIN</dt>
        <dd>
          {v.poolId}, {v.gtin} ({v.market})
        </dd>
      </dl>
      {v.problems.length > 0 ? (
        <Banner tone="error" title={`The L3 answer differs from the record: ${v.problems.join('; ')}`} />
      ) : null}
      <Mirror m={v.mirror} />
    </Section>
  );
}

export function BatchPoolsPage() {
  const batchId = useRouteParams()['batchId'] ?? '';
  const q = useApiQuery(routes.serialisation.batchPools, { params: { batchId } });
  const qa = useOffered('QA');
  if (q.error) return <RefusalMessage error={q.error.error} />;
  if (!q.data) return <p>Loading the serial pools.</p>;
  const v = q.data;
  return (
    <>
      <h1>Serial pools of {v.batchNumber}</h1>
      <Mirror m={v.mirror} />
      {v.releaseProblem ? <Banner tone="warning" title={`Release waits: ${v.releaseProblem}`} /> : <Banner tone="ok" title="Serialisation does not block release." />}
      {v.pools.map((p) => (
        <Section key={p.poolId} title={`Pool ${p.poolId}`} testId={`pool-${p.poolId}`}>
          <p>
            {p.market}, GTIN {p.gtin}, {p.quantity} serials, step {p.stepKey}.{' '}
            {p.latestReport ? `Latest report: ${p.latestReport.unexplained} unexplained.` : 'No report yet.'}
          </p>
          {p.aggregations.length > 0 ? <p>Aggregations: {p.aggregations.map((a) => `${a.action} ${a.childCount} into ${a.parentId}`).join('; ')}</p> : null}
          {p.decommissionTasks.length > 0 ? (
            <ul>
              {p.decommissionTasks.map((t) => (
                <li key={t.taskId} data-testid={`task-${t.taskId}`} data-state={t.state}>
                  {t.taskId}: {words(t.state)}, {t.serialCount} serials ({t.reason})
                </li>
              ))}
            </ul>
          ) : null}
          {qa ? <Reject poolId={p.poolId} /> : null}
        </Section>
      ))}
    </>
  );
}

function Reject({ poolId }: { poolId: string }) {
  const reject = useCommand(routes.serialisation.rejectPool, SERIAL_READS, 'the rejection');
  const [reason, setReason] = useState('');
  return (
    <div data-testid={`reject-${poolId}`}>
      <Field name={`reject-${poolId}`} label="Reason to reject the pool" value={reason} onChange={setReason} />
      <ActButton label="Reject the pool" primary={false} onPress={() => (reason.trim() ? reject.run({ params: { poolId }, body: { reason: reason.trim() } }) : undefined)} disabled={reason.trim() === '' || reject.busy} />
      <ActResult error={reject.error} done={reject.done} label="The L3 system opened a decommissioning task." />
    </div>
  );
}
