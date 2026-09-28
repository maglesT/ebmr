/**
 * Fixture answers built from the contract's example views (C4's fixture mode). Loaded only when
 * VITE_EBMR_FIXTURES=1 (a separate chunk; never in the normal flow).
 */
import { EXAMPLES, STEP_EXAMPLES_BY_BLOCK } from '@ebmr/api-contract/examples';
import type { FixtureMap } from './fixture-fetch.ts';

export function fixturesFromExamples(installation: 'GMP' | 'SANDBOX'): FixtureMap {
  const steps = Object.values(STEP_EXAMPLES_BY_BLOCK).map((n) => EXAMPLES[n].data as { step: { stepKey: string } });
  return {
    'meta.get': installation === 'GMP' ? EXAMPLES['meta-gmp'].data : EXAMPLES['meta-sandbox'].data,
    'session.get': installation === 'GMP' ? EXAMPLES['session-office'].data : EXAMPLES['session-kiosk'].data,
    'execution.run': EXAMPLES.run.data,
    'execution.runs': EXAMPLES.runs.data,
    'execution.workQueue': EXAMPLES['work-queue'].data,
    'execution.testPackages': EXAMPLES['test-packages'].data,
    'execution.step': ({ params }: { params: Record<string, string> }) => steps.find((s) => s.step.stepKey === params['stepKey']) ?? EXAMPLES['step-g04-parameters'].data,
    'esig.createChallenge': EXAMPLES.challenge.data,
    'devices.capture': EXAMPLES.reading.data,
    'designer.version': EXAMPLES.version.data,
    'designer.validate': EXAMPLES['validation-report'].data,
    'designer.simulate': EXAMPLES['simulation-report'].data,
    'audit.events': EXAMPLES['audit-events'].data,
  };
}
