/**
 * The library of block definitions and its guards in batches and masters, rule by rule (SQL mutation group
 * "library-blocks": recipe-core 1800, 1810, 1840; tablets 1803). These tests close the gaps the SQL mutation run
 * (tools/sql-mutation) found in the group's tests (test/library/library-routes.test.ts and library-batch-gmp.test.ts),
 * which call the problem functions with crafted JSON or go through routes that refuse bad input before the database:
 *   - recipe.library_block_guard: a library row written outside recipe.draft_library_block (as the table owner) whose
 *     code, version, title or category differs from its definition, each on its own (EBMR-LIB-001); a definition without
 *     sections, with an empty or non-list sections member, or without a list of signatures, each on its own
 *     (EBMR-LIB-001); a content hash that is not the canonical hash of the definition (EBMR-LIB-002);
 *   - recipe.draft_library_block: each malformed definition on its own (not an object, a code outside the pattern, a
 *     version that is not a number; EBMR-LIB-003);
 *   - recipe.approve_library_block: an unknown block (EBMR-LIB-005), a block that is not a draft (EBMR-LIB-006), an
 *     approver who drafted it (EBMR-LIB-007), a signature applied in another state of the record and a signature of
 *     another person than the actor (EBMR-LIB-007);
 *   - recipe.retire_library_block: an unknown block (EBMR-LIB-005) and a blank or missing reason (EBMR-LIB-008);
 *   - recipe.library_limits_check and tab.library_smart_fields_check, the triggers themselves, on a real update of
 *     recipe.execution_state with only the trigger under test enabled: a row adding a library entry outside its limit
 *     without its LIB_LIMIT_BREACH (EBMR-LIB-020), a hand-keyed library weighing without two-person verification
 *     (EBMR-TAB-480), also when the previous state had no entries member, and a row that adds no entry is not checked;
 *   - recipe.library_limits_problem: each condition of the timer and the section branches on its own (the duration's
 *     unit, a missing duration, a value inside and outside the limit, the exception's type, step key and item, an
 *     exception the previous state already held, an entry the previous state already held, the until-pass field, a
 *     field that is not numeric, a limit slot without a limit);
 *   - recipe.library_snapshot_problem: a snapshot version the library does not hold, next to a version it does;
 *   - recipe.library_at_approval_check on the real approval path: a master whose library version was retired is refused
 *     at QA approval only (EBMR-LIB-021), its earlier life-cycle steps are not;
 *   - recipe.library_at_issue_check on an insert of recipe.control_recipe with only that trigger enabled: a snapshot of a
 *     library version that is not approved is refused (EBMR-LIB-022), an approved or a retired one is not;
 *   - recipe.library_field_schema and recipe.library_entry_schema: each field type's schema, the timers of a block, and
 *     the server-filled lot and equipment facts only for a section with such a field;
 *   - tab.library_smart_problem: an entry the previous state held is not checked again; a lot the register holds but
 *     that is not usable; equipment of another class than the formulation requires, and none required.
 * Each case runs as a seed persona's command on the superuser's connection in a transaction that is always rolled back
 * (kill-support.ts); fixtures that bypass the product's writers are written as the table owner or with triggers off.
 *
 * Controls: PR-03, PR-05, PR-08, PR-14, PR-18, PR-19, DI-22, DI-30, DI-35; invariant INV-25.
 */
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { library } from '@ebmr/recipe-core/pure';
import { startSigningServer, valueOf } from '../esig/support.ts';
import type { TestServer } from '../support/harness.ts';
import { gmpContent, gmpLifecycleWorld } from '../support/gmp-world.ts';
import { signAction } from '../support/signed-acts.ts';
import { attempt, batchWith, inCommand, replica, tag, type Json } from './kill-support.ts';

let gmp: TestServer;
beforeAll(async () => {
  gmp = await startSigningServer('GMP', { stub: false });
}, 600_000);
afterAll(async () => {
  await gmp?.close();
});

/** A minimal valid library definition. */
const defOf = (code: string, version = 1, extra: Json = {}): Json => ({
  code,
  version,
  title: 'Kill block',
  category: 'TEST_IPC',
  sections: [{ id: 'run', title: 'Run', fields: [{ id: 'w', label: 'W', type: 'NUMBER', unit: 'g' }] }],
  signatures: [{ meaning: 'PERFORMED', role: 'IPC_OPERATOR' }],
  ...extra,
});

/** Inserts a library row as the table owner (the guard runs; recipe.draft_library_block does not); '' or the refusal. */
async function insertBlock(c: PoolClient, row: { code: string; version: number; title: string; category: string }, definition: Json, hash?: string, drafter?: string): Promise<string> {
  const o = await attempt(
    c,
    `insert into recipe.library_block (code, version, title, category, definition, content_hash, drafted_by_person, drafted_by_account, correlation_id)
     values ($1, $2, $3, $4, $5::jsonb, coalesce($6, recipe.json_hash($5::jsonb)), coalesce($7::uuid, gen_random_uuid()), gen_random_uuid(), gen_random_uuid())
     returning id::text as r`,
    [row.code, row.version, row.title, row.category, JSON.stringify(definition), hash ?? null, drafter ?? null],
  );
  return o.ok ? '' : o.message;
}

/** A library row as the owner writes it (the definition's own columns); its id. */
async function block(c: PoolClient, definition: Json, drafter?: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `insert into recipe.library_block (code, version, title, category, definition, content_hash, drafted_by_person, drafted_by_account, correlation_id)
     values ($1::jsonb ->> 'code', ($1::jsonb ->> 'version')::integer, $1::jsonb ->> 'title', $1::jsonb ->> 'category', $1::jsonb, recipe.json_hash($1::jsonb),
             coalesce($2::uuid, gen_random_uuid()), gen_random_uuid(), gen_random_uuid())
     returning id::text`,
    [JSON.stringify(definition), drafter ?? null],
  );
  return rows[0]?.id ?? '';
}

const personOf = async (c: PoolClient): Promise<string> => (await c.query<{ p: string }>("select kernel.current_actor() ->> 'person_id' as p")).rows[0]?.p ?? '';

/** A block drafted by the author and approved by QA through the routes; its id and the approval's signature. */
async function routeApprovedBlock(): Promise<{ id: string; signature: string; definition: Json }> {
  const [author, approver] = await Promise.all([gmp.asPersona('author'), gmp.asPersona('approver')]);
  const definition = defOf(`KL-${tag()}`);
  const { block: b } = valueOf(await author.call(routes.library.draft, { body: { definition } }));
  const signed = await signAction(gmp, approver, 'approver', { kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: b.blockId });
  if (!signed.ok) throw new Error(`the library block was not approved: ${JSON.stringify(signed.error)}`);
  const { rows } = await gmp.db.admin.query<{ s: string }>('select signature_id::text as s from recipe.library_block_approval where block_id = $1', [b.blockId]);
  return { id: b.blockId, signature: rows[0]?.s ?? '', definition };
}

describe('the library rows and their writers (recipe-core 1800)', () => {
  it('[PR-03][PR-05] a library row whose code, version, title or category differs from its definition is refused, each on its own (EBMR-LIB-001)', async () => {
    await inCommand(gmp, 'author', async (c) => {
      const code = `KG-${tag()}`;
      const d = defOf(code);
      const row = { code, version: 1, title: 'Kill block', category: 'TEST_IPC' };
      for (const bad of [{ ...row, code: `${code}-X` }, { ...row, version: 2 }, { ...row, title: 'Other title' }, { ...row, category: 'PROCESS' }]) {
        expect(await insertBlock(c, bad, d), JSON.stringify(bad)).toMatch(/^EBMR-LIB-001 the definition's code, version, title and category must match/);
      }
      expect(await insertBlock(c, row, d)).toBe('');
    });
  });

  it('[PR-03] a library row without sections, with an empty or non-list sections member, or without a list of signatures is refused, each on its own (EBMR-LIB-001)', async () => {
    await inCommand(gmp, 'author', async (c) => {
      const code = `KS-${tag()}`;
      const row = { code, version: 1, title: 'Kill block', category: 'TEST_IPC' };
      const without = (key: string): Json => Object.fromEntries(Object.entries(defOf(code)).filter(([k]) => k !== key));
      const noSections = without('sections');
      const noSignatures = without('signatures');
      for (const d of [noSections, defOf(code, 1, { sections: [] }), defOf(code, 1, { sections: { id: 'run' } }), noSignatures, defOf(code, 1, { signatures: { meaning: 'PERFORMED' } })]) {
        expect(await insertBlock(c, row, d), JSON.stringify(d)).toMatch(/^EBMR-LIB-001 a library block has at least one section and a list of signatures/);
      }
    });
  });

  it('[PR-05][DI-22] a library row whose content hash is not the canonical hash of its definition is refused (EBMR-LIB-002)', async () => {
    await inCommand(gmp, 'author', async (c) => {
      const code = `KH-${tag()}`;
      const row = { code, version: 1, title: 'Kill block', category: 'TEST_IPC' };
      expect(await insertBlock(c, row, defOf(code), 'f'.repeat(64))).toMatch(/^EBMR-LIB-002 content_hash is not the canonical hash/);
    });
  });

  it('[PR-03] the author\'s draft is refused for each malformed definition on its own: not an object, a code outside the pattern, a version that is not a number (EBMR-LIB-003)', async () => {
    await inCommand(gmp, 'author', async (c) => {
      const code = `KD-${tag()}`;
      for (const p of ['"just text"', JSON.stringify(defOf('lower-case')), JSON.stringify(defOf(code, 1, { version: '1' }))]) {
        const o = await attempt(c, 'select recipe.draft_library_block($1::jsonb) as r', [p]);
        expect(o.ok ? 'drafted' : o.message, p).toMatch(/^EBMR-LIB-003 a library block definition names its code/);
      }
      const ok = await attempt<Json>(c, 'select recipe.draft_library_block($1::jsonb) as r', [JSON.stringify(defOf(code))]);
      expect(ok.ok).toBe(true);
    });
  });

  it('[DI-35][PR-05] QA\'s approval is refused for an unknown block (EBMR-LIB-005), a block that is not a draft (EBMR-LIB-006) and a block QA drafted (EBMR-LIB-007)', async () => {
    const approved = await routeApprovedBlock();
    await inCommand(gmp, 'approver', async (c) => {
      const approve = async (id: string, sig: string = randomUUID()): Promise<string> => {
        const o = await attempt(c, 'select recipe.approve_library_block($1::uuid, $2::uuid) as r', [id, sig]);
        return o.ok ? 'approved' : o.message;
      };
      expect(await approve(randomUUID())).toMatch(/^EBMR-LIB-005 unknown library block/);
      expect(await approve(approved.id)).toMatch(/^EBMR-LIB-006 .* is APPROVED; only a draft is approved/);
      const own = await block(c, defOf(`KO-${tag()}`), await personOf(c));
      expect(await approve(own)).toMatch(/^EBMR-LIB-007 a library block is approved by another person than its author/);
    });
  });

  it('[DI-35][PR-05] QA\'s approval is refused with a signature applied in another state of the block, or signed by another person than the approver (EBMR-LIB-007)', async () => {
    const approved = await routeApprovedBlock();
    await inCommand(gmp, 'approver', async (c) => {
      // The block back to a draft, its approval signature still valid (the approval row removed as the owner).
      await replica(c, () => c.query('delete from recipe.library_block_approval where block_id = $1', [approved.id]));
      const approve = async (): Promise<string> => {
        const o = await attempt(c, 'select recipe.approve_library_block($1::uuid, $2::uuid) as r', [approved.id, approved.signature]);
        return o.ok ? 'approved' : o.message;
      };
      await c.query('savepoint fixture');
      await replica(c, () => c.query("update esig.signature set record_state = 'APPROVED' where id = $1", [approved.signature]));
      expect(await approve()).toMatch(/^EBMR-LIB-007 signature .* was applied while the record was in state APPROVED/);
      await c.query('rollback to savepoint fixture');
      await replica(c, () => c.query('update esig.signature set signer_person = $2, session_person = $2 where id = $1', [approved.signature, randomUUID()]));
      expect(await approve()).toMatch(/^EBMR-LIB-007 the approval is recorded by the person who signed it/);
      await c.query('rollback to savepoint fixture');
      expect(await approve()).toBe('approved');
    });
  });

  it('[DI-22][PR-05] a retirement is refused for an unknown block (EBMR-LIB-005) and without a reason (EBMR-LIB-008)', async () => {
    const approved = await routeApprovedBlock();
    await inCommand(gmp, 'approver', async (c) => {
      const retire = async (id: string, reason: string | null): Promise<string> => {
        const o = await attempt<string>(c, 'select recipe.retire_library_block($1::uuid, $2) as r', [id, reason]);
        return o.ok ? o.r : o.message;
      };
      expect(await retire(randomUUID(), 'Replaced by a revised form')).toMatch(/^EBMR-LIB-005 unknown library block/);
      expect(await retire(approved.id, '   ')).toMatch(/^EBMR-LIB-008 a retirement states its reason/);
      expect(await retire(approved.id, null)).toMatch(/^EBMR-LIB-008 a retirement states its reason/);
      expect(await retire(approved.id, 'Replaced by a revised form')).toBe('RETIRED');
    });
  });
});

// ---- Library entries in batches (recipe-core 1810, tablets 1803) -------------------------------------------------------

const LIM = (unit: string, high: string): Json => ({
  unit,
  ranges: [{ tier: 'REGISTERED', high: { value: high, inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'REGISTRATION', ref: 'REF-1' } }],
});

const KDEF: Json = {
  code: 'KILL-LIM',
  version: 1,
  title: 'Limits',
  category: 'TEST_IPC',
  sections: [
    {
      id: 'run',
      title: 'Run',
      fields: [
        { id: 'note', label: 'Note', type: 'NUMBER', unit: 'g' },
        { id: 'w', label: 'W', type: 'NUMBER', unit: 'g', limitSlot: 'w' },
        { id: 'calc', label: 'Calculate', type: 'YES_NO', required: false },
        { id: 'loss', label: 'Loss', type: 'CALC', expression: 'w * 1 [%]', unit: '%', limitSlot: 'loss', showWhen: { field: 'calc', equals: true } },
        { id: 'flag', label: 'Flag', type: 'TEXT', limitSlot: 'flag' },
        { id: 'nolim', label: 'No limit', type: 'NUMBER', unit: 'g', limitSlot: 'nolim' },
      ],
    },
    {
      id: 'hold',
      title: 'Hold',
      fields: [
        { id: 'other', label: 'Other', type: 'NUMBER', unit: 'g' },
        { id: 't1', label: 'Hold time', type: 'TIMER', limitSlot: 't1' },
        { id: 't2', label: 'Hold time in seconds', type: 'TIMER', durationUnit: 's', limitSlot: 't2' },
      ],
    },
    { id: 'retry', title: 'Retry', repeat: { kind: 'UNTIL_PASS', untilField: 'r', maxRepeatsSlot: 'maxR' }, fields: [{ id: 'r', label: 'R', type: 'NUMBER', unit: 'g', limitSlot: 'r' }] },
    { id: 'confirm', title: 'Confirm', repeat: { kind: 'UNTIL_PASS', untilField: 'ok', maxRepeatsSlot: 'maxC' }, fields: [{ id: 'ok', label: 'OK', type: 'YES_NO', expected: true, required: false }] },
    { id: 'calcLoop', title: 'Calculated loop', repeat: { kind: 'UNTIL_PASS', untilField: 'g', maxRepeatsSlot: 'maxG' }, fields: [{ id: 'x', label: 'X', type: 'NUMBER', unit: 'g' }, { id: 'g', label: 'G', type: 'CALC', expression: 'x * 1 [%]', unit: '%', limitSlot: 'g' }] },
    {
      id: 'ipc',
      title: 'IPC',
      fields: [
        {
          id: 'wt', label: 'Weights', type: 'TEST_RESULT', unit: 'mg', replicatesSlot: 'n',
          statistics: [{ statistic: 'INDIVIDUAL', limitSlot: 'ind' }, { statistic: 'MIN', limitSlot: 'min' }, { statistic: 'MAX', limitSlot: 'max' }, { statistic: 'MEAN', limitSlot: 'mean' }, { statistic: 'RANGE', limitSlot: 'rng' }, { statistic: 'RSD', limitSlot: 'rsd' }],
        },
        { id: 'rel', label: 'Released', type: 'TEST_RESULT', unit: '%', replicatesSlot: 'v', perPoint: true, required: false, statistics: [{ statistic: 'MEAN', limitSlot: 'relMean' }] },
      ],
    },
  ],
  signatures: [],
};

const SDEF: Json = {
  code: 'KILL-SMART',
  version: 1,
  title: 'Smart',
  category: 'PROCESS',
  sections: [
    {
      id: 'weigh',
      title: 'Weigh',
      fields: [
        { id: 'bal', label: 'Balance', type: 'EQUIPMENT', kind: 'BALANCE', classSlot: 'balanceClass' },
        { id: 'lot', label: 'Lot', type: 'MATERIAL_LOT' },
        { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
      ],
    },
  ],
  signatures: [],
};

const phase = (id: string, type: string, config: Json = {}): Json => ({ kind: 'phase', id, name: id, block: { type, version: '1' }, config });
const LIMITS = { w: LIM('g', '10'), loss: LIM('%', '1.0'), flag: LIM('g', '10'), t1: LIM('min', '30'), t2: LIM('min', '30'), r: LIM('g', '10') };
const contentWith = (balanceClass: string | null = 'CL-K'): Json => ({
  procedure: {
    kind: 'procedure',
    id: 'proc',
    children: [
      phase('p-lib', 'LIB-KILL-LIM', { limits: LIMITS }),
      phase('p-smart', 'LIB-KILL-SMART', balanceClass ? { equipmentClasses: { balanceClass } } : {}),
      phase('p-plain', 'G-01', { limits: LIMITS }),
    ],
  },
  blockDefinitions: [KDEF, SDEF],
});
const CONTENT = contentWith();

const STEPS = { 'p-lib@': { key: 'p-lib@', step: 'p-lib', frames: [] }, 'p-smart@': { key: 'p-smart@', step: 'p-smart', frames: [] }, 'p-plain@': { key: 'p-plain@', step: 'p-plain', frames: [] } };
const OP = 'OP-1';
/** The server's figure for the calculated loss with its evaluation record (O-9 (b); R3-SQL-5). */
const LOSS = (value: string, extra: Json = {}): Json => ({ value, unit: '%', expression: 'w * 1 [%]', languageVersion: '1.0', inputs: { w: { kind: 'DECIMAL', value, unit: 'g' } }, ...extra });
const entry = (kind: string, data: Json, stepKey = 'p-lib@'): Json => ({ kind, stepKey, data, enteredBy: OP });
/**
 * The LIB_LIMIT_BREACH the engine raises for a value of `item` outside its registered limit (exceptions.ts tierDraft, tx.ts
 * raise): a registration-relevant deviation only QA dispositions, the step and the steps after it blocked until it is
 * linked. `extra` replaces members (R3-SQL-1: each fact is compared).
 */
const breach = (item: string, extra: Json = {}, id = 'X1'): Json => ({
  id,
  type: 'LIB_LIMIT_BREACH',
  category: 'OUT_OF_LIMIT',
  title: `Limits, Run: ${item} is outside its registered limit: a registration-relevant deviation is mandatory and only QA dispositions it [registered tier]`,
  controls: ['PR-08'],
  severity: 'CRITICAL',
  source: { stepKey: 'p-lib@', step: 'p-lib', frames: [], item },
  raisedAt: { $u: '1000' },
  raisedSeq: 2,
  raisedBy: OP,
  deviationRequired: true,
  registrationRelevant: true,
  qaOnly: true,
  stageSignOffBlocked: true,
  releaseBlocking: true,
  status: 'OPEN',
  block: { steps: ['p-lib@'], until: 'DEVIATION', downstream: { node: 'task:p-lib', frames: [] } },
  ...extra,
});
/**
 * A timer's start (entry S-<field>, at trusted time 0) and its stop (entry E1) `minutes` later, the stop carrying the
 * duration `value` in `unit` (R3-SQL-3: the database works the duration out from the two times).
 */
const timer = (field: string, value: string | undefined, minutes: number, unit = 'min'): Json => ({
  [`S-${field}`]: { ...(entry('TIMER_START', { field }) as Record<string, Json>), recordedAt: { $u: '0' } },
  E1: { ...(entry('TIMER_STOP', { field, ...(value === undefined ? {} : { duration: { value, unit } }) }) as Record<string, Json>), recordedAt: { $u: String(BigInt(minutes) * 60_000_000n) } },
});

/** recipe.library_limits_problem for a row moving from `old` to `next` (entries and exceptions over the same steps). */
async function limits(c: PoolClient, old: { entries?: Json; exceptions?: Json }, next: { entries?: Json; exceptions?: Json }): Promise<string | null> {
  const { rows } = await c.query<{ p: string | null }>('select recipe.library_limits_problem($1::jsonb, $2::jsonb, $3::jsonb) as p', [
    JSON.stringify(CONTENT),
    JSON.stringify({ steps: STEPS, entries: {}, exceptions: {}, ...old }),
    JSON.stringify({ steps: STEPS, entries: {}, exceptions: {}, ...next }),
  ]);
  return rows[0]?.p ?? null;
}

/** A batch running CONTENT whose execution state is `state`, with only trigger `trigger` enabled on recipe.execution_state. */
async function batchState(c: PoolClient, state: Json, trigger: string): Promise<{ id: string; update: (next: Json) => Promise<string> }> {
  const id = await replica(c, async () => {
    const b = await batchWith(c, gmp.seed.siteCode, CONTENT);
    await c.query(
      "insert into recipe.execution_state (batch_id, state, state_version, state_hash, last_seq, last_row_hash, status) values ($1, $2, 1, repeat('0', 64), 1, repeat('0', 64), 'IN_PROGRESS')",
      [b, JSON.stringify(state)],
    );
    return b;
  });
  await c.query('alter table recipe.execution_state disable trigger user');
  await c.query(`alter table recipe.execution_state enable trigger ${trigger}`);
  return {
    id,
    update: async (next: Json): Promise<string> => {
      const o = await attempt(c, 'update recipe.execution_state set state = $2 where batch_id = $1', [id, JSON.stringify(next)]);
      return o.ok ? '' : o.message;
    },
  };
}

describe('library values against the formulation\'s limits (recipe-core 1810)', () => {
  it('[PR-08] the trigger itself refuses a row adding a library value outside its limit without its LIB_LIMIT_BREACH (EBMR-LIB-020), also after a state without entries; a row adding no entry is not checked', async () => {
    await inCommand(gmp, 'author', async (c) => {
      const out = { E1: entry('run', { w: '50' }) };
      const t = await batchState(c, { steps: STEPS, entries: {}, exceptions: {} }, 'zzg_library_limits');
      expect(await t.update({ steps: STEPS, entries: out, exceptions: {} })).toMatch(/^This row stores w = 50 g at step p-lib, outside its \w+ limit, without the LIB_LIMIT_BREACH it requires \(severity CRITICAL, deviation required\): .*\[EBMR-LIB-020\]$/);
      expect(await t.update({ steps: STEPS, entries: out, exceptions: { X1: breach('p-lib.w') } })).toBe('');
      // A later row that adds no entry is not checked again (the value was taken with its exception).
      expect(await t.update({ steps: STEPS, entries: out, exceptions: {}, note: 'later' })).toBe('');
      const s = await batchState(c, { steps: STEPS }, 'zzg_library_limits');
      expect(await s.update({ steps: STEPS, entries: out, exceptions: {} })).toMatch(/\[EBMR-LIB-020\]$/);
    });
  });

  it('[PR-08] a timer\'s duration is read in its own unit: a limit in another unit and a missing duration are refused, each on its own; another field of the block is not the timer', async () => {
    await inCommand(gmp, 'author', async (c) => {
      // R3-SQL-3 wording: the duration is now worked out from the start and the stop, so a missing or unreadable figure is
      // refused as another figure than the trusted one, and a limit in another unit than the timer's as such.
      expect(await limits(c, {}, { entries: timer('t2', '1200', 20, 's') })).toBe('stores timer t2 at step p-lib, whose limit is not written in the timer\'s unit s');
      expect(await limits(c, {}, { entries: timer('t1', undefined, 20) })).toBe('stores timer t1 at step p-lib with a duration of none (no unit), where its start and stop on trusted time give 20 min');
      expect(await limits(c, {}, { entries: timer('t1', 'soon', 20) })).toMatch(/^stores timer t1 at step p-lib with a duration of soon min, where/);
      expect(await limits(c, {}, { entries: timer('t1', '20', 20) })).toBeNull();
      expect(await limits(c, {}, { entries: timer('t1', '45', 45) })).toMatch(/^stores timer t1 at step p-lib with 45 min, outside its \w+ limit, without the LIB_LIMIT_BREACH/);
    });
  });

  it('[PR-08] only a new LIB_LIMIT_BREACH of this step and this item admits a timer outside its limit', async () => {
    await inCommand(gmp, 'author', async (c) => {
      const E = timer('t1', '45', 45);
      expect(await limits(c, {}, { entries: E, exceptions: { X1: breach('p-lib.t1') } })).toBeNull();
      for (const x of [breach('p-lib.t1', { type: 'OUT_OF_LIMIT' }), breach('p-lib.t1', { source: { stepKey: 'p-lib@2', item: 'p-lib.t1' } }), breach('p-lib.t2')]) {
        expect(await limits(c, {}, { entries: E, exceptions: { X1: x } }), JSON.stringify(x)).toMatch(/^stores timer t1 .* without the LIB_LIMIT_BREACH/);
      }
      // An exception the previous state already held is not this value's.
      expect(await limits(c, { exceptions: { X1: breach('p-lib.t1') } }, { entries: E, exceptions: { X1: breach('p-lib.t1') } })).toMatch(/^stores timer t1 .* without the LIB_LIMIT_BREACH/);
    });
  });

  it('[PR-08] only a new LIB_LIMIT_BREACH of this step and this item admits a section value outside its limit; an entry the previous state held is not checked again', async () => {
    await inCommand(gmp, 'author', async (c) => {
      const E = { E1: entry('run', { w: '50' }) };
      expect(await limits(c, {}, { entries: E, exceptions: { X1: breach('p-lib.w') } })).toBeNull();
      for (const x of [breach('p-lib.w', { type: 'OUT_OF_LIMIT' }), breach('p-lib.w', { source: { stepKey: 'p-lib@2', item: 'p-lib.w' } }), breach('p-lib.loss')]) {
        expect(await limits(c, {}, { entries: E, exceptions: { X1: x } }), JSON.stringify(x)).toMatch(/^stores w = 50 g at step p-lib, outside its \w+ limit, without the LIB_LIMIT_BREACH/);
      }
      expect(await limits(c, { exceptions: { X1: breach('p-lib.w') } }, { entries: E, exceptions: { X1: breach('p-lib.w') } })).toMatch(/without the LIB_LIMIT_BREACH/);
      expect(await limits(c, { entries: E }, { entries: E })).toBeNull();
      expect(await limits(c, {}, { entries: { E1: entry('run', { w: '5' }) } })).toBeNull();
      expect(await limits(c, {}, { entries: { E1: entry('run', { calc: true, computed: { loss: LOSS('1.5') } }) } })).toMatch(/^stores loss = 1\.5 % at step p-lib/);
    });
  });

  it('[PR-08] the until-pass field, a field that is not numeric, a limit slot without a limit, a value not entered and a step of another block are not read against a limit', async () => {
    await inCommand(gmp, 'author', async (c) => {
      expect(await limits(c, {}, { entries: { E1: entry('retry', { r: '50' }) } })).toBeNull();
      expect(await limits(c, {}, { entries: { E1: entry('run', { flag: '50' }) } })).toBeNull();
      expect(await limits(c, {}, { entries: { E1: entry('run', { nolim: '50' }) } })).toBeNull();
      expect(await limits(c, {}, { entries: { E1: entry('run', { note: '50' }) } })).toBeNull();
      expect(await limits(c, {}, { entries: { E1: entry('run', { w: '50' }, 'p-plain@') } })).toBeNull();
    });
  });
});

describe('release review R3: the database judges library values as the engine does (recipe-core 1862)', () => {
  const W = { E1: entry('run', { w: '50' }) };
  /** A one-tier limit in `unit` from `low` to `high` (either may be absent). */
  const RANGE = (unit: string, low: string | null, high: string | null, tier = 'REGISTERED'): Json => ({
    unit,
    ranges: [{ tier, ...(low !== null ? { low: { value: low, inclusive: true } } : {}), ...(high !== null ? { high: { value: high, inclusive: true } } : {}), rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'REGISTRATION', ref: 'REF-1' } }],
  });
  /** recipe.library_limits_problem with the library step configured by `config` (its limits added to LIMITS). */
  const judged = async (c: PoolClient, config: Json, next: { entries?: Json; exceptions?: Json }, old: { entries?: Json; exceptions?: Json } = {}): Promise<string | null> => {
    const cfg = config as Record<string, Json>;
    // A slot given as null is left without limits.
    const lims = Object.fromEntries(Object.entries({ ...LIMITS, ...(cfg['limits'] as Record<string, Json> | undefined) }).filter(([, v]) => v !== null));
    const content = { ...CONTENT, procedure: { kind: 'procedure', id: 'proc', children: [phase('p-lib', 'LIB-KILL-LIM', { ...cfg, limits: lims })] } };
    const { rows } = await c.query<{ p: string | null }>('select recipe.library_limits_problem($1::jsonb, $2::jsonb, $3::jsonb) as p', [
      JSON.stringify(content), JSON.stringify({ steps: STEPS, entries: {}, exceptions: {}, ...old }), JSON.stringify({ steps: STEPS, entries: {}, exceptions: {}, ...next }),
    ]);
    return rows[0]?.p ?? null;
  };
  const ALERT_FACTS = { severity: 'ALERT', deviationRequired: false, registrationRelevant: false, qaOnly: false, stageSignOffBlocked: false, releaseBlocking: false, title: 'x [alert tier]' };
  const alertBreach = (item: string, id = 'X1'): Json => {
    const b = breach(item, ALERT_FACTS, id) as Record<string, Json>;
    delete b['block'];
    return b;
  };

  it('[PR-08][PR-29] R3-SQL-2: test results are judged against their limits: individual readings, minimum, maximum, mean and range, and each point of a profile; the breach needs its exception', async () => {
    await inCommand(gmp, 'author', async (c) => {
      const ipc = (wt: unknown, extra: Json = {}): Json => ({ E1: entry('ipc', { wt, ...(extra as Record<string, Json>) }) });
      const req = /^stores wt \((\w+)\) = [0-9.]+ mg at step p-lib, outside its registered limit, without the LIB_LIMIT_BREACH it requires/;
      const cases: [string, Json, string[], string[]][] = [
        // slot, limit, readings outside, readings inside
        ['ind', RANGE('mg', '237.5', '262.5'), ['250', '270', '250'], ['250', '262.5', '237.5']],
        ['min', RANGE('mg', '240', null), ['239', '250'], ['240', '250']],
        ['max', RANGE('mg', null, '260'), ['250', '261'], ['260', '250']],
        ['mean', RANGE('mg', '237.5', '262.5'), ['270', '270', '250'], ['270', '250', '250']],
        ['rng', RANGE('mg', null, '10'), ['250', '261'], ['250', '260']],
      ];
      for (const [slot, spec, out, inside] of cases) {
        const config = { limits: { [slot]: spec } };
        expect(await judged(c, config, { entries: ipc(out) }), slot).toMatch(req);
        expect(await judged(c, config, { entries: ipc(out), exceptions: { X1: breach('p-lib.wt') } }), slot).toBeNull();
        expect(await judged(c, config, { entries: ipc(inside) }), slot).toBeNull();
        expect(await judged(c, config, { entries: ipc([]) }), slot).toBeNull();
      }
      // The finding: one 270 mg tablet against 237.5-262.5 mg.
      expect(await judged(c, { limits: { ind: RANGE('mg', '237.5', '262.5') } }, { entries: ipc(['250', '270', '250']) })).toMatch(/^stores wt \(individual\) = 270 mg/);
      // The relative standard deviation is the engine's judgement alone.
      expect(await judged(c, { limits: { rsd: RANGE('mg', null, '0.0001') } }, { entries: ipc(['250', '260']) })).toBeNull();
      // Two statistics breached need two exceptions.
      const two = { limits: { ind: RANGE('mg', '237.5', '262.5'), max: RANGE('mg', null, '260') } };
      expect(await judged(c, two, { entries: ipc(['250', '270']), exceptions: { X1: breach('p-lib.wt') } })).toMatch(/^stores wt \(max\) = 270 mg/);
      expect(await judged(c, two, { entries: ipc(['250', '270']), exceptions: { X1: breach('p-lib.wt'), X2: breach('p-lib.wt', {}, 'X2') } })).toBeNull();
      // A profile: each point's readings against that point's limits.
      const points = { points: { rel: [{ id: 'h1', label: '1 h', limits: RANGE('%', '20', '40') }, { id: 'h4', label: '4 h', limits: RANGE('%', '45', '65') }] } };
      const rel = (h1: string[], h4: string[]): Json => ({ E1: entry('ipc', { wt: ['250'], rel: { h1, h4 } }) });
      expect(await judged(c, points, { entries: rel(['30', '30'], ['70', '70']) })).toMatch(/^stores rel \(mean at h4\) = 70 % at step p-lib, outside its registered limit/);
      expect(await judged(c, points, { entries: rel(['10', '10'], ['50', '50']) })).toMatch(/^stores rel \(mean at h1\) = 10 %/);
      expect(await judged(c, points, { entries: rel(['30', '30'], ['70', '70']), exceptions: { X1: breach('p-lib.rel') } })).toBeNull();
      expect(await judged(c, points, { entries: rel(['30', '30'], ['50', '50']) })).toBeNull();
      expect(await judged(c, {}, { entries: rel(['0', '0'], ['0', '0']) })).toBeNull();
      // Limits in another unit, and readings the database cannot read, are refused.
      expect(await judged(c, { limits: { min: RANGE('g', '0.24', null) } }, { entries: ipc(['250']) })).toBe('stores wt at step p-lib, whose min limit is not written in the field\'s unit mg');
      expect(await judged(c, { limits: { min: RANGE('mg', '240', null) } }, { entries: ipc(['2.5e2']) })).toBe('stores wt at step p-lib with readings the database cannot read');
      expect(await judged(c, { limits: { min: RANGE('mg', '240', null) } }, { entries: ipc('250') })).toBe('stores wt at step p-lib with readings the database cannot read');
    });
  });

  it('[PR-30][PR-08] R3-SQL-3: a timer\'s duration is the time between its start and its stop on trusted time, in the timer\'s unit; another figure, another unit or a stop without its start is refused', async () => {
    await inCommand(gmp, 'author', async (c) => {
      // The finding: a 45-minute hold stored as 20 minutes, inside its 30-minute limit.
      expect(await limits(c, {}, { entries: timer('t1', '20', 45) })).toBe('stores timer t1 at step p-lib with a duration of 20 min, where its start and stop on trusted time give 45 min');
      expect(await limits(c, {}, { entries: timer('t1', '2700', 45, 's') })).toBe('stores timer t1 at step p-lib with a duration of 2700 s, where its start and stop on trusted time give 45 min');
      expect(await limits(c, {}, { entries: timer('t1', '45.0', 45) })).toMatch(/^stores timer t1 at step p-lib with a duration of 45\.0 min, where/);
      const inSeconds = { limits: { t2: RANGE('s', null, '1800') } };
      expect(await judged(c, inSeconds, { entries: timer('t2', '1200', 20, 's') })).toBeNull();
      expect(await judged(c, inSeconds, { entries: timer('t2', '20', 20) })).toMatch(/^stores timer t2 at step p-lib with a duration of 20 min, where its start and stop on trusted time give 1200 s$/);
      // A duration that is no whole number of the unit: the engine's quotient, to 34 significant digits.
      const stopAt = (us: string, value: string): Json => {
        const t = timer('t1', value, 0) as Record<string, Record<string, Json>>;
        return { ...t, E1: { ...t['E1'], recordedAt: { $u: us } } };
      };
      expect(await limits(c, {}, { entries: stopAt('35000000', '0.5833333333333333333333333333333333') })).toBeNull();
      expect(await limits(c, {}, { entries: stopAt('35000000', '0.583') })).toMatch(/give 0\.5833333333333333333333333333333333 min$/);
      // A stop without its start, or with only another timer's or another step instance's start.
      const stop = (timer('t1', '20', 20) as Record<string, Json>)['E1'];
      expect(await limits(c, {}, { entries: { E1: stop } })).toBe('stores the stop of timer t1 at step p-lib without its start');
      expect(await limits(c, {}, { entries: { E1: stop, S1: { ...(entry('TIMER_START', { field: 't2' }) as Record<string, Json>), recordedAt: { $u: '0' } }, S2: { ...(entry('TIMER_START', { field: 't1' }, 'p-smart@') as Record<string, Json>), recordedAt: { $u: '0' } } } })).toBe('stores the stop of timer t1 at step p-lib without its start');
      // A start the previous state already held counts (the stop is the new entry).
      const t = timer('t1', '20', 20) as Record<string, Json>;
      expect(await limits(c, { entries: { 'S-t1': t['S-t1'] } }, { entries: t })).toBeNull();
      // A stop recorded before its start cannot be worked out.
      expect(await limits(c, {}, { entries: { ...t, 'S-t1': { ...(t['S-t1'] as Record<string, Json>), recordedAt: { $u: '9999999999' } } } })).toBe('stores the stop of timer t1 at step p-lib, whose duration in min the database cannot work out from its start and stop');
      // The conversion of each unit the engine's durations hold.
      const dur = async (start: string, stopUs: string, unit: string): Promise<string | null> =>
        (await c.query<{ d: string | null }>('select recipe.library_timer_duration($1::bigint, $2::bigint, $3) as d', [start, stopUs, unit])).rows[0]?.d ?? null;
      expect(await Promise.all([dur('0', '1234567', 'ms'), dur('0', '1234567', 's'), dur('0', '3840000000', 'h'), dur('100', '100', 'min'), dur('0', '7', 'd'), dur('0', '100000000000', 'h')])).toEqual([
        '1234.567', '1.234567', '1.066666666666666666666666666666667', '0', '0.00000000008101851851851851851851851851851852', '27.77777777777777777777777777777778',
      ]);
      expect(await Promise.all([dur('0', '60000000', 'wk'), dur('5', '1', 'min'), dur('0', '36000000', 'h'), dur('0', '60000000', 'min')])).toEqual([null, null, '0.01', '1']);
    });
  });

  it('[DI-33][PR-08][INV-25] R3-SQL-5: a calculated field the entry shows carries the server\'s figure with its evaluation record; one its condition hides carries none', async () => {
    await inCommand(gmp, 'author', async (c) => {
      const run = (data: Json): Promise<string | null> => limits(c, {}, { entries: { E1: entry('run', { w: '0.5', ...(data as Record<string, Json>) }) } });
      const noRecord = /^stores entry E1 at step p-lib without the evaluation record of its calculated loss \(a decimal value in %, /;
      expect(await run({ calc: true, computed: { loss: LOSS('0.5') } })).toBeNull();
      // The finding: a shown calculated field with a limit and no figure was skipped.
      expect(await run({ calc: true })).toMatch(noRecord);
      expect(await run({ calc: true, computed: {} })).toMatch(noRecord);
      const bad: (Json | string)[] = [
        'x', { value: '' }, { value: 0.5 }, { value: '5e-1' }, { unit: 'g' }, { unit: undefined }, { expression: 'w * 2 [%]' }, { expression: undefined },
        { languageVersion: '' }, { languageVersion: 1 }, { languageVersion: undefined }, { inputs: [] }, { inputs: undefined },
      ];
      for (const b of bad) {
        const rec = typeof b === 'string' ? b : JSON.parse(JSON.stringify(LOSS('0.5', b))) as Json;
        expect(await run({ calc: true, computed: { loss: rec } }), JSON.stringify(b)).toMatch(noRecord);
      }
      expect(await run({ calc: true, computed: { loss: LOSS('-0.5') } })).toBeNull();
      // Hidden by its condition (the answer is not the given one, or not given): no figure, and one given is refused.
      expect(await run({})).toBeNull();
      expect(await run({ calc: false })).toBeNull();
      expect(await run({ calc: 'true' })).toBeNull();
      expect(await run({ calc: false, computed: { loss: LOSS('0.5') } })).toBe('stores a calculated loss at step p-lib, which its condition hides');
      expect(await run({ computed: { loss: LOSS('0.5') } })).toBe('stores a calculated loss at step p-lib, which its condition hides');
      // A calculated field with no condition is always shown.
      const always = { ...CONTENT, blockDefinitions: [{ ...KDEF, sections: [{ id: 'run', title: 'Run', fields: [{ id: 'loss', label: 'Loss', type: 'CALC', expression: 'w * 1 [%]', unit: '%' }] }] }, SDEF] };
      const q = async (data: Json): Promise<string | null> =>
        (await c.query<{ p: string | null }>('select recipe.library_limits_problem($1::jsonb, $2::jsonb, $3::jsonb) as p', [
          JSON.stringify(always), JSON.stringify({ steps: STEPS, entries: {}, exceptions: {} }), JSON.stringify({ steps: STEPS, entries: { E1: entry('run', data) }, exceptions: {} }),
        ])).rows[0]?.p ?? null;
      expect(await q({ computed: { loss: LOSS('0.5') } })).toBeNull();
      expect(await q({})).toMatch(noRecord);
    });
  });

  it('[INV-20][PR-08] R3-SQL-4: a library loop is decided as the engine decides it: no repeat beyond the maximum or after a pass; the last allowed repeat without a pass needs its endpoint\'s breach and LIB_REPEAT_LIMIT_REACHED with a loop\'s consequences', async () => {
    await inCommand(gmp, 'author', async (c) => {
      const rep = (seq: number, data: Json, kind = 'retry', stepKey = 'p-lib@'): Json => ({ ...(entry(kind, data, stepKey) as Record<string, Json>), recordedSeq: seq });
      /** The exhaustion the engine raises for the loop field `field` (block-version.ts, R3-ENG-1). */
      const exhausted = (field: string, extra: Json = {}, id = 'X9'): Json => ({
        id, type: 'LIB_REPEAT_LIMIT_REACHED', category: 'OUT_OF_LIMIT', title: 'the maximum of 2 repeats was reached without a passing value', controls: ['PR-08', 'INV-20'],
        severity: 'ACTION', source: { stepKey: 'p-lib@', step: 'p-lib', frames: [], item: `p-lib.${field}` }, raisedAt: { $u: '1000' }, raisedSeq: 3, raisedBy: OP,
        deviationRequired: true, registrationRelevant: false, qaOnly: true, stageSignOffBlocked: false, releaseBlocking: true, status: 'OPEN',
        block: { steps: [], until: 'DISPOSITION', downstream: { node: 'task:p-lib', frames: [] } }, ...extra,
      });
      const two = { counts: { maxR: '2', maxC: '1', maxG: '1' }, limits: { g: RANGE('%', null, '10') } };
      const first = { E1: rep(1, { r: '50' }) };
      const second = (r: string): Json => ({ ...first, E2: rep(2, { r }) });
      // A failing value before the last allowed repeat is a repeat: nothing judged, nothing raised.
      expect(await judged(c, two, { entries: first })).toBeNull();
      // The finding: the last allowed repeat fails, and the row raises neither the exhaustion nor the endpoint's breach.
      expect(await judged(c, two, { entries: second('50') }, { entries: first })).toBe('stores the last allowed repeat (2) of section retry at step p-lib, which did not pass, without the LIB_REPEAT_LIMIT_REACHED it requires (severity ACTION, deviation required)');
      expect(await judged(c, two, { entries: second('50'), exceptions: { X9: exhausted('r') } }, { entries: first })).toMatch(/^stores r = 50 g at step p-lib, outside its registered limit, without the LIB_LIMIT_BREACH/);
      const both = { X1: breach('p-lib.r'), X9: exhausted('r') };
      expect(await judged(c, two, { entries: second('50'), exceptions: both }, { entries: first })).toBeNull();
      for (const over of [{ qaOnly: false }, { releaseBlocking: false }, { deviationRequired: false }, { severity: 'ALERT' }, { controls: ['PR-08'] },
        { block: { steps: [], until: 'DEVIATION', downstream: { node: 'task:p-lib', frames: [] } } }, { block: { steps: ['p-lib@'], until: 'DISPOSITION', downstream: { node: 'task:p-lib', frames: [] } } },
        { source: { stepKey: 'p-lib@', step: 'p-lib', frames: [], item: 'p-lib.w' } }, { raisedBy: 'OP-2' }]) {
        expect(await judged(c, two, { entries: second('50'), exceptions: { X1: breach('p-lib.r'), X9: exhausted('r', over) } }, { entries: first }), JSON.stringify(over)).toMatch(/without the LIB_REPEAT_LIMIT_REACHED it requires/);
      }
      // A pass on the last allowed repeat raises nothing; an exhaustion added for it is refused.
      expect(await judged(c, two, { entries: second('5') }, { entries: first })).toBeNull();
      expect(await judged(c, two, { entries: second('5'), exceptions: { X9: exhausted('r') } }, { entries: first })).toBe('adds exception X9 (LIB_REPEAT_LIMIT_REACHED, severity ACTION, item p-lib.r), which no value of the row requires with these facts');
      // No repeat beyond the maximum, and none after a pass.
      expect(await judged(c, two, { entries: { ...(second('50') as Record<string, Json>), E3: rep(3, { r: '5' }) } }, { entries: second('50') })).toBe('stores repeat 3 of section retry at step p-lib, beyond its maximum of 2');
      expect(await judged(c, two, { entries: { E1: rep(1, { r: '5' }), E2: rep(2, { r: '5' }) } }, { entries: { E1: rep(1, { r: '5' }) } })).toBe('stores a repeat of section retry at step p-lib after it passed');
      expect(await judged(c, two, { entries: { E1: rep(1, {}), E2: rep(2, { r: '5' }) } }, { entries: { E1: rep(1, {}) } })).toBeNull();
      // Only earlier entries of this section in this step instance count.
      expect(await judged(c, two, { entries: { E0: rep(1, { r: '50' }, 'confirm'), E1: rep(1, { r: '50' }, 'retry', 'p-plain@'), E2: rep(2, { r: '50' }), E5: rep(5, { r: '50' }) } }, { entries: { E0: rep(1, { r: '50' }, 'confirm'), E1: rep(1, { r: '50' }, 'retry', 'p-plain@'), E5: rep(5, { r: '50' }) } })).toBeNull();
      // Without a maximum the loop is never exhausted; a loop field without a limit passes.
      expect(await judged(c, { limits: {} }, { entries: second('50') }, { entries: first })).toBeNull();
      const noLimit = { counts: { maxR: '2' }, limits: { r: null } };
      expect(await judged(c, noLimit, { entries: second('5') }, { entries: { E1: rep(1, { r: '5' }) } })).toBe('stores a repeat of section retry at step p-lib after it passed');
      // A loop field the database cannot read against its limit is refused.
      expect(await judged(c, { ...two, limits: { r: RANGE('kg', null, '1') } }, { entries: first })).toBe('stores section retry at step p-lib, whose loop field r the database cannot read against its limit');
      expect(await judged(c, two, { entries: { E1: rep(1, { r: 50 }) } })).toBe('stores section retry at step p-lib, whose loop field r the database cannot read against its limit');
      expect(await judged(c, two, { entries: { E1: rep(1, { r: 50 }), E2: rep(2, { r: '5' }) } }, { entries: { E1: rep(1, { r: 50 }) } })).toBe('stores section retry at step p-lib, whose loop field r the database cannot read against its limit');
      // A yes/no loop: the expected answer passes; another answer, or none, on the last allowed repeat exhausts it (no tier).
      const conf = (data: Json): Json => ({ E1: rep(1, data, 'confirm') });
      expect(await judged(c, two, { entries: conf({ ok: true }) })).toBeNull();
      expect(await judged(c, two, { entries: conf({ ok: false }) })).toMatch(/^stores the last allowed repeat \(1\) of section confirm at step p-lib, which did not pass, without/);
      expect(await judged(c, two, { entries: conf({ ok: false }), exceptions: { X9: exhausted('ok') } })).toBeNull();
      expect(await judged(c, two, { entries: conf({}), exceptions: { X9: exhausted('ok') } })).toBeNull();
      // A calculated loop field: its figure decides, and at exhaustion it is judged against its tier.
      const g = (value: string): Json => ({ E1: rep(1, { x: value, computed: { g: { value, unit: '%', expression: 'x * 1 [%]', languageVersion: '1.0', inputs: {} } } }, 'calcLoop') });
      expect(await judged(c, two, { entries: g('5') })).toBeNull();
      expect(await judged(c, two, { entries: g('50'), exceptions: { X9: exhausted('g') } })).toMatch(/^stores g = 50 % at step p-lib, outside its registered limit, without the LIB_LIMIT_BREACH/);
      expect(await judged(c, two, { entries: g('50'), exceptions: { X9: exhausted('g'), X1: breach('p-lib.g') } })).toBeNull();
      // The trigger runs for a row that adds only an exhaustion.
      const t = await batchState(c, { steps: STEPS, entries: {}, exceptions: {} }, 'zzg_library_limits');
      expect(await t.update({ steps: STEPS, entries: {}, exceptions: { X9: exhausted('r') } })).toMatch(/^This row adds exception X9 \(LIB_REPEAT_LIMIT_REACHED.*\[EBMR-LIB-020\]$/);
    });
  });

  it('[PR-08][PR-30] R3: the database\'s library judgement at its edges (SQL mutation run of recipe-core 1862)', async () => {
    await inCommand(gmp, 'author', async (c) => {
      // Loops: an entry of the same row (same recordedSeq) is not an earlier repeat.
      const rep = (seq: number, r: string): Json => ({ ...(entry('retry', { r }) as Record<string, Json>), recordedSeq: seq });
      expect(await judged(c, { counts: { maxR: '2' } }, { entries: { E1: rep(1, '50'), E2: rep(1, '50') } }, { entries: { E1: rep(1, '50') } })).toBeNull();
      // A pass is decided as passes() does: a field with neither limits nor an expected answer passes, as does a slot
      // given to a field that has no unit (a text).
      const pass = async (field: Json, data: Json, config: Json = {}): Promise<boolean | null> =>
        (await c.query<{ p: boolean | null }>('select recipe.library_loop_pass($1::jsonb, $2::jsonb, $3::jsonb) as p', [
          JSON.stringify({ id: 's', repeat: { kind: 'UNTIL_PASS', untilField: 'f' }, fields: [{ id: 'f', label: 'F', ...(field as Record<string, Json>) }] }), JSON.stringify(data), JSON.stringify(config),
        ])).rows[0]?.p ?? null;
      expect(await pass({ type: 'TEXT' }, { f: 'anything' })).toBe(true);
      expect(await pass({ type: 'TEXT', limitSlot: 'f' }, { f: 'anything' }, { limits: { f: RANGE('g', null, '1') } })).toBe(true);
      expect(await pass({ type: 'NUMBER', unit: 'g' }, { f: '99' }, { limits: { f: RANGE('g', null, '1') } })).toBe(true);
      expect(await pass({ type: 'NUMBER', unit: 'g', limitSlot: 'f' }, { f: '99' }, { limits: { f: RANGE('g', null, '1') } })).toBe(false);
      // An optional profile left empty is not read.
      const points = { points: { rel: [{ id: 'h1', label: '1 h', limits: RANGE('%', '20', '40') }] } };
      expect(await judged(c, points, { entries: { E1: entry('ipc', { wt: ['250'] }) } })).toBeNull();
      // Of two readings at the most severe tier, the first is named.
      expect(await judged(c, { limits: { ind: RANGE('mg', '237.5', '262.5') } }, { entries: { E1: entry('ipc', { wt: ['250', '270', '280'] }) } })).toMatch(/^stores wt \(individual\) = 270 mg/);
      // The engine's RSD breach is admitted with the facts of one of the limit's tiers, once; not with other facts, not twice,
      // and not without an RSD limit.
      const rsd = { limits: { rsd: RANGE('mg', null, '0.0001') } };
      const W2 = { E1: entry('ipc', { wt: ['250', '260'] }) };
      expect(await judged(c, rsd, { entries: W2, exceptions: { X1: breach('p-lib.wt') } })).toBeNull();
      expect(await judged(c, rsd, { entries: W2, exceptions: { X1: breach('p-lib.wt'), X2: breach('p-lib.wt', {}, 'X2') } })).toMatch(/^adds exception X2 /);
      expect(await judged(c, rsd, { entries: W2, exceptions: { X1: alertBreach('p-lib.wt') } })).toMatch(/^adds exception X1 /);
      expect(await judged(c, {}, { entries: W2, exceptions: { X1: breach('p-lib.wt') } })).toMatch(/^adds exception X1 /);
      const rsdAction = { limits: { rsd: { ...RANGE('mg', null, '0.0001', 'INTERNAL_ACTION'), actionBreach: 'CONTINUE_CURRENT_STEP_WITH_DEVIATION' } } };
      const actionFacts = { severity: 'ACTION', registrationRelevant: false, qaOnly: false, stageSignOffBlocked: false, releaseBlocking: false, title: 'x [internal action tier]' };
      expect(await judged(c, rsdAction, { entries: W2, exceptions: { X1: breach('p-lib.wt', { ...actionFacts, block: { steps: [], until: 'DEVIATION', downstream: { node: 'task:p-lib', frames: [] } } }) } })).toBeNull();
      expect(await judged(c, rsdAction, { entries: W2, exceptions: { X1: breach('p-lib.wt', actionFacts) } })).toMatch(/^adds exception X1 /);
      // Without the formulation's leave to continue, an internal action breach also holds the step.
      const rsdStop = { limits: { rsd: RANGE('mg', null, '0.0001', 'INTERNAL_ACTION') } };
      expect(await judged(c, rsdStop, { entries: W2, exceptions: { X1: breach('p-lib.wt', actionFacts) } })).toBeNull();
      // A zero duration in a unit the engine's durations do not hold is not worked out either.
      expect((await c.query<{ d: string | null }>("select recipe.library_timer_duration(5, 5, 'wk') as d")).rows[0]?.d).toBeNull();
      // The trigger also runs for a library exception added after a state that had no exceptions member.
      const t = await batchState(c, { steps: STEPS, entries: {} }, 'zzg_library_limits');
      expect(await t.update({ steps: STEPS, entries: {}, exceptions: { X1: breach('p-lib.w') } })).toMatch(/^This row adds exception X1 .*\[EBMR-LIB-020\]$/);
    });
  });

  it('[PR-08][PR-29] R3-SQL-2: of individual readings the most severe tier any reading breaches requires the exception, as the engine raises it (R3-ENG-2)', async () => {
    await inCommand(gmp, 'author', async (c) => {
      const tiers = { limits: { ind: { unit: 'mg', ranges: [...(RANGE('mg', '90', '110') as { ranges: Json[] }).ranges, ...(RANGE('mg', '95', '105', 'ALERT') as { ranges: Json[] }).ranges] } } };
      const E = { E1: entry('ipc', { wt: ['104', '106', '150'] }) };
      expect(await judged(c, tiers, { entries: E, exceptions: { X1: alertBreach('p-lib.wt') } })).toMatch(/^stores wt \(individual\) = 150 mg at step p-lib, outside its registered limit, without the LIB_LIMIT_BREACH it requires \(severity CRITICAL/);
      expect(await judged(c, tiers, { entries: E, exceptions: { X1: breach('p-lib.wt') } })).toBeNull();
      expect(await judged(c, tiers, { entries: { E1: entry('ipc', { wt: ['100', '106', '107'] }) }, exceptions: { X1: alertBreach('p-lib.wt') } })).toBeNull();
    });
  });
  const missing = /^stores w = 50 g at step p-lib, outside its registered limit, without the LIB_LIMIT_BREACH it requires \(severity CRITICAL, deviation required\)$/;

  it('[PR-08][PR-49] R3-SQL-1: a LIB_LIMIT_BREACH carries the facts of the tier breached; one stored as an alert needing no deviation, or with any other fact changed, is refused', async () => {
    await inCommand(gmp, 'author', async (c) => {
      expect(await limits(c, {}, { entries: W, exceptions: { X1: breach('p-lib.w') } })).toBeNull();
      // The finding: a registered breach recorded as an alert that needs no deviation (QA could then record NO_IMPACT).
      expect(await limits(c, {}, { entries: W, exceptions: { X1: breach('p-lib.w', { severity: 'ALERT', deviationRequired: false }) } })).toMatch(missing);
      const changed: Json[] = [
        { severity: 'ACTION' }, { deviationRequired: false }, { qaOnly: false }, { registrationRelevant: false }, { stageSignOffBlocked: false },
        { releaseBlocking: false }, { category: 'TIME_LIMIT' }, { controls: [] }, { status: 'DISPOSITIONED' }, { raisedBy: 'OP-2' },
        { block: { steps: [], until: 'DEVIATION', downstream: { node: 'task:p-lib', frames: [] } } }, { block: { steps: ['p-lib@'], until: 'DISPOSITION', downstream: { node: 'task:p-lib', frames: [] } } },
        { source: { stepKey: 'p-lib@', step: 'p-lib', frames: [{ construct: 'L', index: 1 }], item: 'p-lib.w' } },
        { title: 'w is outside its limit [alert tier]' }, { title: 'w is outside its limit' }, { id: 'X9' },
      ];
      for (const over of changed) expect(await limits(c, {}, { entries: W, exceptions: { X1: breach('p-lib.w', over) } }), JSON.stringify(over)).toMatch(missing);
      // The title's wording beyond its tier mark is the engine's and is not compared; the time of raising is not either.
      expect(await limits(c, {}, { entries: W, exceptions: { X1: breach('p-lib.w', { title: 'other words [registered tier]', raisedAt: { $u: '7' }, raisedSeq: 9 }) } })).toBeNull();
    });
  });

  it('[PR-08][PR-49] R3-SQL-1: an internal action or alert tier gives its own facts; a LIB_LIMIT_BREACH that no value of the row breaches is refused, also on a row that adds no entry (EBMR-LIB-020)', async () => {
    await inCommand(gmp, 'author', async (c) => {
      const tiers = (actionBreach?: string): Json => ({
        unit: 'g',
        ...(actionBreach ? { actionBreach } : {}),
        ranges: [
          { tier: 'INTERNAL_ACTION', high: { value: '10', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'INTERNAL', ref: 'R' } },
          { tier: 'ALERT', high: { value: '8', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'INTERNAL', ref: 'R' } },
        ],
      });
      const run = async (spec: Json, w: string, x: Json): Promise<string | null> => {
        const content = { ...CONTENT, procedure: { kind: 'procedure', id: 'proc', children: [phase('p-lib', 'LIB-KILL-LIM', { limits: { ...LIMITS, w: spec } })] } };
        const { rows } = await c.query<{ p: string | null }>('select recipe.library_limits_problem($1::jsonb, $2::jsonb, $3::jsonb) as p', [
          JSON.stringify(content), JSON.stringify({ steps: STEPS, entries: {}, exceptions: {} }), JSON.stringify({ steps: STEPS, entries: { E1: entry('run', { w }) }, exceptions: { X1: x } }),
        ]);
        return rows[0]?.p ?? null;
      };
      const action = { severity: 'ACTION', registrationRelevant: false, qaOnly: false, stageSignOffBlocked: false, releaseBlocking: false, title: 'w [internal action tier]' };
      expect(await run(tiers(), '11', breach('p-lib.w', action))).toBeNull();
      expect(await run(tiers('CONTINUE_CURRENT_STEP_WITH_DEVIATION'), '11', breach('p-lib.w', { ...action, block: { steps: [], until: 'DEVIATION', downstream: { node: 'task:p-lib', frames: [] } } }))).toBeNull();
      expect(await run(tiers(), '11', breach('p-lib.w', { ...action, title: 'w [registered tier]' }))).toMatch(/without the LIB_LIMIT_BREACH it requires \(severity ACTION, deviation required\)$/);
      const alert = { severity: 'ALERT', deviationRequired: false, registrationRelevant: false, qaOnly: false, stageSignOffBlocked: false, releaseBlocking: false, title: 'w [alert tier]' };
      const noBlock = breach('p-lib.w', alert) as Record<string, Json>;
      delete noBlock['block'];
      expect(await run(tiers(), '9', noBlock)).toBeNull();
      expect(await run(tiers(), '9', breach('p-lib.w', alert))).toMatch(/without the LIB_LIMIT_BREACH it requires \(severity ALERT, deviation not required\)$/);
      // No value of the row is outside its limit: the exception is not one it requires.
      expect(await limits(c, {}, { entries: { E1: entry('run', { w: '5' }) }, exceptions: { X1: breach('p-lib.w') } })).toBe('adds exception X1 (LIB_LIMIT_BREACH, severity CRITICAL, item p-lib.w), which no value of the row requires with these facts');
      expect(await limits(c, {}, { exceptions: { X1: breach('p-lib.w') } })).toMatch(/^adds exception X1 /);
      // Another type of exception is not a library limit exception (since 1927 an answer exception is judged too: no
      // unexpected answer of the row requires this one).
      expect(await limits(c, {}, { exceptions: { X1: breach('p-lib.w', { type: 'LATE_ENTRY' }) } })).toBeNull();
      expect(await limits(c, {}, { exceptions: { X1: breach('p-lib.w', { type: 'LIB_UNEXPECTED_ANSWER' }) } })).toMatch(/^adds exception X1 \(LIB_UNEXPECTED_ANSWER/);
      const t = await batchState(c, { steps: STEPS, entries: W, exceptions: { X1: breach('p-lib.w') } }, 'zzg_library_limits');
      expect(await t.update({ steps: STEPS, entries: W, exceptions: { X1: breach('p-lib.w'), X2: breach('p-lib.w', {}, 'X2') } })).toMatch(/^This row adds exception X2 .*\[EBMR-LIB-020\]$/);
      expect(await t.update({ steps: STEPS, entries: W, exceptions: { X1: breach('p-lib.w'), X2: breach('p-lib.w', { type: 'LATE_ENTRY' }, 'X2') } })).toBe('');
    });
  });
});

describe('the database\'s schema of a library entry (recipe-core 1810, 1840)', () => {
  it('[INV-25][PR-03] each field type has its own schema, optional; a TEXT pattern and CHOICE options are kept; a per-point test result is a record', async () => {
    await inCommand(gmp, 'author', async (c) => {
      const schema = async (f: Json): Promise<unknown> => (await c.query<{ s: unknown }>('select recipe.library_field_schema($1::jsonb) as s', [JSON.stringify(f)])).rows[0]?.s ?? null;
      expect(await schema({ type: 'TEXT', pattern: 'A[0-9]' })).toEqual({ type: 'string', optional: true, pattern: '^(?:A[0-9])$' });
      expect(await schema({ type: 'TEXT' })).toEqual({ type: 'string', optional: true });
      expect(await schema({ type: 'CHOICE', options: ['PASS', 'FAIL'] })).toEqual({ type: 'string', optional: true, enum: ['PASS', 'FAIL'] });
      expect(await schema({ type: 'TEST_RESULT', perPoint: true })).toEqual({ type: 'record', optional: true, values: { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'decimal' } } });
      expect(await schema({ type: 'TEST_RESULT', perPoint: false })).toEqual({ type: 'array', optional: true, minItems: 1, maxItems: 1000, items: { type: 'decimal' } });
      expect(await schema({ type: 'TEST_RESULT' })).toEqual({ type: 'array', optional: true, minItems: 1, maxItems: 1000, items: { type: 'decimal' } });
      expect(await schema({ type: 'TIMER' })).toBeNull();
    });
  });

  it('[INV-25][PR-03] a timer entry names one of the block\'s timers, and only a block with timers takes one; the lot and equipment facts belong to a section with such a field only', async () => {
    await inCommand(gmp, 'author', async (c) => {
      const entrySchema = async (type: string, kind: string): Promise<Json | null> =>
        (await c.query<{ s: Json | null }>('select recipe.library_entry_schema($1::jsonb, $2::jsonb, $3) as s', [JSON.stringify(CONTENT), JSON.stringify({ type, version: '1' }), kind])).rows[0]?.s ?? null;
      expect(await entrySchema('LIB-KILL-LIM', 'TIMER_STOP')).toEqual({ type: 'object', fields: { field: { type: 'string', enum: ['t1', 't2'] } } });
      expect(await entrySchema('LIB-KILL-SMART', 'TIMER_START')).toBeNull();
      expect(Object.keys((await entrySchema('LIB-KILL-LIM', 'run'))?.['fields'] as Json).sort()).toEqual(['calc', 'flag', 'nolim', 'note', 'w']);
      const only = async (fields: Json[]): Promise<string[]> => {
        const content = { ...CONTENT, blockDefinitions: [{ ...SDEF, sections: [{ id: 'one', title: 'One', fields }] }] };
        const s = (await c.query<{ s: Json | null }>('select recipe.library_entry_schema($1::jsonb, $2::jsonb, $3) as s', [JSON.stringify(content), JSON.stringify({ type: 'LIB-KILL-SMART', version: '1' }), 'one'])).rows[0]?.s;
        return Object.keys(s?.['fields'] ?? {}).sort();
      };
      expect(await only([{ id: 'n', type: 'NUMBER', unit: 'g' }])).toEqual(['n']);
      expect(await only([{ id: 'lot', type: 'MATERIAL_LOT' }])).toEqual(['lot', 'lots']);
      expect(await only([{ id: 'bal', type: 'EQUIPMENT', kind: 'BALANCE' }])).toEqual(['bal', 'equipment']);
    });
  });
});

describe('smart fields of library entries (tablets 1803)', () => {
  const smartState = (data: Json, verificationRequired = false): Json => ({
    lastRecordedUs: '1793500000000000',
    header: { marketSet: ['IN'] },
    entries: { E1: entry('weigh', data, 'p-smart@') },
    steps: { ...STEPS, 'p-smart@': { step: 'p-smart', verificationRequired } },
  });

  async function smart(c: PoolClient, old: Json, next: Json, content: Json = CONTENT): Promise<string | null> {
    const { rows } = await c.query<{ p: string | null }>('select tab.library_smart_problem(null, $1::jsonb, $2::jsonb, $3::jsonb) as p', [JSON.stringify(content), JSON.stringify(old), JSON.stringify(next)]);
    return rows[0]?.p ?? null;
  }

  it('[DI-30][PR-14] the trigger itself refuses a row adding a hand-keyed library weighing without two-person verification (EBMR-TAB-480), also after a state without entries; a row adding no entry is not checked', async () => {
    await inCommand(gmp, 'author', async (c) => {
      const t = await batchState(c, { steps: STEPS, entries: {} }, 'zzh_tab_library_smart_fields');
      expect(await t.update(smartState({ net: '10.0' }))).toMatch(/^This row stores the hand-keyed weighing E1 at step p-smart without two-person verification: .*\[EBMR-TAB-480\]$/);
      expect(await t.update(smartState({ net: '10.0' }, true))).toBe('');
      expect(await t.update({ ...smartState({ net: '10.0' }), note: 'later' })).toBe('');
      const s = await batchState(c, { steps: STEPS }, 'zzh_tab_library_smart_fields');
      expect(await s.update(smartState({ net: '10.0' }))).toMatch(/\[EBMR-TAB-480\]$/);
      // An entry the previous state already held is not checked again.
      expect(await smart(c, smartState({ net: '10.0' }), { ...smartState({ net: '10.0' }), note: 'later' })).toBeNull();
    });
  });

  it('[PR-18][IN-23] a lot the register holds, with its facts, that is not usable is refused', async () => {
    await inCommand(gmp, 'author', async (c) => {
      const code = `LK-${tag()}`;
      await replica(c, () =>
        c.query(
          `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at, received_by_person,
                                          received_by_account, correlation_id)
           values (gen_random_uuid(), $1, $2, 'MAT-A', 'Material A', 'EXCIPIENT', 100000, 'g', clock_timestamp() + interval '1 year', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
          [gmp.seed.siteCode, code],
        ),
      );
      const facts = (
        await c.query<{ f: Json }>(
          `select jsonb_strip_nulls(jsonb_build_object('id', f -> 'lotCode', 'material', f -> 'materialCode', 'status', f -> 'status', 'expiresAtUs', f -> 'expiresAtUs',
                                                       'retestAtUs', f -> 'retestAtUs', 'identityTested', f -> 'identityTested')) as f from tab.lot_facts($1, null) f`,
          [code],
        )
      ).rows[0]?.f;
      expect(facts?.['status']).not.toBe('RELEASED');
      const p = await smart(c, { steps: STEPS, entries: {} }, smartState({ lot: code, lots: { lot: facts } }));
      expect(p).toMatch(new RegExp(`^stores entry E1 with lot ${code} is `));
    });
  });

  it('[PR-23][IN-25] equipment of another class than the formulation requires is refused; with no class required the class is not compared', async () => {
    await inCommand(gmp, 'author', async (c) => {
      const code = `BAL-K-${tag()}`;
      await replica(c, async () => {
        await c.query(
          "insert into plant.equipment_class (code, kind, description, calibration_required, check_regime, recorded_by) values ($1, 'INSTRUMENT', 'Balance (kill test)', true, 'DAILY', gen_random_uuid())",
          [`CL-${code}`],
        );
        await c.query("insert into plant.equipment (code, name, class_code, kind, recorded_by) values ($1, 'Balance', $2, 'INSTRUMENT', gen_random_uuid())", [code, `CL-${code}`]);
      });
      const fit = (await c.query<{ f: string }>('select plant.equipment_fitness(id) as f from plant.equipment where code = $1', [code])).rows[0]?.f ?? '';
      const data = { bal: code, equipment: { bal: { code, classCode: `CL-${code}`, fitness: fit } } };
      expect(await smart(c, { steps: STEPS, entries: {} }, smartState(data), contentWith('CL-K'))).toMatch(new RegExp(`^stores entry E1 naming ${code} of class CL-${code}, where the formulation requires CL-K$`));
      const free = await smart(c, { steps: STEPS, entries: {} }, smartState(data), contentWith(null));
      expect(free ?? '').not.toMatch(/the formulation requires/);
      if (fit === 'QUALIFIED' || fit === 'CALIBRATION_DUE_SOON') expect(free).toBeNull();
      else expect(free).toMatch(/^stores entry E1 naming .*, which is /);
    });
  });
});

describe('the snapshots against the library (recipe-core 1810)', () => {
  it('[PR-05] a snapshot of a version the library does not hold is refused as such, next to a version of the same code it does hold', async () => {
    await inCommand(gmp, 'author', async (c) => {
      const code = `KV-${tag()}`;
      await block(c, defOf(code));
      const snap = async (d: Json): Promise<string | null> =>
        (await c.query<{ p: string | null }>('select recipe.library_snapshot_problem($1::jsonb, false) as p', [JSON.stringify({ blockDefinitions: [d] })])).rows[0]?.p ?? null;
      expect(await snap(defOf(code, 2))).toBe(`${code}@2 is not in the library`);
      expect(await snap(defOf(code))).toBe(`${code}@1 is not approved`);
    });
  });

  it('[PR-05][DI-35] at issue, a snapshot of a library version that is not approved is refused (EBMR-LIB-022); an approved or a retired version is not', async () => {
    await inCommand(gmp, 'approver', async (c) => {
      const code = `KI-${tag()}`;
      const d = defOf(code);
      const id = await block(c, d);
      await c.query('alter table recipe.control_recipe enable always trigger a4_library_at_issue');
      const issue = async (): Promise<string> =>
        replica(c, async () => {
          const o = await attempt(
            c,
            `insert into recipe.control_recipe (batch_id, pin_id, version_id, mbr_content_hash, snapshot, snapshot_hash, person_id, account_id)
             values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), repeat('a', 64), $1::jsonb, repeat('b', 64), gen_random_uuid(), gen_random_uuid())`,
            [JSON.stringify({ mbr: { content: { blockDefinitions: [d] } } })],
          );
          return o.ok ? '' : o.message;
        });
      expect(await issue()).toMatch(new RegExp(`^EBMR-LIB-022 this batch cannot be issued: ${code}@1 is not approved`));
      await replica(c, () =>
        c.query('insert into recipe.library_block_approval (block_id, signature_id, approved_by_person, approved_by_account) values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())', [id]),
      );
      expect(await issue()).toBe('');
      await replica(c, () =>
        c.query(
          "insert into recipe.library_block_retirement (block_id, reason, retired_by_person, retired_by_account, correlation_id) values ($1, 'Replaced', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())",
          [id],
        ),
      );
      expect(await issue()).toBe('');
    });
  });

  it('[PR-05][DI-35] on the real approval path, a master using a retired library version passes its earlier steps and is refused at QA approval (EBMR-LIB-021)', async () => {
    const approved = await routeApprovedBlock();
    const approver = await gmp.asPersona('approver');
    valueOf(await approver.call(routes.library.retire, { body: { blockId: approved.id, reason: 'Replaced by a revised form' } }));
    const def = approved.definition;
    const hash = library.definitionHash(def as unknown as library.BlockDefinition);
    const content = gmpContent((m) => {
      const stage = ((((m['procedure'] as Json)['body'] as Json)['children'] as Json[])[0] as Json)['body'] as Json;
      const prep = ((stage['children'] as Json[])[0] as Json)['body'] as Json;
      const lib: Json = {
        kind: 'phase', id: 'p-lib', name: 'Kill (library)', block: { type: `LIB-${String(def['code'])}`, version: '1' }, config: { hash },
        records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [], signatures: { perform: { role: 'PRODUCTION_OPERATOR' } }, significant: false, riskClass: 'HIGH',
      };
      prep['children'] = [lib, ...(prep['children'] as Json[])];
      m['blockDefinitions'] = [def];
    });
    const world = await gmpLifecycleWorld(gmp);
    const v = await world.newVersion(content);
    await world.prepare(v.versionId, content);
    await world.startVerification(v.versionId);
    await world.submit(v.versionId);
    await world.check(v.versionId);
    await expect(world.approve(v.versionId)).rejects.toThrow(new RegExp(`EBMR-LIB-021 this master cannot be approved: ${String(def['code'])}@1 is retired`));
    expect((await world.state(v.versionId)).state).toBe('CHECKED');
  });
});

describe('expected answers and allowed choices in the database (recipe-core 1927)', () => {
  /** An answer exception of the KILL-LIM step as the engine records it (tx.ts raise of an ACTION draft blocking the step). */
  const answer = (type: string, item: string, id = 'X1'): Json => ({
    id, type, category: 'OUT_OF_LIMIT', title: `Limits, Confirm: ${item}`, controls: ['PR-29'], severity: 'ACTION',
    source: { stepKey: 'p-lib@', step: 'p-lib', frames: [], item }, raisedAt: { $u: '1000' }, raisedSeq: 2, raisedBy: OP, deviationRequired: true,
    registrationRelevant: false, qaOnly: false, stageSignOffBlocked: false, releaseBlocking: false, status: 'OPEN', block: { steps: ['p-lib@'], until: 'DEVIATION' },
  });

  it('[PR-29] the trigger itself refuses a row that adds only a LIB_UNEXPECTED_ANSWER or a LIB_NOT_ALLOWED_CHOICE that no answer requires (EBMR-LIB-020); one of another type is not checked', async () => {
    await inCommand(gmp, 'author', async (c) => {
      const t = await batchState(c, { steps: STEPS, entries: {}, exceptions: {} }, 'zzg_library_limits');
      for (const type of ['LIB_UNEXPECTED_ANSWER', 'LIB_NOT_ALLOWED_CHOICE']) {
        expect(await t.update({ steps: STEPS, entries: {}, exceptions: { X1: answer(type, 'p-lib.ok') } }), type).toMatch(new RegExp(`^This row adds exception X1 \\(${type}, severity ACTION, item p-lib\\.ok\\), which no value of the row requires with these facts: .*\\[EBMR-LIB-020\\]$`));
      }
      // A row adding an exception of another type only is not checked.
      expect(await t.update({ steps: STEPS, entries: {}, exceptions: { X1: { ...answer('LIB_UNEXPECTED_ANSWER', 'p-lib.ok'), type: 'LATE_ENTRY' } } })).toBe('');
    });
  });
});
