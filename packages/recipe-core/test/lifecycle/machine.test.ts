/**
 * The MBR version machine is defined once in XState (src/lifecycle/machine.ts); the database's
 * transition table is generated from it (sql/0140) and these tests prove the two agree (ADR 0012
 * decision 2; outline 5.2 "a test fails if they differ"), then replay every state/event pair through
 * the real engine with the real guards, permissions and signatures (model-based, outline 9.1).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getNextSnapshot } from 'xstate';
import { state } from '@ebmr/kernel';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import * as lc from '../../src/lifecycle/index.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import { reason, seedCast, uniqueContent, World } from './support.ts';

let db: TestDatabase;
let w: World;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
}, 300_000);

afterAll(async () => {
  await db.drop();
});

async function rows<T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.app.query<T>(text, params)).rows;
}

describe('the generated seed of the MBR version machine', () => {
  it('[PR-02][INV-04] every committed recipe-core machine seed equals the generator output', () => {
    expect(lc.RECIPE_MACHINES.length).toBeGreaterThan(0);
    for (const m of lc.RECIPE_MACHINES) {
      expect(readFileSync(join(lc.RECIPE_SQL_DIR, m.descriptor.seedFile), 'utf8')).toBe(lc.recipeMachineSeedSql(m));
    }
    expect(lc.seedStatus().every((s) => s.status === 'up-to-date')).toBe(true);
  });

  it('[PR-02] the machine has the states and events of outline 5.2.1 and signatures PREPARED, CHECKED, APPROVED', () => {
    const def = state.extractDefinition(lc.MBR_VERSION_V1);
    expect(def.states).toEqual([...lc.MBR_VERSION_STATES].sort());
    expect([...new Set(def.transitions.map((t) => t.event))].sort()).toEqual([...lc.MBR_VERSION_EVENTS].sort());
    expect(def.transitions.filter((t) => t.signature).map((t) => `${t.from}/${t.event}/${t.signature}`)).toEqual([
      'CHECKED/APPROVE/APPROVED',
      'IN_VERIFICATION/SUBMIT/PREPARED',
      'SUBMITTED/CHECK/CHECKED',
    ]);
    // APPROVED never returns to DRAFT (PR-06: approved content never changes).
    expect(def.transitions.some((t) => t.from === 'APPROVED' && t.to === 'DRAFT')).toBe(false);
    expect(def.final_states).toEqual(['RETIRED', 'WITHDRAWN']);
  });
});

describe('XState and the database agree', () => {
  it('[PR-02][INV-04] the transition table holds exactly the XState transitions, with the same sealed hash', async () => {
    const def = state.extractDefinition(lc.MBR_VERSION_V1);
    const dbRows = await rows<{ from: string; event: string; to: string; guards: string[]; signature: string | null; permission: string | null }>(
      `select from_state as from, event, to_state as to, guard_codes as guards, signature_meaning as signature, permission_code as permission
         from platform.machine_transition where machine_code = 'mbr_version' and machine_version = 1
        order by from_state collate "C", event collate "C"`,
    );
    expect(dbRows).toEqual(def.transitions);
    const [canonical] = await rows<{ text: string; hash: string }>("select platform.machine_canonical_text('mbr_version', 1) as text, platform.machine_definition_hash('mbr_version', 1) as hash");
    expect(canonical?.text).toBe(state.canonicalText(def));
    expect(canonical?.hash).toBe(state.definitionHash(def));
    expect(await rows("select * from platform.machine_integrity_violations() where machine_code = 'mbr_version'")).toEqual([]);
  });

  it('[PR-02] for every state and event, XState\'s next state equals the table\'s', async () => {
    const def = state.extractDefinition(lc.MBR_VERSION_V1);
    const table = new Map(
      (await rows<{ k: string; to: string }>("select from_state || '/' || event as k, to_state as to from platform.machine_transition where machine_code = 'mbr_version'")).map((r) => [r.k, r.to]),
    );
    for (const s of def.states) {
      for (const e of lc.MBR_VERSION_EVENTS) {
        const snapshot = lc.mbrVersionMachine.resolveState({ value: s, context: {} });
        const allowed = snapshot.can({ type: e });
        const next = allowed ? String(getNextSnapshot(lc.mbrVersionMachine, snapshot, { type: e }).value) : null;
        expect({ s, e, allowed, next }).toEqual({ s, e, allowed: table.has(`${s}/${e}`), next: table.get(`${s}/${e}`) ?? null });
      }
    }
  });

  it('[INV-04] every guard the machine names is registered with the engine', async () => {
    const guards = new Set(Object.values(lc.GUARDS));
    const registered = new Set((await rows<{ code: string }>('select code from platform.state_guard')).map((r) => r.code));
    expect([...guards].filter((g) => !registered.has(g))).toEqual([]);
  });
});

describe('model-based: every state/event pair through the real engine', () => {
  type S = lc.MbrVersionState;
  type E = lc.MbrVersionEvent;

  /** A fresh version (own family) driven to `target` along the shortest path with real signatures. */
  async function versionIn(target: S): Promise<{ id: string; content: MbrContent }> {
    const content = uniqueContent();
    const v = await w.newVersion(content);
    await w.prepare(v.versionId, content);
    const id = v.versionId;
    if (target === 'DRAFT') return { id, content };
    if (target === 'WITHDRAWN') {
      await fire(id, 'DRAFT', 'WITHDRAW');
      return { id, content };
    }
    await w.startVerification(id);
    if (target === 'IN_VERIFICATION') return { id, content };
    await w.submit(id);
    if (target === 'SUBMITTED') return { id, content };
    await w.check(id);
    if (target === 'CHECKED') return { id, content };
    await w.approve(id);
    if (target === 'APPROVED') return { id, content };
    await fire(id, 'APPROVED', 'RETIRE');
    return { id, content };
  }

  /** Fires an allowed event with the actor and signature the transition needs. */
  async function fire(id: string, from: S, event: E): Promise<string> {
    const { author, checker, qa } = w.cast;
    const s = await w.state(id);
    switch (event) {
      case 'START_VERIFICATION':
        await w.startVerification(id);
        break;
      case 'SUBMIT':
        await w.submit(id);
        break;
      case 'CHECK':
        await w.check(id);
        break;
      case 'APPROVE':
        await w.approve(id);
        break;
      case 'RETURN': {
        const actor = from === 'IN_VERIFICATION' ? author : from === 'SUBMITTED' ? checker : qa;
        await w.run(actor, (c) => lc.returnToDraft(c, id, s.version), reason('model: return to draft'));
        break;
      }
      case 'WITHDRAW': {
        const actor = from === 'DRAFT' || from === 'IN_VERIFICATION' ? author : qa;
        await w.run(actor, (c) => lc.withdrawVersion(c, id, s.version), reason('model: withdraw'));
        break;
      }
      case 'RETIRE':
        await w.run(qa, (c) => lc.retireVersion(c, id, s.version), reason('model: retire'));
        break;
    }
    return (await w.state(id)).state;
  }

  it(
    '[PR-02][PR-05][INV-04] every event in every state is accepted by the engine exactly when XState allows it',
    async () => {
      const def = state.extractDefinition(lc.MBR_VERSION_V1);
      let accepted = 0;
      let refused = 0;
      for (const s of def.states as S[]) {
        const snapshot = lc.mbrVersionMachine.resolveState({ value: s, context: {} });
        // Refused events: one version in this state serves them all (a refusal changes nothing).
        const probe = await versionIn(s);
        for (const e of lc.MBR_VERSION_EVENTS) {
          if (snapshot.can({ type: e })) continue;
          const v = await w.state(probe.id);
          await expect(w.run(w.cast.author, (c) => lc.transitionVersion(c, probe.id, e, v.version), reason('model: refused'))).rejects.toThrow('EBMR-PLAT-067');
          expect((await w.state(probe.id)).state).toBe(s);
          refused++;
        }
        // Allowed events: a fresh version per event.
        for (const e of lc.MBR_VERSION_EVENTS) {
          if (!snapshot.can({ type: e })) continue;
          const v = await versionIn(s);
          const to = await fire(v.id, s, e);
          expect([s, e, to]).toEqual([s, e, String(getNextSnapshot(lc.mbrVersionMachine, snapshot, { type: e }).value)]);
          accepted++;
        }
      }
      expect(accepted).toBe(def.transitions.length);
      expect(accepted + refused).toBe(def.states.length * lc.MBR_VERSION_EVENTS.length);
      expect(await rows("select * from platform.state_violations() where aggregate_type = 'mbr_version'")).toEqual([]);
      expect(await w.violations()).toEqual([]);
    },
    1_800_000,
  );
});
