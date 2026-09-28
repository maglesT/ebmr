/**
 * Review reproducer F6: the reason-for-change gate of kernel.audit_row_change (0010_audit_trail.sql)
 * must refuse a blank reason, not only a missing one.
 *
 * DI-22 (catalog_test): saving a modification without a reason is blocked. DI-24: a correction records
 * a mandatory reason. Outline 5.4: the "why" of an audit entry is the reason code and text, mandatory for
 * every change or void after first entry. INV-07: every GMP update writes an audit event carrying the
 * reason for the change.
 *
 * The trigger only checks coalesce(reason_code, '') = '', so a reason code of ' ' (whitespace) passes and
 * reason_text is never required. The application role, with a real seeded operator inside a validated
 * kernel.begin_command context, can therefore change or delete a GMP value after first entry and the
 * audit event records no meaningful reason.
 *
 * Safe behaviour asserted here (all through ebmr_app, on the audited fixture table testgmp.sample, which
 * uses the same generic trigger as every non-insert-only GMP table):
 *  - an UPDATE whose reason code is whitespace is refused with EBMR-AUDIT-002;
 *  - an UPDATE with a reason code but no reason text is refused with EBMR-AUDIT-002;
 *  - a DELETE whose reason code is whitespace is refused with EBMR-AUDIT-002;
 *  - the refused attempts leave the rows unchanged and write no UPDATE/DELETE audit event;
 *  - positive control: a reason code with reason text is accepted and audited.
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
  base = await seededTestActor(db, { legalName: 'Test Operator F6' });
});

afterAll(async () => {
  await db.drop();
});

/** The seeded operator in a new command (fresh correlation id), with reason overrides. */
function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return { ...base, correlationId: randomUUID(), ...overrides };
}

const codeOf = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  return m.match(/EBMR-[A-Z]+-\d+/)?.[0] ?? `UNEXPECTED: ${m}`;
};

type Outcome = { ok: true } | { ok: false; code: string };

async function attempt(work: () => Promise<unknown>): Promise<Outcome> {
  try {
    await work();
    return { ok: true };
  } catch (e) {
    return { ok: false, code: codeOf(e) };
  }
}

async function insertSample(batchId: string, value: string): Promise<string> {
  return withCommand(db.app, actor(), async (c) => {
    const { rows } = await c.query<{ id: string }>('insert into testgmp.sample (batch_id, value) values ($1, $2) returning id', [batchId, value]);
    return rows[0]?.id ?? '';
  });
}

async function valueOf(id: string): Promise<string | null> {
  const { rows } = await db.app.query<{ value: string }>('select value::text as value from testgmp.sample where id = $1', [id]);
  return rows[0]?.value ?? null;
}

async function changeEvents(batchId: string) {
  const { rows } = await db.app.query<{ action: string; reason_code: string | null; reason_text: string | null }>(
    `select action, payload ->> 'reason_code' as reason_code, payload ->> 'reason_text' as reason_text
       from kernel.audit_event where chain_key = $1 and action in ('UPDATE', 'DELETE') order by seq`,
    [`batch:${batchId}`],
  );
  return rows;
}

describe('F6: the reason-for-change gate refuses a blank reason', () => {
  it('[DI-22][DI-24][INV-07] a change or delete after first entry with a whitespace reason code or no reason text is refused (EBMR-AUDIT-002)', async () => {
    // Positive control: a reason code with reason text is accepted and recorded.
    const okBatch = randomUUID();
    const okId = await insertSample(okBatch, '10.0');
    await withCommand(db.app, actor({ reasonCode: 'TRANSCRIPTION_ERROR', reasonText: 'wrong digit' }), (c) =>
      c.query('update testgmp.sample set value = 10.5 where id = $1', [okId]),
    );
    expect(await valueOf(okId)).toBe('10.5');
    expect(await changeEvents(okBatch)).toEqual([{ action: 'UPDATE', reason_code: 'TRANSCRIPTION_ERROR', reason_text: 'wrong digit' }]);

    // Sanity: the existing gate refuses a completely missing reason.
    const noneBatch = randomUUID();
    const noneId = await insertSample(noneBatch, '20.0');
    expect(await attempt(() => withCommand(db.app, actor(), (c) => c.query('update testgmp.sample set value = 20.5 where id = $1', [noneId])))).toEqual({
      ok: false,
      code: 'EBMR-AUDIT-002',
    });

    // A: UPDATE with a whitespace-only reason code (reason text present).
    const aBatch = randomUUID();
    const aId = await insertSample(aBatch, '30.0');
    const updateBlankCode = await attempt(() =>
      withCommand(db.app, actor({ reasonCode: ' ', reasonText: 'wrong digit' }), (c) =>
        c.query('update testgmp.sample set value = 30.5 where id = $1', [aId]),
      ),
    );

    // B: UPDATE with a reason code but no reason text.
    const bBatch = randomUUID();
    const bId = await insertSample(bBatch, '40.0');
    const updateNoText = await attempt(() =>
      withCommand(db.app, actor({ reasonCode: 'TRANSCRIPTION_ERROR' }), (c) => c.query('update testgmp.sample set value = 40.5 where id = $1', [bId])),
    );

    // C: DELETE with a whitespace-only reason code and no reason text.
    const cBatch = randomUUID();
    const cId = await insertSample(cBatch, '50.0');
    const deleteBlankCode = await attempt(() =>
      withCommand(db.app, actor({ reasonCode: ' ' }), (c) => c.query('delete from testgmp.sample where id = $1', [cId])),
    );

    const observed = {
      updateBlankCode,
      updateNoText,
      deleteBlankCode,
      valuesAfter: { a: await valueOf(aId), b: await valueOf(bId), c: await valueOf(cId) },
      changeEventsWritten: {
        a: await changeEvents(aBatch),
        b: await changeEvents(bBatch),
        c: await changeEvents(cBatch),
      },
    };

    expect(observed).toEqual({
      updateBlankCode: { ok: false, code: 'EBMR-AUDIT-002' },
      updateNoText: { ok: false, code: 'EBMR-AUDIT-002' },
      deleteBlankCode: { ok: false, code: 'EBMR-AUDIT-002' },
      valuesAfter: { a: '30.0', b: '40.0', c: '50.0' },
      changeEventsWritten: { a: [], b: [], c: [] },
    });
  });
});
