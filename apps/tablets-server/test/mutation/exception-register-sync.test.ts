/**
 * The exception register's sync guards in the database alone (SQL mutation group "change-paths-and-hand-over",
 * recipe-core 0440, 0441, recipe.exception_register_sync; Phase 4 slice 7c, the "not twins" of the Phase 3 exit run).
 * The trigger keeps the register and the batch's state together whatever wrote the row: an exception is registered
 * open as raised and keeps its facts; it is linked to a deviation only by its own accepted ATTACH_DEVIATION, by the
 * linker, and the link never changes; it closes only by its own signed DISPOSITION_EXCEPTION (QA's when it is QA-only,
 * never by the person who raised it) and never reopens or changes; it is never removed.
 *
 * Each case writes the row the state names (recipe.execution_command) and the state itself directly, in a transaction
 * that is always rolled back, with only this trigger enabled on recipe.execution_state (the others guard the engine's own
 * writes and are proven by their own tests).
 *
 * Controls: INV-41, DI-26, PR-08, PR-13, INV-03.
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

interface Row {
  kind?: string;
  type?: string;
  accepted?: boolean;
  command?: Json;
  person?: string;
  signatures?: string[];
  roles?: Json[];
}

/** A batch whose state is driven row by row through the register trigger alone. */
async function driver(c: PoolClient, policy: Json = { qaRoles: ['QA', 'QA_REVIEWER'] }) {
  let seq = 1;
  let state: Json = { exceptions: {} };
  const B = await replica(c, async () => {
    const id = await batchWith(c, gmp.seed.siteCode, { procedure: { kind: 'procedure', id: 'proc', children: [] } });
    await c.query('update recipe.batch_execution set policy = $2 where id = $1', [id, JSON.stringify(policy)]);
    await c.query(
      "insert into recipe.execution_state (batch_id, state, state_version, state_hash, last_seq, last_row_hash, status) values ($1, $2, 1, repeat('0', 64), 1, repeat('0', 64), 'IN_PROGRESS')",
      [id, JSON.stringify(state)],
    );
    return id;
  });
  const insertRow = async (n: number, r: Row): Promise<void> => {
    const accepted = r.accepted ?? true;
    await c.query(
      `insert into recipe.execution_command (batch_id, seq, kind, command_id, command_type, command, command_hash, actor_person, actor_account, actor_role, source,
                                             session_id, device_class, now_us, accepted, refusal, state_version, state_hash, events_hash, event_count, roles, signature_ids,
                                             prev_row_hash, row_hash, correlation_id)
       values ($1, $2, $3, gen_random_uuid(), $4, $5, repeat('0', 64), $6, gen_random_uuid(), 'OPERATOR', 'UI', gen_random_uuid(), 'TERMINAL', 0, $7,
               case when $7 then null else '{"code": "X"}'::jsonb end, 1, repeat('0', 64), repeat('0', 64), 0, $8, $9::uuid[], repeat('0', 64), repeat('0', 64), gen_random_uuid())`,
      [B, n, r.kind ?? 'COMMAND', r.type ?? 'RECORD_ENTRY', JSON.stringify(r.command ?? {}), r.person ?? randomUUID(), accepted, JSON.stringify(r.roles ?? []), r.signatures ?? []],
    );
  };
  return {
    B,
    /** Writes row r and moves the state to `exceptions`; '' when taken, else the refusal (the state stays as it was). */
    async step(r: Row, exceptions: unknown, opts: { missingRow?: boolean } = {}): Promise<string> {
      seq += 1;
      if (!opts.missingRow) await replica(c, () => insertRow(seq, r));
      const next = { ...state, exceptions };
      const o = await attempt(c, 'update recipe.execution_state set state = $2, last_seq = $3 where batch_id = $1', [B, JSON.stringify(next), seq]);
      if (o.ok) state = next;
      return o.ok ? '' : o.message;
    },
    /** Sets the state without the trigger (a state the register never saw). */
    async force(exceptions: unknown): Promise<void> {
      state = { ...state, exceptions };
      await replica(c, async () => {
        await c.query('update recipe.execution_state set state = $2 where batch_id = $1', [B, JSON.stringify(state)]);
      });
    },
  };
}

const X = (extra: Json = {}): Json => ({ type: 'OUT_OF_LIMIT', category: 'OUT_OF_LIMIT', severity: 'ACTION', title: 'Weight out of limit', raisedBy: 'P-RAISER', source: { stepKey: 's@1', step: 's' }, status: 'OPEN', ...extra });

async function onlyRegisterTrigger(c: PoolClient): Promise<void> {
  await c.query('alter table recipe.execution_state disable trigger user');
  await c.query('alter table recipe.execution_state enable trigger zzr_exception_register');
}

describe('the exception register follows the state (recipe-core 0440, 0441)', () => {
  it('[INV-41][DI-26] a row the state names must be recorded; an exception arrives open, unlinked, undecided, and is registered; one the state held without the register is refused; its raised facts never change; it is never removed', async () => {
    await inCommand(gmp, 'operator1', async (c) => {
      await onlyRegisterTrigger(c);
      const d = await driver(c);
      expect(await d.step({}, { k1: X() }, { missingRow: true })).toMatch(/names row \d+, which is not recorded.*\[EBMR-EXE-160\]$/);
      for (const bad of [X({ status: 'DISPOSITIONED' }), X({ disposition: {} }), X({ deviation: { ref: 'DEV-1' } })]) {
        expect(await d.step({}, { k1: bad }), JSON.stringify(bad)).toMatch(/^Exception k1 arrives already linked or closed.*\[EBMR-EXE-161\]$/);
      }
      expect(await d.step({}, { k1: X({ category: 'NO_SUCH' }) })).toMatch(/\[EBMR-EXE-160\]$/);
      expect(await d.step({}, { k1: X() })).toBe('');
      const reg = (await c.query<{ id: string; t: string }>('select exception_id as id, exception_type as t from recipe.exception_register where batch_id = $1', [d.B])).rows;
      expect(reg).toEqual([{ id: 'k1', t: 'OUT_OF_LIMIT' }]);
      // Unchanged and a second one raised: both kept.
      expect(await d.step({}, { k1: X(), k2: X({ title: 'Second' }) })).toBe('');
      // A fact of k1 changed; k2 removed.
      expect(await d.step({}, { k1: X({ title: 'Changed' }), k2: X({ title: 'Second' }) })).toMatch(/^Exception k1 no longer has the facts the register holds.*\[EBMR-EXE-160\]$/);
      expect(await d.step({}, { k1: X() })).toMatch(/^Exception k2 is in the register but no longer in the state.*\[EBMR-EXE-160\]$/);
      expect(await d.step({}, [X()])).toMatch(/^Exception k1 is in the register but no longer in the state.*\[EBMR-EXE-160\]$/);
      // The state held k3 without the register (written around the trigger): the next row is refused.
      await d.force({ k1: X(), k2: X({ title: 'Second' }), k3: X() });
      expect(await d.step({}, { k1: X(), k2: X({ title: 'Second' }), k3: X() })).toMatch(/^Exception k3 is in the state of the batch but not in the register.*\[EBMR-EXE-160\]$/);
      // Another batch's register never counts for this one.
      const other = await driver(c);
      expect(await other.step({}, { k9: X() })).toBe('');
    });
  });

  it('[PR-08][INV-41] a deviation is linked only by the exception\'s own accepted ATTACH_DEVIATION, by the person it names, with a reference; the link is never changed or taken away', async () => {
    await inCommand(gmp, 'operator1', async (c) => {
      await onlyRegisterTrigger(c);
      const d = await driver(c);
      expect(await d.step({}, { k1: X(), k2: X() })).toBe('');
      const linker = randomUUID();
      const linked = (extra: Json = {}): Json => X({ deviation: { ref: 'DEV-1', linkedBy: linker, ...extra } });
      const attach = (extra: Row = {}): Row => ({ type: 'ATTACH_DEVIATION', command: { exception: 'k1' }, person: linker, ...extra });
      const refusedLink = /^Exception k1 is linked to a deviation by a .* row; .*\[EBMR-EXE-161\]$/;
      for (const [label, row, x] of [
        ['another command', attach({ type: 'RECORD_ENTRY' }), linked()],
        ['a refused row', attach({ accepted: false }), linked()],
        ['a sweep row', attach({ kind: 'SWEEP' }), linked()],
        ['another exception', attach({ command: { exception: 'k2' } }), linked()],
        ['not an object', attach(), X({ deviation: 'DEV-1' })],
        ['another linker', attach(), linked({ linkedBy: randomUUID() })],
        ['no reference', attach(), linked({ ref: '  ' })],
      ] as const) {
        expect(await d.step(row, { k1: x, k2: X() }), label).toMatch(refusedLink);
      }
      expect(await d.step(attach(), { k1: linked(), k2: X() })).toBe('');
      const acts = (await c.query<{ e: string; a: string; r: string }>('select exception_id as e, act as a, deviation_ref as r from recipe.exception_register_act where batch_id = $1', [d.B])).rows;
      expect(acts).toEqual([{ e: 'k1', a: 'DEVIATION_LINKED', r: 'DEV-1' }]);
      // Kept as linked by later rows of any kind.
      expect(await d.step({}, { k1: linked(), k2: X() })).toBe('');
      const changed = /^The deviation link of exception k1 was changed or taken away.*\[EBMR-EXE-161\]$/;
      expect(await d.step(attach(), { k1: linked({ ref: 'DEV-2' }), k2: X() })).toMatch(changed);
      expect(await d.step(attach(), { k1: linked({ linkedBy: randomUUID() }), k2: X() })).toMatch(changed);
      expect(await d.step(attach(), { k1: X(), k2: X() })).toMatch(changed);
    });
  });

  it('[INV-41][PR-13][INV-03] an exception closes only by its own accepted, signed DISPOSITION_EXCEPTION with an outcome and a justification, by the person it names; QA\'s when it is QA-only; never by the person who raised it; never reopened or changed after', async () => {
    await inCommand(gmp, 'operator1', async (c) => {
      await onlyRegisterTrigger(c);
      const d = await driver(c);
      const qa = X({ tier: 'REGISTERED' });
      expect(await d.step({}, { k1: X(), k2: qa, k3: X({ raisedBy: 'P-SELF' }) })).toBe('');
      const by = randomUUID();
      const sig = randomUUID();
      const closed = (extra: Json = {}): Json => X({ status: 'DISPOSITIONED', disposition: { by, signature: sig, outcome: 'NO_IMPACT', justification: 'Within the validated range', ...extra } });
      const dispose = (extra: Row = {}): Row => ({ type: 'DISPOSITION_EXCEPTION', command: { exception: 'k1' }, person: by, signatures: [sig], ...extra });
      const others = { k2: qa, k3: X({ raisedBy: 'P-SELF' }) };
      const refused = /^Exception k1 is closed by a .* row; .*\[EBMR-EXE-161\]$/;
      for (const [label, row, x] of [
        ['another command', dispose({ type: 'RECORD_ENTRY' }), closed()],
        ['a refused row', dispose({ accepted: false }), closed()],
        ['another exception', dispose({ command: { exception: 'k2' } }), closed()],
        ['status not DISPOSITIONED', dispose(), { ...closed(), status: 'CLOSED' }],
        ['status changed without a disposition', dispose(), X({ status: 'DISPOSITIONED' })],
        ['open with a disposition', dispose(), { ...closed(), status: 'OPEN' }],
        ['disposition not an object', dispose(), X({ status: 'DISPOSITIONED', disposition: 'NO_IMPACT' })],
        ['another person', dispose({ person: randomUUID() }), closed()],
        ['an unsigned row', dispose({ signatures: [] }), closed()],
        ['another outcome', dispose(), closed({ outcome: 'REWORK' })],
        ['no justification', dispose(), closed({ justification: ' ' })],
      ] as const) {
        expect(await d.step(row, { k1: x, ...others }), label).toMatch(refused);
      }
      expect(await d.step(dispose(), { k1: closed(), ...others })).toBe('');
      expect(await d.step({}, { k1: closed(), ...others })).toBe('');
      const changed = /^The disposition of exception k1 was changed or taken away.*\[EBMR-EXE-161\]$/;
      for (const x of [{ ...closed(), status: 'OPEN' }, closed({ by: randomUUID() }), closed({ outcome: 'DEVIATION_RAISED' }), closed({ signature: randomUUID() }), closed({ justification: 'Other' })]) {
        expect(await d.step(dispose(), { k1: x, ...others }), JSON.stringify(x)).toMatch(changed);
      }
      // DEVIATION_RAISED is an outcome too.
      const d2 = await driver(c);
      expect(await d2.step({}, { k1: X() })).toBe('');
      expect(await d2.step(dispose(), { k1: closed({ outcome: 'DEVIATION_RAISED' }) })).toBe('');
      // QA-only: a row with a quality-unit role the batch counts as QA.
      const sig2 = randomUUID();
      const qaClosed = { ...qa, status: 'DISPOSITIONED', disposition: { by, signature: sig2, outcome: 'NO_IMPACT', justification: 'QA decision' } };
      const qaRow = (roles: Json[]): Row => ({ type: 'DISPOSITION_EXCEPTION', command: { exception: 'k2' }, person: by, signatures: [sig2], roles });
      const qaRefused = /^Exception k2 \(OUT_OF_LIMIT, tier REGISTERED\) is dispositioned only by QA.*\[EBMR-EXE-162\]$/;
      expect(await d.step(qaRow([{ role: 'OPERATOR' }]), { k1: closed(), k2: qaClosed, k3: others.k3 })).toMatch(qaRefused);
      expect(await d.step(qaRow([]), { k1: closed(), k2: qaClosed, k3: others.k3 })).toMatch(qaRefused);
      const d3 = await driver(c, { qaRoles: ['QA_REVIEWER'] });
      expect(await d3.step({}, { k2: qa })).toBe('');
      expect(await d3.step(qaRow([{ role: 'QA' }]), { k2: qaClosed })).toMatch(qaRefused);
      expect(await d3.step(qaRow([{ role: 'QA_REVIEWER' }]), { k2: qaClosed })).toBe('');
      // A batch that counts a non-QA role as QA does not make it the quality unit.
      const d6 = await driver(c, { qaRoles: ['OPERATOR', 'QA'] });
      expect(await d6.step({}, { k2: qa })).toBe('');
      expect(await d6.step(qaRow([{ role: 'OPERATOR' }]), { k2: qaClosed })).toMatch(qaRefused);
      const d4 = await driver(c, { qaRoles: 'QA' });
      expect(await d4.step({}, { k2: qa })).toBe('');
      expect(await d4.step(qaRow([{ role: 'QA' }]), { k2: qaClosed })).toMatch(qaRefused);
      expect(await d.step(qaRow([{ role: 'OPERATOR' }, { role: 'QA' }]), { k1: closed(), k2: qaClosed, k3: others.k3 })).toBe('');
      // The person who raised it never decides it.
      const self = randomUUID();
      const d5 = await driver(c);
      expect(await d5.step({}, { k3: X({ raisedBy: self }) })).toBe('');
      const selfClosed = X({ raisedBy: self, status: 'DISPOSITIONED', disposition: { by: self, signature: sig, outcome: 'NO_IMPACT', justification: 'x' } });
      expect(await d5.step({ type: 'DISPOSITION_EXCEPTION', command: { exception: 'k3' }, person: self, signatures: [sig] }, { k3: selfClosed })).toMatch(
        new RegExp(`^${self} raised it, so the disposition of exception k3 is refused.*\\[EBMR-EXE-163\\]$`),
      );
      const acts = (await c.query<{ e: string; o: string }>("select exception_id as e, outcome as o from recipe.exception_register_act where batch_id = $1 and act = 'DISPOSITIONED' order by exception_id", [d.B])).rows;
      expect(acts).toEqual([{ e: 'k1', o: 'NO_IMPACT' }, { e: 'k2', o: 'NO_IMPACT' }]);
    });
  });
});
