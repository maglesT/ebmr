/**
 * The validation interlocks of a test database (Phase 7 slice 7c; D-P7-12, D-P7-0-7): the kernel-side counterpart of
 * the test-kit helpers approveValidationSummary and approveSystemDescription (packages/test-kit/src/validation.ts),
 * for the test files built on the kernel's template (kernel and recipe-core tests may not import the test-kit:
 * .dependency-cruiser.cjs). The same real signed acts:
 * - approveTestRelease: a QA person signs VALIDATION_SUMMARY_APPROVED over the running release and a fixed test summary
 *   hash, then records the approval with that signature (platform.approve_validation_summary). A GMP batch issue needs
 *   it (DI-03, recipe-core 1250).
 * - describeTestInterfaces: the system owner records each interface under the fixture change record (the real raise,
 *   approve and close path is the test-kit helper's and packages/kernel/test/config/change-control.test.ts's). An
 *   inbound message or an adapter start needs it on a GMP installation (DI-06, kernel 1350).
 * Both are idempotent per database: a release already approved, or an interface already described, is left alone.
 */
import { createHash, randomUUID } from 'node:crypto';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import * as config from '../../src/config/release.ts';
import { seedActor, type SeededActor } from '../identity/seed.ts';
import { signFor } from '../records/helpers.ts';
import { ensureFixtureChangeRecord, underChange } from './change-record.ts';
import type { TestDatabase } from './db.ts';

const qaOf = new WeakMap<object, SeededActor>();
const ownerOf = new WeakMap<object, SeededActor>();

const fresh = (ctx: ActorContext, text: string): ActorContext => ({ ...ctx, correlationId: randomUUID(), reasonCode: 'TEST_SETUP', reasonText: text });

async function qa(db: TestDatabase): Promise<SeededActor> {
  let a = qaOf.get(db);
  if (!a) {
    a = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Vera Validation (test QA)' });
    qaOf.set(db, a);
  }
  return a;
}

async function owner(db: TestDatabase): Promise<SeededActor> {
  let a = ownerOf.get(db);
  if (!a) {
    a = await seedActor(db, { roleCode: 'PROCESS_OWNER', legalName: 'Sami System-Owner (test)' });
    ownerOf.set(db, a);
  }
  return a;
}

/** Approves a validation summary of the running release (once per release); returns the release. */
export async function approveTestRelease(db: TestDatabase): Promise<string> {
  const release = await config.schemaRelease(db.app);
  if ((await config.validationSummaryProblem(db.app)) === null) return release;
  const summary = createHash('sha256').update(`TEST validation summary of release ${release} (DEMO-ONLY)`, 'utf8').digest('hex');
  const by = await qa(db);
  const signatureId = await signFor(db, by, { type: config.VALIDATION_SUMMARY_AGGREGATE, id: config.validationSummaryAggregateId(release, summary) }, config.VALIDATION_SUMMARY_MEANING, 'PROPOSED');
  await withCommand(db.app, fresh(by, 'test installation: approve the validation summary of the running release'), (c) =>
    config.approveValidationSummary(c, { schemaRelease: release, summarySha256: summary, title: 'TEST validation summary (DEMO-ONLY)', signatureId }),
  );
  return release;
}

/** A loopback interface of `system` for adapter `code` (the OPC UA feed signed), as the test adapters run. */
export function testInterface(code: string, system: config.SystemInterface['sourceSystem']): config.SystemInterface {
  return { adapterCode: code, sourceSystem: system, endpointHost: '127.0.0.1', transport: 'LOOPBACK', signedFeed: system === 'OPCUA', status: 'DESCRIBED' };
}

/**
 * Records `interfaces` in the approved system description (those not described yet), as `by` (a system owner holding
 * CONFIG.SYSTEM_DESCRIPTION; default a PROCESS_OWNER seeded here: a server test passes its installation's bootstrap
 * owner, since its database is bootstrapped already).
 */
export async function describeTestInterfaces(db: TestDatabase, interfaces: readonly config.SystemInterface[], by?: ActorContext): Promise<void> {
  const todo: config.SystemInterface[] = [];
  for (const i of interfaces) if (i.status !== 'DESCRIBED' || !(await config.interfaceDescribed(db.app, i.adapterCode))) todo.push(i);
  if (todo.length === 0) return;
  await ensureFixtureChangeRecord(db);
  const as = by ?? (await owner(db));
  await withCommand(db.app, underChange(fresh(as, 'test installation: the approved system description')), async (c) => {
    for (const i of todo) await config.describeInterface(c, i);
  });
}
