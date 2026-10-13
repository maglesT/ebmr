/**
 * G-24@2 in the database alone (SQL mutation group "reprocessing", recipe-core 0622, 0625, recipe.g24v2_check; Phase 4
 * slice 7c, the "not twins" of the Phase 3 exit run). The row trigger holds whatever wrote the state: in a batch whose
 * MBR has a G-24@2 step, the start of that step (other than a validated re-treatment) takes one unused signed STEP
 * authorisation of this batch, step and case, signed by someone other than the starter; the step takes no start data;
 * an ADDITION entry stores exactly what its block writes from the row's command and needs the step's second-person
 * check before the database's own addition rules. A batch without a G-24@2 step is not this trigger's.
 *
 * Each case writes the row the state names and the state itself directly, in a transaction that is always rolled back,
 * with only this trigger enabled on recipe.execution_state.
 *
 * Controls: PR-47, IN-19, INV-33 (reprocessing only under the quality unit's prior authorisation), PR-14.
 */
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from '../support/harness.ts';
import { attempt, batchWith, inCommand, replica, type Json } from './kill-support.ts';

let gmp: TestServer;
beforeAll(async () => {
  gmp = await startServer('GMP');
}, 180_000);
afterAll(async () => {
  await gmp?.close();
});

const node = (id: string, version: string, kase: string | null): Json => ({ kind: 'phase', id, block: { type: 'G-24', version }, ...(kase ? { reprocessing: { case: kase } } : {}) });
const CONTENT = {
  procedure: { kind: 'procedure', id: 'proc', children: [node('p-g24', '2', 'RECOVERY'), node('p-vr', '2', 'VALIDATED_RETREATMENT'), node('p-v1', '1', 'RECOVERY'), { kind: 'phase', id: 'p-g04', block: { type: 'G-04', version: '1' } }] },
};

async function driver(c: PoolClient, content: Json = CONTENT) {
  let seq = 1;
  let state: Json = { steps: {}, entries: {} };
  const B = await replica(c, async () => {
    const id = await batchWith(c, gmp.seed.siteCode, content);
    await c.query(
      "insert into recipe.execution_state (batch_id, state, state_version, state_hash, last_seq, last_row_hash, status) values ($1, $2, 1, repeat('0', 64), 1, repeat('0', 64), 'IN_PROGRESS')",
      [id, JSON.stringify(state)],
    );
    return id;
  });
  return {
    B,
    async step(command: Json, next: Json, opts: { accepted?: boolean; kind?: string } = {}): Promise<string> {
      seq += 1;
      const accepted = opts.accepted ?? true;
      await replica(c, async () => {
        await c.query(
          `insert into recipe.execution_command (batch_id, seq, kind, command_id, command_type, command, command_hash, actor_person, actor_account, actor_role, source,
                                                 session_id, device_class, now_us, accepted, refusal, state_version, state_hash, events_hash, event_count, prev_row_hash, row_hash,
                                                 correlation_id)
           values ($1, $2, $3, gen_random_uuid(), $4, $5, repeat('0', 64), gen_random_uuid(), gen_random_uuid(), 'OPERATOR', 'UI', gen_random_uuid(), 'TERMINAL', 0, $6,
                   case when $6 then null else '{"code": "X"}'::jsonb end, 1, repeat('0', 64), repeat('0', 64), 0, repeat('0', 64), repeat('0', 64), gen_random_uuid())`,
          [B, seq, opts.kind ?? 'COMMAND', typeof command['type'] === 'string' ? command['type'] : 'RECORD_ENTRY', JSON.stringify(command), accepted],
        );
      });
      const o = await attempt(c, 'update recipe.execution_state set state = $2, last_seq = $3 where batch_id = $1', [B, JSON.stringify(next), seq]);
      if (o.ok) state = next;
      return o.ok ? '' : o.message;
    },
    get state() {
      return state;
    },
  };
}

async function authorise(c: PoolClient, batch: string, step: string, kase: string, signer: string): Promise<void> {
  await replica(c, async () => {
    const id = (await c.query<{ id: string }>(
      `insert into recipe.reprocessing_authorisation (batch_id, step_id, scope, case_code, investigation_ref, risk_evaluation_ref, proposed_by_person, proposed_by_account, correlation_id)
       values ($1, $2, 'STEP', $3, 'INV-1', 'RISK-1', gen_random_uuid(), gen_random_uuid(), gen_random_uuid()) returning id::text`,
      [batch, step, kase],
    )).rows[0]?.id;
    await c.query('insert into recipe.reprocessing_authorisation_signature (authorisation_id, signature_id, signer_person, recorded_by_account) values ($1, gen_random_uuid(), $2, gen_random_uuid())', [id, signer]);
  });
}

async function onlyG24Trigger(c: PoolClient): Promise<void> {
  await c.query('alter table recipe.execution_state disable trigger user');
  await c.query('alter table recipe.execution_state enable trigger zr_g24v2');
}

const steps = (status: Record<string, string>, extra: Json = {}): Json =>
  Object.fromEntries(Object.entries(status).map(([key, s]) => [key, { key, step: key.split('@')[0], status: s, ...((extra[key] as Json | undefined) ?? {}) }]));

describe('G-24@2 starts and additions (recipe-core 0622, 0625)', () => {
  it('[PR-47][IN-19][INV-33] a G-24@2 step starts only on an unused signed STEP authorisation of this batch, step and case by another person; a validated re-treatment, a G-24@1 step, a step already started and a batch without G-24@2 take none', async () => {
    await inCommand(gmp, 'operator1', async (c) => {
      await onlyG24Trigger(c);
      const starter = randomUUID();
      const qa = randomUUID();
      const start = (step: string, who = starter): Json => ({ type: 'START_STEP', step, actor: { id: who } });
      const refused = (code: string) => new RegExp(`^This accepted START_STEP row starts reprocessing step p-g24 .*\\(${code}\\): .*\\[EBMR-RPR-030\\]$`);
      const d = await driver(c);
      // Unauthorised; authorised for another case or another step or batch; authorised only by the starter.
      expect(await d.step(start('p-g24'), { steps: steps({ 'p-g24@1': 'IN_PROGRESS' }), entries: {} })).toMatch(refused('G24-NOT-AUTHORISED'));
      await authorise(c, d.B, 'p-g24', 'REPROCESSING_ADDITION', qa);
      await authorise(c, d.B, 'p-v1', 'RECOVERY', qa);
      const other = await driver(c);
      await authorise(c, other.B, 'p-g24', 'RECOVERY', qa);
      expect(await d.step(start('p-g24'), { steps: steps({ 'p-g24@1': 'IN_PROGRESS' }), entries: {} })).toMatch(refused('G24-NOT-AUTHORISED'));
      await authorise(c, d.B, 'p-g24', 'RECOVERY', starter);
      expect(await d.step(start('p-g24'), { steps: steps({ 'p-g24@1': 'IN_PROGRESS' }), entries: {} })).toMatch(refused('G24-SELF-AUTHORISED'));
      await authorise(c, d.B, 'p-g24', 'RECOVERY', qa);
      // Not this trigger's: the step not started by the row, a started step started again, another step's start.
      expect(await d.step(start('p-g24'), { steps: steps({ 'p-g24@1': 'READY' }), entries: {} })).toBe('');
      expect(await d.step(start('p-vr'), { steps: steps({ 'p-g24@1': 'READY', 'p-vr@1': 'IN_PROGRESS' }), entries: {} })).toBe('');
      expect(await d.step(start('p-v1'), { steps: steps({ 'p-g24@1': 'READY', 'p-vr@1': 'IN_PROGRESS', 'p-v1@1': 'IN_PROGRESS' }), entries: {} })).toBe('');
      expect(await d.step({ type: 'RECORD_ENTRY', step: 'p-g24', actor: { id: starter } }, { steps: steps({ 'p-g24@1': 'IN_PROGRESS', 'p-vr@1': 'IN_PROGRESS', 'p-v1@1': 'IN_PROGRESS' }), entries: {} })).toBe('');
      // The authorised start takes the authorisation once.
      const d2 = await driver(c);
      await authorise(c, d2.B, 'p-g24', 'RECOVERY', qa);
      expect(await d2.step(start('p-g24'), { steps: steps({ 'p-g24@1': 'IN_PROGRESS' }), entries: {} })).toBe('');
      expect((await c.query<{ k: string }>('select step_key as k from recipe.reprocessing_step_start where batch_id = $1', [d2.B])).rows).toEqual([{ k: 'p-g24@1' }]);
      expect(await d2.step(start('p-g24'), { steps: steps({ 'p-g24@1': 'IN_PROGRESS' }), entries: {} })).toBe('');
      const d2b = await driver(c);
      await authorise(c, d2b.B, 'p-g24', 'RECOVERY', qa);
      expect(await d2b.step(start('p-g24'), { steps: steps({ 'p-g24@1': 'IN_PROGRESS' }), entries: {} })).toBe('');
      expect(await d2b.step({ type: 'RECORD_ENTRY' }, { steps: steps({ 'p-g24@1': 'READY' }), entries: {} })).toBe('');
      expect(await d2b.step(start('p-g24'), { steps: steps({ 'p-g24@1': 'IN_PROGRESS' }), entries: {} })).toMatch(refused('G24-AUTHORISATION-USED'));
      // A refused row's message names it so.
      const d3 = await driver(c);
      expect(await d3.step({ type: 'RECORD_ENTRY' }, { steps: steps({ 'p-g24@1': 'IN_PROGRESS' }), entries: { s1: { kind: 'START_DATA', stepKey: 'p-g24@1', recordedSeq: '1', data: {} } } }, { accepted: false })).toMatch(
        /^This refused RECORD_ENTRY row stores start data s1 at G-24@2 step p-g24@1, which takes none.*\[EBMR-RPR-030\]$/,
      );
      expect(await d3.step({ type: 'SWEEP' }, { steps: steps({ 'p-g24@1': 'IN_PROGRESS' }), entries: { s1: { kind: 'START_DATA', stepKey: 'p-g24@1', recordedSeq: '1', data: {} } } }, { kind: 'SWEEP' })).toMatch(
        /^This sweep SWEEP row stores start data s1/,
      );
      // A batch whose MBR has no G-24@2 step: nothing is checked.
      const plain = await driver(c, { procedure: { kind: 'procedure', id: 'proc', children: [node('p-g24', '1', 'RECOVERY'), { kind: 'phase', id: 'p-x', block: { type: 'G-24', version: '3' } }] } });
      expect(await plain.step(start('p-g24'), { steps: steps({ 'p-g24@1': 'IN_PROGRESS' }), entries: { s1: { kind: 'START_DATA', stepKey: 'p-g24@1', recordedSeq: '1', data: {} } } })).toBe('');
      const d6 = await driver(c, { procedure: { kind: 'procedure', id: 'proc', children: [{ kind: 'phase', id: 'p-x', block: { type: 'G-25', version: '2' } }] } });
      expect(await d6.step(start('p-x'), { steps: steps({ 'p-x@1': 'IN_PROGRESS' }), entries: {} })).toBe('');
    });
  });

  it('[PR-47][PR-14][INV-33] at a G-24@2 step: no start data; an ADDITION stores exactly what its block writes from the command and needs the step\'s second-person check, then the database\'s addition rules; entries already in the row and other steps\' entries are left alone', async () => {
    await inCommand(gmp, 'operator1', async (c) => {
      await onlyG24Trigger(c);
      const by = randomUUID();
      const entry = { container: 'OC-1', quantity: { value: '2.5', unit: 'kg' }, source: { batch: 'B-0' }, authorisation: 'AUTH-1', authorisedBy: 'QA-1' };
      const want = { container: 'OC-1', net: { value: '2.5', unit: 'kg' }, source: { batch: 'B-0' }, case: 'RECOVERY', authorisation: 'AUTH-1', authorisedBy: 'QA-1', addedBy: by };
      const add = (data: Json, step = 'p-g24@1'): Json => ({ kind: 'ADDITION', stepKey: step, recordedSeq: '5', enteredBy: by, data });
      const st = (verify: unknown) => steps({ 'p-g24@1': 'IN_PROGRESS', 'p-v1@1': 'IN_PROGRESS', 'p-g04@1': 'IN_PROGRESS' }, { 'p-g24@1': { verificationRequired: verify } });
      const d = await driver(c);
      const row = { type: 'RECORD_ENTRY', entry };
      const prefix = '^This accepted RECORD_ENTRY row ';
      expect(await d.step(row, { steps: st(true), entries: { s1: { kind: 'START_DATA', stepKey: 'p-g24@1', recordedSeq: '1', data: {} } } })).toMatch(new RegExp(`${prefix}stores start data s1 at G-24@2 step p-g24@1`));
      expect(await d.step(row, { steps: st(true), entries: { a1: add({ ...want, net: { value: '2.6', unit: 'kg' } }) } })).toMatch(new RegExp(`${prefix}stores entry a1 \\(ADDITION\\) of step p-g24@1 with data`));
      expect(await d.step({ type: 'RECORD_ENTRY', entry: [] }, { steps: st(true), entries: { a1: add(want) } })).toMatch(new RegExp(`${prefix}stores entry a1 \\(ADDITION\\) of step p-g24@1 with data`));
      expect(await d.step(row, { steps: st(false), entries: { a1: add(want) } })).toMatch(new RegExp(`${prefix}stores entry a1 \\(ADDITION\\), which needs a second person's check`));
      expect(await d.step(row, { steps: st('true'), entries: { a1: add(want) } })).toMatch(new RegExp(`${prefix}stores entry a1 \\(ADDITION\\), which needs a second person's check`));
      // With the check, the addition rules decide (here: no such container of the source).
      const ruled = await d.step(row, { steps: st(true), entries: { a1: add(want) } });
      expect(ruled).toMatch(/\[EBMR-RPR-030\]$/);
      expect(ruled).not.toMatch(/with data|second person's check|start data/);
      // Not this trigger's: start data and additions at other steps; other kinds; entries already in the row.
      expect(await d.step(row, { steps: st(true), entries: { s1: { kind: 'START_DATA', stepKey: 'p-v1@1', recordedSeq: '1', data: {} }, a1: add({ x: 1 }, 'p-g04@1'), n1: { kind: 'NOTE', stepKey: 'p-g24@1', recordedSeq: '2', data: {} } } })).toBe('');
      expect(await d.step(row, { steps: st(true), entries: { s1: { kind: 'START_DATA', stepKey: 'p-v1@1', recordedSeq: '1', data: {} }, a1: add({ x: 1 }, 'p-g04@1'), n1: { kind: 'NOTE', stepKey: 'p-g24@1', recordedSeq: '2', data: {} } } })).toBe('');
      // The first refused entry is the one reported (the check stops there).
      const d3 = await driver(c);
      expect(await d3.step(row, { steps: st(true), entries: { a1: { ...add({ ...want, container: 'OC-2' }), recordedSeq: '1' }, s9: { kind: 'START_DATA', stepKey: 'p-g24@1', recordedSeq: '2', data: {} } } })).toMatch(
        new RegExp(`${prefix}stores entry a1 \\(ADDITION\\) of step p-g24@1 with data`),
      );
      // Start data already in the row before (written around the trigger) is not new.
      const d4 = await driver(c);
      const old = { s1: { kind: 'START_DATA', stepKey: 'p-g24@1', recordedSeq: '1', data: {} } };
      await replica(c, async () => {
        await c.query('update recipe.execution_state set state = $2 where batch_id = $1', [d4.B, JSON.stringify({ steps: st(true), entries: old })]);
      });
      expect(await d4.step(row, { steps: st(true), entries: { ...old, n1: { kind: 'NOTE', stepKey: 'p-g24@1', recordedSeq: '2', data: {} } } })).toBe('');
      // A row with an entries member that is no object holds nothing new.
      const d2 = await driver(c);
      await replica(c, async () => {
        await c.query("update recipe.execution_state set state = jsonb_set(state, '{entries}', '[]') where batch_id = $1", [d2.B]);
      });
      expect(await d2.step(row, { steps: st(true), entries: [add(want)] })).toBe('');
      expect(d.state).toBeTruthy();
    });
  });

  it('[INV-33] recipe-core 0930: recipe.reprocessing_start_problem, which nothing has called since 0625, is gone; no function or view names it', async () => {
    const { rows } = await gmp.db.admin.query<{ fn: string | null; refs: string; views: string }>(
      `select to_regprocedure('recipe.reprocessing_start_problem(uuid, text, text, text)')::text as fn,
              (select count(*)::text from pg_catalog.pg_proc where prosrc ilike '%reprocessing_start_problem%') as refs,
              (select count(*)::text from pg_catalog.pg_views where definition ilike '%reprocessing_start_problem%') as views`,
    );
    expect(rows[0]).toEqual({ fn: null, refs: '0', views: '0' });
  });
});
