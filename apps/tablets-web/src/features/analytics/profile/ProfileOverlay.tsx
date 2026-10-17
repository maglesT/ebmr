/**
 * The golden profile overlay of one batch, step and tag (Phase 6A slice 6A-6; DI-51, DI-52, DI-32): the advisory band,
 * the method and version, the data age, the band chart, the share outside the band and the distance against its limit,
 * the flags, and every sample of the step's window exactly as recorded (raw text, shown decimal, status code and
 * quality). Shown on /analytics/profiles and under the trend viewer's chart (slice 6b).
 */
import { routes } from '@ebmr/api-contract';
import { StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../../api/hooks.ts';
import { RefusalMessage } from '../../../app/refusal.tsx';
import { AdvisoryBand, Stat } from '../shared.tsx';
import { BandChart } from './BandChart.tsx';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function ProfileOverlay({ batchId, step, tag }: { batchId: string; step: string; tag: string }) {
  const ready = UUID.test(batchId) && step.trim() !== '' && tag.trim() !== '';
  const q = useApiQuery(routes.analyticsProfile.batch, { query: { batch: batchId, step: step.trim(), tag: tag.trim() } }, { enabled: ready });
  if (!ready) return <p>Choose a batch, a step and a tag.</p>;
  if (q.error) return <RefusalMessage error={q.error.error} />;
  const p = q.data;
  if (!p) return <p>Loading the golden profile.</p>;
  return (
    <div data-testid="profile-overlay">
      <AdvisoryBand v={p} />
      <p>
        {p.batchNumber} · {p.step} · {p.tag} on {p.equipmentCode} ({p.equipmentType}) · against reference set {p.referenceSet} of {p.referenceBatches.toString()} batches · run data as of{' '}
        {p.run?.dataAsOf.text ?? 'n/a'}
      </p>
      {p.status === 'NOT_ASSESSED' ? (
        <p data-testid="profile-not-assessed">Not assessed: {p.why}</p>
      ) : (
        <>
          <BandChart low={p.band.low} high={p.band.high} reference={p.band.reference} curve={p.curve} unit={p.unit} />
          <ul data-testid="profile-stats">
            <li>Points outside the band: {p.outsidePoints.toString()} of {p.points.toString()}, share <Stat value={p.outsideShare} /> (flagged above 10 %)</li>
            <li>DTW distance <Stat value={p.distance} /> against the limit <Stat value={p.distanceLimit} /> {p.unit}</li>
          </ul>
        </>
      )}
      <p>Samples: {p.used.toString()} used, {p.droppedBad.toString()} BAD dropped, {p.uncertain.toString()} UNCERTAIN used.</p>
      {p.flags.length === 0 ? <p data-testid="profile-no-flag">No flag on this curve.</p> : (
        <ul data-testid="profile-flags">
          {p.flags.map((f) => (
            <li key={f.flagId}>
              <StatusChip tone={f.severity === 'HIGH' ? 'error' : 'warning'} label={f.severity} /> <strong>{f.rule}</strong>: {f.reasons.map((r) => r.text).join(' ')}
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary>The samples as recorded ({p.samples.length.toString()})</summary>
        <table data-testid="profile-samples">
          <thead>
            <tr><th>Source time (epoch µs)</th><th>Raw value</th><th>Shown value</th><th>Status code</th><th>Quality</th></tr>
          </thead>
          <tbody>
            {p.samples.map((s) => (
              <tr key={`${s.sourceUs}-${s.statusCode}`}>
                <td>{s.sourceUs}</td><td>{s.raw}</td><td>{s.value ?? '(none)'}</td><td>{s.statusCode}</td><td>{s.quality}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
