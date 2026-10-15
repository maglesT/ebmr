/**
 * One PQR extract (Phase 4 slice 6c; IN-01 (b), PR-58; D-P4-8, D-6-7): its query version and SHA-256, whether a re-run
 * gives the same hash now, the reconciliation to the registers, every batch (export-only SKUs and failed batches marked,
 * market removals listed), the deviations with CAPA as recorded on them, the change records, and the authorised person's
 * sign-off (PQR_SIGN_OFF). The sign-off is offered to the AP only; the server decides it.
 */
import { routes, type PqrExtractView } from '@ebmr/api-contract';
import { Banner, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useSessionRole } from '../../app/roles.ts';
import { useRouteParams } from '../floor/params.ts';
import { PQR_READS, words } from './reads.ts';

export function PqrExtractPage() {
  const extractId = useRouteParams()['extractId'] ?? '';
  const q = useApiQuery(routes.pqr.extract, { params: { extractId } });
  if (q.error) return <RefusalMessage error={q.error.error} />;
  if (!q.data) return <p>Loading the extract.</p>;
  const v = q.data;
  return (
    <>
      <h1>
        PQR extract {v.productCode}, {v.periodFrom} to {v.periodTo}
      </h1>
      <dl data-testid="pqr-header">
        <dt>Query version</dt>
        <dd>{v.queryVersion}</dd>
        <dt>Result SHA-256</dt>
        <dd data-testid="pqr-hash">{v.resultSha256}</dd>
        <dt>Run by</dt>
        <dd>
          {v.ranBy.legalName} ({words(v.ranBy.role)}) {v.ranAt.text}
        </dd>
        <dt>Re-run now</dt>
        <dd data-testid="pqr-reproduces" data-reproduces={String(v.reproduces)}>
          <StatusChip tone={v.reproduces ? 'ok' : 'warning'} label={v.reproduces ? 'Gives the same hash' : 'The records changed: run the extract again'} />
        </dd>
      </dl>
      {v.queryProblem ? <Banner tone="warning" title={v.queryProblem} /> : null}
      <Reconciliation view={v} />
      <SignOff view={v} />
      <Batches view={v} />
      <Section title="Deviations (CAPA as recorded on them)" testId="pqr-deviations">
        {v.deviations.length === 0 ? <p>No deviation is linked to these batches or their lots.</p> : null}
        <ul>
          {v.deviations.map((d) => (
            <li key={d.deviationId}>
              {d.ref} {d.title}: {words(d.classification)}, {words(d.state)}; CAPA {d.capaRefs.length > 0 ? d.capaRefs.join(', ') : (d.noCapaReason ?? 'not recorded yet')}; batches {d.batches.join(', ')}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Change records" testId="pqr-changes">
        {v.changes.length === 0 ? <p>No change record in the period.</p> : null}
        <ul>
          {v.changes.map((c) => (
            <li key={c.changeRecordId}>
              {c.number} {c.title} ({words(c.changeClass)})
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Critical process parameters, IPC results and yields (typed, as recorded)" testId="pqr-cpp">
        {v.cpp.length === 0 ? <p>No typed CPP value in this extract (query version {v.queryVersion}).</p> : null}
        {v.cpp.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th scope="col">Batch</th>
                <th scope="col">Parameter or calculation</th>
                <th scope="col">Step</th>
                <th scope="col">Attempt</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {v.cpp.map((c) => (
                <tr key={`${c.batchNumber}:${c.ref}`} data-testid={`pqr-cpp-${c.batchNumber}-${c.id}`} data-failed={String(c.failed)}>
                  <td>{c.batchNumber}</td>
                  <td>{c.id}</td>
                  <td>{c.step}</td>
                  <td>{c.attempt}</td>
                  <td>{cppValue(c.value)}{c.failed ? ' (failed its limits)' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Section>
    </>
  );
}

/** A typed value as recorded: a decimal with its unit, a series of readings, or the value itself. */
function cppValue(v: Record<string, unknown>): string {
  if (Array.isArray(v['values'])) return `${(v['values'] as unknown[]).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ')} ${typeof v['unit'] === 'string' ? v['unit'] : ''}`.trim();
  if ('value' in v) return `${typeof v['value'] === 'string' ? v['value'] : JSON.stringify(v['value'])}${typeof v['unit'] === 'string' ? ` ${v['unit']}` : ''}`;
  return JSON.stringify(v);
}

function Reconciliation({ view: v }: { view: PqrExtractView }) {
  const r = v.reconciliation;
  const lines = [
    ['Batches (batch number register)', r.batches],
    ['Deviations (deviation register)', r.deviations],
    ['Change records', r.changes],
  ] as const;
  return (
    <Section title="Reconciliation to the registers" testId="pqr-reconciliation">
      <StatusChip tone={r.ok ? 'ok' : 'error'} label={r.ok ? 'Reconciled' : 'Does not reconcile'} />
      <table>
        <thead>
          <tr>
            <th scope="col">Register</th>
            <th scope="col">In the extract</th>
            <th scope="col">In the register</th>
          </tr>
        </thead>
        <tbody>
          {lines.map(([label, l]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{l.extract}</td>
              <td>{l.register}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.problems.length > 0 ? (
        <ul>
          {r.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

function SignOff({ view: v }: { view: PqrExtractView }) {
  const ap = useSessionRole() === 'AUTHORISED_PERSON';
  const signed = useSignedAct(PQR_READS);
  return (
    <Section title="Authorised person's sign-off" testId="pqr-sign-off">
      {v.signOff ? (
        <p data-testid="pqr-signed-off">
          Signed off by {v.signOff.signedBy.legalName} {v.signOff.signedAt.text}.
        </p>
      ) : (
        <>
          <p>Not signed off. The authorised person signs off an extract that still gives the same hash and reconciles, and was not involved in the reviewed batches' records.</p>
          {ap ? (
            <>
              <ActButton
                label="Sign off the extract"
                onPress={() => signed.sign({ kind: 'PQR_SIGN_OFF', extractId: v.extractId }, `Sign off the PQR extract of ${v.productCode}, ${v.periodFrom} to ${v.periodTo} (SHA-256 ${v.resultSha256.slice(0, 12)})`)}
                disabled={signed.busy || !v.reproduces || !v.reconciliation.ok}
              />
              <ActResult error={signed.error} outcome={signed.outcome} />
            </>
          ) : null}
        </>
      )}
    </Section>
  );
}

function Batches({ view: v }: { view: PqrExtractView }) {
  const c = v.counts;
  return (
    <Section title="Batches" testId="pqr-batches">
      <p>
        {c.batches} batches ({c.exportOnlyBatches} export-only, {c.failedBatches} failed), {c.lots} finished lots ({c.exportOnlyLots} export-only), {c.marketRemovals} market removals.
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Batch</th>
            <th scope="col">Issued</th>
            <th scope="col">Markets</th>
            <th scope="col">Lots</th>
            <th scope="col">Market removals</th>
            <th scope="col">Deviations</th>
          </tr>
        </thead>
        <tbody>
          {v.batches.map((b) => (
            <tr key={b.batchId} data-testid={`pqr-batch-${b.batchNumber}`} data-export-only={String(b.exportOnly)}>
              <th scope="row">
                {b.batchNumber} ({words(b.recordKind)}){b.exportOnly ? ' export-only' : ''}
                {b.failed ? ' failed' : ''}
              </th>
              <td>{b.issuedOn}</td>
              <td>{b.markets.join(', ')}</td>
              <td>
                {b.lots.map((l) => `${l.lotCode} (${l.markets.join(', ')}${l.exportOnly ? ', export-only' : ''}; ${l.manufacturerRelease ? words(l.manufacturerRelease) : 'not decided'})`).join('; ') || 'none'}
              </td>
              <td>{b.marketRemovals.map((m) => `${m.market}${m.removedAfterFailure ? ' after failure' : ''}`).join(', ') || 'none'}</td>
              <td>{b.deviations.join(', ') || 'none'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}
