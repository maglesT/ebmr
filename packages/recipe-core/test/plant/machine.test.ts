/**
 * The plant machines are defined once in XState (src/plant/machine.ts); their transition tables are generated from them
 * (sql/0401, sql/0402) and these tests prove the two agree (ADR 0012 decision 2), and that every guard is registered.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getNextSnapshot, type AnyStateMachine } from 'xstate';
import { state } from '@ebmr/kernel';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { RECIPE_SQL_DIR } from '../../src/lifecycle/write-seeds.ts';
import * as plant from '../../src/plant/index.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, 300_000);

afterAll(async () => {
  await db.drop();
});

const MACHINES: {
  d: state.MachineDescriptor;
  m: AnyStateMachine;
  events: readonly string[];
  states: readonly string[];
}[] = [
  {
    d: plant.EQUIPMENT_CLEANLINESS_V1,
    m: plant.equipmentCleanlinessMachine,
    events: plant.EQUIPMENT_EVENTS,
    states: plant.EQUIPMENT_STATES,
  },
  {
    d: plant.AREA_STATUS_V1,
    m: plant.areaStatusMachine,
    events: plant.AREA_EVENTS,
    states: plant.AREA_STATES,
  },
];

describe('the generated plant machine seeds', () => {
  it('[INV-12][INV-15] every committed plant machine seed equals the generator output', () => {
    for (const m of plant.PLANT_MACHINES) {
      expect(readFileSync(join(RECIPE_SQL_DIR, m.descriptor.seedFile), 'utf8')).toBe(plant.plantMachineSeedSql(m));
    }
    expect(plant.plantSeedStatus().every((s) => s.status === 'up-to-date')).toBe(true);
  });

  it('[IN-21][INV-15] the machines have the states of outline 5.2.8: cleanliness CLEAN -> IN_PRODUCT -> DIRTY -> CLEANING -> CLEAN; rooms DIRTY -> CLEANING -> CLEAN -> CLEARED_FOR_BATCH -> IN_USE -> DIRTY and OUT_OF_SERVICE', () => {
    for (const { d, states } of MACHINES) expect(state.extractDefinition(d).states).toEqual([...states].sort());
    const area = state.extractDefinition(plant.AREA_STATUS_V1).transitions.map((t) => `${t.from}>${t.to}`);
    for (const step of ['DIRTY>CLEANING', 'CLEANING>CLEAN', 'CLEAN>CLEARED_FOR_BATCH', 'CLEARED_FOR_BATCH>IN_USE', 'IN_USE>DIRTY'])
      expect(area).toContain(step);
    // A room is never used straight from CLEAN or DIRTY: only CLEARED_FOR_BATCH leads to IN_USE.
    expect(area.filter((t) => t.endsWith('>IN_USE'))).toEqual(['CLEARED_FOR_BATCH>IN_USE']);
    const eq = state.extractDefinition(plant.EQUIPMENT_CLEANLINESS_V1).transitions.map((t) => `${t.from}>${t.to}`);
    expect(eq.filter((t) => t.endsWith('>IN_PRODUCT'))).toEqual(['CLEAN>IN_PRODUCT']);
  });
});

describe('XState and the database agree', () => {
  it('[INV-12][INV-15] each transition table holds exactly the XState transitions, with the same sealed hash, and every guard is registered', async () => {
    const registered = new Set((await db.app.query<{ code: string }>('select code from platform.state_guard')).rows.map((r) => r.code));
    for (const { d } of MACHINES) {
      const def = state.extractDefinition(d);
      const { rows } = await db.app.query(
        `select from_state as from, event, to_state as to, guard_codes as guards, signature_meaning as signature, permission_code as permission
           from platform.machine_transition where machine_code = $1 and machine_version = 1
          order by from_state collate "C", event collate "C"`,
        [d.code],
      );
      expect(rows).toEqual(def.transitions);
      const { rows: h } = await db.app.query<{ hash: string }>('select platform.machine_definition_hash($1, 1) as hash', [d.code]);
      expect(h[0]?.hash).toBe(state.definitionHash(def));
      expect(def.transitions.flatMap((t) => t.guards).filter((g) => !registered.has(g))).toEqual([]);
    }
  });

  it("[INV-12][INV-15] for every state and event, XState's next state equals the table's", async () => {
    for (const { d, m, events } of MACHINES) {
      const table = new Map(
        (
          await db.app.query<{ k: string; to: string }>(
            "select from_state || '/' || event as k, to_state as to from platform.machine_transition where machine_code = $1",
            [d.code],
          )
        ).rows.map((r) => [r.k, r.to]),
      );
      for (const s of state.extractDefinition(d).states) {
        for (const e of events) {
          const snapshot = m.resolveState({ value: s, context: {} });
          const allowed = snapshot.can({ type: e });
          const next = allowed ? String(getNextSnapshot(m, snapshot, { type: e }).value) : null;
          expect({ s, e, allowed, next }).toEqual({
            s,
            e,
            allowed: table.has(`${s}/${e}`),
            next: table.get(`${s}/${e}`) ?? null,
          });
        }
      }
    }
  });
});
