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
        { id: 'loss', label: 'Loss', type: 'CALC', expression: 'w * 1 [%]', unit: '%', limitSlot: 'loss' },
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
    { id: 'retry', title: 'Retry', repeat: { kind: 'UNTIL_PASS', untilField: 'r' }, fields: [{ id: 'r', label: 'R', type: 'NUMBER', unit: 'g', limitSlot: 'r' }] },
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
const timer = (field: string, value?: string): Json => entry('TIMER_STOP', { field, ...(value === undefined ? {} : { duration: { value, unit: 'min' } }) });

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
      expect(await limits(c, {}, { entries: { E1: timer('t2', '20') } })).toMatch(/^stores the stop of timer t2 at step p-lib without a duration the database can read/);
      expect(await limits(c, {}, { entries: { E1: timer('t1') } })).toMatch(/^stores the stop of timer t1 at step p-lib without a duration the database can read/);
      expect(await limits(c, {}, { entries: { E1: timer('t1', 'soon') } })).toMatch(/^stores the duration soon of timer t1 at step p-lib, which the database cannot read/);
      expect(await limits(c, {}, { entries: { E1: timer('t1', '20') } })).toBeNull();
      expect(await limits(c, {}, { entries: { E1: timer('t1', '45') } })).toMatch(/^stores timer t1 at step p-lib with 45 min, outside its \w+ limit, without the LIB_LIMIT_BREACH/);
    });
  });

  it('[PR-08] only a new LIB_LIMIT_BREACH of this step and this item admits a timer outside its limit', async () => {
    await inCommand(gmp, 'author', async (c) => {
      const E = { E1: timer('t1', '45') };
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
      expect(await limits(c, {}, { entries: { E1: entry('run', { computed: { loss: { value: '1.5', unit: '%' } } }) } })).toMatch(/^stores loss = 1\.5 % at step p-lib/);
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
      // Another type of exception is not a library limit exception.
      expect(await limits(c, {}, { exceptions: { X1: breach('p-lib.w', { type: 'LIB_UNEXPECTED_ANSWER' }) } })).toBeNull();
      const t = await batchState(c, { steps: STEPS, entries: W, exceptions: { X1: breach('p-lib.w') } }, 'zzg_library_limits');
      expect(await t.update({ steps: STEPS, entries: W, exceptions: { X1: breach('p-lib.w'), X2: breach('p-lib.w', {}, 'X2') } })).toMatch(/^This row adds exception X2 .*\[EBMR-LIB-020\]$/);
      expect(await t.update({ steps: STEPS, entries: W, exceptions: { X1: breach('p-lib.w'), X2: breach('p-lib.w', { type: 'LIB_UNEXPECTED_ANSWER' }, 'X2') } })).toBe('');
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
      expect(Object.keys((await entrySchema('LIB-KILL-LIM', 'run'))?.['fields'] as Json).sort()).toEqual(['flag', 'nolim', 'note', 'w']);
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

  it('[PR-19][IN-11] equipment of another class than the formulation requires is refused; with no class required the class is not compared', async () => {
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
