import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAnchor, verifyChain } from '../../src/audit/verify.ts';
import { toDbContext, withCommand, type ActorContext } from '../../src/db/command.ts';
import { actor as fakeActor } from '../support/actors.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seededTestActor } from '../support/seeded-actor.ts';

let db: TestDatabase;
let base: ActorContext;
beforeAll(async () => {
  db = await createTestDatabase();
  // With the identity module installed, the actor must be a real, active identity; with only the
  // foundation migrations (EBMR_MIGRATIONS='^00') any well-formed context is accepted.
  const { rows } = await db.admin.query<{ iam: string | null }>("select to_regnamespace('iam')::text as iam");
  base = rows[0]?.iam ? await seededTestActor(db, { legalName: 'Test Operator' }) : fakeActor();
});

/** The test operator in a new command (fresh correlation id), with optional reason or zone overrides. */
function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return { ...base, correlationId: randomUUID(), ...overrides };
}
afterAll(async () => {
  await db.drop();
});

async function insertSample(batchId: string, value: string, ctx = actor()) {
  return withCommand(db.app, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>('insert into testgmp.sample (batch_id, value) values ($1, $2) returning id', [batchId, value]);
    return rows[0]?.id ?? '';
  });
}

async function events(chainKey: string) {
  const { rows } = await db.app.query<{ seq: string; action: string; recorded_at: Date; correlation_id: string; payload: Record<string, unknown> }>(
    'select seq, action, recorded_at, correlation_id, payload from kernel.audit_event where chain_key = $1 order by seq',
    [chainKey],
  );
  return rows;
}

describe('audit capture', () => {
  it('[DI-22][INV-07] a GMP insert writes an audit event in the same transaction with who, what, when, how', async () => {
    const batch = randomUUID();
    const ctx = actor();
    const id = await insertSample(batch, '12.503', ctx);
    const [e] = await events(`batch:${batch}`);
    expect(e?.action).toBe('INSERT');
    expect(e?.correlation_id).toBe(ctx.correlationId);
    const p = e?.payload as { actor: Record<string, string>; record_id: string; source: string; site_zone: string; body: { new: Record<string, unknown> } };
    expect(p.actor['person_id']).toBe(ctx.personId);
    expect(p.actor['role_code']).toBe('OPERATOR');
    expect(p.actor['device_id']).toBe(ctx.deviceId);
    expect(p.actor['legal_name']).toBe('Test Operator');
    expect(p.source).toBe('UI');
    expect(p.site_zone).toBe('Asia/Kolkata');
    expect(p.record_id).toBe(id);
    expect(p.body.new['value']).toBe(12.503);
  });

  it('[INV-07] a rolled-back command leaves neither the row nor its audit event', async () => {
    const batch = randomUUID();
    await expect(
      withCommand(db.app, actor(), async (c) => {
        await c.query('insert into testgmp.sample (batch_id, value) values ($1, 1)', [batch]);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await events(`batch:${batch}`)).toHaveLength(0);
    const { rows } = await db.app.query('select 1 from testgmp.sample where batch_id = $1', [batch]);
    expect(rows).toHaveLength(0);
  });

  it('[INV-07] a GMP write without a declared actor is refused', async () => {
    await expect(db.app.query('insert into testgmp.sample (batch_id, value) values ($1, 1)', [randomUUID()])).rejects.toThrow('EBMR-AUDIT-001');
  });

  it('[INV-07] an actor context missing a required field is refused', async () => {
    const ctx = toDbContext(actor());
    delete ctx['session_id'];
    await expect(db.app.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(ctx)])).rejects.toThrow('missing session_id');
  });

  it('[DI-22][DI-24] a change after first entry needs a reason and records old and new values', async () => {
    const batch = randomUUID();
    const id = await insertSample(batch, '10.0');
    await expect(
      withCommand(db.app, actor(), (c) => c.query('update testgmp.sample set value = 10.5 where id = $1', [id])),
    ).rejects.toThrow('EBMR-AUDIT-002');
    await withCommand(db.app, actor({ reasonCode: 'TRANSCRIPTION_ERROR', reasonText: 'wrong digit' }), (c) =>
      c.query('update testgmp.sample set value = 10.5 where id = $1', [id]),
    );
    const [, upd] = await events(`batch:${batch}`);
    const p = upd?.payload as { reason_code: string; reason_text: string; body: { old: Record<string, unknown>; new: Record<string, unknown> } };
    expect(upd?.action).toBe('UPDATE');
    expect(p.reason_code).toBe('TRANSCRIPTION_ERROR');
    expect(p.reason_text).toBe('wrong digit');
    expect(p.body.old['value']).toBe(10.0);
    expect(p.body.new['value']).toBe(10.5);
  });

  it('[DI-24][DI-22] an entry is removed only with a reason, and the audit trail keeps the original values', async () => {
    const batch = randomUUID();
    const id = await insertSample(batch, '7.25');
    await expect(withCommand(db.app, actor(), (c) => c.query('delete from testgmp.sample where id = $1', [id]))).rejects.toThrow('EBMR-AUDIT-002');
    await withCommand(db.app, actor({ reasonCode: 'VOID', reasonText: 'entered against the wrong batch' }), (c) =>
      c.query('delete from testgmp.sample where id = $1', [id]),
    );
    const [ins, del] = await events(`batch:${batch}`);
    expect(ins?.action).toBe('INSERT');
    expect(del?.action).toBe('DELETE');
    const p = del?.payload as { reason_code: string; reason_text: string; actor: Record<string, string>; body: { old: Record<string, unknown> } };
    expect(p.reason_code).toBe('VOID');
    expect(p.reason_text).toBe('entered against the wrong batch');
    expect(p.actor['person_id']).toBe(base.personId);
    expect(p.body.old['value']).toBe(7.25);
    expect(await verifyChain(db.app, `batch:${batch}`)).toEqual([]);
  });

  it('[DI-23] nothing the application can call disables the audit trail or removes audit events', async () => {
    // Functions the application role may execute in the kernel schema: none alters triggers or deletes audit rows.
    const { rows: fns } = await db.admin.query<{ name: string; src: string }>(`
      select p.proname as name, p.prosrc as src from pg_catalog.pg_proc p
      where p.pronamespace = 'kernel'::regnamespace and has_function_privilege('ebmr_app', p.oid, 'EXECUTE')`);
    expect(fns.length).toBeGreaterThan(0);
    for (const f of fns) {
      expect(f.src, f.name).not.toMatch(/disable\s+trigger|delete\s+from\s+kernel\.audit_event|truncate/i);
    }
    // The application role owns no table and holds no TRIGGER, UPDATE, DELETE or TRUNCATE right on audit tables.
    const { rows: rights } = await db.admin.query<{ t: string; p: string }>(`
      select t, p from unnest(array['kernel.audit_event', 'kernel.audit_chain_head', 'kernel.audit_checkpoint', 'kernel.audit_anchor',
                                    'kernel.audited_table', 'kernel.ddl_log']) t,
                       unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER']) p
      where has_table_privilege('ebmr_app', t, p)`);
    expect(rights).toEqual([]);
  });

  it('[DI-22] a plain-language business entry shares the correlation ID of the row entries', async () => {
    const batch = randomUUID();
    const ctx = actor({ correlationId: randomUUID() });
    await withCommand(db.app, ctx, async (c) => {
      await c.query('insert into testgmp.sample (batch_id, value) values ($1, 12.503)', [batch]);
      await c.query("select kernel.audit_business_event($1, 'weighing recorded, 12.503 kg, balance B-17')", [`batch:${batch}`]);
    });
    const rows = await events(`batch:${batch}`);
    expect(rows.map((r) => r.action)).toEqual(['INSERT', 'BUSINESS']);
    expect(new Set(rows.map((r) => r.correlation_id))).toEqual(new Set([ctx.correlationId]));
  });
});

describe('insert-only records and protected audit rows', () => {
  it('[INV-06] an insert-only record cannot be updated, deleted or truncated, even with a reason', async () => {
    const batch = randomUUID();
    const ctx = actor({ reasonCode: 'CORRECTION' });
    await withCommand(db.app, ctx, (c) => c.query('insert into testgmp.reading (batch_id, value) values ($1, 7)', [batch]));
    await expect(withCommand(db.app, ctx, (c) => c.query('update testgmp.reading set value = 8 where batch_id = $1', [batch]))).rejects.toThrow('EBMR-AUDIT-004');
    await expect(withCommand(db.app, ctx, (c) => c.query('delete from testgmp.reading where batch_id = $1', [batch]))).rejects.toThrow('EBMR-AUDIT-004');
    // The application role has no TRUNCATE right at all; a table owner would still hit the trigger.
    await expect(withCommand(db.app, ctx, (c) => c.query('truncate testgmp.reading'))).rejects.toThrow(/EBMR-AUDIT-004|permission denied/);
    await expect(db.admin.query('truncate testgmp.reading')).rejects.toThrow('EBMR-AUDIT-004');
  });

  it('[INV-06] the insert-only audit entry stores the row hash instead of a copy', async () => {
    const batch = randomUUID();
    await withCommand(db.app, actor(), (c) => c.query('insert into testgmp.reading (batch_id, value) values ($1, 7)', [batch]));
    const [e] = await events(`batch:${batch}`);
    expect((e?.payload as { body: { row_hash: string } }).body.row_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('[INV-06][DI-23] the application role cannot write, change or delete audit events', async () => {
    await expect(db.app.query("insert into kernel.audit_event (chain_key, seq, prev_hash, hash, recorded_at, correlation_id, action, payload) values ('x', 1, '', '', now(), gen_random_uuid(), 'INSERT', '{}')")).rejects.toThrow(/permission denied/);
    await expect(db.app.query("update kernel.audit_event set payload = '{}'")).rejects.toThrow(/permission denied/);
    await expect(db.app.query('delete from kernel.audit_event')).rejects.toThrow(/permission denied/);
    await expect(db.app.query("select kernel.append_audit_event('x', 'INSERT', null, null, '{}')")).rejects.toThrow(/permission denied/);
  });
});

describe('audit trail always on', () => {
  it('[DI-23] the application role cannot disable an audit trigger', async () => {
    await expect(db.app.query('alter table testgmp.sample disable trigger zz_audit_testgmp_sample')).rejects.toThrow(/must be owner/);
  });

  it('[DI-23] if a superuser disables an audit trigger, GMP writes are refused until it is re-enabled', async () => {
    await db.admin.query('alter table testgmp.sample disable trigger zz_audit_testgmp_sample');
    try {
      await expect(insertSample(randomUUID(), '1')).rejects.toThrow('EBMR-AUDIT-005');
      const { rows } = await db.app.query<{ command_tag: string }>("select command_tag from kernel.ddl_log where object_identity = 'testgmp.sample'");
      expect(rows.map((r) => r.command_tag)).toContain('ALTER TABLE');
    } finally {
      await db.admin.query('alter table testgmp.sample enable trigger zz_audit_testgmp_sample');
    }
    await expect(insertSample(randomUUID(), '1')).resolves.toBeTruthy();
  });
});

describe('tamper evidence', () => {
  it('[INV-08] an intact chain verifies', async () => {
    const batch = randomUUID();
    const id = await insertSample(batch, '5');
    await withCommand(db.app, actor({ reasonCode: 'X' }), (c) => c.query('update testgmp.sample set note = $2 where id = $1', [id, 'n']));
    expect(await verifyChain(db.app, `batch:${batch}`)).toEqual([]);
  });

  it('[INV-08][DI-23] altering an audit row directly in the database, deleting one, or moving the head is detected and the entry is named', async () => {
    const batch = randomUUID();
    for (const v of ['1', '2', '3']) await insertSample(batch, v);
    const key = `batch:${batch}`;
    await db.admin.query("update kernel.audit_event set payload = jsonb_set(payload, '{body,new,value}', '99') where chain_key = $1 and seq = 2", [key]);
    const altered = await verifyChain(db.app, key);
    expect(altered.map((p) => p.problem)).toContain('hash does not match the payload (event altered)');
    expect(altered.find((p) => p.problem === 'hash does not match the payload (event altered)')?.seq).toBe(2);

    const other = randomUUID();
    for (const v of ['1', '2', '3']) await insertSample(other, v);
    await db.admin.query('delete from kernel.audit_event where chain_key = $1 and seq = 2', [`batch:${other}`]);
    const problems = (await verifyChain(db.app, `batch:${other}`)).map((p) => p.problem).join(' | ');
    expect(problems).toContain('gap');

    const third = randomUUID();
    for (const v of ['1', '2']) await insertSample(third, v);
    await db.admin.query('delete from kernel.audit_event where chain_key = $1 and seq = 2', [`batch:${third}`]);
    expect((await verifyChain(db.app, `batch:${third}`)).map((p) => p.problem).join()).toContain('chain head does not match');
  });

  it('[INV-08] a consistent rewrite of a whole chain is caught by the anchor', async () => {
    const batch = randomUUID();
    const key = `batch:${batch}`;
    await insertSample(batch, '1');
    await insertSample(batch, '2');
    const { rows } = await db.app.query<{ id: string }>('select kernel.create_anchor() as id');
    const anchorId = Number(rows[0]?.id);
    // Other tests in this file tamper with their own chains; only this chain matters here.
    const mine = async () => (await verifyAnchor(db.app, anchorId)).filter((p) => p.includes(key));
    expect(await mine()).toEqual([]);
    // Attacker with superuser rights rewrites seq 2 and recomputes its hash and the head.
    await db.admin.query(
      `update kernel.audit_event set payload = jsonb_set(payload, '{body,new,value}', '42'),
              hash = sha256(prev_hash || convert_to(jsonb_set(payload, '{body,new,value}', '42')::text, 'UTF8'))
        where chain_key = $1 and seq = 2`,
      [key],
    );
    await db.admin.query('update kernel.audit_chain_head h set last_hash = e.hash from kernel.audit_event e where h.chain_key = $1 and e.chain_key = $1 and e.seq = h.last_seq', [key]);
    expect(await verifyChain(db.app, key)).toEqual([]);
    expect((await mine()).join()).toContain(`chain ${key} at seq 2 differs from the anchor`);
  });

  it('[INV-08] a checkpoint seals the head of a chain that verifies', async () => {
    const batch = randomUUID();
    await insertSample(batch, '1');
    await withCommand(db.app, actor(), (c) => c.query("select kernel.checkpoint_chain($1, 'record closed')", [`batch:${batch}`]));
    const { rows } = await db.app.query<{ seq: string }>('select seq from kernel.audit_checkpoint where chain_key = $1', [`batch:${batch}`]);
    expect(rows.map((r) => Number(r.seq))).toEqual([1]);
  });
});

describe('server time', () => {
  it('[INV-16] recorded_at comes from the database clock, not the client', async () => {
    const batch = randomUUID();
    const before = (await db.app.query<{ t: Date }>('select clock_timestamp() as t')).rows[0]?.t as Date;
    await insertSample(batch, '1');
    const after = (await db.app.query<{ t: Date }>('select clock_timestamp() as t')).rows[0]?.t as Date;
    const [e] = await events(`batch:${batch}`);
    expect(e?.recorded_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(e?.recorded_at.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});
