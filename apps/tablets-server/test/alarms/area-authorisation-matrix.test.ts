/**
 * Area authorisation in the qualification matrix over HTTP (Phase 6 slice 6b; PR-15, D-P6b-5; contract plantRules
 * areaAuthorisations, recordAreaAuthorisation, withdrawAreaAuthorisation; kernel 0130 and 1190). A controlled room's
 * authorisations are records of the qualification register: recorded by a training coordinator for a defined type,
 * never for oneself, valid from the recording instant, withdrawn with a reason; the matrix shows each record and
 * whether it counts now (iam.person_area_authorised, the function the step guard reads).
 */
import { randomUUID } from 'node:crypto';
import { routes } from '@ebmr/api-contract';
import { withCommand, type ActorContext } from '@ebmr/kernel';
import { plant } from '@ebmr/recipe-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { actorOfBrowser, refusalOf, valueOf } from '../esig/support.ts';
import { grantedPerson, loginOf } from '../support/granted-person.ts';
import { startServer, type TestBrowser, type TestServer } from '../support/harness.ts';

let gmp: TestServer;
let coordinator: TestBrowser;
let coordinatorLogin = '';
const room = `RM-POT-${randomUUID().slice(0, 6).toUpperCase()}`;
const reason = <T extends ActorContext>(ctx: T): T => ({ ...ctx, reasonCode: 'TEST_SETUP', reasonText: 'area authorisation matrix', correlationId: randomUUID() });

beforeAll(async () => {
  gmp = await startServer('GMP');
  vi.useFakeTimers({ toFake: ['performance'] });
  const steward = await gmp.asPersona('steward');
  await withCommand(gmp.db.app, reason(await actorOfBrowser(gmp, steward, 'steward')), async (c) => {
    await plant.defineArea(c, { code: room, kind: 'ROOM', name: 'Potent product suite (matrix test)' });
    await c.query("select plant.set_area_rule($1, true, null, 'Potent product: authorised staff only')", [room]);
  });
  const tc = await grantedPerson(gmp, 'TRAINING_COORDINATOR', 'Tara Coordinator');
  coordinatorLogin = tc.loginName;
  coordinator = await loginOf(gmp, tc);
}, 300_000);
afterAll(async () => {
  vi.useRealTimers();
  await gmp?.close();
});

const areaOf = async (b: TestBrowser) => valueOf(await b.call(routes.plantRules.areaAuthorisations)).areas.find((a) => a.code === room);

describe('area authorisation in the qualification matrix (PR-15)', () => {
  it('[PR-15] area authorisations are recorded in the qualification matrix by the training coordinator, never for oneself, and withdrawn with a reason', async () => {
    const operator = gmp.seed.personas.find((p) => p.key === 'operator1');
    if (!operator) throw new Error('operator1 is not seeded');
    // The controlled room is listed before its type exists; nobody can be recorded for it yet.
    expect(await areaOf(coordinator)).toMatchObject({ authorisationRequired: true, qualificationCode: `AREA.${room}`, typeDefined: false, records: [] });
    const early = await coordinator.call(routes.plantRules.recordAreaAuthorisation, { params: { code: room }, body: { loginName: operator.loginName } });
    expect(refusalOf(early)).toMatchObject({ status: 422, code: 'EBMR-PLANT-187' });
    expect(valueOf(await coordinator.call(routes.plantRules.createAreaAuthorisation, { body: { area: room, name: 'Potent product suite' } }))).toEqual({ qualificationCode: `AREA.${room}` });

    // Recorded for operator1: the matrix shows the record and that it counts; so does the step guard's function.
    const rec = valueOf(await coordinator.call(routes.plantRules.recordAreaAuthorisation, { params: { code: room }, body: { loginName: operator.loginName } }));
    expect(rec).toMatchObject({ person: { loginName: operator.loginName }, recordedBy: { loginName: coordinatorLogin }, source: 'INTERNAL', validTo: null, withdrawnAt: null, current: true });
    const area = await areaOf(coordinator);
    expect(area?.typeDefined).toBe(true);
    expect(area?.records.map((r) => [r.recordId, r.current])).toEqual([[rec.recordId, true]]);
    const counts = async () =>
      (await gmp.db.app.query<{ ok: boolean }>('select iam.person_area_authorised(p.id, $2, clock_timestamp()) as ok from iam.account a join iam.person p on p.id = a.person_id where a.login_name = $1', [operator.loginName, room])).rows[0]?.ok;
    expect(await counts()).toBe(true);

    // Refusals: for oneself, an end before the start, an unknown user; a person without QUALIFICATION.RECORD.
    expect(refusalOf(await coordinator.call(routes.plantRules.recordAreaAuthorisation, { params: { code: room }, body: { loginName: coordinatorLogin } }))).toMatchObject({ code: 'EBMR-IAM-003' });
    expect(refusalOf(await coordinator.call(routes.plantRules.recordAreaAuthorisation, { params: { code: room }, body: { loginName: operator.loginName, validTo: '2020-01-01T00:00:00+05:30' } }))).toMatchObject({ status: 422, code: 'EBMR-PLANT-188' });
    expect(refusalOf(await coordinator.call(routes.plantRules.recordAreaAuthorisation, { params: { code: room }, body: { loginName: 'nobody.here' } }))).toMatchObject({ status: 404, code: 'EBMR-PLANT-186' });
    const qa = await gmp.asPersona('qaInvestigator');
    expect(refusalOf(await qa.call(routes.plantRules.recordAreaAuthorisation, { params: { code: room }, body: { loginName: operator.loginName } })).status).toBeGreaterThanOrEqual(400);
    expect(refusalOf(await qa.call(routes.plantRules.withdrawAreaAuthorisation, { params: { recordId: rec.recordId }, body: { reason: 'Not my call' } })).status).toBeGreaterThanOrEqual(400);

    // Withdrawn with its reason: kept in the matrix, no longer counting; withdrawing it again is refused.
    const gone = valueOf(await coordinator.call(routes.plantRules.withdrawAreaAuthorisation, { params: { recordId: rec.recordId }, body: { reason: 'Moved to the packaging hall' } }));
    expect(gone).toMatchObject({ recordId: rec.recordId, withdrawalReason: 'Moved to the packaging hall', current: false });
    expect(gone.withdrawnAt).not.toBeNull();
    expect(await counts()).toBe(false);
    expect(refusalOf(await coordinator.call(routes.plantRules.withdrawAreaAuthorisation, { params: { recordId: rec.recordId }, body: { reason: 'Twice' } }))).toMatchObject({ code: 'EBMR-IAM-160' });
    expect(refusalOf(await coordinator.call(routes.plantRules.withdrawAreaAuthorisation, { params: { recordId: randomUUID() }, body: { reason: 'Unknown' } }))).toMatchObject({ status: 404, code: 'EBMR-PLANT-185' });
    expect((await areaOf(coordinator))?.records.map((r) => r.withdrawalReason)).toEqual(['Moved to the packaging hall']);
    // Bypass: the application role cannot change or remove a record itself.
    await expect(gmp.db.app.query("update iam.person_qualification set withdrawn_at = null where id = $1", [rec.recordId])).rejects.toThrow(/permission denied/);
    await expect(gmp.db.app.query('delete from iam.person_qualification where id = $1', [rec.recordId])).rejects.toThrow(/permission denied/);
  });
});
