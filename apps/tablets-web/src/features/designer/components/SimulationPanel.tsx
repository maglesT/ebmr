/**
 * Simulation of the saved revision (module C2; DI-04 static verification evidence; DI-05: the output carries the
 * TEST, NOT GMP watermark with the SIMULATION notice and is never a GMP record). The simulation runs on the server
 * in a worker thread and writes nothing.
 */
import { useState } from 'react';
import { routes, type CallError } from '@ebmr/api-contract';
import { Banner, Button, StatusChip, WatermarkBand } from '@ebmr/ui-kit';
import { api } from '../../../api/client.ts';
import { RefusalMessage } from '../../../app/refusal.tsx';
import { dcls } from '../classes.ts';
import type { SimulationData } from '../model/types.ts';

export function SimulationPanel({ versionId, revision, dirty }: { versionId: string; revision: number; dirty: boolean }) {
  const [result, setResult] = useState<SimulationData | null>(null);
  const [error, setError] = useState<CallError | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const r = await api.call(routes.designer.simulate, { params: { versionId }, body: {} });
    setBusy(false);
    if (r.ok) setResult(r.value);
    else setError(r.error);
  };
  return (
    <div className={dcls('stack')}>
      <Button variant="primary" onPress={() => void run()} isDisabled={busy}>
        {busy ? 'Simulating…' : `Simulate saved revision ${revision}`}
      </Button>
      {dirty ? <p className={dcls('small')}>You have unsaved changes; the simulation runs on the saved revision {revision}.</p> : null}
      {error ? <RefusalMessage error={error} /> : null}
      {result ? (
        <section aria-label="Simulation report" className={dcls('stack')}>
          <WatermarkBand text={result.watermark.text} notice={result.watermark.notice} />
          <div className={dcls('inline')}>
            <StatusChip tone={result.passed ? 'ok' : 'error'} label={result.passed ? 'Simulation passed' : 'Simulation found problems'} />
            <span className={dcls('small')}>of content {result.contentHash.slice(0, 12)}… at {result.simulatedAt.text}</span>
          </div>
          <dl className={dcls('dl')}>
            <dt>Paths</dt>
            <dd>{result.paths}</dd>
            <dt>Steps reached</dt>
            <dd>
              {result.coverage.nodes.covered} of {result.coverage.nodes.total}
            </dd>
            <dt>Decisions</dt>
            <dd>
              {result.coverage.decisions.covered} of {result.coverage.decisions.total}
            </dd>
            <dt>Coverage</dt>
            <dd>{result.coverage.percent} %</dd>
          </dl>
          {result.problems.length > 0 ? (
            <Banner tone="error" title={`${result.problems.length} problems`}>
              <ul className={dcls('list')}>
                {result.problems.map((p, i) => (
                  <li key={`${p.code}-${i}`}>{p.message}</li>
                ))}
              </ul>
            </Banner>
          ) : null}
          <details>
            <summary>Simulated runs ({result.runs.length})</summary>
            <ul className={dcls('list')}>
              {result.runs.slice(0, 50).map((r) => (
                <li key={r.pathId}>
                  {r.pathId}: {r.outcome}
                  {r.exceptions.length > 0 ? ` (exceptions: ${r.exceptions.join(', ')})` : ''}
                </li>
              ))}
            </ul>
          </details>
        </section>
      ) : null}
    </div>
  );
}
