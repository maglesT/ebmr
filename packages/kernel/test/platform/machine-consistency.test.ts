/**
 * The XState definition and the database transition table describe exactly the same machine
 * (outline 5.2: "each machine is defined once as data (XState); from it the build generates the
 * database's allowed-transition table"; ADR 0012 decision 2: "a test fails if they differ").
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMachine, getNextSnapshot, setup } from 'xstate';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { gmp, type MachineDescriptor } from '../../src/state/definition.ts';
import { createAggregateState, transition } from '../../src/state/engine.ts';
import { canonicalText, definitionHash, extractDefinition, MachineDefinitionError } from '../../src/state/extract.ts';
import { KERNEL_MACHINES, SAMPLE_RECORD_V1 } from '../../src/state/machines/index.ts';
import { machineSeedSql } from '../../src/state/seed.ts';
import { KERNEL_SQL_DIR, seedStatus } from '../../src/state/write-seeds.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { grantPermission, installStubHooks, stubSignature, testActor } from './helpers.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

async function rows<T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.app.query<T>(text, params)).rows;
}

describe('generated seed', () => {
  it('every committed machine seed migration equals the generator output', () => {
    expect(KERNEL_MACHINES.length).toBeGreaterThan(0);
    for (const { descriptor, source } of KERNEL_MACHINES) {
      const committed = readFileSync(join(KERNEL_SQL_DIR, descriptor.seedFile), 'utf8');
      expect(committed).toBe(machineSeedSql(descriptor, source));
    }
    expect(seedStatus().every((s) => s.status === 'up-to-date')).toBe(true);
  });

  it('a changed machine no longer matches its published seed, so it needs a new version', () => {
    const changed: MachineDescriptor = {
      ...SAMPLE_RECORD_V1,
      machine: setup({}).createMachine({
        id: 'sample_record',
        initial: 'DRAFT',
        states: {
          DRAFT: { on: { SUBMIT: gmp('SUBMITTED', { permission: 'sample_record.submit' }) } },
          SUBMITTED: { on: { APPROVE: gmp('APPROVED', { signature: 'APPROVED', permission: 'sample_record.approve' }) } },
          APPROVED: { type: 'final' },
        },
      }),
    };
    const committed = readFileSync(join(KERNEL_SQL_DIR, SAMPLE_RECORD_V1.seedFile), 'utf8');
    expect(machineSeedSql(changed, 'x')).not.toBe(committed);
    expect(definitionHash(extractDefinition(changed))).not.toBe(definitionHash(extractDefinition(SAMPLE_RECORD_V1)));
  });
});

describe('XState and the database agree', () => {
  for (const { descriptor } of KERNEL_MACHINES) {
    it(`${descriptor.code} v${descriptor.version}: the transition table holds exactly the XState transitions`, async () => {
      const def = extractDefinition(descriptor);
      const dbRows = await rows<{ from: string; event: string; to: string; guards: string[]; signature: string | null; permission: string | null }>(
        `select from_state as from, event, to_state as to, guard_codes as guards, signature_meaning as signature, permission_code as permission
           from platform.machine_transition where machine_code = $1 and machine_version = $2
          order by from_state collate "C", event collate "C"`,
        [descriptor.code, descriptor.version],
      );
      expect(dbRows).toEqual(def.transitions);
      const [version] = await rows<{ initial_state: string; states: string[]; final_states: string[]; definition_hash: string; aggregate_type: string; create_permission: string }>(
        `select v.initial_state, v.states, v.final_states, v.definition_hash, m.aggregate_type, v.create_permission
           from platform.machine_version v join platform.machine m on m.code = v.machine_code where v.machine_code = $1 and v.version = $2`,
        [descriptor.code, descriptor.version],
      );
      expect(version?.create_permission).toBe(def.create_permission);
      expect([...(version?.states ?? [])].sort()).toEqual(def.states);
      expect([...(version?.final_states ?? [])].sort()).toEqual(def.final_states);
      expect(version?.initial_state).toBe(def.initial);
      expect(version?.aggregate_type).toBe(def.aggregate_type);
      expect(version?.definition_hash).toBe(definitionHash(def));
      const [canonical] = await rows<{ text: string; hash: string }>('select platform.machine_canonical_text($1, $2) as text, platform.machine_definition_hash($1, $2) as hash', [
        descriptor.code,
        descriptor.version,
      ]);
      expect(canonical?.text).toBe(canonicalText(def));
      expect(canonical?.hash).toBe(definitionHash(def));
    });

    it(`${descriptor.code} v${descriptor.version}: for every state and event, XState's next state equals the table's`, async () => {
      const def = extractDefinition(descriptor);
      const events = [...new Set(def.transitions.map((t) => t.event))];
      const table = new Map((await rows<{ k: string; to: string }>(
        "select from_state || '/' || event as k, to_state as to from platform.machine_transition where machine_code = $1 and machine_version = $2",
        [descriptor.code, descriptor.version],
      )).map((r) => [r.k, r.to]));
      for (const state of def.states) {
        for (const event of events) {
          const snapshot = descriptor.machine.resolveState({ value: state, context: {} });
          const allowed = snapshot.can({ type: event });
          const next: unknown = getNextSnapshot(descriptor.machine, snapshot, { type: event }).value;
          expect({ state, event, allowed, next: allowed ? next : null }).toEqual({
            state,
            event,
            allowed: table.has(`${state}/${event}`),
            next: table.get(`${state}/${event}`) ?? null,
          });
        }
      }
    });
  }
});

describe('the engine enforces exactly the XState model', () => {
  it('sample_record: every event in every state is accepted by the engine exactly when XState allows it', async () => {
    await installStubHooks(db);
    await grantPermission(db, 'QA_REVIEWER', 'sample_record.submit', 'sample_record.check', 'sample_record.approve', 'sample_record.retire');
    const actor: ActorContext = await testActor(db, { roleCode: 'QA_REVIEWER', reasonCode: 'MODEL_TEST', reasonText: 'model-based path' });
    const machine = SAMPLE_RECORD_V1.machine;
    const def = extractDefinition(SAMPLE_RECORD_V1);
    const events = [...new Set(def.transitions.map((t) => t.event))];

    // Shortest event path from the initial state to every state (breadth-first over the XState machine).
    const paths = new Map<string, string[]>([[def.initial, []]]);
    const queue = [def.initial];
    while (queue.length > 0) {
      const state = queue.shift() ?? '';
      for (const event of events) {
        const snapshot = machine.resolveState({ value: state, context: {} });
        if (!snapshot.can({ type: event })) continue;
        const next = String(getNextSnapshot(machine, snapshot, { type: event }).value);
        if (!paths.has(next)) {
          paths.set(next, [...(paths.get(state) ?? []), event]);
          queue.push(next);
        }
      }
    }
    expect([...paths.keys()].sort()).toEqual(def.states);

    const signatureFor = new Map(def.transitions.filter((t) => t.signature).map((t) => [`${t.from}/${t.event}`, t.signature ?? '']));
    const fire = async (id: string, from: string, event: string, version: number) => {
      const meaning = signatureFor.get(`${from}/${event}`);
      const payload = meaning ? { signature_id: await stubSignature(db, meaning, 'sample_record', id) } : {};
      return withCommand(db.app, actor, (c) =>
        transition(c, { machine: 'sample_record', aggregateType: 'sample_record', aggregateId: id, event, expectedVersion: version, payload }),
      );
    };

    let accepted = 0;
    let refused = 0;
    for (const [state, path] of paths) {
      for (const event of events) {
        const id = randomUUID();
        await withCommand(db.app, actor, async (c) => {
          await c.query("insert into platform.stub_record (id, title, body) values ($1, 'model', 'body')", [id]);
          await createAggregateState(c, 'sample_record', { aggregateType: 'sample_record', aggregateId: id });
        });
        let current = def.initial;
        for (const [i, step] of path.entries()) {
          current = (await fire(id, current, step, i + 1)).to;
        }
        expect(current).toBe(state);
        const snapshot = machine.resolveState({ value: state, context: {} });
        if (snapshot.can({ type: event })) {
          const result = await fire(id, state, event, path.length + 1);
          expect([state, event, result.to]).toEqual([state, event, String(getNextSnapshot(machine, snapshot, { type: event }).value)]);
          accepted++;
        } else {
          await expect(fire(id, state, event, path.length + 1)).rejects.toThrow('EBMR-PLAT-067');
          refused++;
        }
      }
    }
    expect(accepted).toBe(def.transitions.length);
    expect(accepted + refused).toBe(def.states.length * events.length);
    expect(await rows('select * from platform.state_violations()')).toEqual([]);
  });
});

describe('the extractor refuses machines the database cannot represent', () => {
  const descriptor = (machine: MachineDescriptor['machine'], code = 'bad_machine', createPermission = 'bad_machine.create'): MachineDescriptor => ({
    code,
    version: 1,
    aggregateType: 'bad_machine',
    description: 'invalid',
    createPermission,
    machine,
    seedFile: '0599_never.sql',
  });
  const cases: [string, MachineDescriptor][] = [
    ['nested states', descriptor(createMachine({ id: 'bad_machine', initial: 'A', states: { A: { initial: 'X', states: { X: {} }, on: { GO: 'B' } }, B: { type: 'final' } } }))],
    ['parallel states', descriptor(createMachine({ id: 'bad_machine', type: 'parallel', states: { A: {}, B: {} } }))],
    ['guarded alternatives', descriptor(createMachine({ id: 'bad_machine', initial: 'A', states: { A: { on: { GO: [{ target: 'B', guard: () => true }, { target: 'C' }] } }, B: { type: 'final' }, C: { type: 'final' } } }))],
    ['an XState guard', descriptor(createMachine({ id: 'bad_machine', initial: 'A', states: { A: { on: { GO: { target: 'B', guard: () => true } } }, B: { type: 'final' } } }))],
    ['transition actions', descriptor(createMachine({ id: 'bad_machine', initial: 'A', states: { A: { on: { GO: { target: 'B', actions: () => undefined } } }, B: { type: 'final' } } }))],
    ['delayed transitions', descriptor(createMachine({ id: 'bad_machine', initial: 'A', states: { A: { after: { 1000: 'B' } }, B: { type: 'final' } } }))],
    ['eventless transitions', descriptor(createMachine({ id: 'bad_machine', initial: 'A', states: { A: { always: 'B' }, B: { type: 'final' } } }))],
    ['a lower-case state', descriptor(createMachine({ id: 'bad_machine', initial: 'draft', states: { draft: { on: { GO: 'DONE' } }, DONE: { type: 'final' } } }))],
    ['a targetless transition', descriptor(createMachine({ id: 'bad_machine', initial: 'A', states: { A: { on: { GO: {} } }, B: { type: 'final' } } }))],
    ['unknown meta keys', descriptor(createMachine({ id: 'bad_machine', initial: 'A', states: { A: { on: { GO: { target: 'B', meta: { guards: [], role: 'QA' } } } }, B: { type: 'final' } } }))],
    ['a malformed permission', descriptor(createMachine({ id: 'bad_machine', initial: 'A', states: { A: { on: { GO: gmp('B', { permission: 'Approve' }) } }, B: { type: 'final' } } }))],
    ['an id that differs from the code', descriptor(createMachine({ id: 'other', initial: 'A', states: { A: { on: { GO: 'B' } }, B: { type: 'final' } } }))],
    // DI-17: every transition names its permission, and the version the permission that creates an aggregate.
    ['a transition without a permission', descriptor(createMachine({ id: 'bad_machine', initial: 'A', states: { A: { on: { GO: gmp('B') } }, B: { type: 'final' } } }))],
    ['a transition without GMP metadata', descriptor(createMachine({ id: 'bad_machine', initial: 'A', states: { A: { on: { GO: 'B' } }, B: { type: 'final' } } }))],
    [
      'a malformed create permission',
      descriptor(createMachine({ id: 'bad_machine', initial: 'A', states: { A: { on: { GO: gmp('B', { permission: 'bad_machine.go' }) } }, B: { type: 'final' } } }), 'bad_machine', 'Create'),
    ],
  ];
  for (const [name, d] of cases) {
    it(`refuses ${name}`, () => {
      expect(() => extractDefinition(d)).toThrow(MachineDefinitionError);
    });
  }
  it('accepts the same small machine once every transition and the version name their permissions', () => {
    const ok = descriptor(createMachine({ id: 'bad_machine', initial: 'A', states: { A: { on: { GO: gmp('B', { permission: 'bad_machine.go' }) } }, B: { type: 'final' } } }));
    expect(extractDefinition(ok)).toMatchObject({ create_permission: 'bad_machine.create', transitions: [{ from: 'A', event: 'GO', to: 'B', permission: 'bad_machine.go' }] });
  });
});
