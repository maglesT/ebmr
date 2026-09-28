/**
 * Review reproducer F17: the sample_record content provider (platform.sample_record_content, kernel
 * migration 0910) derives content_version from 1 + the number of kernel.audit_event UPDATE rows of the
 * record. The audit trigger (kernel.audit_row_change, 0010) records every UPDATE, including one that
 * changes nothing, while the signed-table registration covers only title and body, so
 * esig.on_signed_content_change (0220) returns early for a no-op UPDATE and writes no invalidation.
 * A no-op save therefore changes the signed envelope hash (content_version is part of it, 0200
 * esig.canonical_envelope) without superseding the signature.
 *
 * Scenario:
 *   1. The author creates a sample record (DRAFT) and signs PREPARED on it.
 *   2. In a command with a reason, the author saves the record without changing anything:
 *      update platform.stub_record set title = title where id = X.
 *
 * Safe behaviour asserted (INV-09: a signature that is not superseded is bound to the record's
 * current content hash; DI-37): after the no-op save the signature is either still VALID (nothing
 * signed changed) or properly SUPERSEDED_BY_CHANGE with an invalidation row; it is never
 * CONTENT_MISMATCH, and esig.invariant_violations() reports no INV-09 for it.
 *
 * Positive control: right after signing, the signature is VALID and INV-09 is clean, so the setup
 * (roles, provider, seal key) is right and only the no-op save changes the outcome.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAggregateState } from '../../src/state/engine.ts';
import type { SeededActor } from '../identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { ensureSealKey, run, signStub, testActor } from '../esig/helpers.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureSealKey(db);
  // The sample record's content provider and its signed-table registration come from kernel migration 0910.
});

afterAll(async () => {
  await db.drop();
});

async function newRecord(author: SeededActor): Promise<string> {
  return run(db, author, async (c) => {
    const { rows } = await c.query<{ id: string }>("insert into platform.stub_record (title, body) values ('Cleaning SOP', 'Version 1 text') returning id");
    const id = rows[0]?.id ?? '';
    await createAggregateState(c, 'sample_record', { aggregateType: 'sample_record', aggregateId: id });
    return id;
  });
}

interface SigState {
  status: string;
  valid: boolean;
  content_version: string;
  invalidation: unknown;
}

async function stateOf(signatureId: string): Promise<SigState> {
  const { rows } = await db.admin.query<{ s: SigState }>('select esig.signature_state($1) as s', [signatureId]);
  return rows[0]?.s ?? { status: '?', valid: false, content_version: '?', invalidation: null };
}

async function inv09For(signatureId: string): Promise<string[]> {
  const { rows } = await db.admin.query<{ detail: string }>(
    "select detail from esig.invariant_violations() where invariant = 'INV-09' and signature_id = $1", [signatureId]);
  return rows.map((r) => r.detail);
}

async function evidence(id: string, signatureId: string): Promise<string> {
  const provided = await db.admin.query<{ p: unknown }>("select platform.sample_record_content($1) as p", [id]);
  const audits = await db.admin.query<{ action: string; body: unknown }>(
    "select action, payload as body from kernel.audit_event where table_name = 'platform.stub_record' and record_id = $1 order by seq", [id]);
  const inval = await db.admin.query<{ n: string }>('select count(*)::text as n from esig.signature_invalidation where signature_id = $1', [signatureId]);
  const resign = await db.admin.query<{ meaning_code: string }>("select meaning_code from esig.resigning_required('sample_record', $1)", [id]);
  return JSON.stringify({ provided: provided.rows[0]?.p, auditEvents: audits.rows.map((r) => r.action), invalidations: inval.rows[0]?.n,
                          resigningRequired: resign.rows.map((r) => r.meaning_code) });
}

describe('F17: a no-op save of a signed sample record never breaks the signature binding silently', () => {
  it('[INV-09][DI-37] after an UPDATE that changes no signed column the signature is VALID or SUPERSEDED_BY_CHANGE, never CONTENT_MISMATCH', async () => {
    const author = await testActor(db, { roleCode: 'MBR_AUTHOR', legalName: 'A. Author' });
    const id = await newRecord(author);

    // Step 1: the author signs PREPARED on the DRAFT record.
    const sig = await signStub(db, author, id, { meaning: 'PREPARED', aggregateType: 'sample_record', expectedState: 'DRAFT' });

    // Positive control: freshly signed, valid, and INV-09 clean.
    const before = await stateOf(sig.signatureId);
    expect(before.status).toBe('VALID');
    expect(await inv09For(sig.signatureId)).toEqual([]);

    // Step 2: a save that changes nothing (DRAFT allows edits; a reason is given as the audit trail requires).
    await run(db, author, (c) => c.query('update platform.stub_record set title = title where id = $1', [id]), {
      reasonCode: 'REWORK',
      reasonText: 'saved without changes',
    });
    const { rows: same } = await db.admin.query<{ title: string; body: string }>('select title, body from platform.stub_record where id = $1', [id]);
    expect(same[0]).toEqual({ title: 'Cleaning SOP', body: 'Version 1 text' });

    const after = await stateOf(sig.signatureId);
    const violations = await inv09For(sig.signatureId);
    const why = await evidence(id, sig.signatureId);

    // Safe: either nothing signed changed (VALID) or the change superseded the signature with an invalidation.
    expect.soft(['VALID', 'SUPERSEDED_BY_CHANGE'], `no-op save left signature ${after.status} (signed content_version ${before.content_version}): ${why}`)
      .toContain(after.status);
    if (after.status === 'SUPERSEDED_BY_CHANGE') expect(after.invalidation).not.toBeNull();
    expect(violations, `INV-09 raised for the signature after a no-op save: ${why}`).toEqual([]);
  });
});
