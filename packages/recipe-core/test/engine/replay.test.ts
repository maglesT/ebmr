/**
 * Replay of stored execution rows (module C3; DI-34, INV-19, INV-20, INV-25): both tablet fixtures run to
 * completion (with PREPARE rows before signed commands, SWEEP rows and refused commands) replay
 * identically; a tampered command, clock, state hash or row order is reported at that row.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decode, encode } from '../../src/engine/codec.ts';
import type { BatchDefinition } from '../../src/engine/definition.ts';
import { replay, type ExecutionRow } from '../../src/engine/replay.ts';
import type { Command, IssueRequest } from '../../src/engine/types.ts';
import { buildFlow, candidateCommands, GENERATED_DATA, shapes } from './model-support.ts';
import { Recorder } from './recorder.ts';
import { autopilot, define, FIXTURE_INPUTS, fixtureDefinition, flatGranulationDefinition, GRANULATION_SCENARIO, MIN, OP1, PACKAGING_SCENARIO, Run, SUP1, T0, type Scenario } from './support.ts';

type Name = 'tablet-granulation-compression' | 'tablet-blister-packaging';

function request(def: BatchDefinition, name?: Name): IssueRequest {
  return {
    batchId: 'BATCH-1',
    batchNumber: 'TEST-B0001',
    batchSize: def.mbr.header.batchSizes[0]?.id ?? '',
    marketSet: [...def.mbr.header.marketSet],
    inputs: name ? FIXTURE_INPUTS[name] : {},
    ...(name === 'tablet-blister-packaging' ? { variants: { packDestination: 'US-EXPORT' } } : {}),
    issuedBy: SUP1,
  };
}

/**
 * Runs a fixture to completion on autopilot while a recorder mirrors every command the way the store
 * persists it (PREPARE, COMMAND, a SWEEP every few commands), plus one refused command.
 */
function recordedRun(name: Name, scenario: Scenario, def: BatchDefinition = fixtureDefinition(name)): { def: BatchDefinition; rows: ExecutionRow[] } {
  const rec = Recorder.issue(def, request(def, name), T0);
  const run = Run.issue(def, request(def, name), T0);
  let n = 0;
  const original = run.exec.bind(run);
  run.exec = (input) => {
    n += 1;
    const cmd = { ...input, commandId: input.commandId ?? `R-${n}` } as Command;
    if (n % 7 === 0) rec.sweep(run.nowUs);
    rec.exec(cmd, run.nowUs);
    return original(cmd);
  };
  // A refused command (out of sequence) is stored too.
  run.exec({ type: 'START_STEP', actor: OP1, step: [...def.steps.keys()].at(-1) ?? '' });
  expect(autopilot(run, scenario)).toBe('COMPLETE');
  expect(rec.state.status).toBe('EXECUTION_COMPLETE');
  rec.sweep(run.nowUs + 1000n * MIN);
  return { def, rows: rec.rows };
}

const cache = new Map<Name, { def: BatchDefinition; rows: ExecutionRow[] }>();
function fixtureRows(name: Name): { def: BatchDefinition; rows: ExecutionRow[] } {
  let r = cache.get(name);
  if (!r) {
    r = recordedRun(name, name === 'tablet-granulation-compression' ? GRANULATION_SCENARIO : PACKAGING_SCENARIO);
    cache.set(name, r);
  }
  return r;
}

function withCommand(row: ExecutionRow, change: (c: Record<string, unknown>) => void): ExecutionRow {
  const c = decode(row.command) as Record<string, unknown>;
  change(c);
  return { ...row, command: encode(c) };
}

describe('replay of stored execution rows', { timeout: 240_000 }, () => {
  for (const name of ['tablet-granulation-compression', 'tablet-blister-packaging'] as const) {
    it(`[DI-34][INV-19][INV-20][INV-25] ${name} run to completion replays identically, row for row, with every invariant holding`, () => {
      const { def, rows } = fixtureRows(name);
      expect(rows.some((r) => !r.accepted)).toBe(true);
      if (name === 'tablet-granulation-compression') expect(rows.map((r) => r.kind)).toContain('PREPARE');
      const r = replay(def, rows);
      expect(r.firstDifference).toBeNull();
      expect(r.identical).toBe(true);
      expect(r.invariantViolations).toEqual([]);
      expect(r.state?.status).toBe('EXECUTION_COMPLETE');
    });
  }

  it('[DI-34][INV-19][INV-20] R-flow item 1: the granulation master with no operation (its phases directly in its stages) replays identically, row for row', () => {
    const { def, rows } = recordedRun('tablet-granulation-compression', GRANULATION_SCENARIO, flatGranulationDefinition());
    const r = replay(def, rows);
    expect(r.firstDifference).toBeNull();
    expect(r.identical).toBe(true);
    expect(r.invariantViolations).toEqual([]);
    expect(r.state?.status).toBe('EXECUTION_COMPLETE');
  });

  it('[DI-34] a tampered value, clock or state hash is reported at the row where it was changed', () => {
    const { def, rows } = fixtureRows('tablet-granulation-compression');
    const k = rows.findIndex((r) => r.kind === 'COMMAND' && r.accepted && (decode(r.command) as Command).type === 'RECORD_DATA');
    expect(k).toBeGreaterThan(0);
    const tamper = (i: number, row: ExecutionRow): ExecutionRow[] => rows.map((r, j) => (j === i ? row : r));
    const value = replay(def, tamper(k, withCommand(rows[k] as ExecutionRow, (c) => ((c['value'] as { value: string }).value = '123.45'))));
    expect(value.firstDifference?.seq).toBe(rows[k]?.seq);
    const clock = replay(def, tamper(k, { ...(rows[k] as ExecutionRow), nowUs: (rows[k] as ExecutionRow).nowUs + 1n }));
    expect(clock.firstDifference?.seq).toBe(rows[k]?.seq);
    expect(['eventsHash', 'stateHash']).toContain(clock.firstDifference?.field);
    const hash = replay(def, tamper(k, { ...(rows[k] as ExecutionRow), stateHash: 'f'.repeat(64) }));
    expect(hash.firstDifference).toMatchObject({ seq: rows[k]?.seq, field: 'stateHash' });
    const accepted = replay(def, tamper(k, { ...(rows[k] as ExecutionRow), accepted: false }));
    expect(accepted.firstDifference).toMatchObject({ seq: rows[k]?.seq, field: 'accepted' });
    const missing = replay(def, rows.filter((_, j) => j !== k));
    expect(missing.firstDifference?.seq).toBe(rows[k + 1]?.seq);
  });

  it('[DI-34][INV-20] random command sequences on generated flows replay identically', () => {
    fc.assert(
      fc.property(shapes.node, fc.array(fc.record({ pick: fc.nat({ max: 1000 }), minutes: fc.constantFrom(0, 1, 7, 30), k: fc.nat({ max: 100 }), sweep: fc.boolean() }), { minLength: 5, maxLength: 60 }), (shape, moves) => {
        const def = define(buildFlow(shape));
        const rec = Recorder.issue(def, request(def), T0);
        const run = new Run(def, rec.state, T0, { checkInvariants: false });
        let now = T0;
        let n = 0;
        for (const m of moves) {
          now += BigInt(m.minutes) * MIN;
          if (m.sweep) rec.sweep(now);
          run.state = rec.state;
          run.nowUs = now;
          const c = candidateCommands(def, run, m.k, m.k % 2 === 0, GENERATED_DATA);
          const input = c.all[m.pick % Math.max(1, c.all.length)];
          if (input) rec.exec({ ...input, commandId: `G-${++n}` }, now);
        }
        const r = replay(def, rec.rows);
        expect(r.firstDifference).toBeNull();
      }),
      { numRuns: 30 },
    );
  });
});
