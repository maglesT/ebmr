/**
 * The reason recorded for an update of an audited recipe row (DI-22, DI-24; EBMR-AUDIT-002).
 *
 * The audit trigger refuses an UPDATE of an audited row unless the command context carries a reason code
 * and a reason text, neither blank (outline 5.4).
 *
 * A change the user starts carries the user's own reason, both halves: an MBR draft attribute (0150), a stub
 * batch issued or moved on (0170). Recipe code writes no half of it (migration 0250): a command with no reason,
 * with only a reason text, with a reason code and a blank reason text, or with a white-space reason code is
 * refused by the kernel (EBMR-AUDIT-002) and the whole command rolls back; a command with both halves has them
 * recorded exactly as given, and its context is untouched.
 *
 * An update that only follows from another act of the same command (an authorisation cell superseded when a
 * successor is activated, or ended by a withdrawal or a retirement, 0160) is completed with a fixed reason
 * naming the act (recipe.push_reason, migrations 0100 and 0230) only when the command gave no reason code
 * (NULL or empty, the test of 0100): the act's code is used, with the command's own reason text where it gave
 * one and the act's text where it did not. A command that gives its own reason code owns its reason: a blank
 * reason text is not completed, the kernel refuses the update (EBMR-AUDIT-002) and the whole command rolls
 * back, so an audit entry never shows the user's code next to a text the system wrote. A reason code of only
 * white space is a code the command gave, and a blank one: it is not replaced by the act's code, whatever the
 * text, and the kernel refuses the update, so a malformed reason never goes through with both halves written
 * by the system. The completed reason ends with the act: the command's own context is restored with
 * kernel.set_actor_context, so any other change in the same command still needs both halves.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '../../../kernel/src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import * as lc from '../../src/lifecycle/index.ts';
import { cell, scope, seedCast, uniqueContent, World } from './support.ts';

let db: TestDatabase;
let w: World;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
}, 300_000);

afterAll(async () => {
  await db.drop();
});

const BS = 'PO-20K';
const S = [cell('S1', 'L1', BS)];
const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, params)).rows as T[];
const current = (versionId: string, market: string): lc.MarketAuthorisationDefinition => ({
  versionId,
  market,
  kind: 'CURRENT',
  cells: S,
  regulatoryBasis: `${market}: registration on file`,
});

/** The kernel's refusal of an update of `table` whose command context lacks a half of the reason. */
const reasonRequired = (table: string): RegExp =>
  new RegExp(`^EBMR-AUDIT-002 a reason is required to update ${table.replace('.', '\\.')}: give a reason code and a reason text$`);

interface UpdateEntry {
  record_id: string;
  reason_code: string | null;
  reason_text: string | null;
  status: string | null;
}

/** The UPDATE entries a command wrote on one audited table, with the reason each carries. */
const updates = (correlationId: string, table: string): Promise<UpdateEntry[]> =>
  q<UpdateEntry>(
    `select record_id, payload ->> 'reason_code' as reason_code, payload ->> 'reason_text' as reason_text,
            payload -> 'body' -> 'new' ->> 'status' as status
     from kernel.audit_event where correlation_id = $1 and table_name = $2 and action = 'UPDATE' order by id`,
    [correlationId, table],
  );

/** Every audit entry a command left behind: none when it was refused and rolled back. */
const entriesOf = (correlationId: string): Promise<unknown[]> => q('select id from kernel.audit_event where correlation_id = $1', [correlationId]);

/** Status and end of validity of one authorisation cell. */
const cellNow = (cellId: string | undefined): Promise<{ status: string; valid_until: string | null }[]> =>
  q('select status, recipe.utc_text(valid_until) as valid_until from recipe.authorisation_cell where id = $1', [cellId]);

/** The validated actor context of the command running on `c` (NULL when none counts). */
const actorNow = async (c: pg.PoolClient): Promise<Record<string, unknown> | null> =>
  (await c.query<{ ctx: Record<string, unknown> | null }>('select kernel.current_actor() as ctx')).rows[0]?.ctx ?? null;

/** A command context carrying the given reason halves under a correlation id of its own. */
const because = (reasonCode: string, reasonText: string): Partial<ActorContext> & { correlationId: string } => ({
  reasonCode,
  reasonText,
  correlationId: randomUUID(),
});

describe('the reason of a draft-attribute edit (EBMR-AUDIT-002)', () => {
  const draftAttributes = (versionId: string) =>
    q<{ effective_from: string | null; review_due: string | null }>(
      'select recipe.utc_text(effective_from) as effective_from, review_due::text as review_due from recipe.mbr_version where id = $1',
      [versionId],
    );

  it.each([
    { given: 'no reason', code: '', text: '' },
    { given: 'a reason text and no reason code', code: '', text: 'effective date agreed with QA' },
    { given: 'a reason code and an empty reason text', code: 'DATE_CORRECTION', text: '' },
    { given: 'a reason code and a white-space reason text', code: 'DATE_CORRECTION', text: ' \t ' },
    { given: 'a white-space reason code and a reason text', code: ' \t ', text: 'effective date agreed with QA' },
    { given: 'a white-space reason code and an empty reason text', code: ' \t ', text: '' },
    { given: 'a white-space reason code and a white-space reason text', code: ' ', text: ' \t ' },
  ])('[DI-22][DI-24] a draft-attribute edit by a command with $given is refused (EBMR-AUDIT-002): the author\'s own reason is required, recipe code writes no half of it, and nothing changes', async ({ code, text }) => {
    const v = await w.newVersion(uniqueContent());
    const before = await draftAttributes(v.versionId);
    expect(before).toHaveLength(1);
    const ctx = because(code, text);
    const refused = w.run(w.cast.author, (c) => lc.setDraftAttributes(c, v.versionId, { effectiveFrom: '2026-02-01T00:00:00Z', reviewDue: '2028-01-31' }), ctx);
    await expect(refused).rejects.toThrow(reasonRequired('recipe.mbr_version'));
    expect(await draftAttributes(v.versionId)).toEqual(before);
    expect(await entriesOf(ctx.correlationId)).toEqual([]);
  });

  it('[DI-22][DI-24] a command with a reason code and a reason text edits a draft attribute; the audit entry records the command\'s own reason exactly and the command\'s context is left as it was', async () => {
    const v = await w.newVersion(uniqueContent());
    const ctx = because('DATE_CORRECTION', 'effective date agreed with QA');
    const [before, after] = await w.run(
      w.cast.author,
      async (c) => {
        const b = await actorNow(c);
        await lc.setDraftAttributes(c, v.versionId, { effectiveFrom: '2026-02-01T00:00:00Z', reviewDue: '2028-01-31' });
        return [b, await actorNow(c)] as const;
      },
      ctx,
    );
    expect(await updates(ctx.correlationId, 'recipe.mbr_version')).toEqual([
      { record_id: v.versionId, reason_code: 'DATE_CORRECTION', reason_text: 'effective date agreed with QA', status: null },
    ]);
    expect(before).toMatchObject({ correlation_id: ctx.correlationId, reason_code: 'DATE_CORRECTION', reason_text: 'effective date agreed with QA' });
    expect(after).toEqual(before);
    expect(await draftAttributes(v.versionId)).toEqual([{ effective_from: '2026-02-01T00:00:00.000000Z', review_due: '2028-01-31' }]);
  });
});

describe('the reason of an authorisation-cell update (EBMR-AUDIT-002)', () => {
  it('[DI-22][DI-24][INV-17] a supersession by a command with a reason code and a blank reason text, or with a white-space reason code, is refused (EBMR-AUDIT-002) and changes nothing; a command with only a reason text records it with the act\'s code', async () => {
    const v1 = await w.approvedVersion(uniqueContent());
    const a1 = await w.authorise(current(v1.versionId, 'IN'));
    const v1Cell = a1.cells[0]?.cell_id;
    const v2 = await w.approvedSuccessor(v1.versionId, (m) => (m.header.title = `${m.header.title} v2`));
    const id = await w.run(w.cast.qa, (c) => lc.proposeMarketAuthorisation(c, current(v2.versionId, 'IN')));
    const qaSig = await w.sign(w.cast.qa, lc.MARKET_AUTHORISATION_AGGREGATE, id, 'MBR_MARKET_AUTHORISED', 'PROPOSED');
    const regSig = await w.sign(w.cast.regulatory, lc.MARKET_AUTHORISATION_AGGREGATE, id, 'REGULATORY_CONFIRMED', 'PROPOSED');

    // Activating v2 for India supersedes v1's CURRENT cell in the same command: refused without a text, and
    // refused with a white-space code, which the act's code MBR_SUPERSEDED does not replace.
    for (const [code, text] of [
      ['NEW_VERSION_EFFECTIVE', ''],
      ['NEW_VERSION_EFFECTIVE', ' \t '],
      [' \t ', ''],
      [' ', 'successor version registered for India'],
    ] as const) {
      const refused = because(code, text);
      await expect(w.run(w.cast.qa, (c) => lc.activateMarketAuthorisation(c, id, qaSig, regSig), refused)).rejects.toThrow(reasonRequired('recipe.authorisation_cell'));
      expect(await entriesOf(refused.correlationId)).toEqual([]);
    }
    expect(await cellNow(v1Cell)).toEqual([{ status: 'CURRENT', valid_until: null }]);
    expect(await q('select authorisation_id from recipe.market_authorisation_activation where authorisation_id = $1', [id])).toEqual([]);

    const activation = because('', 'successor version registered for India');
    const a2 = await w.run(w.cast.qa, (c) => lc.activateMarketAuthorisation(c, id, qaSig, regSig), activation);
    expect(a2.cells[0]?.superseded_cell_id).toBe(v1Cell);
    expect(await updates(activation.correlationId, 'recipe.authorisation_cell')).toEqual([
      { record_id: v1Cell, reason_code: 'MBR_SUPERSEDED', reason_text: 'successor version registered for India', status: 'SUPERSEDED' },
    ]);
    expect(await w.violations()).toEqual([]);
  });

  it('[DI-22][DI-24][INV-17] the completed reason ends with the act: after an activation by a command with no reason code supersedes a cell, a later change in the same command is refused (EBMR-AUDIT-002) and nothing changes', async () => {
    const v1 = await w.approvedVersion(uniqueContent());
    const a1 = await w.authorise(current(v1.versionId, 'IN'));
    const v1Cell = a1.cells[0]?.cell_id;
    const v2 = await w.approvedSuccessor(v1.versionId, (m) => (m.header.title = `${m.header.title} v2`));
    const id = await w.run(w.cast.qa, (c) => lc.proposeMarketAuthorisation(c, current(v2.versionId, 'IN')));
    const qaSig = await w.sign(w.cast.qa, lc.MARKET_AUTHORISATION_AGGREGATE, id, 'MBR_MARKET_AUTHORISED', 'PROPOSED');
    const regSig = await w.sign(w.cast.regulatory, lc.MARKET_AUTHORISATION_AGGREGATE, id, 'REGULATORY_CONFIRMED', 'PROPOSED');

    for (const [code, text] of [
      ['', ''],
      ['', 'successor version registered for India'],
    ] as const) {
      const ctx = because(code, text);
      const batchId = randomUUID();
      const seen: { before?: Record<string, unknown> | null; after?: Record<string, unknown> | null; superseded?: string | null | undefined } = {};
      const refused = w.run(
        w.cast.qa,
        async (c) => {
          seen.before = await actorNow(c);
          seen.superseded = (await lc.activateMarketAuthorisation(c, id, qaSig, regSig)).cells[0]?.superseded_cell_id;
          seen.after = await actorNow(c);
          const { rows } = await c.query<{ id: string }>('insert into testgmp.sample (batch_id, value) values ($1, 1) returning id', [batchId]);
          await c.query('update testgmp.sample set value = 2 where id = $1', [rows[0]?.id]);
        },
        ctx,
      );
      await expect(refused).rejects.toThrow(reasonRequired('testgmp.sample'));
      // The activation superseded v1's cell with the act's reason, then the command's own context was the validated one again.
      expect(seen.superseded).toBe(v1Cell);
      expect(seen.before).toMatchObject({ correlation_id: ctx.correlationId });
      expect(seen.after).toEqual(seen.before);
      expect(await q('select id from testgmp.sample where batch_id = $1', [batchId])).toEqual([]);
      expect(await entriesOf(ctx.correlationId)).toEqual([]);
    }
    expect(await cellNow(v1Cell)).toEqual([{ status: 'CURRENT', valid_until: null }]);
    expect(await q('select authorisation_id from recipe.market_authorisation_activation where authorisation_id = $1', [id])).toEqual([]);
    expect(await w.violations()).toEqual([]);
  });

  it('[DI-22][DI-24][INV-17] a withdrawal by a command with a reason code and a blank reason text is refused (EBMR-AUDIT-002) even though the withdrawal states its own reason; with both halves the cell update records the command\'s reason', async () => {
    const v = await w.approvedVersion(uniqueContent());
    const us = await w.authorise(current(v.versionId, 'US'));
    const usCell = us.cells[0]?.cell_id;

    const refused = because('REGISTRATION_LAPSED', '  ');
    await expect(w.run(w.cast.qa, (c) => lc.withdrawMarketAuthorisation(c, us.authorisationId, 'US registration lapsed'), refused)).rejects.toThrow(
      reasonRequired('recipe.authorisation_cell'),
    );
    expect(await entriesOf(refused.correlationId)).toEqual([]);
    expect(await cellNow(usCell)).toEqual([{ status: 'CURRENT', valid_until: null }]);
    expect(await q('select authorisation_id from recipe.market_authorisation_withdrawal where authorisation_id = $1', [us.authorisationId])).toEqual([]);

    const withdrawal = because('REGISTRATION_LAPSED', 'US registration lapsed; renewal not filed');
    expect(await w.run(w.cast.qa, (c) => lc.withdrawMarketAuthorisation(c, us.authorisationId, 'US registration lapsed'), withdrawal)).toEqual({ cellsEnded: 1 });
    expect(await updates(withdrawal.correlationId, 'recipe.authorisation_cell')).toEqual([
      { record_id: usCell, reason_code: 'REGISTRATION_LAPSED', reason_text: 'US registration lapsed; renewal not filed', status: 'WITHDRAWN' },
    ]);
    expect(await w.violations()).toEqual([]);
  });

  it('[DI-22][DI-24][INV-17] a retirement by a command with a reason code and a blank reason text is refused (EBMR-AUDIT-002): no cell ends and the version stays APPROVED; with both halves each cell update records the command\'s reason', async () => {
    const v = await w.approvedVersion(uniqueContent());
    const a = await w.authorise(current(v.versionId, 'IN'));
    const inCell = a.cells[0]?.cell_id;
    const s = await w.state(v.versionId);

    const refused = because('PRODUCT_DISCONTINUED', '\t ');
    await expect(w.run(w.cast.qa, (c) => lc.retireVersion(c, v.versionId, s.version), refused)).rejects.toThrow(reasonRequired('recipe.authorisation_cell'));
    expect(await entriesOf(refused.correlationId)).toEqual([]);
    expect(await cellNow(inCell)).toEqual([{ status: 'CURRENT', valid_until: null }]);
    expect(await w.state(v.versionId)).toEqual(s);

    const retirement = because('PRODUCT_DISCONTINUED', 'product discontinued in every market');
    await w.run(w.cast.qa, (c) => lc.retireVersion(c, v.versionId, s.version), retirement);
    expect(await updates(retirement.correlationId, 'recipe.authorisation_cell')).toEqual([
      { record_id: inCell, reason_code: 'PRODUCT_DISCONTINUED', reason_text: 'product discontinued in every market', status: 'WITHDRAWN' },
    ]);
    expect((await w.state(v.versionId)).state).toBe('RETIRED');
    expect(await w.violations()).toEqual([]);
  });
});

describe('the reason of a stub-batch update (EBMR-AUDIT-002)', () => {
  /** Every reason a command may give that is not both halves: none, only a text, a blank text, a white-space code. */
  const incomplete = (text: string): (readonly [string, string])[] => [
    ['', ''],
    ['', text],
    ['BATCH_PROGRESS', ''],
    ['BATCH_PROGRESS', ' \t '],
    [' \t ', ''],
    [' ', text],
  ];

  it('[DI-22][DI-24][INV-01] issuing a batch or moving it on needs the issuer\'s own reason: a command without both halves is refused (EBMR-AUDIT-002), recipe code writes no half of it, and nothing changes; with both halves the audit entry records them exactly', async () => {
    const v = await w.approvedVersion(uniqueContent());
    await w.authorise(current(v.versionId, 'IN'));
    const batchId = await w.planBatch(v.familyId, ['IN'], scope('S1', 'L1', BS));
    const batchNow = () => q<{ status: string }>('select status from recipe.stub_batch where id = $1', [batchId]);

    for (const [code, text] of incomplete('first batch of the validation campaign')) {
      const refusedIssue = because(code, text);
      await expect(w.run(w.cast.issuer, (c) => lc.issueStubBatch(c, batchId), refusedIssue)).rejects.toThrow(reasonRequired('recipe.stub_batch'));
      expect(await entriesOf(refusedIssue.correlationId)).toEqual([]);
      expect(await batchNow()).toEqual([{ status: 'PLANNED' }]);
      expect(await q('select id from recipe.batch_mbr_pin where batch_id = $1', [batchId])).toEqual([]);
      expect(await q('select id from recipe.control_recipe where batch_id = $1', [batchId])).toEqual([]);
    }

    const issue = because('CAMPAIGN_START', 'first batch of the validation campaign');
    const issued = await w.run(w.cast.issuer, (c) => lc.issueStubBatch(c, batchId), issue);
    expect(issued.versionId).toBe(v.versionId);
    expect(await updates(issue.correlationId, 'recipe.stub_batch')).toEqual([
      { record_id: batchId, reason_code: 'CAMPAIGN_START', reason_text: 'first batch of the validation campaign', status: 'ISSUED' },
    ]);

    for (const [code, text] of incomplete('line clearance signed off by production')) {
      const refusedStart = because(code, text);
      await expect(w.run(w.cast.issuer, (c) => lc.setStubBatchStatus(c, batchId, 'IN_PROGRESS'), refusedStart)).rejects.toThrow(reasonRequired('recipe.stub_batch'));
      expect(await entriesOf(refusedStart.correlationId)).toEqual([]);
      expect(await batchNow()).toEqual([{ status: 'ISSUED' }]);
    }

    const start = because('LINE_CLEARANCE_DONE', 'line clearance signed off by production');
    await w.run(w.cast.issuer, (c) => lc.setStubBatchStatus(c, batchId, 'IN_PROGRESS'), start);
    expect(await updates(start.correlationId, 'recipe.stub_batch')).toEqual([
      { record_id: batchId, reason_code: 'LINE_CLEARANCE_DONE', reason_text: 'line clearance signed off by production', status: 'IN_PROGRESS' },
    ]);

    for (const [code, text] of incomplete('packing reconciled')) {
      const refusedComplete = because(code, text);
      await expect(w.run(w.cast.issuer, (c) => lc.setStubBatchStatus(c, batchId, 'COMPLETED'), refusedComplete)).rejects.toThrow(reasonRequired('recipe.stub_batch'));
      expect(await entriesOf(refusedComplete.correlationId)).toEqual([]);
      expect(await batchNow()).toEqual([{ status: 'IN_PROGRESS' }]);
    }

    const complete = because('BATCH_COMPLETE', 'packing reconciled; yield within limits');
    await w.run(w.cast.issuer, (c) => lc.setStubBatchStatus(c, batchId, 'COMPLETED'), complete);
    expect(await updates(complete.correlationId, 'recipe.stub_batch')).toEqual([
      { record_id: batchId, reason_code: 'BATCH_COMPLETE', reason_text: 'packing reconciled; yield within limits', status: 'COMPLETED' },
    ]);
    expect(await w.violations()).toEqual([]);
  });
});
