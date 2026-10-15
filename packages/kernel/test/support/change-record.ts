/**
 * Test fixture for configuration change control (DI-09, kernel 1195).
 *
 * A configuration change needs the number of an approved, open change record in the command's context. Tests whose
 * subject is not change control itself set configuration under the fixture record below. It is written by the database
 * owner under the software-release identity, as a migration would, with a placeholder approval: it stands in for the
 * real path (raise, quality-unit e-signature, approve), which packages/kernel/test/config/change-control.test.ts proves.
 * It covers every area registered when it is first written.
 */
import type { ActorContext } from '../../src/db/command.ts';
import type { TestDatabase } from './db.ts';

export const FIXTURE_CHANGE_RECORD = 'CR-TEST-FIXTURE';

const ready = new WeakSet<object>();

/** Writes the fixture change record into this test database once. */
export async function ensureFixtureChangeRecord(db: TestDatabase): Promise<string> {
  if (ready.has(db)) return FIXTURE_CHANGE_RECORD;
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query(`select kernel.set_actor_context(jsonb_build_object(
      'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
      'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
      'site_zone', 'UTC', 'correlation_id', gen_random_uuid(), 'legal_name', 'Test fixture (change record)',
      'reason_code', 'SOFTWARE_RELEASE', 'reason_text', 'test fixture: an approved configuration change record'))`);
    await c.query(
      `insert into platform.change_record (number, title, description, areas, raised_by_person, raised_by_account)
       select $1, 'Test fixture', 'Configuration set up by tests', (select array_agg(code order by code) from platform.config_area),
              '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'
       where not exists (select 1 from platform.change_record where number = $1)`,
      [FIXTURE_CHANGE_RECORD],
    );
    await c.query(
      `insert into platform.change_record_event (change_record_id, event, signature_id, person_id, account_id)
       select r.id, 'APPROVED', gen_random_uuid(), '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'
         from platform.change_record r
        where r.number = $1 and not exists (select 1 from platform.change_record_event e where e.change_record_id = r.id and e.event = 'APPROVED')`,
      [FIXTURE_CHANGE_RECORD],
    );
    await c.query('select kernel.set_actor_context(null)');
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
  ready.add(db);
  return FIXTURE_CHANGE_RECORD;
}

/** The context with the fixture change record (write the record first with ensureFixtureChangeRecord). */
export function underChange<T extends ActorContext>(ctx: T, changeRecord: string = FIXTURE_CHANGE_RECORD): T {
  return { ...ctx, changeRecord };
}

/** Writes the fixture record if needed and returns the context under it. */
export async function withChangeRecord<T extends ActorContext>(db: TestDatabase, ctx: T): Promise<T> {
  await ensureFixtureChangeRecord(db);
  return underChange(ctx);
}
