/**
 * Kernel 1181 (Phase 6 slice 6a, builder A): the register of overrides of interface-captured values (DI-31, DI-26) and
 * the LMS qualification source on the generic mirror freshness (INV-26, INV-38). As the application role through real
 * identities; the override function is owner-only and is reached through a domain command (site services 0913), so
 * here the application's attempts to reach it directly are refused.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, withCommand, type ActorContext } from '../../src/db/command.ts';
import { heldHead } from '../integrations/support.ts';
import { ensureFixtureChangeRecord, underChange } from '../support/change-record.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { describeTestInterfaces, testInterface } from '../support/validation.ts';
import { expectPermissionDenied, expectRefused, testActor } from '../identity/helpers.ts';
import { seedAdministration, seedServiceActor, withReason, type SeededActor } from '../identity/seed.ts';

let db: TestDatabase;
let admin: SeededActor;
let owner: SeededActor;
let lms: SeededActor;
const LMS = `LMS-${randomBytes(3).toString('hex').toUpperCase()}`;

const ctxOf = (a: SeededActor): ActorContext => {
  const { seed: _seed, ...c } = a;
  void _seed;
  return { ...c, correlationId: randomUUID() };
};

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureFixtureChangeRecord(db);
  ({ admin, owner } = await seedAdministration(db));
  lms = await seedServiceActor(db, { kind: 'INTEGRATION', name: 'LMS adapter' });
  // Slice 7c (DI-06, kernel 1350): a GMP installation exchanges messages only with a described interface.
  await describeTestInterfaces(db, [testInterface(LMS, 'LMS')]);
  await withCommand(db.app, withReason(admin), (c) =>
    c.query('select iam.register_integration_adapter($1, $2, $3, $4, $5)', [LMS, 'LMS', lms.accountId, lms.deviceId, 'LMS adapter for 1181']));
}, 120_000);
afterAll(async () => {
  await db.drop();
});

const fresh = async (at = 'clock_timestamp()'): Promise<boolean | null> =>
  (await db.app.query<{ f: boolean | null }>(`select iam.qualification_source_fresh('LMS', ${at}) as f`)).rows[0]?.f ?? null;
const setMode = (mode: string) =>
  withCommand(db.app, underChange(withReason(owner)), (c) => c.query("select platform.set_setting('integration.mode.lms_qualification', $1)", [mode]));

describe('the LMS qualification source on the generic mirror freshness (kernel 1181)', () => {
  it('[DI-31] stale LMS mirror: an LMS qualification is not fresh once the adapter stops synchronising, and the refusal names the mirror', async () => {
    // STAND_IN: the 0130 heartbeat rules LMS rows (none recorded: not fresh), the generic mirror is not read.
    expect(await fresh()).toBe(false);
    expect((await db.app.query<{ p: string | null }>('select iam.lms_mirror_problem() as p')).rows[0]?.p).toBeNull();
    await setMode('MIRROR');
    try {
      expect(await fresh()).toBe(false);
      expect((await db.app.query<{ p: string | null }>('select iam.lms_mirror_problem() as p')).rows[0]?.p).toMatch(/^EBMR-INT-010 the LMS mirror LMS_QUALIFICATION is stale: it has never synchronised/);
      await withCommand(db.app, ctxOf(lms), async (c) => c.query("select platform.record_mirror_sync('LMS_QUALIFICATION', $1)", [await heldHead(db, LMS)]));
      expect(await fresh()).toBe(true);
      expect((await db.app.query<{ p: string | null }>('select iam.lms_mirror_problem() as p')).rows[0]?.p).toBeNull();
      // The bound is the data class's (3600 s by default): two hours later the source is stale, and was fresh two hours ago.
      await db.admin.query("update platform.mirror_sync set last_synced_at = last_synced_at - interval '2 hours' where data_class = 'LMS_QUALIFICATION'");
      expect(await fresh()).toBe(false);
      expect(await fresh("clock_timestamp() - interval '2 hours'")).toBe(true);
      expect((await db.app.query<{ p: string | null }>('select iam.lms_mirror_problem() as p')).rows[0]?.p).toMatch(/last synchronised 720\d s ago, more than its bound of 3600 s/);
      // The INTERNAL register never goes stale.
      expect((await db.app.query("select iam.qualification_source_fresh('INTERNAL', clock_timestamp()) as f")).rows[0]).toEqual({ f: true });
    } finally {
      await setMode('STAND_IN');
    }
  });
});

describe('overrides of interface-captured values (kernel 1181)', () => {
  it('[DI-31][DI-26] the override register is written only through a domain correction: the application can neither call the function nor write the table', async () => {
    const person = await testActor(db);
    await expectPermissionDenied(withCommand(db.app, ctxOf(person), (c) =>
      c.query("select platform.record_inbound_override(gen_random_uuid(), 'lot_receipt', gen_random_uuid(), 'containers', '2', null, '3', null, 'x')")));
    await expectPermissionDenied(withCommand(db.app, ctxOf(person), (c) => c.query("insert into platform.inbound_override (adapter_id) values (gen_random_uuid())")));
    await expectPermissionDenied(withCommand(db.app, ctxOf(person), (c) => c.query('delete from platform.inbound_override')));
  });

  it('[DI-31][DI-14] an override is a person\'s, with a reason and a new value, of a value that came in a message', async () => {
    // Owner-level code calling the function directly still meets its rules.
    const sha = createHash('sha256').update('{}').digest('hex');
    const msg = await withCommand(db.app, ctxOf(lms), async (c) =>
      (await c.query<{ id: string }>('select platform.accept_inbound($1::jsonb) as id', [JSON.stringify({
        sourceSystem: 'LMS', messageType: 'lms.qualification', sourceRecordId: 'Q-1', sourceTimestamp: '1800000000000000', sequenceNo: '1',
        idempotencyKey: `k-${randomUUID()}`, schemaVersion: '1', payloadHash: sha, payload: {},
      })])).rows[0]?.id ?? '');
    const asOwner = async (actor: SeededActor, args: unknown[]): Promise<void> => {
      const c = await db.admin.connect();
      try {
        await c.query('begin');
        await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctxOf(actor)))]);
        await c.query('select platform.record_inbound_override($1, $2, $3, $4, $5, $6, $7, $8, $9)', args);
        await c.query('commit');
      } catch (error) {
        await c.query('rollback');
        throw error;
      } finally {
        c.release();
      }
    };
    const person = await testActor(db);
    const rec = randomUUID();
    await expectRefused(asOwner(lms, [msg, 'lot_receipt', rec, 'containers', '2', null, '3', null, 'the LMS corrects']), 'EBMR-INT-020');
    await expectRefused(asOwner(person, [msg, 'lot_receipt', rec, 'containers', '2', null, '3', null, ' ']), 'EBMR-INT-021');
    await expectRefused(asOwner(person, [randomUUID(), 'lot_receipt', rec, 'containers', '2', null, '3', null, 'reason']), 'EBMR-INT-022');
    await expectRefused(asOwner(person, [msg, 'lot_receipt', rec, 'containers', '2', null, '2', null, 'reason']), 'EBMR-INT-023');
    await asOwner(person, [msg, 'lot_receipt', rec, 'containers', '2', null, '3', null, 'the delivery note shows three']);
    const { rows } = await db.app.query('select adapter_code, original_value, corrected_value, corrected_by_person::text as p from platform.inbound_override where record_id = $1', [rec]);
    expect(rows).toEqual([{ adapter_code: LMS, original_value: '2', corrected_value: '3', p: person.personId }]);
  });
});
