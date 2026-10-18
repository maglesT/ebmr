/**
 * The contingency-form gates on a real GMP batch (SQL mutation group "records-contingency-forms": kernel 1174
 * records.issue_contingency_pack, recipe-core 0911 recipe.refuse_unreconciled_completion; decision 0012). These tests
 * close the gaps the Phase 4 focused mutation run found: no pack is issued for a batch that ended (completed, aborted or
 * cancelled), and the completion gate concerns the move to EXECUTION_COMPLETE only, not any other change of status. The
 * status is written as the superuser, as in test/lifecycle/execution-complete-forms.test.ts.
 *
 * Controls: DI-43 (paper contingency forms), PR-16 (batch completion).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withProtectedNumbers } from '../../../kernel/src/continuity/numbers.ts';
import { withCommand, type ActorContext } from '../../../kernel/src/db/command.ts';
import { issueContingencyPack, type IssuedForm } from '../../../kernel/src/records/contingency.ts';
import { tempDir, tempLedger } from '../../../kernel/test/continuity/helpers.ts';
import { cmd } from '../../../kernel/test/esig/helpers.ts';
import { seedActor, seedServiceActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { again } from '../../../kernel/test/records/helpers.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { approveTestRelease } from '../../../kernel/test/support/validation.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import * as execution from '../../src/execution/index.ts';
import { define, FIXTURE_INPUTS, FIXTURE_JUSTIFICATIONS } from '../engine/support.ts';
import { gmpOrderFor } from '../lifecycle/gmp-support.ts';
import { cell, reason, seedCast, uniqueContent, World } from '../lifecycle/support.ts';

let db: TestDatabase;
let w: World;
let steward: SeededActor;
let erp: SeededActor;
let supervisor: SeededActor;
let master: { familyId: string; content: MbrContent };
const dir = tempDir('forms-mutation');
const ledger = tempLedger('forms-mutation', dir.path);
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

beforeAll(async () => {
  db = await createTestDatabase();
  // Slice 7c (DI-03, recipe-core 1250): a GMP batch is issued only on a release with an approved validation summary.
  await approveTestRelease(db);
  w = new World(db, await seedCast(db));
  steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Mira Steward' });
  supervisor = await seedActor(db, { roleCode: 'SHIFT_SUPERVISOR', legalName: 'Sunil Supervisor' });
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

async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
const setStatus = (batch: string, s: string): Promise<unknown> => db.admin.query('update recipe.execution_state set status = $2 where batch_id = $1', [batch, s]);

describe('a contingency pack for a batch that ended, and the completion gate (kernel 1174, recipe-core 0911)', () => {
  it('[DI-43] [PR-16] a change of status other than completion is not held by open forms; no pack is issued once the batch ended', async () => {
    const aborted = await issuedBatch();
    await pack(aborted, 1);
    expect(await messageOf(setStatus(aborted, 'ABORTED'))).toBe('ok');
    expect(await messageOf(pack(aborted, 1))).toMatch(/EBMR-REC-107 the batch is ABORTED: a contingency pack is issued at its issue or at a stage start, never after it ended/);
    const completed = await issuedBatch();
    await setStatus(completed, 'EXECUTION_COMPLETE');
    expect(await messageOf(pack(completed, 1))).toMatch(/EBMR-REC-107 the batch is EXECUTION_COMPLETE/);
    const cancelled = await issuedBatch();
    await setStatus(cancelled, 'CANCELLED');
    expect(await messageOf(pack(cancelled, 1))).toMatch(/EBMR-REC-107 the batch is CANCELLED/);
    const running = await issuedBatch();
    expect((await pack(running, 1)).length).toBe(1);
  });
});
