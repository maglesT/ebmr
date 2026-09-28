/**
 * ADR-0016 as corrected after the Phase 1 exit review (finding F1): a transaction has exactly one
 * validated actor context, the one kernel code installed last. kernel.set_actor_context keeps one
 * marker per connection and replaces it on every switch, so a context that kernel code switched away
 * from, or cleared, cannot be put back with set_config, and module code restores a context through
 * kernel.set_actor_context.
 *
 * Controls: DI-14 and DI-16 (a disabled account or another person cannot act through a stale
 * context), DI-22 (only contexts installed by kernel code are attributed); invariants INV-07 (every
 * GMP write attributed to the declared actor of the same transaction) and INV-40 (no attribution
 * without the person's own, fresh authentication).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, type ActorContext } from '../../src/db/command.ts';
import { authenticate } from '../../src/identity/authentication.ts';
import { hashSecret } from '../../src/identity/secrets.ts';
import { asSuperuserTransaction, expectRefused } from '../identity/helpers.ts';
import { seedActor, seedAuthn, type SeededActor } from '../identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

let db: TestDatabase;
let first: SeededActor;
let second: SeededActor;

beforeAll(async () => {
  db = await createTestDatabase();
  first = await seedActor(db, { legalName: 'Context Operator One', acknowledgeEsig: false });
  second = await seedActor(db, { legalName: 'Context Operator Two', acknowledgeEsig: false });
});

afterAll(async () => {
  await db.drop();
});

const INSERT_SAMPLE = 'insert into testgmp.sample (batch_id, value) values ($1, $2) returning id';
const ctxJson = (a: ActorContext): string => JSON.stringify(toDbContext({ ...a, correlationId: a.correlationId ?? randomUUID() }));

/** One statement that must be refused with `code`, inside a savepoint of an open transaction. */
async function refusedIn(c: pg.PoolClient, sql: string, params: unknown[], code: string): Promise<void> {
  await c.query('savepoint refused');
  try {
    await expectRefused(c.query(sql, params), code);
  } finally {
    await c.query('rollback to savepoint refused');
  }
}

const currentPerson = async (c: pg.PoolClient): Promise<string | null> =>
  (await c.query<{ p: string | null }>("select kernel.current_actor() ->> 'person_id' as p")).rows[0]?.p ?? null;

describe('ADR-0016: only the context installed last in the transaction is validated', () => {
  it('[INV-07][DI-22][DI-14][DI-16] bypass: after a second command in the same transaction, set_config back to the first command\'s context is refused', async () => {
    const batch = randomUUID();
    const firstCtx = ctxJson(first);
    const c = await db.app.connect();
    try {
      await c.query('begin');
      await c.query('select kernel.begin_command($1::jsonb)', [firstCtx]);
      await c.query(INSERT_SAMPLE, [batch, '1']);
      await c.query('select kernel.begin_command($1::jsonb)', [ctxJson(second)]);
      expect(await currentPerson(c)).toBe(second.personId);
      // The first context was validated earlier in this very transaction, and its text is known exactly.
      await c.query("select set_config('ebmr.ctx', $1, true)", [firstCtx]);
      expect(await currentPerson(c)).toBeNull();
      await refusedIn(c, INSERT_SAMPLE, [batch, '2'], 'EBMR-AUDIT-009');
      await refusedIn(c, 'select iam.assert_validated_actor()', [], 'EBMR-IAM-002');
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  it('[INV-07][DI-22] a savepoint rollback restores the previous context together with its marker, and a released switch stays in force', async () => {
    const batch = randomUUID();
    const firstCtx = ctxJson(first);
    await asSuperuserTransaction(db, async (c) => {
      await c.query('select kernel.begin_command($1::jsonb)', [firstCtx]);
      await c.query('savepoint switched');
      await c.query('select kernel.set_actor_context($1::jsonb)', [ctxJson(second)]);
      expect(await currentPerson(c)).toBe(second.personId);
      await c.query('rollback to savepoint switched');
      // Back to the first context: validated again, because its marker came back with it.
      expect(await currentPerson(c)).toBe(first.personId);
      await c.query(INSERT_SAMPLE, [batch, '1']);
      await c.query('savepoint switched_again');
      await c.query('select kernel.set_actor_context($1::jsonb)', [ctxJson(second)]);
      await c.query('release savepoint switched_again');
      expect(await currentPerson(c)).toBe(second.personId);
      await c.query("select set_config('ebmr.ctx', $1, true)", [firstCtx]);
      expect(await currentPerson(c)).toBeNull();
      await refusedIn(c, INSERT_SAMPLE, [batch, '2'], 'EBMR-AUDIT-009');
      const { rows } = await c.query<{ p: string }>(
        "select payload -> 'actor' ->> 'person_id' as p from kernel.audit_event where chain_key = $1 order by seq",
        [`batch:${batch}`],
      );
      expect(rows.map((r) => r.p)).toEqual([first.personId]);
    });
  });

  it('[INV-07][DI-22] clearing the context removes its marker: set_config cannot restore a cleared context', async () => {
    const batch = randomUUID();
    const firstCtx = ctxJson(first);
    await asSuperuserTransaction(db, async (c) => {
      await c.query('select kernel.begin_command($1::jsonb)', [firstCtx]);
      await c.query(INSERT_SAMPLE, [batch, '1']);
      await c.query('select kernel.set_actor_context(null)');
      const { rows } = await c.query<{ n: string }>('select count(*)::text as n from kernel.command_marker where backend_pid = pg_backend_pid()');
      expect(rows[0]?.n).toBe('0');
      await c.query("select set_config('ebmr.ctx', $1, true)", [firstCtx]);
      expect(await currentPerson(c)).toBeNull();
      await refusedIn(c, INSERT_SAMPLE, [batch, '2'], 'EBMR-AUDIT-009');
    });
  });

  it('[INV-40][INV-07][DI-22] a credential change inside a command restores the command\'s own context through the kernel; the self-service context it used cannot be reinstalled', async () => {
    const changer = await seedActor(db, { legalName: 'Context Credential Owner', acknowledgeEsig: false });
    const ev = await authenticate(seedAuthn(db), {
      method: 'PASSWORD', identifier: changer.seed.loginName, secret: changer.seed.password,
      deviceFingerprint: changer.seed.deviceFingerprint, purpose: 'CREDENTIAL_CHANGE',
    });
    const verifier = await hashSecret('Context-Renewed-Secret-2026');
    const batch = randomUUID();
    await asSuperuserTransaction(db, async (c) => {
      await c.query('select kernel.begin_command($1::jsonb)', [ctxJson(first)]);
      const { rows: changed } = await c.query<{ id: string }>("select iam.authn_change_secret($1, 'PASSWORD', $2) as id", [ev.authEventId, verifier]);
      expect(changed[0]?.id).toBeTruthy();
      // The command's own context is the validated actor again, for the kernel and for the identity module.
      expect(await currentPerson(c)).toBe(first.personId);
      const { rows: asserted } = await c.query<{ p: string }>("select iam.assert_validated_actor() ->> 'person_id' as p");
      expect(asserted[0]?.p).toBe(first.personId);
      await c.query(INSERT_SAMPLE, [batch, '1']);
      // The self-service context of the change, rebuilt exactly from its audit entry, is not an actor any more.
      const { rows: selfService } = await c.query<{ ctx: Record<string, string> }>(
        `select jsonb_build_object('person_id', p -> 'actor' ->> 'person_id', 'account_id', p -> 'actor' ->> 'account_id',
                                   'role_code', p -> 'actor' ->> 'role_code', 'session_id', p -> 'actor' ->> 'session_id',
                                   'source', p ->> 'source', 'site_zone', p ->> 'site_zone', 'correlation_id', p ->> 'correlation_id',
                                   'device_id', p -> 'actor' ->> 'device_id', 'auth_event_id', p -> 'actor' ->> 'auth_event_id',
                                   'legal_name', p -> 'actor' ->> 'legal_name', 'reason_code', p ->> 'reason_code',
                                   'reason_text', p ->> 'reason_text') as ctx
           from (select e.payload as p from kernel.audit_event e
                  where e.payload -> 'actor' ->> 'role_code' = 'SELF_SERVICE' and e.payload -> 'actor' ->> 'auth_event_id' = $1
                  order by e.id limit 1) x`,
        [ev.authEventId],
      );
      const rebuilt = selfService[0]?.ctx;
      expect(rebuilt?.['person_id']).toBe(changer.personId);
      await c.query("select set_config('ebmr.ctx', $1, true)", [JSON.stringify(rebuilt)]);
      expect(await currentPerson(c)).toBeNull();
      await refusedIn(c, INSERT_SAMPLE, [batch, '2'], 'EBMR-AUDIT-009');
      await refusedIn(c, 'select iam.assert_validated_actor()', [], 'EBMR-IAM-002');
    });
  });

  it('[INV-07][DI-22] a credential change outside any command leaves no actor behind', async () => {
    const changer = await seedActor(db, { legalName: 'Context Credential Owner Two', acknowledgeEsig: false });
    const ev = await authenticate(seedAuthn(db), {
      method: 'PASSWORD', identifier: changer.seed.loginName, secret: changer.seed.password,
      deviceFingerprint: changer.seed.deviceFingerprint, purpose: 'CREDENTIAL_CHANGE',
    });
    const verifier = await hashSecret('Context-Renewed-Secret-2027');
    await asSuperuserTransaction(db, async (c) => {
      await c.query("select iam.authn_change_secret($1, 'PASSWORD', $2)", [ev.authEventId, verifier]);
      const { rows } = await c.query<{ raw: string; actor: unknown }>("select current_setting('ebmr.ctx', true) as raw, kernel.current_actor() as actor");
      expect(rows[0]).toEqual({ raw: '', actor: null });
      await refusedIn(c, INSERT_SAMPLE, [randomUUID(), '1'], 'EBMR-AUDIT-001');
    });
  });
});
