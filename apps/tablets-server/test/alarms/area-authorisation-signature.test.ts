/**
 * Area authorisation at the step over the real server and engine (kernel 1190, recipe-core 0973 and 0974; PR-15,
 * D-P6b-5): the dispensing booth DISP-1 made a controlled area; operator1, without an authorisation, cannot start a
 * step there nor sign it performed; with one recorded by the training coordinator the same person can, and once it is
 * withdrawn the signature is refused again. The refusals come from the database's guard on the execution store (every
 * writer), shown with their guidance.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { passwordActor } from '@ebmr/test-kit';
import { actorOfBrowser } from '../esig/support.ts';
import { dcMini, importAndIssue, personaIn, refusalOf, RunDriver, startExecServer, writePackage, type ExecServer } from '../execution/support.ts';

let sbx: ExecServer;
let d: RunDriver;
let qaBrowser: Awaited<ReturnType<ExecServer['asPersona']>>;
/** qa1 acting as training coordinator, with a fresh tap per command on the shared terminal (INV-40). */
async function tc(): Promise<ActorContext> {
  vi.advanceTimersByTime(7_000);
  return reason({ ...(await actorOfBrowser(sbx, qaBrowser, 'qa1')), roleCode: 'TRAINING_COORDINATOR' });
}
let code = '';
const reason = <T extends ActorContext>(ctx: T): T => ({ ...ctx, reasonCode: 'TEST_SETUP', reasonText: 'area authorisation', correlationId: randomUUID() });

beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
  const steward = reason(await actorOfBrowser(sbx, await sbx.asPersona('steward'), 'steward'));
  await withCommand(sbx.db.app, steward, async (c) => {
    if ((await c.query("select 1 from plant.area where code = 'DISP-1'")).rowCount === 0) await c.query(`select plant.define_area($1::jsonb)`, [JSON.stringify({ code: 'DISP-1', kind: 'ROOM', name: 'Dispensing booth 1' })]);
    await c.query("select plant.set_area_rule('DISP-1', true, null, 'Potent dispensing: authorised staff only')");
  });
  // The training coordinator: no sandbox persona holds the role, so qa1's account is granted it through the kernel's
  // access workflow (requested by the administrator, approved by the process owner).
  qaBrowser = await sbx.asPersona('qa1');
  const qa = await actorOfBrowser(sbx, qaBrowser, 'qa1');
  const admin = reason(await passwordActor(sbx.db, sbx.seed.bootstrap.admin, sbx.seed.bootstrap.admin.fingerprint));
  const owner = reason(await passwordActor(sbx.db, sbx.seed.bootstrap.owner, sbx.seed.bootstrap.owner.fingerprint));
  const grantId = await withCommand(sbx.db.app, admin, (c) => identity.requestRoleGrant(c, { accountId: qa.accountId, roleCode: 'TRAINING_COORDINATOR', reason: 'test set-up: area authorisation' }));
  await withCommand(sbx.db.app, owner, (c) => identity.decideRoleGrant(c, grantId, true, 'test set-up: area authorisation'));
  code = await withCommand(sbx.db.app, await tc(), async (c) => String((await c.query<{ r: string }>("select iam.create_area_authorisation_type('DISP-1', 'Dispensing booth 1') as r")).rows[0]?.r));
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
  d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
}, 300_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

const authorise = async (): Promise<string> =>
  withCommand(sbx.db.app, await tc(), async (c) =>
    String((await c.query<{ r: string }>("select iam.record_qualification($1, $2, clock_timestamp() - interval '1 hour', null) as r", [personaIn(sbx, 'operator1').personId, code])).rows[0]?.r));

describe('area authorisation at the step (PR-15)', () => {
  it('[PR-15] a user without area authorisation cannot sign a step in the controlled area', async () => {
    const key = 'p-disp-clear@';
    const start = await d.command('operator1', { type: 'START_STEP', stepKey: key });
    expect(refusalOf(start)).toMatchObject({ status: 422, code: 'EBMR-PLANT-180' });
    const qid = await authorise();
    await d.ok('operator1', { type: 'START_STEP', stepKey: key });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: key, entry: { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: key, entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } });
    // The authorisation withdrawn: the signature is refused and nothing is signed.
    await withCommand(sbx.db.app, await tc(), (c) => c.query('select iam.withdraw_qualification($1, $2)', [qid, 'Moved to the packaging hall']));
    const before = d.signatures;
    const refused = await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: key });
    expect(refused.result.ok).toBe(false);
    expect(JSON.stringify(refused.result.ok ? null : refused.result.error)).toMatch(/EBMR-PLANT-180/);
    expect(d.signatures).toBe(before);
    expect((await d.stepView('operator1', key)).step.status).toBe('IN_PROGRESS');
    // Authorised again: the same person signs.
    await authorise();
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: key });
    expect((await d.stepView('operator1', key)).step.status).toBe('AWAITING_VERIFICATION');
  });
});
