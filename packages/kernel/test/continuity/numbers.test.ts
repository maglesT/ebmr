import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ledgerMaxCeiling } from '../../src/continuity/ledger.ts';
import { numberInvariantViolations, reserveCounterBlock, unprotectedSequences, withProtectedNumbers } from '../../src/continuity/numbers.ts';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { installNumberStub, tempDir, tempLedger, testActor } from './helpers.ts';

let db: TestDatabase;
let ops: ActorContext;
const dir = tempDir('numbers');

beforeAll(async () => {
  db = await createTestDatabase();
  ops = await testActor(db, { roleCode: 'SYSTEM_SERVICE', source: 'SYSTEM' });
  for (const key of ['test.number:A', 'test.number:B', 'test.number:C']) await installNumberStub(db, key, 5);
});
afterAll(async () => {
  await db.drop();
  dir.cleanup();
});

const issue = (key: string) => withCommand(db.app, ops, async (c) => (await c.query<{ v: string }>('select testgmp.issue_number($1)::text as v', [key])).rows[0]?.v);

describe('write-ahead ceilings', () => {
  it('[INV-27] a protected counter issues nothing until its ceiling is written to the external ledger first', async () => {
    const ledger = tempLedger('numbers-a', dir.path);
    await expect(issue('test.number:A')).rejects.toThrow('EBMR-CONT-011');

    const ceiling = await reserveCounterBlock(db.app, ops, ledger, 'test.number:A');
    expect(ceiling).toBe(5n);
    expect(await ledgerMaxCeiling(ledger, 'test.number:A')).toBe(5n);
    const { rows } = await db.app.query<{ new_ceiling: string; ledger_receipt: string }>(
      "select new_ceiling::text, ledger_receipt from continuity.ceiling_reservation where sequence_key = 'test.number:A'",
    );
    expect(rows).toEqual([{ new_ceiling: '5', ledger_receipt: expect.stringMatching(/^ledger:1:[0-9a-f]{16}$/) as string }]);

    const issued: (string | undefined)[] = [];
    for (let i = 0; i < 5; i++) issued.push(await issue('test.number:A'));
    expect(issued).toEqual(['1', '2', '3', '4', '5']);
    await expect(issue('test.number:A')).rejects.toThrow('EBMR-CONT-011');

    // The command wrapper reserves the next block (ledger first) and retries.
    const next = await withProtectedNumbers(db.app, ops, ledger, async (c) => (await c.query<{ v: string }>("select testgmp.issue_number('test.number:A')::text as v")).rows[0]?.v);
    expect(next).toBe('6');
    expect(await ledgerMaxCeiling(ledger, 'test.number:A')).toBe(10n);
    expect(await numberInvariantViolations(db.app)).toEqual([]);
  });

  it('[INV-27] a ceiling the ledger holds but the database never acknowledged is skipped, never reused, and raises an alarm', async () => {
    const ledger = tempLedger('numbers-b', dir.path);
    await reserveCounterBlock(db.app, ops, ledger, 'test.number:B');
    expect(await issue('test.number:B')).toBe('1');
    expect(await issue('test.number:B')).toBe('2');
    // A reservation reached the ledger, then the acknowledgement was lost (crash); values up to 10 may be in use.
    await ledger.append({ type: 'CEILING', database: ledger.database, sequenceKey: 'test.number:B', ceiling: '10', floor: '5' });

    expect(await reserveCounterBlock(db.app, ops, ledger, 'test.number:B')).toBe(15n);
    expect(await issue('test.number:B')).toBe('11');
    const bump = await db.app.query<{ value_before: string; value_after: string }>(
      "select value_before::text, value_after::text from continuity.sequence_bump where sequence_key = 'test.number:B' and reason = 'LEDGER_AHEAD'",
    );
    expect(bump.rows).toEqual([{ value_before: '2', value_after: '10' }]);
    const alarm = await db.app.query<{ severity: string }>("select severity from continuity.open_alarm where alarm_code = 'LEDGER_AHEAD' and details ->> 'sequence_key' = 'test.number:B'");
    expect(alarm.rows).toEqual([{ severity: 'CRITICAL' }]);
  });

  it('[INV-27] a database ceiling missing from the external ledger stops further reservations (write-ahead broken)', async () => {
    const ledger = tempLedger('numbers-c', dir.path);
    await reserveCounterBlock(db.app, ops, ledger, 'test.number:C');
    const emptyLedger = tempLedger('numbers-c-lost', dir.path);
    await expect(reserveCounterBlock(db.app, ops, emptyLedger, 'test.number:C')).rejects.toThrow('EBMR-CONT-013');
  });
});

describe('bypass attempts', () => {
  it('[INV-27] the application role cannot move a counter, issue a value directly, forge a reservation record or reset a protected sequence', async () => {
    await expect(db.app.query("update continuity.counter set last_value = 0 where sequence_key = 'test.number:A'")).rejects.toThrow(/permission denied/);
    await expect(db.app.query("delete from continuity.counter where sequence_key = 'test.number:A'")).rejects.toThrow(/permission denied/);
    await expect(db.app.query("select continuity.next_counter_value('test.number:A')")).rejects.toThrow(/permission denied/);
    await expect(db.app.query("select continuity.register_protected_counter('x.y:z', 'OTHER', 'x', 'x', 5)")).rejects.toThrow(/permission denied/);
    await expect(
      db.app.query(
        "insert into continuity.ceiling_reservation (sequence_key, previous_ceiling, new_ceiling, external_floor, ledger_receipt, incarnation, correlation_id) values ('test.number:A', 0, 99, 0, 'x', 'x', gen_random_uuid())",
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(db.app.query("delete from continuity.sequence_bump")).rejects.toThrow(/permission denied/);
    await expect(db.app.query("select setval('kernel.audit_anchor_id_seq', 1)")).rejects.toThrow(/permission denied/);
    await expect(db.app.query("select setval('kernel.audit_event_id_seq', 1)")).rejects.toThrow(/permission denied/);
  });

  it('[INV-27] not even the table owner can move a counter backwards or remove it', async () => {
    const c = await db.admin.connect();
    try {
      for (const sql of [
        "update continuity.counter set last_value = 0 where sequence_key = 'test.number:A'",
        "update continuity.counter set reserved_ceiling = 0 where sequence_key = 'test.number:A'",
        "delete from continuity.counter where sequence_key = 'test.number:A'",
        'truncate continuity.counter cascade',
        "delete from continuity.protected_sequence where sequence_key = 'kernel.audit_event.id'",
      ]) {
        await c.query('begin');
        await c.query('set local role ebmr_owner');
        await expect(c.query(sql)).rejects.toThrow('EBMR-CONT-016');
        await c.query('rollback');
      }
    } finally {
      c.release();
    }
  });
});

describe('registry', () => {
  it('[INV-27] identifiers that leave the database are registered as protected; a stray sequence is reported by the invariant query', async () => {
    const { rows } = await db.app.query<{ sequence_key: string; identifier_kind: string }>(
      "select sequence_key, identifier_kind from continuity.protected_sequence where owner_module = 'kernel' order by 1",
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { sequence_key: 'kernel.audit_anchor.id', identifier_kind: 'AUDIT_ANCHOR_ID' },
        { sequence_key: 'kernel.audit_event.id', identifier_kind: 'AUDIT_EVENT_ID' },
      ]),
    );
    const before = await unprotectedSequences(db.app);
    expect(before).not.toContain('kernel.audit_event_id_seq');
    expect(before).not.toContain('kernel.audit_anchor_id_seq');
    await db.admin.query('create sequence testgmp.stray_seq');
    await db.admin.query('alter sequence testgmp.stray_seq owner to ebmr_owner');
    expect(await unprotectedSequences(db.app)).toContain('testgmp.stray_seq');
  });
});
