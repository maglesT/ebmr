/**
 * Simulation of the saved revision (module C2; DI-04 static verification evidence; DI-05: the output carries the
 * TEST, NOT GMP watermark with the SIMULATION notice and is never a GMP record). The simulation runs on the server
 * in a worker thread and writes nothing.
 *
 * A report is shown only for the saved content it was run on (DI-04; review P20): once a new revision is saved, an
 * earlier report (or one still on its way) is no longer shown as the current one, and a report the server made on
 * other content than the revision on screen is shown as such, never as "Simulation passed".
 */
import { useRef, useState } from 'react';
import { routes, type CallError } from '@ebmr/api-contract';
import { Banner, Button, StatusChip, WatermarkBand } from '@ebmr/ui-kit';
import { api } from '../../../api/client.ts';
import { RefusalMessage } from '../../../app/refusal.tsx';
import { dcls } from '../classes.ts';
import type { SimulationData } from '../model/types.ts';
import { shortHash } from './common.tsx';

interface Run {
  /** The saved revision on screen when the simulation was asked for: `${versionId}:${revision}:${contentHash}`. */
  savedAs: string;
  result: SimulationData | null;
  error: CallError | null;
}

export function SimulationPanel({ versionId, revision, contentHash, dirty }: { versionId: string; revision: number; contentHash: string; dirty: boolean }) {
  const savedAs = `${versionId}:${revision}:${contentHash}`;
  const [run, setRun] = useState<Run | null>(null);
  const [busyFor, setBusyFor] = useState<string | null>(null);
  const requests = useRef(0);
  const start = async (): Promise<void> => {
    const asked = savedAs;
    const n = ++requests.current;
    setBusyFor(asked);
    setRun(null);
    const r = await api.call(routes.designer.simulate, { params: { versionId }, body: {} });
    if (n !== requests.current) return; // a later simulation was asked for meanwhile: only its answer counts
    setBusyFor(null);
    setRun(r.ok ? { savedAs: asked, result: r.value, error: null } : { savedAs: asked, result: null, error: r.error });
  };
  // Only the answer for the revision on screen counts; one for an earlier revision is dropped.
  const current = run?.savedAs === savedAs ? run : null;
  const result = current?.result ?? null;
  const error = current?.error ?? null;
  const busy = busyFor === savedAs;
  const otherContent = result !== null && result.contentHash !== contentHash;
  return (
    <div className={dcls('stack')}>
      <Button variant="primary" onPress={() => void start()} isDisabled={busy}>
        {busy ? 'Simulating…' : `Simulate saved revision ${revision}`}
      </Button>
      {dirty ? <p className={dcls('small')}>You have unsaved changes; the simulation runs on the saved revision {revision}.</p> : null}
      {error ? <RefusalMessage error={error} /> : null}
      {result && otherContent ? (
        <Banner tone="warning" title="This simulation ran on other content than the saved revision on screen.">
          <p>
            It simulated content {shortHash(result.contentHash)}; revision {revision} on screen is {shortHash(contentHash)}. The version was probably saved again
            elsewhere: reload it, then simulate again.
          </p>
        </Banner>
      ) : null}
      {result && !otherContent ? (
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
