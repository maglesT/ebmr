/**
 * The profile tests of a lot (Phase 7 slice 7p, contract quality.lotProfiles; site services 1640): each profile of the
 * lot's specification in effect (e.g. a dissolution profile of three time points, or the acid and buffer stages of a
 * delayed-release tablet) as ONE release requirement with its status (PASS, FAIL or OPEN, the database's), and per time
 * point its limits, its current RELEASE result and the latest LIMS value. QC records the result of each point here
 * (quality.recordLotResult with the point), typed or taken from the LIMS value; the database judges it against the
 * point's own limits. The approval of each result is in the results list above (its signature).
 */
import { useState } from 'react';
import { routes, type LotProfileView } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { LOT_READS } from './LotsPage.tsx';

const READS = LOT_READS;

const limits = (lower: string | null, upper: string | null, unit: string): string =>
  `${[lower ? `from ${lower}` : '', upper ? `to ${upper}` : ''].filter(Boolean).join(' ')} ${unit}`;

export function LotProfiles({ lotId, qc }: { lotId: string; qc: boolean }) {
  const q = useApiQuery(routes.quality.lotProfiles, { params: { lotId } });
  if (q.error) return <RefusalMessage error={q.error.error} />;
  if (!q.data || q.data.profiles.length === 0) return null;
  return (
    <Section title="Profiles (one release requirement each)" testId="lot-profiles">
      {q.data.profiles.map((p) => (
        <Profile key={p.testCode} lotId={lotId} p={p} qc={qc} />
      ))}
    </Section>
  );
}

function Profile({ lotId, p, qc }: { lotId: string; p: LotProfileView; qc: boolean }) {
  const staged = p.points.some((x) => x.stage);
  return (
    <div data-testid={`profile-${p.testCode}`} data-status={p.status}>
      <h3>
        {p.testCode} profile <StatusChip tone={p.status === 'PASS' ? 'ok' : p.status === 'FAIL' ? 'error' : 'warning'} label={p.status} />
      </h3>
      {p.problem ? <p>{p.problem}</p> : <p>Every time point has an approved result within its limits.</p>}
      <table aria-label={`Time points of ${p.testCode}`}>
        <thead>
          <tr>
            <th scope="col">Point</th>
            {staged ? <th scope="col">Stage</th> : null}
            <th scope="col">Limits</th>
            <th scope="col">Result</th>
            <th scope="col">LIMS</th>
            {qc ? <th scope="col">Record</th> : null}
          </tr>
        </thead>
        <tbody>
          {p.points.map((x) => (
            <PointRow key={x.pointNo} lotId={lotId} testCode={p.testCode} unit={p.unit} point={x} staged={staged} qc={qc} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PointRow({ lotId, testCode, unit, point: x, staged, qc }: { lotId: string; testCode: string; unit: string; point: LotProfileView['points'][number]; staged: boolean; qc: boolean }) {
  const [value, setValue] = useState('');
  const record = useCommand(routes.quality.recordLotResult, READS, `recording ${testCode} at ${x.label}`);
  const send = async (v: string) => {
    const r = await record.run({ params: { lotId }, body: { testCode, point: x.label, purpose: 'RELEASE', value: v } });
    if (r) setValue('');
  };
  const limsValue = x.lims?.value && x.lims.unit === unit ? x.lims.value : null;
  return (
    <tr data-testid={`point-${testCode}-${x.label}`}>
      <td>{x.label}</td>
      {staged ? <td>{x.stage ?? ''}</td> : null}
      <td>{limits(x.lowerLimit, x.upperLimit, unit)}</td>
      <td>
        {x.result ? (
          <>
            {x.result.value} {unit} <StatusChip tone={x.result.verdict === 'PASS' ? 'ok' : 'error'} label={x.result.verdict} /> <StatusChip tone="neutral" label={x.result.state} />
          </>
        ) : (
          'no result'
        )}
      </td>
      <td>{x.lims ? `${x.lims.value ?? ''} ${x.lims.unit ?? ''} ${x.lims.verdict ?? ''} (${x.lims.state}, sample ${x.lims.sampleId})` : '—'}</td>
      {qc ? (
        <td>
          {x.result === null ? (
            <>
              <Field name={`value-${testCode}-${x.label}`} label={`Value at ${x.label}`} value={value} onChange={setValue} inputMode="decimal" />
              <ActButton label={`Record ${testCode} at ${x.label}`} onPress={() => send(value.trim())} disabled={value.trim() === '' || record.busy} />
              {limsValue ? <ActButton primary={false} label={`Record the LIMS value at ${x.label}`} onPress={() => send(limsValue)} disabled={record.busy} /> : null}
            </>
          ) : null}
          <ActResult error={record.error} done={record.done} label="Recorded; QC approves it in the results list." />
        </td>
      ) : null}
    </tr>
  );
}
