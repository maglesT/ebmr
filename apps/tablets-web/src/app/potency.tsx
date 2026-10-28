/**
 * R13 (owner's rabeprazole demo, 25 October 2026): the potency of a lot and what it means for dispensing, before anyone
 * weighs.
 *  - LotPotency: the lot's current approved result (basis, assay, water or loss on drying, the as-is potency), the
 *    approved LIMS results it came from, and its history (who, when, why).
 *  - PotencyPreview: what each potency-adjusted dispensing step (TB-01) of a batch will calculate for its reserved lots
 *    (or a lot about to be reserved). A preview only; the weighing step recalculates.
 * The values are the server's; the floor never types a potency or a target (PR-19, DI-33).
 */
import { routes, type RouteResponse } from '@ebmr/api-contract';
import { StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../api/hooks.ts';
import { Section } from './acts.tsx';
import { RefusalMessage } from './refusal.tsx';

type Quality = RouteResponse<typeof routes.execution.lotQuality>;

const BASIS: Readonly<Record<string, string>> = {
  AS_IS: 'as is',
  ANHYDROUS_WATER: 'anhydrous (corrected for water)',
  DRIED_LOD: 'dried (corrected for loss on drying)',
  ANHYDROUS_SOLVENT_FREE: 'anhydrous and solvent-free',
  ACTIVITY: 'activity (U/mg)',
};
export const basisText = (b: string): string => BASIS[b] ?? b.toLowerCase().replace(/_/g, ' ');

/** "assay 99.4 %, water 0.6 %" of a result's values. */
export function valuesText(r: { assay: string; water: string | null; lod: string | null; solvents: string | null }): string {
  return [`assay ${r.assay} %`, ...(r.water !== null ? [`water ${r.water} %`] : []), ...(r.lod !== null ? [`loss on drying ${r.lod} %`] : []), ...(r.solvents !== null ? [`residual solvents ${r.solvents} %`] : [])].join(', ');
}

export function LotPotencyBody({ v }: { v: Quality }) {
  const a = v.assay;
  return (
    <>
      {a ? (
        <>
          <p data-testid="lot-potency-current">
            <strong>As-is potency {a.asIs ?? '–'} %</strong> ({valuesText(a)}; on the {basisText(a.basis)} basis), certificate {a.certificateRef}, recorded {a.recordedAt.text}
          </p>
          {a.usable === false ? (
            <p role="alert" data-testid="lot-potency-unusable">
              A LIMS result this potency came from is no longer approved: a dispensing cannot use it until QC records the potency again.
            </p>
          ) : null}
          {a.sources && a.sources.length > 0 ? (
            <p data-testid="lot-potency-sources">From the approved results: {a.sources.map((s) => `${s.testCode} ${s.result} ${s.unit} (${s.state.toLowerCase()})`).join(', ')}</p>
          ) : null}
        </>
      ) : (
        <p data-testid="lot-potency-current">No potency recorded: a potency-adjusted dispensing cannot use this lot yet.</p>
      )}
      {v.history && v.history.length > 0 ? (
        <table aria-label="Potency history" data-testid="lot-potency-history">
          <thead>
            <tr>
              <th scope="col">Recorded</th>
              <th scope="col">By</th>
              <th scope="col">Values</th>
              <th scope="col">As-is potency</th>
              <th scope="col">Why</th>
            </tr>
          </thead>
          <tbody>
            {v.history.map((h) => (
              <tr key={`${h.recordedAt.text}-${h.certificateRef}-${h.assay}`}>
                <td>
                  {h.recordedAt.text} {h.current ? <StatusChip tone="ok" label="current" /> : null}
                </td>
                <td>{h.by}</td>
                <td>
                  {valuesText(h)} ({basisText(h.basis)}), {h.certificateRef}
                </td>
                <td>{h.asIs ?? '–'} %</td>
                <td>{h.reason ?? 'first result'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}

/** The lot's potency, for anyone who sees the lot. */
export function LotPotency({ lotCode }: { lotCode: string }) {
  const q = useApiQuery(routes.execution.lotQuality, { params: { code: lotCode } });
  return (
    <Section title={`Potency of lot ${lotCode}`} testId="lot-potency">
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.isPending ? <p>Loading…</p> : null}
      {q.data ? <LotPotencyBody v={q.data} /> : null}
    </Section>
  );
}

/** What TB-01 will calculate for the batch's reserved lots (and `lotCode`, about to be reserved). Nothing when the batch has no potency-adjusted step. */
export function PotencyPreview({ batchId, lotCode }: { batchId: string; lotCode?: string }) {
  const q = useApiQuery(routes.batches.potencyPreview, { params: { batchId }, query: lotCode ? { lotCode } : {} });
  if (q.isPending) return <p>Loading…</p>;
  if (q.error) return <RefusalMessage error={q.error.error} />;
  const p = q.data;
  if (p.steps.length === 0) return null;
  return (
    <section aria-label={`Potency preview of ${p.batchNumber}`} data-testid="potency-preview">
      <h3>Potency preview of {p.batchNumber}</h3>
      <p>
        <StatusChip tone="neutral" label="preview: the weighing step recalculates" /> {p.note}
      </p>
      {p.steps.map((s) => (
        <div key={s.stepId} data-testid={`potency-preview-${s.stepId}`}>
          <h4>
            Step {s.number} {s.title}
          </h4>
          <p>
            Standard: {s.active.material} {s.active.standard} {s.active.unit}
            {s.excipient ? `; ${s.excipient.material} ${s.excipient.standard} ${s.excipient.unit} (compensating)` : ''}
          </p>
          {s.lots.length === 0 ? <p>No lot of {s.active.material} is reserved for this batch yet.</p> : null}
          <ul>
            {s.lots.map((l) => (
              <li key={l.lotCode} data-testid={`potency-preview-lot-${l.lotCode}`}>
                Lot {l.lotCode}
                {l.reserved ? '' : ' (not reserved yet)'}:{' '}
                {l.activeTarget !== null
                  ? `as-is potency ${l.asIs ?? '–'} % → ${s.active.material} ${l.activeTarget} ${s.active.unit}${l.excipientTarget !== null && s.excipient ? `; ${s.excipient.material} ${l.excipientTarget} ${s.excipient.unit}` : ''}`
                  : 'no target can be calculated'}
                {l.problem ? <span role="note"> ({l.problem})</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
