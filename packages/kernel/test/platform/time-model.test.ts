/**
 * Two-timestamp model, late entries, site zone storage and clock monotonicity (outline 5.6;
 * control DI-27; invariant INV-16).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { Instant } from '../../src/time/instant.ts';
import { evaluateAtInstants, guardInstants } from '../../src/time/entry-time.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { grantPermission, installStubHooks, stubSignature, testActor, withTriggersDisabled } from './helpers.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
  await installStubHooks(db);
});
afterAll(async () => {
  await db.drop();
});

interface EntryRow {
  id: string;
  batch_id: string;
  recorded_at: string;
  occurred_at: string | null;
  occurred_trust: string | null;
  time_basis: string;
  time_basis_at: string;
  is_late: boolean;
  late_window_ends_at: string | null;
  site_zone: string;
  site_utc_offset: string;
  aggregate_seq: string;
  clock_regressed: boolean;
  review_flags: string[];
  entered_by: string;
}

const ENTRY_COLUMNS = `id, batch_id, recorded_at::text, occurred_at::text, occurred_trust, time_basis, time_basis_at::text, is_late,
  late_window_ends_at::text, site_zone, site_utc_offset::text, aggregate_seq::text, clock_regressed, review_flags, entered_by`;

async function newStep(opts: { batchId?: string; startedAgo?: string; plannedEnd?: string | null } = {}): Promise<{ stepId: string; batchId: string }> {
  const batchId = opts.batchId ?? randomUUID();
  const stepId = await withCommand(db.app, await testActor(db), async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `insert into platform.stub_step (batch_id, planned_end_at) values ($1, clock_timestamp() + $2::interval) returning id`,
      [batchId, opts.plannedEnd === undefined ? '8 hours' : opts.plannedEnd],
    );
    return rows[0]?.id ?? '';
  });
  if (opts.startedAgo) {
    // Test set-up only: a step that started in the past (triggers off for this superuser transaction).
    await withTriggersDisabled(db, (c) => c.query('update platform.stub_step set started_at = started_at - $2::interval where id = $1', [stepId, opts.startedAgo]));
  }
  return { stepId, batchId };
}

interface EntryInput {
  itemNo?: number;
  value?: string;
  occurredAgo?: string;
  occurredAt?: string;
  trust?: string;
  lateReason?: string;
  cosignatureId?: string;
}

async function addEntry(stepId: string, input: EntryInput = {}, ctx?: ActorContext): Promise<EntryRow> {
  return withCommand(db.app, ctx ?? (await testActor(db)), async (c) => {
    const { rows } = await c.query<EntryRow>(
      `insert into platform.stub_step_entry (step_id, item_no, value, unit, occurred_at, occurred_trust, late_reason_code, cosignature_id)
       values ($1, $2, $3, 'kg',
               coalesce($4::timestamptz, clock_timestamp() - $5::interval), $6, $7, $8)
       returning ${ENTRY_COLUMNS}`,
      [stepId, input.itemNo ?? 1, input.value ?? '12.503', input.occurredAt ?? null, input.occurredAgo ?? null, input.trust ?? null, input.lateReason ?? null, input.cosignatureId ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error('no row');
    return row;
  });
}

async function sql<T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.app.query<T>(text, params)).rows;
}

describe('two times per event', () => {
  it('[INV-16] platform.check_occurred_at accepts an event time between the step start and recorded_at and refuses others', async () => {
    const check = (occurred: string | null, trust: string | null, start: string | null, recorded: string) =>
      db.app.query('select platform.check_occurred_at($1, $2, $3, $4)', [occurred, trust, start, recorded]);
    await expect(check('2026-09-27T10:05:00Z', 'USER_CLAIMED', '2026-09-27T10:00:00Z', '2026-09-27T10:10:00Z')).resolves.toBeTruthy();
    await expect(check(null, null, '2026-09-27T10:00:00Z', '2026-09-27T10:10:00Z')).resolves.toBeTruthy();
    await expect(check('2026-09-27T10:11:00Z', 'DEVICE_SYNCED', '2026-09-27T10:00:00Z', '2026-09-27T10:10:00Z')).rejects.toThrow('EBMR-PLAT-012');
    await expect(check('2026-09-27T09:59:59Z', 'PAPER', '2026-09-27T10:00:00Z', '2026-09-27T10:10:00Z')).rejects.toThrow('EBMR-PLAT-013');
    await expect(check('2026-09-27T10:05:00Z', null, null, '2026-09-27T10:10:00Z')).rejects.toThrow('EBMR-PLAT-011');
    await expect(check('2026-09-27T10:05:00Z', 'GUESSED', null, '2026-09-27T10:10:00Z')).rejects.toThrow('EBMR-PLAT-010');
  });

  it('[INV-16] time constraints use occurred_at only when it is DEVICE_SYNCED, and each row records which time it used', async () => {
    const { stepId } = await newStep({ startedAgo: '1 hour' });
    const synced = await addEntry(stepId, { itemNo: 1, occurredAgo: '10 minutes', trust: 'DEVICE_SYNCED' });
    expect(synced.time_basis).toBe('OCCURRED_AT');
    expect(synced.time_basis_at).toBe(synced.occurred_at);
    expect(synced.is_late).toBe(false);

    const unsynced = await addEntry(stepId, { itemNo: 2, occurredAgo: '5 minutes', trust: 'DEVICE_UNSYNCED' });
    expect(unsynced.time_basis).toBe('RECORDED_AT');
    expect(unsynced.time_basis_at).toBe(unsynced.recorded_at);
    expect(unsynced.review_flags).toContain('DEVICE_TIME_UNSYNCED');

    const plain = await addEntry(stepId, { itemNo: 3 });
    expect(plain.occurred_at).toBeNull();
    expect(plain.time_basis).toBe('RECORDED_AT');
    expect(plain.review_flags).toEqual([]);
  });

  it('[DI-27][INV-16] a time a person enters is kept apart from the entry time, flagged, and needs the late-entry path', async () => {
    const { stepId } = await newStep({ startedAgo: '1 hour' });
    await expect(addEntry(stepId, { occurredAgo: '20 minutes', trust: 'USER_CLAIMED' })).rejects.toThrow('EBMR-PLAT-015');
    const row = await addEntry(stepId, { occurredAgo: '20 minutes', trust: 'USER_CLAIMED', lateReason: 'FORGOT_TO_RECORD' });
    expect(row.is_late).toBe(true);
    expect(row.occurred_at).not.toBe(row.recorded_at);
    expect(Instant.parse(row.occurred_at ?? '').isBefore(Instant.parse(row.recorded_at))).toBe(true);
    expect(row.time_basis).toBe('RECORDED_AT');
    expect(row.review_flags).toContain('LATE_ENTRY');
    // A reason on an entry that is not late is refused rather than silently kept.
    await expect(addEntry(stepId, { itemNo: 2, lateReason: 'X' })).rejects.toThrow('EBMR-PLAT-019');
  });

  it('[INV-16] a PAPER back-entry is a late entry too', async () => {
    const { stepId } = await newStep({ startedAgo: '1 hour' });
    await expect(addEntry(stepId, { occurredAgo: '30 minutes', trust: 'PAPER' })).rejects.toThrow('EBMR-PLAT-015');
    const row = await addEntry(stepId, { occurredAgo: '30 minutes', trust: 'PAPER', lateReason: 'SERVER_DOWN_CONTINGENCY' });
    expect(row.is_late).toBe(true);
  });

  it('[INV-16] claimed event times stay in order within the step', async () => {
    const { stepId } = await newStep({ startedAgo: '1 hour' });
    await addEntry(stepId, { itemNo: 1, occurredAgo: '40 minutes', trust: 'DEVICE_SYNCED' });
    await addEntry(stepId, { itemNo: 3, occurredAgo: '10 minutes', trust: 'DEVICE_SYNCED' });
    await expect(addEntry(stepId, { itemNo: 2, occurredAgo: '50 minutes', trust: 'USER_CLAIMED', lateReason: 'LATE' })).rejects.toThrow('EBMR-PLAT-014');
    await expect(addEntry(stepId, { itemNo: 2, occurredAgo: '5 minutes', trust: 'USER_CLAIMED', lateReason: 'LATE' })).rejects.toThrow('EBMR-PLAT-014');
    const ok = await addEntry(stepId, { itemNo: 2, occurredAgo: '20 minutes', trust: 'USER_CLAIMED', lateReason: 'LATE' });
    expect(ok.is_late).toBe(true);
  });
});

describe('late-entry window', () => {
  it('[INV-16] within the window a reason suffices; beyond it a valid supervisor co-signature is required', async () => {
    // Kernel default: the window ends at the planned end of the step.
    const { stepId, batchId } = await newStep({ startedAgo: '2 hours', plannedEnd: '-30 minutes' });
    await expect(addEntry(stepId, { occurredAgo: '1 hour', trust: 'USER_CLAIMED', lateReason: 'LATE' })).rejects.toThrow('EBMR-PLAT-016');
    await expect(addEntry(stepId, { occurredAgo: '1 hour', trust: 'USER_CLAIMED', lateReason: 'LATE', cosignatureId: randomUUID() })).rejects.toThrow(
      'EBMR-PLAT-008',
    );
    const wrongMeaning = await stubSignature(db, 'VERIFIED', 'batch', batchId);
    await expect(addEntry(stepId, { occurredAgo: '1 hour', trust: 'USER_CLAIMED', lateReason: 'LATE', cosignatureId: wrongMeaning })).rejects.toThrow(
      'EBMR-PLAT-008',
    );
    const cosign = await stubSignature(db, 'LATE_ENTRY_APPROVED', 'batch', batchId);
    const row = await addEntry(stepId, { occurredAgo: '1 hour', trust: 'USER_CLAIMED', lateReason: 'LATE', cosignatureId: cosign });
    expect(row.review_flags).toEqual(expect.arrayContaining(['LATE_ENTRY', 'LATE_BEYOND_WINDOW']));

    const inside = await newStep({ startedAgo: '2 hours', plannedEnd: '1 hour' });
    const ok = await addEntry(inside.stepId, { occurredAgo: '1 hour', trust: 'USER_CLAIMED', lateReason: 'LATE' });
    expect(ok.review_flags).not.toContain('LATE_BEYOND_WINDOW');
  });

  it('[INV-16] with no signature verifier registered, a co-signed late entry is refused (fail closed)', async () => {
    const { stepId, batchId } = await newStep({ startedAgo: '2 hours', plannedEnd: '-30 minutes' });
    const cosign = await stubSignature(db, 'LATE_ENTRY_APPROVED', 'batch', batchId);
    const { rows } = await db.admin.query<{ function_oid: string }>("select function_oid::text from platform.hook where name = 'SIGNATURE'");
    await db.admin.query("delete from platform.hook where name = 'SIGNATURE'");
    try {
      await expect(addEntry(stepId, { occurredAgo: '1 hour', trust: 'USER_CLAIMED', lateReason: 'LATE', cosignatureId: cosign })).rejects.toThrow(
        'EBMR-PLAT-007',
      );
    } finally {
      await db.admin.query("select platform.register_hook('SIGNATURE', $1::regprocedure)", [rows[0]?.function_oid]);
    }
  });

  it('[INV-16] a fixed late-entry window (policy value, e.g. 15 min for injectables) is measured from the event', async () => {
    const qa = await testActor(db, { roleCode: 'QA_ADMIN', reasonCode: 'POLICY_CHANGE', reasonText: 'edition default' });
    await grantPermission(db, 'QA_ADMIN', 'platform.settings.change');
    await withCommand(db.app, qa, async (c) => {
      await c.query("select platform.set_setting('time.late_entry_window_mode', 'FIXED_INTERVAL')");
      await c.query("select platform.set_setting('time.late_entry_window_min', '15')");
    });
    try {
      const { stepId } = await newStep({ startedAgo: '2 hours', plannedEnd: '4 hours' });
      const inside = await addEntry(stepId, { itemNo: 1, occurredAgo: '10 minutes', trust: 'USER_CLAIMED', lateReason: 'LATE' });
      expect(inside.review_flags).not.toContain('LATE_BEYOND_WINDOW');
      await expect(addEntry(stepId, { itemNo: 1, occurredAgo: '20 minutes', trust: 'USER_CLAIMED', lateReason: 'LATE' })).rejects.toThrow('EBMR-PLAT-016');
    } finally {
      await withCommand(db.app, qa, (c) => c.query("select platform.set_setting('time.late_entry_window_mode', 'PLANNED_STEP_END')"));
    }
  });

  it('[INV-16] changing a time policy needs a reason and the permission, and values outside the allowed set are refused', async () => {
    const noReason = await testActor(db, { roleCode: 'QA_ADMIN' });
    await expect(withCommand(db.app, noReason, (c) => c.query("select platform.set_setting('time.late_entry_window_min', '10')"))).rejects.toThrow(
      'EBMR-PLAT-022',
    );
    const operator = await testActor(db, { roleCode: 'OPERATOR', reasonCode: 'X' });
    await expect(withCommand(db.app, operator, (c) => c.query("select platform.set_setting('time.late_entry_window_min', '10')"))).rejects.toThrow(
      'EBMR-PLAT-006',
    );
    const qa = await testActor(db, { roleCode: 'QA_ADMIN', reasonCode: 'X' });
    await grantPermission(db, 'QA_ADMIN', 'platform.settings.change');
    await expect(withCommand(db.app, qa, (c) => c.query("select platform.set_setting('time.late_entry_window_mode', 'NEVER')"))).rejects.toThrow('EBMR-PLAT-021');
    await expect(withCommand(db.app, qa, (c) => c.query("select platform.set_setting('time.late_entry_window_min', '2000')"))).rejects.toThrow('EBMR-PLAT-021');
    await expect(db.app.query("insert into platform.setting_value (key, value, set_by_person, reason_code) values ('time.late_entry_window_min', '999', 'x', 'y')")).rejects.toThrow(
      /permission denied/,
    );
  });

  it('[INV-16] status guards of a late entry are evaluated at both instants; a failure at either requires an exception', async () => {
    const { stepId } = await newStep({ startedAgo: '2 hours' });
    const row = await addEntry(stepId, { occurredAgo: '1 hour', trust: 'USER_CLAIMED', lateReason: 'LATE' });
    const rows = await sql<{ instant_role: 'OCCURRED_AT' | 'RECORDED_AT'; at: string }>(
      'select instant_role, at::text from platform.guard_instants($1, $2, $3)',
      [row.occurred_at, row.occurred_trust, row.recorded_at],
    );
    expect(rows.map((r) => r.instant_role)).toEqual(['OCCURRED_AT', 'RECORDED_AT']);
    const fromDb = rows.map((r) => ({ role: r.instant_role, at: Instant.parse(r.at) }));
    const recorded = Instant.parse(row.recorded_at);
    const occurred = Instant.parse(row.occurred_at ?? '');
    expect(fromDb).toEqual(guardInstants(recorded, occurred));

    // A balance whose calibration expired 30 minutes ago: valid at the event, not at entry.
    const calibrationValidUntil = recorded.plusMicros(-30n * 60n * 1_000_000n);
    const result = await evaluateAtInstants(fromDb, (at) =>
      at.isAfter(calibrationValidUntil) ? { passed: false, reason: 'balance calibration expired' } : { passed: true },
    );
    expect(result.evaluations.map((e) => [e.role, e.passed])).toEqual([
      ['OCCURRED_AT', true],
      ['RECORDED_AT', false],
    ]);
    expect(result.exceptionRequired).toBe(true);

    const contemporaneous = await sql<{ instant_role: string }>('select instant_role from platform.guard_instants(null, null, clock_timestamp())');
    expect(contemporaneous.map((r) => r.instant_role)).toEqual(['RECORDED_AT']);
  });
});

describe('recorded_at is the database clock', () => {
  it('[INV-16] the application role cannot supply recorded_at or any derived time column', async () => {
    const { stepId } = await newStep();
    const forged: Record<string, string> = {
      recorded_at: "'2001-01-01T00:00:00Z'",
      time_basis_at: "'2001-01-01T00:00:00Z'",
      time_basis: "'OCCURRED_AT'",
      site_utc_offset: "'00:00'",
      site_zone: "'UTC'",
      is_late: 'false',
      aggregate_seq: '1',
      clock_regressed: 'false',
      review_flags: "'{}'",
      batch_id: 'gen_random_uuid()',
      entered_by: "'someone else'",
    };
    for (const [col, value] of Object.entries(forged)) {
      await expect(
        withCommand(db.app, await testActor(db), (c) =>
          c.query(`insert into platform.stub_step_entry (step_id, item_no, value, ${col}) values ($1, 1, 1, ${value})`, [stepId]),
        ),
      ).rejects.toThrow(/permission denied/);
    }
    await expect(
      withCommand(db.app, await testActor(db), (c) => c.query("insert into platform.stub_step (batch_id, started_at) values (gen_random_uuid(), '2001-01-01')")),
    ).rejects.toThrow(/permission denied/);
  });

  it('[INV-16] even a superuser-supplied recorded_at is replaced by the database clock', async () => {
    const { stepId } = await newStep();
    const before = Instant.parse((await sql<{ t: string }>('select clock_timestamp()::text as t'))[0]?.t ?? '');
    const row = await withCommand(db.admin, await testActor(db), async (c) => {
      const { rows } = await c.query<EntryRow>(
        `insert into platform.stub_step_entry (step_id, item_no, value, recorded_at, time_basis_at, time_basis, batch_id, entered_by, site_zone,
                                               site_utc_offset, is_late, aggregate_seq, clock_regressed, review_flags)
         values ($1, 1, 5, '2001-01-01T00:00:00Z', '2001-01-01T00:00:00Z', 'RECORDED_AT', gen_random_uuid(), 'forged', 'UTC', '0', false, 99, false, '{}')
         returning ${ENTRY_COLUMNS}`,
        [stepId],
      );
      return rows[0] as EntryRow;
    });
    const after = Instant.parse((await sql<{ t: string }>('select clock_timestamp()::text as t'))[0]?.t ?? '');
    const recorded = Instant.parse(row.recorded_at);
    expect(recorded.compare(before)).toBeGreaterThanOrEqual(0);
    expect(recorded.compare(after)).toBeLessThanOrEqual(0);
    expect(row.time_basis_at).toBe(row.recorded_at);
    expect(row.entered_by).not.toBe('forged');
    expect(row.aggregate_seq).toBe('1');
  });

  it('[INV-16] a stored recorded_at never changes afterwards', async () => {
    const { stepId } = await newStep();
    const row = await addEntry(stepId);
    await expect(
      withCommand(db.app, await testActor(db, { reasonCode: 'X' }), (c) => c.query("update platform.stub_step_entry set recorded_at = '2001-01-01' where id = $1", [row.id])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withCommand(db.admin, await testActor(db, { reasonCode: 'X' }), (c) => c.query("update platform.stub_step_entry set value = 1 where id = $1", [row.id])),
    ).rejects.toThrow('EBMR-AUDIT-004');
    // On a mutable platform table the forcing trigger keeps the stored time on update.
    await grantPermission(db, 'TIME_ADMIN', 'platform.time_source.manage');
    const admin = await testActor(db, { roleCode: 'TIME_ADMIN', reasonCode: 'SOURCE_REPLACED' });
    const sourceId = await withCommand(db.app, admin, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "select platform.register_time_source('Test NTP A', 'NTP', 'ntp-a.example', 'test reference', gen_random_uuid(), 'VAL-001') as id",
      );
      return rows[0]?.id ?? '';
    });
    const t0 = (await sql<{ t: string }>('select recorded_at::text as t from platform.time_source where id = $1', [sourceId]))[0]?.t;
    await withCommand(db.admin, admin, (c) => c.query("update platform.time_source set active = false, recorded_at = '2001-01-01' where id = $1", [sourceId]));
    const t1 = (await sql<{ t: string; active: boolean }>('select recorded_at::text as t, active from platform.time_source where id = $1', [sourceId]))[0];
    expect(t1?.t).toBe(t0);
    expect(t1?.active).toBe(false);
  });

  it('[INV-16] the time-model invariant query returns no rows for the platform, and reports a disabled forcing trigger', async () => {
    const mine = async () =>
      (await sql<{ table_name: string; problem: string }>('select table_name, problem from platform.time_model_violations()')).filter((r) =>
        r.table_name.startsWith('platform.'),
      );
    expect(await mine()).toEqual([]);
    const { rows } = await db.app.query<{ n: string }>("select count(*)::text as n from platform.db_time_column where table_name::text like 'platform.%'");
    expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(15);
    await db.admin.query('alter table platform.stub_step_entry disable trigger a0_db_time_platform_stub_step_entry');
    try {
      expect(await mine()).toEqual([{ table_name: 'platform.stub_step_entry', problem: 'forcing trigger missing or disabled' }]);
    } finally {
      await db.admin.query('alter table platform.stub_step_entry enable trigger a0_db_time_platform_stub_step_entry');
    }
    expect(await mine()).toEqual([]);
  });

  it('[DI-27][INV-16] change a terminal clock, then record a step: the stored time is unaffected', async () => {
    const { stepId } = await newStep({ startedAgo: '10 minutes' });
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2001-02-03T04:05:06Z') });
    try {
      // The terminal's clock is now wrong by 25 years; its request carries that time.
      const terminalTime = new Date().toISOString();
      expect(terminalTime.startsWith('2001-02-03')).toBe(true);
      const row = await addEntry(stepId, { itemNo: 1 });
      const dbTime = Instant.parse((await sql<{ t: string }>('select clock_timestamp()::text as t'))[0]?.t ?? '');
      const recorded = Instant.parse(row.recorded_at);
      expect(dbTime.epochMicros - recorded.epochMicros).toBeGreaterThanOrEqual(0n);
      expect(dbTime.epochMicros - recorded.epochMicros).toBeLessThan(60_000_000n);
      expect(row.recorded_at.startsWith('2001')).toBe(false);
      // Sending the terminal time as the entry time is not possible ...
      await expect(
        withCommand(db.app, await testActor(db), (c) =>
          c.query('insert into platform.stub_step_entry (step_id, item_no, value, recorded_at) values ($1, 2, 1, $2)', [stepId, terminalTime]),
        ),
      ).rejects.toThrow(/permission denied/);
      // ... and claiming it as the event time is refused: it lies before the step started.
      await expect(addEntry(stepId, { itemNo: 2, occurredAt: terminalTime, trust: 'USER_CLAIMED', lateReason: 'TERMINAL' })).rejects.toThrow('EBMR-PLAT-013');
      // A terminal clock that runs ahead cannot claim a future event time either.
      vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));
      await expect(addEntry(stepId, { itemNo: 2, occurredAt: new Date().toISOString(), trust: 'DEVICE_SYNCED' })).rejects.toThrow('EBMR-PLAT-012');
    } finally {
      vi.useRealTimers();
    }
  });

  it('[DI-27] entries store the UTC instant with the site time zone and the offset in force', async () => {
    const { stepId } = await newStep();
    const india = await addEntry(stepId, { itemNo: 1 }, await testActor(db, { siteZone: 'Asia/Kolkata' }));
    expect(india.site_zone).toBe('Asia/Kolkata');
    expect(india.site_utc_offset).toBe('05:30:00');
    const berlin = await addEntry(stepId, { itemNo: 2 }, await testActor(db, { siteZone: 'Europe/Berlin' }));
    const expected = (await sql<{ o: string }>("select platform.utc_offset($1, 'Europe/Berlin')::text as o", [berlin.recorded_at]))[0]?.o;
    expect(['01:00:00', '02:00:00']).toContain(berlin.site_utc_offset);
    expect(berlin.site_utc_offset).toBe(expected);
    await expect(addEntry(stepId, { itemNo: 3 }, await testActor(db, { siteZone: 'Mars/Olympus' }))).rejects.toThrow('EBMR-PLAT-017');
    await expect(addEntry(stepId, { itemNo: 3 }, await testActor(db, { siteZone: 'IST' }))).rejects.toThrow('EBMR-PLAT-017');
  });
});

describe('monotonic order per aggregate', () => {
  it('[INV-16] each event of an aggregate gets the next counter value', async () => {
    const { stepId, batchId } = await newStep();
    const seqs: string[] = [];
    for (let i = 1; i <= 3; i++) seqs.push((await addEntry(stepId, { itemNo: i })).aggregate_seq);
    expect(seqs).toEqual(['1', '2', '3']);
    const other = await newStep({ batchId });
    expect((await addEntry(other.stepId)).aggregate_seq).toBe('4');
  });

  it('[INV-16] a recorded_at earlier than the aggregate\'s last value is flagged and ordered by the counter', async () => {
    const { stepId, batchId } = await newStep();
    await addEntry(stepId, { itemNo: 1 });
    // Simulate a clock that stepped back (e.g. failover to a node that is behind): the
    // aggregate's last recorded time is one hour ahead of the current database clock.
    await db.admin.query(
      "update platform.aggregate_clock set last_recorded_at = clock_timestamp() + interval '1 hour' where aggregate_type = 'batch' and aggregate_id = $1",
      [batchId],
    );
    const row = await addEntry(stepId, { itemNo: 2 });
    expect(row.clock_regressed).toBe(true);
    expect(row.aggregate_seq).toBe('2');
    expect(row.review_flags).toContain('CLOCK_REGRESSION');
    const anomalies = await sql<{ kind: string; aggregate_seq: string }>(
      "select kind, aggregate_seq::text from platform.time_anomaly where aggregate_type = 'batch' and aggregate_id = $1",
      [batchId],
    );
    expect(anomalies).toEqual([{ kind: 'CLOCK_REGRESSION', aggregate_seq: '2' }]);
    await expect(db.app.query('delete from platform.time_anomaly')).rejects.toThrow(/permission denied/);
    await expect(db.app.query("update platform.aggregate_clock set last_seq = 0")).rejects.toThrow(/permission denied/);
  });
});
