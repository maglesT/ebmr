/**
 * Web feature `training` (Phase 6 slice 6g, SANDBOX only; DI-05; D-P6g-2, D-P6g-0-9): training mode is the sandbox
 * installation. The page carries the TEST, NOT GMP watermark the server gives (besides the shell's band and overlay),
 * lists the training personas and the scripted exercises with the person's own attempts, and lets the person start an
 * exercise and mark its steps done; each step links to the real screen it is done on. Nothing here reaches GMP data.
 */
import { createRoute, Link, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { routes as api, type TrainingExerciseView } from '@ebmr/api-contract';
import { Banner, StatusChip, WatermarkBand } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import type { HomeTile } from '../../app/feature.ts';
import { RefusalMessage } from '../../app/refusal.tsx';

const READS: readonly string[] = [api.training.overview.id];

export function TrainingPage() {
  const q = useApiQuery(api.training.overview);
  if (q.error) return <RefusalMessage error={q.error.error} />;
  const v = q.data;
  if (!v) return <p>Opening training…</p>;
  return (
    <>
      <WatermarkBand text={v.watermark.text} notice={v.watermark.notice} />
      <h1>Training</h1>
      <Banner tone="test" title={`${v.watermark.text}: training mode`}>
        This is the sandbox installation. Everything done here is training data in the sandbox database and never becomes a GMP record (DI-05).
      </Banner>
      <Section title="Training personas" testId="training-personas">
        <p>Sign in as one of these to do an exercise in its role.</p>
        <ul>
          {v.personas.map((p) => (
            <li key={p.personId}>{p.legalName} ({p.loginName}) · {p.roles.join(', ')}</li>
          ))}
        </ul>
      </Section>
      {v.exercises.map((e) => <Exercise key={e.code} e={e} />)}
    </>
  );
}

function Exercise({ e }: { e: TrainingExerciseView }) {
  const start = useCommand(api.training.start, READS);
  const step = useCommand(api.training.completeStep, READS);
  const current = e.attempts.find((a) => !a.complete) ?? null;
  return (
    <Section title={`${e.title} (v${e.version.toString()})`} testId={`training-${e.code}`}>
      <p>{e.summary} Roles: {e.roles.join(', ')}.</p>
      <ol>
        {e.steps.map((s) => {
          const done = current?.done.includes(s.no) ?? false;
          return (
            <li key={s.no} data-testid={`training-${e.code}-step-${s.no.toString()}`} data-done={done ? 'true' : 'false'}>
              {s.instruction} <Link to={s.screen}>Open the screen</Link>{' '}
              {current ? (done ? <StatusChip tone="ok" label="Done" /> : <ActButton label="Mark done" primary={false} onPress={() => step.run({ params: { attemptId: current.attemptId }, body: { step: s.no } })} />) : null}
            </li>
          );
        })}
      </ol>
      {current === null ? <ActButton label="Start the exercise" onPress={() => start.run({ body: { exerciseCode: e.code } })} /> : null}
      <p>{e.attempts.filter((a) => a.complete).length.toString()} completed attempt(s).</p>
      <ActResult error={start.error ?? step.error} />
    </Section>
  );
}

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [createRoute({ getParentRoute: () => root, path: '/training', component: TrainingPage })];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'training', title: 'Training', description: 'Training mode on the sandbox (TEST, NOT GMP): personas and scripted exercises on the real screens.', to: '/training', installations: ['SANDBOX'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
