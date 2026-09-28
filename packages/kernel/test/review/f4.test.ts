/**
 * Review reproducer F4: dropping an insert-only guard trigger must not go unseen.
 *
 * kernel.register_audited_table gives every insert-only table two guards besides the audit trigger:
 * aa_insert_only_* (BEFORE UPDATE OR DELETE -> kernel.reject_mutation, EBMR-AUDIT-004) and
 * aa_no_truncate_*. ADR-0007 and 0010_audit_trail.sql say an event trigger records DDL so that a
 * disabled trigger or altered table is visible afterwards (kernel.ddl_log), and DI-23 says GMP writes
 * are refused while the trail's protection is missing (kernel.audit_triggers_ok, EBMR-AUDIT-005).
 *
 * kernel.log_ddl only reads pg_event_trigger_ddl_commands() on ddl_command_end; PostgreSQL reports
 * no commands there for DROP statements, and nothing listens on sql_drop. audit_triggers_ok only
 * looks at zz_audit_*. So a DROP TRIGGER of the insert-only guard leaves no DDL log row, begin_command
 * still accepts GMP writes, and a registered insert-only row can be updated (INV-06).
 *
 * Safe behaviour asserted here, after a superuser drops aa_insert_only_testgmp_reading:
 *   - kernel.ddl_log has a new row for the DROP TRIGGER;
 *   - kernel.audit_triggers_ok() (or begin_command) reports the missing guard;
 *   - a GMP command that updates an insert-only row is refused and the row is unchanged.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seededTestActor } from '../support/seeded-actor.ts';

let db: TestDatabase;
let base: ActorContext;

beforeAll(async () => {
  db = await createTestDatabase();
  base = await seededTestActor(db, { legalName: 'Test Operator F4' });
});

afterAll(async () => {
  await db.drop();
});

const actor = (overrides: Partial<ActorContext> = {}): ActorContext => ({ ...base, correlationId: randomUUID(), ...overrides });

const codeOf = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  return m.match(/EBMR-[A-Z]+-\d+/)?.[0] ?? `UNEXPECTED: ${m}`;
};

describe('F4: dropping an insert-only guard trigger is recorded and stops GMP writes', () => {
  it('[DI-23][INV-06] after DROP TRIGGER aa_insert_only_*, kernel.ddl_log records it, audit_triggers_ok is false and an update of an insert-only row is refused', async () => {
    const batch = randomUUID();
    await withCommand(db.app, actor(), (c) => c.query('insert into testgmp.reading (batch_id, value) values ($1, 7)', [batch]));

    // Sanity: with the guard in place, the insert-only row cannot be changed even with a reason (EBMR-AUDIT-004).
    await expect(withCommand(db.app, actor({ reasonCode: 'CORRECTION' }), (c) => c.query('update testgmp.reading set value = 8 where batch_id = $1', [batch]))).rejects.toThrow(
      'EBMR-AUDIT-004',
    );
    // Sanity: the trail reports healthy before the drop.
    const { rows: okBefore } = await db.app.query<{ ok: boolean }>('select kernel.audit_triggers_ok() as ok');
    expect(okBefore[0]?.ok).toBe(true);

    const { rows: before } = await db.admin.query<{ max: string }>('select coalesce(max(id), 0)::text as max from kernel.ddl_log');
    const beforeId = before[0]?.max ?? '0';

    // A superuser (or the owner) removes the insert-only guard.
    await db.admin.query('drop trigger aa_insert_only_testgmp_reading on testgmp.reading');
    try {
      const observed: Record<string, unknown> = {};

      // 1. The DROP must leave a row in kernel.ddl_log.
      const { rows: logged } = await db.app.query<{ command_tag: string; object_identity: string | null }>(
        `select command_tag, object_identity from kernel.ddl_log
          where id > $1::bigint
            and (command_tag = 'DROP TRIGGER' or object_identity like '%aa_insert_only_testgmp_reading%')`,
        [beforeId],
      );
      observed['ddlLogRecordsDropTrigger'] = logged.length > 0;

      // 2. The start-of-command check must see that the guard is gone.
      const { rows: okAfter } = await db.app.query<{ ok: boolean }>('select kernel.audit_triggers_ok() as ok');
      observed['auditTriggersOkAfterDrop'] = okAfter[0]?.ok;

      // 3. A GMP command (with a reason, so EBMR-AUDIT-002 does not mask the result) must not be
      //    able to change the insert-only row.
      let updateOutcome: string;
      try {
        await withCommand(db.app, actor({ reasonCode: 'CORRECTION' }), (c) => c.query('update testgmp.reading set value = 8 where batch_id = $1', [batch]));
        updateOutcome = 'COMMITTED';
      } catch (e) {
        updateOutcome = `REFUSED ${codeOf(e)}`;
      }
      observed['updateOfInsertOnlyRowRefused'] = updateOutcome.startsWith('REFUSED EBMR-');
      const { rows: value } = await db.admin.query<{ value: string }>('select value::text as value from testgmp.reading where batch_id = $1', [batch]);
      observed['insertOnlyValueAfterAttempt'] = value[0]?.value;

      expect(observed, `update outcome: ${updateOutcome}`).toEqual({
        ddlLogRecordsDropTrigger: true,
        auditTriggersOkAfterDrop: false,
        updateOfInsertOnlyRowRefused: true,
        insertOnlyValueAfterAttempt: '7',
      });
    } finally {
      await db.admin.query(
        'create trigger aa_insert_only_testgmp_reading before update or delete on testgmp.reading for each row execute function kernel.reject_mutation()',
      );
    }
  });
});
