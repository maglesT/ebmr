/**
 * Test arrangement for qualification (training) requirements limited to a product (Phase 6 exit review 6jc-R16; IN-04,
 * DI-21, INV-26): a requirement on one permission, optionally limited to a product, the person's qualification from a
 * source, and an LMS mirror made stale. Written by the superuser with triggers off, as test arrangement only (the
 * requirement and qualification commands are proven in the kernel's own tests); each requirement is ended after its
 * test, so the other tests of the file are not affected.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { TestDatabase } from '../support/db.ts';

async function asOwner<T>(db: TestDatabase, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

export interface Requirement {
  /** The qualification type the requirement asks for. */
  code: string;
  id: string;
}

/** A new qualification type required for `permission`, limited to `product` when given (no product: every product). */
export async function permissionRequirement(db: TestDatabase, permission: string, product?: string): Promise<Requirement> {
  const code = `SOP-R16-${randomUUID().slice(0, 8).toUpperCase()}`;
  const id = await asOwner(db, async (c) => {
    await c.query('insert into iam.qualification_type (code, name, description) values ($1, $2, $3)', [code, `Training ${code}`, 'Test training (6jc-R16)']);
    const { rows } = await c.query<{ id: string }>(
      `insert into iam.qualification_requirement (qualification_code, permission_code, scope_product, reason, created_by_person)
       values ($1, $2, $3, 'Training required for the test (6jc-R16)', gen_random_uuid()) returning id::text as id`,
      [code, permission, product ?? null],
    );
    return rows[0]!.id;
  });
  return { code, id };
}

/** The requirement no longer in force. */
export async function endRequirement(db: TestDatabase, r: Requirement): Promise<void> {
  await asOwner(db, (c) => c.query('update iam.qualification_requirement set effective_to = clock_timestamp() where id = $1', [r.id]));
}

/** `personId` holds the requirement's qualification from `source` (INTERNAL is always fresh; LMS is a mirror). */
export async function qualify(db: TestDatabase, personId: string, r: Requirement, source: 'INTERNAL' | 'LMS' = 'INTERNAL'): Promise<void> {
  await asOwner(db, (c) =>
    c.query(
      `insert into iam.person_qualification (person_id, qualification_code, source_code, valid_from, recorded_by_person, recorded_by_account)
       values ($1, $2, $3, now() - interval '1 day', gen_random_uuid(), gen_random_uuid())`,
      [personId, r.code, source],
    ),
  );
}

/** Runs `fn` with the LMS mirror's last synchronisation 30 days ago (a stale source), then puts it back. */
export async function withStaleLms<T>(db: TestDatabase, fn: () => Promise<T>): Promise<T> {
  const before = (await db.admin.query<{ t: Date }>("select last_synced_at as t from iam.mirror_heartbeat where source_code = 'LMS'")).rows[0]?.t;
  await asOwner(db, (c) =>
    c.query(`insert into iam.mirror_heartbeat (source_code, last_synced_at) values ('LMS', now() - interval '30 days')
             on conflict (source_code) do update set last_synced_at = excluded.last_synced_at`),
  );
  try {
    return await fn();
  } finally {
    await asOwner(db, (c) =>
      before ? c.query("update iam.mirror_heartbeat set last_synced_at = $1 where source_code = 'LMS'", [before]) : c.query("delete from iam.mirror_heartbeat where source_code = 'LMS'"),
    );
  }
}

/** Runs `fn` under requirement `r`, ended afterwards whatever happens. */
export async function underRequirement<T>(db: TestDatabase, r: Requirement, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    await endRequirement(db, r);
  }
}
