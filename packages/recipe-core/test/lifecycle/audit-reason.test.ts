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
 * The three market-authorisation commands of QA carry the QA person's own reason, both halves, too (migration
 * 0290): activating a record (a first activation as much as a successor's, which supersedes the predecessor's
 * cell), withdrawing it, and retiring a version (with or without open cells). recipe.require_own_reason refuses
 * a command without both halves right after its permission check (EBMR-AUDIT-002, leading the message as in the
 * kernel's refusals), before anything is written; the cells are superseded or ended in the command's own context,
 * so each audit entry records the reason exactly as given and the command's context is never replaced. The
 * helpers that used to complete a missing reason with one naming the act (recipe.push_reason and
 * recipe.restore_actor, 0100 and 0230) are gone.
 *
 * The RETIRE transition is also open to the application role directly, through platform.transition: its guard
 * mbr_version.no_open_authorisation refuses it without both halves (0290), so the engine never completes a blank
 * half for it and the state row's audit entry records the QA person's own reason. The other transitions that need
 * a reason do the same (kernel 0960, recipe-core 0301): the kernel guard platform.reason_given and the recipe guards
 * mbr_version.never_authorised (APPROVED -WITHDRAW->) and mbr_version.draft_entry_recorded (every RETURN) refuse a
 * command without both halves, so a WITHDRAW or a RETURN records the person's own reason, and none the engine wrote.
 *
 * A half is blank by one test everywhere (kernel.is_blank, kernel 0960; recipe.reason_is_blank is the same): NULL, or
 * nothing but characters that show nothing on their own. White space of any kind (the no-break space, the
 * ideographic space), controls, the format characters (the zero-width space, the byte order mark, the word joiner,
 * the interlinear annotation marks, the Egyptian hieroglyph format controls, the prepended number marks), the other
 * default-ignorable code points and the blank fillers say nothing, and a reason made only of them is refused. The
 * execution engine refuses the same texts (guards.ts isBlankText); the class is compared with it over every code
 * point.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '../../../kernel/src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { isBlankText } from '../../src/engine/guards.ts';
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

/**
 * Recipe core's refusal of a QA command (`act`) whose context lacks a half of the person's own reason (0290). The rule
 * code leads the message, as in the kernel's own EBMR-AUDIT-002 refusals.
 */
const ownReasonRequired = (act: string): RegExp =>
  new RegExp(
    `^EBMR-AUDIT-002 ${act} needs the reason of the person who gives it: a reason code and a reason text, neither blank\\. The system writes no part of it \\(DI-22, DI-24\\)$`,
  );

/** The engine's refusal of a RETIRE whose command lacks a half of the QA person's own reason (guard, 0290). */
const retireReasonRequired =
  /^EBMR-PLAT-068 RETIRE refused in state APPROVED: (.*; )?mbr_version\.no_open_authorisation: the retirement needs the reason of the QA person who retires the version: a reason code and a reason text, neither blank; the system writes no part of it \(DI-22, DI-24; EBMR-AUDIT-002\)$/;

/**
 * Halves that look like text but say nothing (written as code points, so the source holds no invisible character):
 * the no-break space, the zero-width space, the ideographic space, and the byte order mark with a word joiner and a
 * zero-width joiner. The kernel's own test counts the first two as text in this database; the recipe's does not.
 */
const NBSP = String.fromCodePoint(0x00a0);
const ZWSP = String.fromCodePoint(0x200b);
const IDEOGRAPHIC = String.fromCodePoint(0x3000);
const INVISIBLE = String.fromCodePoint(0xfeff, 0x2060, 0x200d);
/**
 * Format characters the recipe's own list of 0290 missed (round-1 verification): the interlinear annotation anchor,
 * the Egyptian hieroglyph format controls with the Syriac abbreviation mark, and an Arabic number sign with the
 * Kaithi number sign. A RETIRE and an activation with the first as their reason text committed.
 */
const ANNOTATION = String.fromCodePoint(0xfff9);
const HIEROGLYPH_FORMAT = String.fromCodePoint(0x13430, 0x1343f, 0x070f);
const NUMBER_SIGNS = String.fromCodePoint(0x0600, 0x110bd);

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

/**
 * A proposed record of `def` with the QA and regulatory signatures, not yet activated. A second QA person proposes; the
 * proposer cannot authorise (owner item 11, recipe-core 1889).
 */
const signedProposal = async (def: lc.MarketAuthorisationDefinition): Promise<{ id: string; qaSig: string; regSig: string }> => {
  const id = await w.run(w.cast.qa2, (c) => lc.proposeMarketAuthorisation(c, def));
  const qaSig = await w.sign(w.cast.qa, lc.MARKET_AUTHORISATION_AGGREGATE, id, 'MBR_MARKET_AUTHORISED', 'PROPOSED');
  const regSig = await w.sign(w.cast.regulatory, lc.MARKET_AUTHORISATION_AGGREGATE, id, 'REGULATORY_CONFIRMED', 'PROPOSED');
  return { id, qaSig, regSig };
};

/**
 * Proposes, signs and activates `def`. The activation carries the QA person's own reason, both halves (migration 0290);
 * the World's `authorise` gives none.
 */
const authorise = async (def: lc.MarketAuthorisationDefinition): Promise<lc.ActivationResult> => {
  const p = await signedProposal(def);
  return w.run(w.cast.qa, (c) => lc.activateMarketAuthorisation(c, p.id, p.qaSig, p.regSig), because('MARKET_AUTHORISED', `${def.market}: registration on file`));
};

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

describe('the reason of a market-authorisation command (EBMR-AUDIT-002)', () => {
  /**
   * Every reason a command may give that is not both halves: none, only a text, a blank text, a white-space code, and
   * halves made only of white space or invisible characters the kernel's own test lets through (0290).
   */
  const incomplete = (code: string, text: string): (readonly [string, string])[] => [
    ['', ''],
    ['', text],
    [code, ''],
    [code, ' \t '],
    [' \t ', ''],
    [' ', text],
    [code, NBSP],
    [code, ` ${ZWSP} `],
    [code, `${IDEOGRAPHIC} `],
    [code, INVISIBLE],
    [code, ANNOTATION],
    [code, `${HIEROGLYPH_FORMAT}${NUMBER_SIGNS}`],
    [NBSP, text],
    [ZWSP, text],
    [ANNOTATION, text],
  ];

  const activationOf = (id: string): Promise<unknown[]> => q('select authorisation_id from recipe.market_authorisation_activation where authorisation_id = $1', [id]);

  /** The distinct reasons carried by every audit entry of a command. */
  const reasonsOf = (correlationId: string): Promise<{ reason_code: string | null; reason_text: string | null }[]> =>
    q(
      `select distinct payload ->> 'reason_code' as reason_code, payload ->> 'reason_text' as reason_text
         from kernel.audit_event where correlation_id = $1`,
      [correlationId],
    );

  it.each([
    { given: 'no reason', code: '', text: '' },
    { given: 'a reason text and no reason code', code: '', text: 'registration granted for India' },
    { given: 'a reason code and an empty reason text', code: 'REGISTRATION_GRANTED', text: '' },
    { given: 'a reason code and a white-space reason text', code: 'REGISTRATION_GRANTED', text: ' \t ' },
    { given: 'a white-space reason code and a reason text', code: ' \t ', text: 'registration granted for India' },
    { given: 'a white-space reason code and an empty reason text', code: ' ', text: '' },
    { given: 'a reason code and a no-break-space reason text', code: 'REGISTRATION_GRANTED', text: NBSP },
    { given: 'a reason code and a zero-width-space reason text', code: 'REGISTRATION_GRANTED', text: ZWSP },
    { given: 'a reason code and an ideographic-space reason text', code: 'REGISTRATION_GRANTED', text: IDEOGRAPHIC },
    { given: 'a reason code and a reason text of invisible format characters', code: 'REGISTRATION_GRANTED', text: INVISIBLE },
    { given: 'a reason code and an interlinear-annotation reason text (U+FFF9)', code: 'REGISTRATION_GRANTED', text: ANNOTATION },
    { given: 'a reason code and a reason text of Egyptian hieroglyph format controls (U+13430)', code: 'REGISTRATION_GRANTED', text: HIEROGLYPH_FORMAT },
    { given: 'a reason code and a reason text of prepended number signs', code: 'REGISTRATION_GRANTED', text: NUMBER_SIGNS },
    { given: 'a no-break-space reason code and a reason text', code: NBSP, text: 'registration granted for India' },
    { given: 'an interlinear-annotation reason code and a reason text', code: ANNOTATION, text: 'registration granted for India' },
  ])('[DI-22][DI-24][INV-17] a first activation by a command with $given is refused (EBMR-AUDIT-002) although it supersedes nothing: the QA person\'s own reason is required, the system writes no half of it, and nothing is activated', async ({ code, text }) => {
    const v = await w.approvedVersion(uniqueContent());
    const p = await signedProposal(current(v.versionId, 'IN'));
    const ctx = because(code, text);
    await expect(w.run(w.cast.qa, (c) => lc.activateMarketAuthorisation(c, p.id, p.qaSig, p.regSig), ctx)).rejects.toThrow(ownReasonRequired('the activation of a market authorisation'));
    expect(await entriesOf(ctx.correlationId)).toEqual([]);
    expect(await activationOf(p.id)).toEqual([]);
    expect(await q('select id from recipe.authorisation_cell where version_id = $1', [v.versionId])).toEqual([]);
  });

  it('[DI-22][DI-24][INV-17] a first activation with both halves of the QA person\'s reason records exactly that reason in every audit entry it writes', async () => {
    const v = await w.approvedVersion(uniqueContent());
    const p = await signedProposal(current(v.versionId, 'IN'));
    const ctx = because('REGISTRATION_GRANTED', 'registration granted for India');
    const a = await w.run(w.cast.qa, (c) => lc.activateMarketAuthorisation(c, p.id, p.qaSig, p.regSig), ctx);
    expect(a.cells).toHaveLength(1);
    expect(await reasonsOf(ctx.correlationId)).toEqual([{ reason_code: 'REGISTRATION_GRANTED', reason_text: 'registration granted for India' }]);
    expect(await w.violations()).toEqual([]);
  });

  it('[DI-22][DI-24][INV-17] a successor\'s activation supersedes the predecessor\'s cell only with the QA person\'s own reason: without both halves it is refused (EBMR-AUDIT-002), no half is written by the system, the cell stays CURRENT and no audit entry remains; with both halves the supersession records them exactly and the command\'s context is left as it was', async () => {
    const v1 = await w.approvedVersion(uniqueContent());
    const a1 = await authorise(current(v1.versionId, 'IN'));
    const v1Cell = a1.cells[0]?.cell_id;
    const v2 = await w.approvedSuccessor(v1.versionId, (m) => (m.header.title = `${m.header.title} v2`));
    const p = await signedProposal(current(v2.versionId, 'IN'));

    for (const [code, text] of incomplete('NEW_VERSION_EFFECTIVE', 'successor version registered for India')) {
      const refused = because(code, text);
      await expect(w.run(w.cast.qa, (c) => lc.activateMarketAuthorisation(c, p.id, p.qaSig, p.regSig), refused)).rejects.toThrow(
        ownReasonRequired('the activation of a market authorisation'),
      );
      expect(await entriesOf(refused.correlationId)).toEqual([]);
      expect(await cellNow(v1Cell)).toEqual([{ status: 'CURRENT', valid_until: null }]);
      expect(await activationOf(p.id)).toEqual([]);
    }

    const ctx = because('NEW_VERSION_EFFECTIVE', 'successor version registered for India');
    const batchId = randomUUID();
    const seen = await w.run(
      w.cast.qa,
      async (c) => {
        const before = await actorNow(c);
        const superseded = (await lc.activateMarketAuthorisation(c, p.id, p.qaSig, p.regSig)).cells[0]?.superseded_cell_id;
        const after = await actorNow(c);
        // A later change in the same command carries the same reason: nothing replaced the command's context.
        const { rows } = await c.query<{ id: string }>('insert into testgmp.sample (batch_id, value) values ($1, 1) returning id', [batchId]);
        await c.query('update testgmp.sample set value = 2 where id = $1', [rows[0]?.id]);
        return { before, superseded, after };
      },
      ctx,
    );
    expect(seen.superseded).toBe(v1Cell);
    expect(seen.before).toMatchObject({ correlation_id: ctx.correlationId, reason_code: 'NEW_VERSION_EFFECTIVE', reason_text: 'successor version registered for India' });
    expect(seen.after).toEqual(seen.before);
    expect(await updates(ctx.correlationId, 'recipe.authorisation_cell')).toEqual([
      { record_id: v1Cell, reason_code: 'NEW_VERSION_EFFECTIVE', reason_text: 'successor version registered for India', status: 'SUPERSEDED' },
    ]);
    expect(await reasonsOf(ctx.correlationId)).toEqual([{ reason_code: 'NEW_VERSION_EFFECTIVE', reason_text: 'successor version registered for India' }]);
    expect(await w.violations()).toEqual([]);
  });

  it('[DI-22][DI-24][INV-17] a withdrawal needs the QA person\'s own reason in the command, whatever reason the withdrawal states: without both halves it is refused (EBMR-AUDIT-002), the system writes no half, nothing is withdrawn and no audit entry remains; with both halves the cell update records them exactly', async () => {
    const v = await w.approvedVersion(uniqueContent());
    const us = await authorise(current(v.versionId, 'US'));
    const usCell = us.cells[0]?.cell_id;

    for (const [code, text] of incomplete('REGISTRATION_LAPSED', 'US registration lapsed; renewal not filed')) {
      const refused = because(code, text);
      await expect(w.run(w.cast.qa, (c) => lc.withdrawMarketAuthorisation(c, us.authorisationId, 'US registration lapsed'), refused)).rejects.toThrow(
        ownReasonRequired('the withdrawal of a market authorisation'),
      );
      expect(await entriesOf(refused.correlationId)).toEqual([]);
      expect(await cellNow(usCell)).toEqual([{ status: 'CURRENT', valid_until: null }]);
      expect(await q('select authorisation_id from recipe.market_authorisation_withdrawal where authorisation_id = $1', [us.authorisationId])).toEqual([]);
    }
    // The reason the withdrawal states is blank by the recipe's test too: white space or invisible characters say nothing.
    for (const stated of ['', ' \t ', NBSP, `${ZWSP}${IDEOGRAPHIC}`, INVISIBLE, ANNOTATION, HIEROGLYPH_FORMAT]) {
      const refused = because('REGISTRATION_LAPSED', 'US registration lapsed; renewal not filed');
      await expect(w.run(w.cast.qa, (c) => lc.withdrawMarketAuthorisation(c, us.authorisationId, stated), refused)).rejects.toThrow(/^A withdrawal states its reason \(EBMR-RCP-084\)$/);
      expect(await entriesOf(refused.correlationId)).toEqual([]);
      expect(await cellNow(usCell)).toEqual([{ status: 'CURRENT', valid_until: null }]);
    }

    const withdrawal = because('REGISTRATION_LAPSED', 'US registration lapsed; renewal not filed');
    expect(await w.run(w.cast.qa, (c) => lc.withdrawMarketAuthorisation(c, us.authorisationId, 'US registration lapsed'), withdrawal)).toEqual({ cellsEnded: 1 });
    expect(await updates(withdrawal.correlationId, 'recipe.authorisation_cell')).toEqual([
      { record_id: usCell, reason_code: 'REGISTRATION_LAPSED', reason_text: 'US registration lapsed; renewal not filed', status: 'WITHDRAWN' },
    ]);
    expect(await reasonsOf(withdrawal.correlationId)).toEqual([{ reason_code: 'REGISTRATION_LAPSED', reason_text: 'US registration lapsed; renewal not filed' }]);
    expect(await w.violations()).toEqual([]);
  });

  it('[DI-22][DI-24][PR-05][INV-17] a retirement needs the QA person\'s own reason, both halves, whether or not a cell is open: without them it is refused (EBMR-AUDIT-002), no cell ends and the version stays APPROVED; with both halves each cell update records them exactly', async () => {
    // A version that was never authorised has no cell to end: the reason is required all the same.
    const bare = await w.approvedVersion(uniqueContent());
    const bareState = await w.state(bare.versionId);
    for (const [code, text] of incomplete('PRODUCT_DISCONTINUED', 'product discontinued in every market')) {
      const refused = because(code, text);
      await expect(w.run(w.cast.qa, (c) => lc.retireVersion(c, bare.versionId, bareState.version), refused)).rejects.toThrow(ownReasonRequired('the retirement of an MBR version'));
      expect(await entriesOf(refused.correlationId)).toEqual([]);
      expect(await w.state(bare.versionId)).toEqual(bareState);
    }

    const v = await w.approvedVersion(uniqueContent());
    const a = await authorise(current(v.versionId, 'IN'));
    const inCell = a.cells[0]?.cell_id;
    const s = await w.state(v.versionId);
    for (const [code, text] of incomplete('PRODUCT_DISCONTINUED', 'product discontinued in every market')) {
      const refused = because(code, text);
      await expect(w.run(w.cast.qa, (c) => lc.retireVersion(c, v.versionId, s.version), refused)).rejects.toThrow(ownReasonRequired('the retirement of an MBR version'));
      expect(await entriesOf(refused.correlationId)).toEqual([]);
      expect(await cellNow(inCell)).toEqual([{ status: 'CURRENT', valid_until: null }]);
      expect(await w.state(v.versionId)).toEqual(s);
    }

    const retirement = because('PRODUCT_DISCONTINUED', 'product discontinued in every market');
    await w.run(w.cast.qa, (c) => lc.retireVersion(c, v.versionId, s.version), retirement);
    expect(await updates(retirement.correlationId, 'recipe.authorisation_cell')).toEqual([
      { record_id: inCell, reason_code: 'PRODUCT_DISCONTINUED', reason_text: 'product discontinued in every market', status: 'WITHDRAWN' },
    ]);
    expect((await w.state(v.versionId)).state).toBe('RETIRED');
    expect(await w.violations()).toEqual([]);
  });

  it('[DI-22][DI-24][PR-05] a RETIRE made directly through the engine (platform.transition, open to the application role) needs the QA person\'s own reason, both halves, as recipe.retire_version does: without them the guard refuses it, the version stays APPROVED and no audit entry remains; with both halves the state row\'s audit entry and history record exactly that reason, and none the engine wrote', async () => {
    // A version that was never authorised: no open cell, so only the reason stands in the way.
    const v = await w.approvedVersion(uniqueContent());
    const s = await w.state(v.versionId);
    const retire = (c: pg.PoolClient) =>
      c.query("select platform.transition('mbr_version', 'mbr_version', $1, 'RETIRE', $2, '{}'::jsonb) as r", [v.versionId, s.version]);

    // First the review's probes: a code with a two-space text (P1) and a code with an empty text (P2) both committed.
    const probes: (readonly [string, string])[] = [
      ['PRODUCT_DISCONTINUED', '  '],
      ['PRODUCT_DISCONTINUED', ''],
    ];
    for (const [code, text] of [...probes, ...incomplete('PRODUCT_DISCONTINUED', 'product discontinued in every market')]) {
      const refused = because(code, text);
      await expect(w.run(w.cast.qa, retire, refused)).rejects.toThrow(retireReasonRequired);
      expect(await entriesOf(refused.correlationId)).toEqual([]);
      expect(await w.state(v.versionId)).toEqual(s);
    }

    const retirement = because('PRODUCT_DISCONTINUED', 'product discontinued in every market');
    await w.run(w.cast.qa, retire, retirement);
    expect(await w.state(v.versionId)).toEqual({ state: 'RETIRED', version: s.version + 1 });
    // The state row's audit entry carries the QA person's reason, not the event text the engine completes a blank half with.
    expect(
      await q(
        `select record_id, payload ->> 'reason_code' as reason_code, payload ->> 'reason_text' as reason_text, payload -> 'body' -> 'new' ->> 'state' as state
           from kernel.audit_event where correlation_id = $1 and table_name = 'platform.aggregate_state' and action = 'UPDATE'`,
        [retirement.correlationId],
      ),
    ).toEqual([{ record_id: v.versionId, reason_code: 'PRODUCT_DISCONTINUED', reason_text: 'product discontinued in every market', state: 'RETIRED' }]);
    expect(
      await q("select reason_code, reason_text from platform.state_history where aggregate_type = 'mbr_version' and aggregate_id = $1 and event = 'RETIRE'", [v.versionId]),
    ).toEqual([{ reason_code: 'PRODUCT_DISCONTINUED', reason_text: 'product discontinued in every market' }]);
    expect(await reasonsOf(retirement.correlationId)).toEqual([{ reason_code: 'PRODUCT_DISCONTINUED', reason_text: 'product discontinued in every market' }]);
    expect(await w.violations()).toEqual([]);
  });

  it('[DI-22][DI-24] the recipe\'s blank test refuses white space of any kind, controls and every invisible format character, and nothing else: a reason in any script is text', async () => {
    const blank = async (p: string | null): Promise<boolean> => (await q<{ b: boolean }>('select recipe.reason_is_blank($1) as b', [p]))[0]?.b ?? false;
    const formatCharacters = String.fromCodePoint(0xfff9, 0xfffa, 0xfffb, 0x13430, 0x1343f, 0x070f, 0x0600, 0x0605, 0x06dd, 0x0890, 0x0891, 0x08e2, 0x110bd, 0x110cd);
    for (const p of [null, '', ' \t\r\n', NBSP, ZWSP, IDEOGRAPHIC, INVISIBLE, ANNOTATION, HIEROGLYPH_FORMAT, NUMBER_SIGNS, formatCharacters,
                     `${NBSP}${ZWSP}${IDEOGRAPHIC}${INVISIBLE}${ANNOTATION} `, String.fromCodePoint(0x2800, 0x3164, 0x180e, 0x0085, 0xe0020)]) {
      expect({ p, blank: await blank(p) }).toEqual({ p, blank: true });
    }
    for (const p of ['x', `${NBSP}x${ZWSP}`, `${ANNOTATION}x${HIEROGLYPH_FORMAT}`, 'पंजीकरण रद्द', 'Zulassung erloschen', '登録取消', '.', '0']) {
      expect({ p, blank: await blank(p) }).toEqual({ p, blank: false });
    }
  });

  it('[DI-22][DI-24][PR-49] one blank test everywhere: over every code point, kernel.is_blank counts exactly the characters the execution engine counts as showing nothing (isBlankText), and recipe.reason_is_blank and records.is_blank answer as it does', async () => {
    // Every Unicode scalar value but U+0000, which a text value cannot hold.
    const engine: number[] = [];
    for (let c = 1; c <= 0x10ffff; c++) if ((c < 0xd800 || c > 0xdfff) && isBlankText(String.fromCodePoint(c))) engine.push(c);
    expect(engine).toHaveLength(4290);
    const [all] = await q<{ kernel: number[] }>(
      'select array_agg(i order by i) filter (where kernel.is_blank(chr(i))) as kernel from generate_series(1, 1114111) i where i not between 55296 and 57343',
    );
    expect(all?.kernel).toEqual(engine);
    // The recipe's and the records module's tests are the kernel's: every code point of the basic plane, and every
    // blank code point beyond it with its neighbours.
    const probe = new Set<number>();
    for (let c = 1; c <= 0xffff; c++) if (c < 0xd800 || c > 0xdfff) probe.add(c);
    for (const c of engine) for (const n of [c - 1, c, c + 1]) if (n > 0xffff && n <= 0x10ffff) probe.add(n);
    const [some] = await q<{ recipe: number[]; records: number[] }>(
      `select array_agg(i order by i) filter (where recipe.reason_is_blank(chr(i))) as recipe,
              array_agg(i order by i) filter (where records.is_blank(chr(i))) as records
         from unnest($1::int[]) i`,
      [[...probe]],
    );
    const expected = engine.filter((c) => probe.has(c));
    expect(some?.recipe).toEqual(expected);
    expect(some?.records).toEqual(expected);
  }, 120_000);

  it('[DI-22][DI-24] no recipe function writes a reason for a command: the helpers that completed one are gone, no function refers to them, ending cells takes no reason, the reason checks are private to the owner, and the RETIRE guard binds only that transition of the sealed machine', async () => {
    const [fns] = await q<{ push: string | null; restore: string | null; old_end: string | null; end: string | null; own: string | null; blank: string | null }>(
      `select to_regprocedure('recipe.push_reason(text, text)')::text as push, to_regprocedure('recipe.restore_actor(jsonb)')::text as restore,
              to_regprocedure('recipe.end_open_cells(uuid, uuid, text, text)')::text as old_end,
              to_regprocedure('recipe.end_open_cells(uuid, uuid)')::text as end, to_regprocedure('recipe.require_own_reason(text)')::text as own,
              to_regprocedure('recipe.reason_is_blank(text)')::text as blank`,
    );
    expect(fns).toEqual({ push: null, restore: null, old_end: null, end: 'recipe.end_open_cells(uuid,uuid)', own: 'recipe.require_own_reason(text)', blank: 'recipe.reason_is_blank(text)' });
    const callers = await q<{ fn: string }>(
      `select p.oid::regprocedure::text as fn from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname not in ('pg_catalog', 'information_schema') and p.prosrc ~ '(push_reason|restore_actor)' order by 1`,
    );
    expect(callers).toEqual([]);
    const [grants] = await q<{ own: boolean; end: boolean; blank: boolean; guard: boolean }>(
      `select has_function_privilege('ebmr_app', 'recipe.require_own_reason(text)', 'execute') as own,
              has_function_privilege('ebmr_app', 'recipe.end_open_cells(uuid, uuid)', 'execute') as end,
              has_function_privilege('ebmr_app', 'recipe.reason_is_blank(text)', 'execute') as blank,
              has_function_privilege('ebmr_app', 'recipe.guard_no_open_authorisation(text, uuid, jsonb, jsonb, jsonb)', 'execute') as guard`,
    );
    expect(grants).toEqual({ own: false, end: false, blank: false, guard: false });
    expect(
      await q(
        `select t.from_state, t.event, t.to_state from platform.machine_transition t
          where t.machine_code = 'mbr_version' and 'mbr_version.no_open_authorisation' = any (t.guard_codes) order by 1, 2`,
      ),
    ).toEqual([{ from_state: 'APPROVED', event: 'RETIRE', to_state: 'RETIRED' }]);
    expect(
      await q("select g.function_oid::text as fn from platform.state_guard g where g.code = 'mbr_version.no_open_authorisation'"),
    ).toEqual([{ fn: 'recipe.guard_no_open_authorisation(text,uuid,jsonb,jsonb,jsonb)' }]);
    expect(await q('select * from platform.machine_integrity_violations()')).toEqual([]);
  });
});

describe('the reason of a life-cycle transition of an MBR version (kernel 0960, recipe-core 0301)', () => {
  /** Every reason that is not both halves, including halves made only of characters that show nothing. */
  const incomplete = (code: string, text: string): (readonly [string, string])[] => [
    ['', ''],
    ['', text],
    [code, ''],
    [code, ' \t '],
    [' ', text],
    [code, NBSP],
    [code, `${ZWSP}${IDEOGRAPHIC}`],
    [code, ANNOTATION],
    [code, HIEROGLYPH_FORMAT],
    [ANNOTATION, text],
  ];

  const escaped = (m: string): string => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** The engine's refusal of `event` in state `from`, naming exactly the failing guards and their reasons. */
  const refusedBy = (event: string, from: string, ...reasons: string[]): RegExp => new RegExp(`^${escaped(`EBMR-PLAT-068 ${event} refused in state ${from}: ${reasons.join('; ')}`)}$`);
  const KERNEL_GUARD =
    'platform.reason_given: a reason is required for this transition: the reason code and the reason text of the person who makes it, neither blank; the system writes no part of it (DI-22, DI-24; EBMR-AUDIT-002)';
  const WITHDRAW_GUARD =
    'mbr_version.never_authorised: the withdrawal needs the reason of the QA person who withdraws the version: a reason code and a reason text, neither blank; the system writes no part of it (DI-22, DI-24; EBMR-AUDIT-002)';
  const RETURN_GUARD =
    'mbr_version.draft_entry_recorded: the return to DRAFT needs the reason of the person who returns the version: a reason code and a reason text, neither blank; the system writes no part of it (DI-22, DI-24; EBMR-AUDIT-002)';

  /** The UPDATE entries of the version's state row a command wrote, with the reason each carries. */
  const stateUpdates = (correlationId: string) =>
    q(
      `select record_id, payload ->> 'reason_code' as reason_code, payload ->> 'reason_text' as reason_text, payload -> 'body' -> 'new' ->> 'state' as state
         from kernel.audit_event where correlation_id = $1 and table_name = 'platform.aggregate_state' and action = 'UPDATE' order by id`,
      [correlationId],
    );
  const historyOf = (versionId: string, event: string) =>
    q("select reason_code, reason_text from platform.state_history where aggregate_type = 'mbr_version' and aggregate_id = $1 and event = $2 order by to_version", [versionId, event]);
  const cyclesOf = async (versionId: string): Promise<number> => (await q<{ n: number }>('select count(*)::int as n from recipe.mbr_draft_entry where version_id = $1', [versionId]))[0]?.n ?? -1;

  it('[DI-22][DI-24][PR-05] a WITHDRAW of an APPROVED version that was never authorised, made through platform.transition (lc.withdrawVersion), needs the QA person\'s own reason, both halves: without them the kernel guard and the recipe guard both refuse it, the version stays APPROVED and no audit entry remains; with both halves the state row\'s audit entry and history record exactly that reason, and none the engine wrote', async () => {
    const v = await w.approvedVersion(uniqueContent());
    const s = await w.state(v.versionId);
    // First the review's probe: a code with an empty text committed, and the engine wrote 'WITHDRAW: APPROVED -> WITHDRAWN'.
    for (const [code, text] of [['PRODUCT_DROPPED', ''] as const, ...incomplete('PRODUCT_DROPPED', 'product dropped before launch')]) {
      const refused = because(code, text);
      await expect(w.run(w.cast.qa, (c) => lc.withdrawVersion(c, v.versionId, s.version), refused), JSON.stringify([code, text])).rejects.toThrow(
        refusedBy('WITHDRAW', 'APPROVED', KERNEL_GUARD, WITHDRAW_GUARD),
      );
      expect(await entriesOf(refused.correlationId)).toEqual([]);
      expect(await w.state(v.versionId)).toEqual(s);
    }

    const withdrawal = because('PRODUCT_DROPPED', `product dropped before launch${ZWSP}`);
    await w.run(w.cast.qa, (c) => lc.withdrawVersion(c, v.versionId, s.version), withdrawal);
    expect(await w.state(v.versionId)).toEqual({ state: 'WITHDRAWN', version: s.version + 1 });
    expect(await stateUpdates(withdrawal.correlationId)).toEqual([
      { record_id: v.versionId, reason_code: 'PRODUCT_DROPPED', reason_text: `product dropped before launch${ZWSP}`, state: 'WITHDRAWN' },
    ]);
    expect(await historyOf(v.versionId, 'WITHDRAW')).toEqual([{ reason_code: 'PRODUCT_DROPPED', reason_text: `product dropped before launch${ZWSP}` }]);
    expect(await w.violations()).toEqual([]);
  });

  it('[DI-22][DI-24][DI-37][INV-09] a return to DRAFT (recipe.return_to_draft, open to the application role) needs the person\'s own reason, both halves, from every state it leaves: without them the kernel guard and the recipe guard refuse it, no draft cycle is recorded, the version stays where it was and no audit entry remains; with both halves the state row\'s audit entry and history record exactly that reason', async () => {
    const at = async (from: 'IN_VERIFICATION' | 'SUBMITTED' | 'CHECKED') => {
      const content = uniqueContent();
      const v = await w.newVersion(content);
      await w.prepare(v.versionId, content);
      await w.startVerification(v.versionId);
      if (from !== 'IN_VERIFICATION') await w.submit(v.versionId);
      if (from === 'CHECKED') await w.check(v.versionId);
      return v.versionId;
    };
    const cases = [
      { from: 'IN_VERIFICATION', returner: w.cast.author },
      { from: 'SUBMITTED', returner: w.cast.checker },
      { from: 'CHECKED', returner: w.cast.qa },
    ] as const;
    for (const { from, returner } of cases) {
      const versionId = await at(from);
      const s = await w.state(versionId);
      expect(s.state).toBe(from);
      const cycles = await cyclesOf(versionId);
      for (const [code, text] of incomplete('REWORK', 'section 4 needs rework')) {
        const refused = because(code, text);
        await expect(w.run(returner, (c) => lc.returnToDraft(c, versionId, s.version), refused), JSON.stringify([from, code, text])).rejects.toThrow(
          refusedBy('RETURN', from, KERNEL_GUARD, RETURN_GUARD),
        );
        expect(await entriesOf(refused.correlationId)).toEqual([]);
        expect(await w.state(versionId)).toEqual(s);
        expect(await cyclesOf(versionId)).toBe(cycles);
      }
      const back = because('REWORK', `section 4 needs rework (${from})`);
      await w.run(returner, (c) => lc.returnToDraft(c, versionId, s.version), back);
      expect(await w.state(versionId)).toEqual({ state: 'DRAFT', version: s.version + 1 });
      expect(await cyclesOf(versionId)).toBe(cycles + 1);
      expect(await stateUpdates(back.correlationId)).toEqual([{ record_id: versionId, reason_code: 'REWORK', reason_text: `section 4 needs rework (${from})`, state: 'DRAFT' }]);
      expect(await historyOf(versionId, 'RETURN')).toEqual([{ reason_code: 'REWORK', reason_text: `section 4 needs rework (${from})` }]);
    }
    expect(await w.violations()).toEqual([]);
  });

  it('[DI-22][DI-24] a WITHDRAW of a version before approval needs the person\'s own reason, both halves (kernel guard platform.reason_given): without them it is refused and the version stays; with both halves the audit entry records exactly them', async () => {
    const v = await w.newVersion(uniqueContent());
    const s = await w.state(v.versionId);
    expect(s.state).toBe('DRAFT');
    for (const [code, text] of incomplete('ABANDONED', 'master replaced by another family')) {
      const refused = because(code, text);
      await expect(w.run(w.cast.author, (c) => lc.withdrawVersion(c, v.versionId, s.version), refused), JSON.stringify([code, text])).rejects.toThrow(
        refusedBy('WITHDRAW', 'DRAFT', KERNEL_GUARD),
      );
      expect(await entriesOf(refused.correlationId)).toEqual([]);
      expect(await w.state(v.versionId)).toEqual(s);
    }
    const withdrawal = because('ABANDONED', 'master replaced by another family');
    await w.run(w.cast.author, (c) => lc.withdrawVersion(c, v.versionId, s.version), withdrawal);
    expect(await stateUpdates(withdrawal.correlationId)).toEqual([
      { record_id: v.versionId, reason_code: 'ABANDONED', reason_text: 'master replaced by another family', state: 'WITHDRAWN' },
    ]);
  });

  it('[DI-22][DI-24] the reason guards of the version machine: never_authorised binds only APPROVED -WITHDRAW->, draft_entry_recorded every RETURN, each still pointing at its own function, private to the owner and described with the reason; the sealed machine is unchanged', async () => {
    expect(
      await q(
        `select g.code, t.from_state, t.event from platform.machine_transition t cross join unnest(t.guard_codes) g (code)
          where t.machine_code = 'mbr_version' and g.code in ('mbr_version.never_authorised', 'mbr_version.draft_entry_recorded') order by 1, 2`,
      ),
    ).toEqual([
      { code: 'mbr_version.draft_entry_recorded', from_state: 'CHECKED', event: 'RETURN' },
      { code: 'mbr_version.draft_entry_recorded', from_state: 'IN_VERIFICATION', event: 'RETURN' },
      { code: 'mbr_version.draft_entry_recorded', from_state: 'SUBMITTED', event: 'RETURN' },
      { code: 'mbr_version.never_authorised', from_state: 'APPROVED', event: 'WITHDRAW' },
    ]);
    // Every RETURN and WITHDRAW, and RETIRE, also carries the kernel's reason guard.
    expect(
      await q(
        `select t.from_state, t.event from platform.machine_transition t
          where t.machine_code = 'mbr_version' and t.event in ('RETURN', 'WITHDRAW', 'RETIRE') and not ('platform.reason_given' = any (t.guard_codes))`,
      ),
    ).toEqual([]);
    expect(
      await q(
        `select g.code, g.function_oid::text as fn, g.description, has_function_privilege('ebmr_app', g.function_oid, 'execute') as app
           from platform.state_guard g where g.code in ('mbr_version.never_authorised', 'mbr_version.draft_entry_recorded') order by 1`,
      ),
    ).toEqual([
      {
        code: 'mbr_version.draft_entry_recorded',
        fn: 'recipe.guard_draft_entry_recorded(text,uuid,jsonb,jsonb,jsonb)',
        description:
          'The command carries the reason of the person who returns the version, code and text (DI-22, DI-24), and the return to DRAFT recorded a new draft cycle in this transaction, superseding every signature (DI-37; INV-09)',
        app: false,
      },
      {
        code: 'mbr_version.never_authorised',
        fn: 'recipe.guard_never_authorised(text,uuid,jsonb,jsonb,jsonb)',
        description: "The command carries the QA person's own reason, code and text (DI-22, DI-24), and the version was never authorised for any market (ADR 0014)",
        app: false,
      },
    ]);
    expect(await q('select * from platform.machine_integrity_violations()')).toEqual([]);
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
    await authorise(current(v.versionId, 'IN'));
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
