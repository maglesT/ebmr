/**
 * Fixture answers built from the contract's example views (C4's fixture mode). Loaded only when
 * VITE_EBMR_FIXTURES=1 (a separate chunk; never in the normal flow).
 *
 * The session answers let a fixture-mode page that holds a terminal key start up and show the example session
 * (device nonce, the terminal the example session is on, sign-in and role choice answering that session, lock,
 * unlock, keep-alive, sign-out). Fixture mode has no demo terminal keys: the demo picker lists none (lead TODO T7).
 * Every answer is one the server can give for the examples (apps/tablets-web/test/api/contract-examples.test.tsx).
 */
import type { SessionView } from '@ebmr/api-contract';
import { EXAMPLES, STEP_EXAMPLES_BY_BLOCK } from '@ebmr/api-contract/examples';
import type { FixtureMap } from './fixture-fetch.ts';

export function fixturesFromExamples(installation: 'GMP' | 'SANDBOX'): FixtureMap {
  const steps = Object.values(STEP_EXAMPLES_BY_BLOCK).map((n) => EXAMPLES[n].data as { step: { stepKey: string } });
  const session = (installation === 'GMP' ? EXAMPLES['session-office'].data : EXAMPLES['session-kiosk'].data) as SessionView;
  return {
    'meta.get': installation === 'GMP' ? EXAMPLES['meta-gmp'].data : EXAMPLES['meta-sandbox'].data,
    'session.deviceNonce': { nonce: 'fixture-nonce-0123456789', expiresInSeconds: 60 },
    'session.identify': session.device,
    'session.demoDevices': { devices: [] },
    'session.login': session,
    'session.chooseRole': session,
    'session.get': session,
    'session.logout': { loggedOut: true },
    'access.lock': { ...session, locked: true },
    'access.unlock': session,
    'access.keepAlive': session,
    'execution.run': EXAMPLES.run.data,
    'execution.runs': EXAMPLES.runs.data,
    'execution.workQueue': EXAMPLES['work-queue'].data,
    'execution.testPackages': EXAMPLES['test-packages'].data,
    'execution.step': ({ params }: { params: Record<string, string> }) => steps.find((s) => s.step.stepKey === params['stepKey']) ?? EXAMPLES['step-g04-parameters'].data,
    'esig.createChallenge': EXAMPLES.challenge.data,
    'devices.capture': EXAMPLES.reading.data,
    'designer.templates': EXAMPLES.templates.data,
    'designer.families': EXAMPLES.families.data,
    'designer.palette': EXAMPLES.palette.data,
    'designer.version': EXAMPLES.version.data,
    'designer.validate': EXAMPLES['validation-report'].data,
    'designer.simulate': EXAMPLES['simulation-report'].data,
    'audit.events': EXAMPLES['audit-events'].data,
  };
}
