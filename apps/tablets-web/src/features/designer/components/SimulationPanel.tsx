/**
 * Simulation of the saved revision (module C2; DI-04 static verification evidence; DI-05: the output carries the
 * TEST, NOT GMP watermark with the SIMULATION notice and is never a GMP record). The simulation runs on the server
 * in a worker thread and writes nothing.
 *
 * Each simulated run is listed with its outcome and the exceptions it ended with (a loop driven to its maximum), and
 * the panel counts the runs that ended with an exception; a list that shows only its first runs says so (review F54).
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

/** How many runs a list shows; the summary says when the list is cut (review F54). */
export const RUNS_SHOWN = 50;

type SimulatedRun = SimulationData['runs'][number];

/** A list of simulated runs with each one's outcome and exceptions; the summary says when it shows only the first ones. */
function RunList({ title, runs }: { title: string; runs: readonly SimulatedRun[] }) {
  if (runs.length === 0) return null;
  const cut = runs.length > RUNS_SHOWN;
  return (
    <details>
      <summary>
        {title} ({cut ? `the first ${RUNS_SHOWN} of ${runs.length}` : runs.length})
      </summary>
      <ul className={dcls('list')} aria-label={title}>
        {runs.slice(0, RUNS_SHOWN).map((r) => (
          <li key={r.pathId}>
            {r.pathId}: {r.outcome}
            {r.exceptions.length > 0 ? ` (exceptions: ${r.exceptions.join('; ')})` : ''}
          </li>
        ))}
      </ul>
      {cut ? (
        <p className={dcls('small')}>
          {runs.length - RUNS_SHOWN} more {runs.length - RUNS_SHOWN === 1 ? 'run is' : 'runs are'} not listed here; the counts above include them.
        </p>
      ) : null}
    </details>
  );
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
  const withExceptions = result?.runs.filter((r) => r.exceptions.length > 0).length ?? 0;
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
            <dt>Ended with an exception</dt>
            <dd>{withExceptions === 0 ? 'none' : `${withExceptions} of ${result.runs.length} runs (a loop driven to its maximum)`}</dd>
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
          <RunList title="Runs that ended with an exception" runs={result.runs.filter((r) => r.exceptions.length > 0)} />
          <RunList title="Simulated runs" runs={result.runs} />
        </section>
      ) : null}
    </div>
  );
}
