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

/** The refusal the server gives for a lot it does not know (execution runs.ts notFound; fixture mode knows the lot example only). */
const LOT_UNKNOWN = {
  refusal: {
    code: 'EXE_NOT_FOUND',
    kind: 'STALE',
    whatHappened: 'The lot was not found.',
    why: 'There is no lot with this id on this installation.',
    controls: ['DI-34'],
    whatYouCanDo: ['Reload the list and open it again.'],
    whoCanHelp: [],
  },
  correlationId: 'fixture',
  retryable: false,
};

export function fixturesFromExamples(installation: 'GMP' | 'SANDBOX'): FixtureMap {
  const steps = Object.values(STEP_EXAMPLES_BY_BLOCK).map((n) => EXAMPLES[n].data as { step: { stepKey: string } });
  const session = (installation === 'GMP' ? EXAMPLES['session-office'].data : EXAMPLES['session-kiosk'].data) as SessionView;
  const commandResult = EXAMPLES['command-result'].data as unknown as { step: { step: { stepKey: string } } | null };
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
    'execution.issueForm': EXAMPLES['issue-form'].data,
    'execution.timeline': EXAMPLES.timeline.data,
    'execution.verifyReplay': EXAMPLES.replay.data,
    'execution.lot': ({ params }: { params: Record<string, string> }) => (params['code'] === EXAMPLES.lot.data.lotCode ? EXAMPLES.lot.data : { status: 404, body: LOT_UNKNOWN }),
    // A command is answered as the server answers an accepted one: the run's next version and the step it targeted
    // (or the step on show), as an example shows it.
    'execution.command': ({ body }: { body: unknown }) => {
      const b = body as { expectedVersion: number; viewStepKey?: string; intent: { type: string; stepKey?: string } };
      const key = b.viewStepKey ?? b.intent.stepKey;
      if (b.intent.type === 'START_STEP' && key === commandResult.step?.step.stepKey) return commandResult;
      return { accepted: true, version: b.expectedVersion + 1, step: steps.find((s) => s.step.stepKey === key) ?? null };
    },
    'esig.createChallenge': EXAMPLES.challenge.data,
    'devices.capture': EXAMPLES.reading.data,
    'designer.templates': EXAMPLES.templates.data,
    'designer.families': EXAMPLES.families.data,
    'designer.palette': EXAMPLES.palette.data,
    'designer.version': EXAMPLES.version.data,
    'designer.validate': EXAMPLES['validation-report'].data,
    'designer.simulate': EXAMPLES['simulation-report'].data,
    'audit.events': EXAMPLES['audit-events'].data,
    ...(installation === 'GMP' ? gmpSlice6(steps) : {}),
  };
}

/**
 * Phase 3 slice 6 (GMP): the GMP batch routes answer as the execution ones do (same views), the TB-08 step example by
 * its key; every other new route answers with its first contract example (planning, master data, plant, quality).
 */
function gmpSlice6(steps: { step: { stepKey: string } }[]): FixtureMap {
  const firstExamples: Record<string, unknown> = {};
  for (const e of Object.values(EXAMPLES)) {
    if (!('routeId' in e) || typeof e.routeId !== 'string') continue;
    if (!/^(batches|planning|masterData|plant|quality|review|containers|specifications|samples|release|qpPackage|records|pqr|capa|config|integrations|notifications|support|contractGiver|controlled|esig\.(dscConfiguration|setDscMode|registerDscAnchor|setDscMeaning|dscEnrolment|enrolDsc|endDscEnrolment)|devices\.processReadings|designer\.formulaChoice|esig\.describe)/.test(e.routeId)) continue;
    if (!(e.routeId in firstExamples)) firstExamples[e.routeId] = e.data;
  }
  const tb08 = EXAMPLES['batches-step-tb08'].data as { step: { stepKey: string } };
  const gmpSteps = [tb08, ...steps];
  // Deviation-lite (slice 5a routes) answer with the deviation of the list example; a lot has no result yet.
  const deviation = (EXAMPLES['quality-deviations'].data as { deviations: unknown[] }).deviations[0];
  const deviationRoutes = ['quality.deviation', 'quality.raiseDeviation', 'quality.linkDeviation', 'quality.startInvestigation', 'quality.recordFinding', 'quality.cancelDeviation'];
  return {
    ...firstExamples,
    ...Object.fromEntries(deviationRoutes.map((id) => [id, deviation])),
    'quality.lotResults': { results: [] },
    'batches.step': ({ params }: { params: Record<string, string> }) => gmpSteps.find((s) => s.step.stepKey === params['stepKey']) ?? EXAMPLES['batches-step'].data,
    'batches.command': ({ body }: { body: unknown }) => {
      const b = body as { expectedVersion: number; viewStepKey?: string; intent: { stepKey?: string } };
      const key = b.viewStepKey ?? b.intent.stepKey;
      return { accepted: true, version: b.expectedVersion + 1, step: gmpSteps.find((s) => s.step.stepKey === key) ?? null };
    },
  };
}
