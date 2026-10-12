/**
 * The material lot machine is defined once in XState (src/lots/machine.ts); the database's transition table is
 * generated from it (sql/0711) and these tests prove the two agree (ADR 0012 decision 2; outline 5.2 "a test fails
 * if they differ"), and that the lots the other tests drove left consistent state rows and histories.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getNextSnapshot } from 'xstate';
import { state } from '@ebmr/kernel';
import {
  MATERIAL_LOT_EVENTS,
  MATERIAL_LOT_STATES,
  MATERIAL_LOT_V1,
  MATERIAL_LOT_V2,
  MATERIAL_LOT_V2_EVENTS,
  materialLotMachine,
  SITE_MACHINES,
  SITE_SQL_DIR,
  siteMachineSeedSql,
  siteSeedStatus,
} from '../../src/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

async function rows<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.app.query<T>(text, params)).rows;
}

describe('the material lot machine', () => {
  it('[IN-24][INV-13] the committed seed equals the generator output', () => {
    expect(SITE_MACHINES.length).toBeGreaterThan(0);
    for (const m of SITE_MACHINES) expect(readFileSync(join(SITE_SQL_DIR, m.descriptor.seedFile), 'utf8')).toBe(siteMachineSeedSql(m));
    expect(siteSeedStatus().every((s) => s.status === 'up-to-date')).toBe(true);
  });

  it('[IN-24] the states and signatures of outline 5.2.9: every status decision is signed, a finished lot cannot leave quarantine, RETEST_DUE and EXPIRED are not stored', () => {
    const def = state.extractDefinition(MATERIAL_LOT_V1);
    expect(def.states).toEqual([...MATERIAL_LOT_STATES].sort());
    expect([...new Set(def.transitions.map((t) => t.event))].sort()).toEqual([...MATERIAL_LOT_EVENTS].sort());
    expect(def.states).not.toContain('RETEST_DUE');
    expect(def.states).not.toContain('EXPIRED');
    // Only consumption at zero is unsigned; every other change carries a signature.
    expect(def.transitions.filter((t) => !t.signature).map((t) => t.event)).toEqual(['CONSUME', 'CONSUME']);
    for (const t of def.transitions) expect(t.guards).toContain('material_lot.command_recorded');
    for (const t of def.transitions.filter((x) => x.from === 'QUARANTINE')) expect(t.guards).toContain('material_lot.not_finished');
    const release = def.transitions.find((t) => t.event === 'RELEASE');
    expect(release?.signature).toBe('MATERIAL_LOT_RELEASED');
    expect(release?.guards).toEqual(expect.arrayContaining(['material_lot.release_route_satisfied', 'material_lot.within_dates', 'material_lot.signer_is_actor']));
    expect(def.transitions.filter((t) => t.to === 'DESTROYED').every((t) => t.signature === 'MATERIAL_DESTRUCTION_WITNESSED')).toBe(true);
    expect(def.final_states).toEqual(['CONSUMED', 'DESTROYED']);
  });

  it('[IN-24] the transition table holds exactly the XState transitions, with the same sealed hash, and XState\'s next state equals the table\'s for every pair', async () => {
    const def = state.extractDefinition(MATERIAL_LOT_V1);
    const dbRows = await rows<{ from: string; event: string; to: string; guards: string[]; signature: string | null; permission: string | null }>(
      `select from_state as from, event, to_state as to, guard_codes as guards, signature_meaning as signature, permission_code as permission
         from platform.machine_transition where machine_code = 'material_lot' and machine_version = 1
        order by from_state collate "C", event collate "C"`,
    );
    expect(dbRows).toEqual(def.transitions);
    const [canonical] = await rows<{ text: string; hash: string }>("select platform.machine_canonical_text('material_lot', 1) as text, platform.machine_definition_hash('material_lot', 1) as hash");
    expect(canonical?.hash).toBe(state.definitionHash(def));
    const table = new Map((await rows<{ k: string; to: string }>("select from_state || '/' || event as k, to_state as to from platform.machine_transition where machine_code = 'material_lot'")).map((r) => [r.k, r.to]));
    for (const s of def.states) {
      for (const e of MATERIAL_LOT_EVENTS) {
        const snapshot = materialLotMachine.resolveState({ value: s, context: {} });
        const next: unknown = snapshot.can({ type: e }) ? getNextSnapshot(materialLotMachine, snapshot, { type: e }).value : null;
        expect({ s, e, next }).toEqual({ s, e, next: table.get(`${s}/${e}`) ?? null });
      }
    }
  });
});

describe('the material lot machine, version 2 (Phase 4 slice 3a)', () => {
  it('[IN-05] version 2 keeps every transition of version 1 and adds only the manufacturer release\'s two exits of a finished lot from quarantine, guarded by the decision recorded in the same transaction', async () => {
    const v1 = state.extractDefinition(MATERIAL_LOT_V1);
    const v2 = state.extractDefinition(MATERIAL_LOT_V2);
    expect(v2.states).toEqual(v1.states);
    const added = v2.transitions.filter((t) => !v1.transitions.some((x) => x.from === t.from && x.event === t.event));
    expect(added).toEqual([
      { from: 'QUARANTINE', event: 'MANUFACTURER_REJECT', to: 'REJECTED', guards: ['material_lot.command_recorded', 'material_lot.manufacturer_decision'], signature: null, permission: 'release.manufacturer' },
      { from: 'QUARANTINE', event: 'MANUFACTURER_RELEASE', to: 'RELEASED', guards: ['material_lot.command_recorded', 'material_lot.manufacturer_decision'], signature: null, permission: 'release.manufacturer' },
    ]);
    expect(v2.transitions.filter((t) => !added.includes(t))).toEqual(v1.transitions);
    const dbRows = await rows<{ from: string; event: string }>(
      `select from_state as from, event from platform.machine_transition where machine_code = 'material_lot' and machine_version = 2 order by from_state collate "C", event collate "C"`,
    );
    expect(dbRows).toEqual(v2.transitions.map((t) => ({ from: t.from, event: t.event })));
    expect([...MATERIAL_LOT_V2_EVENTS].sort()).toEqual([...new Set(v2.transitions.map((t) => t.event))].sort());
    // The decision guard refuses a lot it does not know, and every other event of a finished lot.
    const [g] = (await db.admin.query<{ r: string }>(`select site.guard_manufacturer_decision('material_lot', gen_random_uuid(), '{"event": "MANUFACTURER_RELEASE"}'::jsonb, '{}'::jsonb, '{}'::jsonb) as r`)).rows;
    expect(g?.r).toBe('the lot does not exist');
  });
});
