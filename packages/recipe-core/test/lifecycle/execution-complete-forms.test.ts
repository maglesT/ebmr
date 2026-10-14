/**
 * A batch completes only with its contingency forms reconciled (Phase 4 slice 6 gate, residual R-6b-1; recipe-core 0911
 * over kernel 1170; DI-43, PR-16; D-6-6). The batches are real GMP batches issued from an effective master; their packs
 * are issued and reconciled through the kernel's definers as the application role with real signatures. The completion
 * is written as the database owner, as every path that completes a batch writes it (the engine's projection runs inside
 * the owner's definers; the demo shortcut writes it as a superuser): the trigger refuses it on every path, and the
 * application role can neither write the row nor switch the trigger off.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withProtectedNumbers } from '../../../kernel/src/continuity/numbers.ts';
import { withCommand, type ActorContext } from '../../../kernel/src/db/command.ts';
import { issueContingencyPack, recordContingencyFormEvent, signFormReconciliation, type IssuedForm } from '../../../kernel/src/records/contingency.ts';
import { tempDir, tempLedger } from '../../../kernel/test/continuity/helpers.ts';
import { cmd } from '../../../kernel/test/esig/helpers.ts';
import { expectPermissionDenied, expectRefused } from '../../../kernel/test/identity/helpers.ts';
import { seedActor, seedServiceActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { again, signFor } from '../../../kernel/test/records/helpers.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import * as execution from '../../src/execution/index.ts';
import { define, FIXTURE_INPUTS, FIXTURE_JUSTIFICATIONS } from '../engine/support.ts';
import { gmpOrderFor } from './gmp-support.ts';
import { cell, reason, seedCast, uniqueContent, World } from './support.ts';

let db: TestDatabase;
let w: World;
let steward: SeededActor;
let erp: SeededActor;
let operator: SeededActor;
let operator2: SeededActor;
let supervisor: SeededActor;
let qa: SeededActor;
let master: { familyId: string; content: MbrContent };
const dir = tempDir('complete-forms');
const ledger = tempLedger('complete-forms', dir.path);
const SITE = 'SITE-1';
const BS = 'BS-200K';
const FIXTURE = 'tablet-granulation-compression';

function without(content: unknown, types: readonly string[]): unknown {
  if (Array.isArray(content)) {
    return content.filter((x) => !(x && typeof x === 'object' && types.includes(String(((x as Record<string, unknown>)['block'] as Record<string, unknown> | undefined)?.['type'])))).map((x) => without(x, types));
  }
  if (content && typeof content === 'object') return Object.fromEntries(Object.entries(content).map(([k, v]) => [k, without(v, types)]));
  return content;
}

const run = <T>(actor: ActorContext, work: (c: pg.PoolClient) => Promise<T>): Promise<T> => withCommand(db.app, again(actor), work);

async function issuedBatch(): Promise<string> {
  const batchId = randomUUID();
  const erpOrder = await gmpOrderFor(db, erp, master.content, BS);
  await cmd(db, w.cast.issuer).then((ctx) =>
    withProtectedNumbers(db.app, ctx, ledger, (c) => execution.prepareGmpIssue(c, batchId, { familyId: master.familyId, markets: ['IN'], site: SITE, line: 'L1', batchSize: BS, erpOrder })),
  );
  const signatureId = await w.sign(w.cast.issuer, 'batch_issue', batchId, 'ISSUED', 'PLANNED');
  await w.run(w.cast.issuer, (c) =>
    execution.issueGmpBatch(c, {
      batchId,
      signatureId,
      define: (x) => define(x, { installation: 'GMP', justifications: FIXTURE_JUSTIFICATIONS }),
      request: { inputs: FIXTURE_INPUTS[FIXTURE], issuedBy: { id: w.cast.issuer.personId, kind: 'PERSON', roles: [] } },
    }), reason('batch issued for the test'));
  return batchId;
}

async function pack(batch: string, pages: number): Promise<IssuedForm[]> {
  return run(supervisor, (c) =>
    issueContingencyPack(c, { batchId: batch, batchLabel: `B-${batch.slice(0, 6)}`, moment: 'ISSUE', stageRef: null, templateRef: 'MBR downtime form DT-1 v2', destination: 'Granulation suite 2', pages, reason: 'planned network outage' }),
  );
}

/** Completion as every path writes it (the owner's definers, the superuser demo shortcut). */
const complete = (batch: string): Promise<unknown> => db.admin.query("update recipe.execution_state set status = 'EXECUTION_COMPLETE' where batch_id = $1", [batch]);
const status = async (batch: string): Promise<string> => (await db.admin.query<{ s: string }>('select status as s from recipe.execution_state where batch_id = $1', [batch])).rows[0]!.s;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
  steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Mira Steward' });
  operator = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Om Operator' });
  operator2 = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Oza Operator' });
  supervisor = await seedActor(db, { roleCode: 'SHIFT_SUPERVISOR', legalName: 'Sunil Supervisor' });
  qa = await seedActor(db, { roleCode: 'QA_SHOP_FLOOR', legalName: 'Meera Floor' });
  erp = await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_INTERFACE', name: 'ERP interface' });
  const raw = uniqueContent(FIXTURE, ['IN']);
  raw.header.product = { ...raw.header.product, code: raw.header.product.code.toUpperCase() };
  // A GMP master never holds the sandbox-only blocks G-09 and G-10 (as in the release tests).
  const m = without(raw, ['G-09', 'G-10']) as MbrContent;
  const v = await w.approvedVersion(m);
  await w.authorise({ versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, 'L1', BS)], regulatoryBasis: 'IN: registration on file' });
  await w.run(steward, (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({ rule_code: `R-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: m.header.product.code, batch_kind: 'PROCESSING', format: 'F{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
    ]),
  );
  master = { familyId: v.familyId, content: m };
}, 900_000);
afterAll(async () => {
  await db.drop();
  dir.cleanup();
});

describe('EXECUTION_COMPLETE waits for the contingency forms (DI-43, PR-16)', () => {
  it('[DI-43][PR-16] a batch with no contingency form issued completes as before', async () => {
    const b = await issuedBatch();
    await complete(b);
    expect(await status(b)).toBe('EXECUTION_COMPLETE');
  });

  it('[DI-43][PR-16] completion is refused while a form is issued and not returned, returned and not verified, or reported missing without its deviation reference; it passes once every form is reconciled and FORMS_RECONCILED is signed', async () => {
    const b = await issuedBatch();
    const [f1, f2, f3] = (await pack(b, 3)) as [IssuedForm, IssuedForm, IssuedForm];
    const before = await status(b);
    // Issued, none returned: every serial is named.
    await expectRefused(complete(b), 'EBMR-EXE-310', new RegExp(`EBMR-REC-106 3 contingency form.*${f1.serial}.*${f2.serial}.*${f3.serial}`));
    // f1 returned, not yet verified.
    await run(operator, (c) => recordContingencyFormEvent(c, f1.formId, 'RETURNED'));
    await run(operator, (c) => recordContingencyFormEvent(c, f1.formId, 'TRANSCRIBED', null, 'entries of step S2.3 transcribed from paper'));
    await expectRefused(complete(b), 'EBMR-EXE-310', f1.serial);
    await run(operator2, (c) => recordContingencyFormEvent(c, f1.formId, 'VERIFIED'));
    // f2 reported missing: a void without the deviation reference is refused, so it stays open.
    await run(operator, (c) => recordContingencyFormEvent(c, f2.formId, 'REPORTED_MISSING', 'not returned from the suite'));
    await expectRefused(run(supervisor, (c) => recordContingencyFormEvent(c, f2.formId, 'VOIDED', 'lost')), 'EBMR-REC-102', /deviation/);
    await expectRefused(complete(b), 'EBMR-EXE-310', new RegExp(`${f2.serial}.*${f3.serial}`));
    await run(supervisor, (c) => recordContingencyFormEvent(c, f2.formId, 'VOIDED', 'lost in the suite', 'DEV-2026-0042'));
    await run(operator, (c) => recordContingencyFormEvent(c, f3.formId, 'VOIDED', 'unused: the system came back'));
    // Every form reconciled, the reconciliation not yet signed.
    await expectRefused(complete(b), 'EBMR-EXE-310', /not signed \(FORMS_RECONCILED/);
    expect(await status(b)).toBe(before);
    const sig = await signFor(db, qa, { type: 'form_reconciliation', id: b }, 'FORMS_RECONCILED', 'RECONCILED');
    await run(qa, (c) => signFormReconciliation(c, b, sig));
    await complete(b);
    expect(await status(b)).toBe('EXECUTION_COMPLETE');
  });

  it('[DI-43][PR-16] only the move into EXECUTION_COMPLETE is gated: another write of the status of a batch with a form still out passes', async () => {
    const b = await issuedBatch();
    await pack(b, 1);
    const before = await status(b);
    expect(before).not.toBe('EXECUTION_COMPLETE');
    await db.admin.query('update recipe.execution_state set status = status where batch_id = $1', [b]);
    expect(await status(b)).toBe(before);
    await expectRefused(complete(b), 'EBMR-EXE-310');
  });

  it('[DI-43][PR-16] the application role cannot write the completion around the gate nor switch the gate off', async () => {
    const b = await issuedBatch();
    await pack(b, 1);
    await expectPermissionDenied(db.app.query("update recipe.execution_state set status = 'EXECUTION_COMPLETE' where batch_id = $1", [b]));
    await expect(db.app.query('alter table recipe.execution_state disable trigger a1_form_reconciliation')).rejects.toThrow(/must be owner|permission denied/);
    await expect(db.app.query('drop function recipe.refuse_unreconciled_completion() cascade')).rejects.toThrow(/must be owner|permission denied/);
    const t = (await db.admin.query<{ e: string }>("select tgenabled as e from pg_trigger where tgrelid = 'recipe.execution_state'::regclass and tgname = 'a1_form_reconciliation'")).rows[0];
    expect(t?.e).toBe('O');
    await expectRefused(complete(b), 'EBMR-EXE-310');
  });
});
