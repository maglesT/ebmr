/**
 * Example fixtures for every view (Phase 2 apps plan section 4, "Views"): validated by a test and used by C4
 * (through the web app's createFixtureFetch) before the sandbox server exists. Subpath
 * `@ebmr/api-contract/examples`, so the production bundle never carries them unless a fixture mode imports it.
 *
 * The JSON files live in ../fixtures; one StepScreenView per block of the dc-mini template. The designer examples are
 * the server's answers (review F55); the step and run examples are written for the screens and checked against the
 * template's limits and their own moment (asOf) by apps/tablets-web/test/api/contract-examples.test.ts.
 */
import type { z } from 'zod';
import audit from '../fixtures/audit-events.json' with { type: 'json' };
import challenge from '../fixtures/challenge.json' with { type: 'json' };
import commandResult from '../fixtures/command-result.json' with { type: 'json' };
import manifestation from '../fixtures/manifestation.json' with { type: 'json' };
import metaGmp from '../fixtures/meta-gmp.json' with { type: 'json' };
import metaSandbox from '../fixtures/meta-sandbox.json' with { type: 'json' };
import reading from '../fixtures/reading.json' with { type: 'json' };
import replay from '../fixtures/replay.json' with { type: 'json' };
import run from '../fixtures/run.json' with { type: 'json' };
import runs from '../fixtures/runs.json' with { type: 'json' };
import sessionKiosk from '../fixtures/session-kiosk.json' with { type: 'json' };
import sessionOffice from '../fixtures/session-office.json' with { type: 'json' };
import simulation from '../fixtures/simulation-report.json' with { type: 'json' };
import g03 from '../fixtures/step-g03-acknowledge.json' with { type: 'json' };
import g04 from '../fixtures/step-g04-parameters.json' with { type: 'json' };
import g07 from '../fixtures/step-g07-weighing.json' with { type: 'json' };
import g08 from '../fixtures/step-g08-charge.json' with { type: 'json' };
import g09 from '../fixtures/step-g09-equipment-status.json' with { type: 'json' };
import g10 from '../fixtures/step-g10-clearance.json' with { type: 'json' };
import g17 from '../fixtures/step-g17-hold-point.json' with { type: 'json' };
import g20 from '../fixtures/step-g20-yield.json' with { type: 'json' };
import g22 from '../fixtures/step-g22-output.json' with { type: 'json' };
import testPackages from '../fixtures/test-packages.json' with { type: 'json' };
import timeline from '../fixtures/timeline.json' with { type: 'json' };
import families from '../fixtures/families.json' with { type: 'json' };
import issueForm from '../fixtures/issue-form.json' with { type: 'json' };
import lot from '../fixtures/lot.json' with { type: 'json' };
import palette from '../fixtures/palette.json' with { type: 'json' };
import templates from '../fixtures/templates.json' with { type: 'json' };
import validationFindings from '../fixtures/validation-report-findings.json' with { type: 'json' };
import validation from '../fixtures/validation-report.json' with { type: 'json' };
import versionInVerification from '../fixtures/version-in-verification.json' with { type: 'json' };
import version from '../fixtures/version.json' with { type: 'json' };
import workQueue from '../fixtures/work-queue.json' with { type: 'json' };
import { ReadingView } from './ns/devices.ts';
import { ChallengeView, ManifestationView } from './ns/esig.ts';
import { routes } from './routes.ts';

export interface Example {
  /** The schema the example must parse with. */
  schema: z.ZodType;
  data: unknown;
  /** The route whose response it is, when it is one (for fixture fetches). */
  routeId?: string;
}

const r = routes;

export const EXAMPLES = {
  'meta-gmp': { schema: r.meta.get.response, data: metaGmp, routeId: r.meta.get.id },
  'meta-sandbox': { schema: r.meta.get.response, data: metaSandbox, routeId: r.meta.get.id },
  'session-kiosk': { schema: r.session.get.response, data: sessionKiosk, routeId: r.session.get.id },
  'session-office': { schema: r.session.get.response, data: sessionOffice, routeId: r.session.get.id },
  'step-g03-acknowledge': { schema: r.execution.step.response, data: g03, routeId: r.execution.step.id },
  'step-g04-parameters': { schema: r.execution.step.response, data: g04, routeId: r.execution.step.id },
  'step-g07-weighing': { schema: r.execution.step.response, data: g07, routeId: r.execution.step.id },
  'step-g08-charge': { schema: r.execution.step.response, data: g08, routeId: r.execution.step.id },
  'step-g09-equipment-status': { schema: r.execution.step.response, data: g09, routeId: r.execution.step.id },
  'step-g10-clearance': { schema: r.execution.step.response, data: g10, routeId: r.execution.step.id },
  'step-g17-hold-point': { schema: r.execution.step.response, data: g17, routeId: r.execution.step.id },
  'step-g20-yield': { schema: r.execution.step.response, data: g20, routeId: r.execution.step.id },
  'step-g22-output': { schema: r.execution.step.response, data: g22, routeId: r.execution.step.id },
  run: { schema: r.execution.run.response, data: run, routeId: r.execution.run.id },
  runs: { schema: r.execution.runs.response, data: runs, routeId: r.execution.runs.id },
  'work-queue': { schema: r.execution.workQueue.response, data: workQueue, routeId: r.execution.workQueue.id },
  'test-packages': { schema: r.execution.testPackages.response, data: testPackages, routeId: r.execution.testPackages.id },
  // The sandbox server's own answers for a test batch of the version example (lead TODO T7), compared with the
  // server by apps/tablets-server/test/execution/contract-examples.test.ts.
  'issue-form': { schema: r.execution.issueForm.response, data: issueForm, routeId: r.execution.issueForm.id },
  'command-result': { schema: r.execution.command.response, data: commandResult, routeId: r.execution.command.id },
  timeline: { schema: r.execution.timeline.response, data: timeline, routeId: r.execution.timeline.id },
  replay: { schema: r.execution.verifyReplay.response, data: replay, routeId: r.execution.verifyReplay.id },
  lot: { schema: r.execution.lot.response, data: lot, routeId: r.execution.lot.id },
  challenge: { schema: ChallengeView, data: challenge, routeId: r.esig.createChallenge.id },
  manifestation: { schema: ManifestationView, data: manifestation },
  reading: { schema: ReadingView, data: reading, routeId: r.devices.capture.id },
  // The designer examples are the server's own answers for the dc-mini template, made stable (ids, instants) and
  // compared with the server by apps/tablets-server/test/designer/contract-examples.test.ts (review F55).
  templates: { schema: r.designer.templates.response, data: templates, routeId: r.designer.templates.id },
  families: { schema: r.designer.families.response, data: families, routeId: r.designer.families.id },
  palette: { schema: r.designer.palette.response, data: palette, routeId: r.designer.palette.id },
  version: { schema: r.designer.version.response, data: version, routeId: r.designer.version.id },
  'version-in-verification': { schema: r.designer.version.response, data: versionInVerification, routeId: r.designer.version.id },
  'validation-report': { schema: r.designer.validate.response, data: validation, routeId: r.designer.validate.id },
  'validation-report-findings': { schema: r.designer.validate.response, data: validationFindings, routeId: r.designer.validate.id },
  'simulation-report': { schema: r.designer.simulate.response, data: simulation, routeId: r.designer.simulate.id },
  'audit-events': { schema: r.audit.events.response, data: audit, routeId: r.audit.events.id },
} as const satisfies Record<string, Example>;

export type ExampleName = keyof typeof EXAMPLES;

/** The step screen examples by block, in template order. */
export const STEP_EXAMPLES_BY_BLOCK: Readonly<Record<string, ExampleName>> = {
  'G-10@1': 'step-g10-clearance',
  'G-09@1': 'step-g09-equipment-status',
  'G-03@1': 'step-g03-acknowledge',
  'G-07@1': 'step-g07-weighing',
  'G-20@1': 'step-g20-yield',
  'G-08@1': 'step-g08-charge',
  'G-04@1': 'step-g04-parameters',
  'G-17@1': 'step-g17-hold-point',
  'G-22@1': 'step-g22-output',
};

/** An example parsed with its schema (typed as the schema's output). */
export function example<N extends ExampleName>(name: N): z.output<(typeof EXAMPLES)[N]['schema']> {
  const e = EXAMPLES[name];
  return e.schema.parse(e.data) as z.output<(typeof EXAMPLES)[N]['schema']>;
}
