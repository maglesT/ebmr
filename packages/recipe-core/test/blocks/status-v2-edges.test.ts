/**
 * G-09@2 and G-10@2 (database-backed equipment use and area occupancy; PR-23, PR-34, IN-21) at their edges, through
 * their handlers on a minimal view: only the units the step checks, each once; PERFORMED needs every unit (or one when
 * the step names none) and the occupied area; a clearance step names its checker; the nominal entries. The database
 * binding of the use and occupancy is proved in test/plant/status-blocks.test.ts. Written for the Phase 3 exit mutation
 * run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import { G09V2, G10V2 } from '../../src/blocks/generic/status.ts';
import type { HandlerView } from '../../src/blocks/contract.ts';
import type { PhaseNode } from '../../src/flow/model.ts';

type Json = Record<string, unknown>;
const U1 = '00000000-0000-4000-9000-000000000001';

class World {
  entries: { id: string; kind: string; data: Json; recordedAt: bigint }[] = [];
  constructor(readonly phase: Json) {}
  view(): HandlerView {
    return { phase: this.phase, config: {}, stepKey: 'p@', nowUs: 0n, entries: (k?: string) => this.entries.filter((e) => k === undefined || e.kind === k), actor: { id: 'OP1' } } as unknown as HandlerView;
  }
  rec(block: typeof G09V2, entry: Json & { kind: string }): { refused?: string; data?: Json } {
    const r = (block.handler?.acceptEntry as (v: HandlerView, e: Json) => { ok: boolean; data?: Json; problems?: { message: string }[] })(this.view(), entry);
    if (!r.ok) return { refused: (r.problems ?? []).map((p) => p.message).join(' | ') };
    this.entries.push({ id: `E${this.entries.length}`, kind: entry.kind, data: r.data ?? {}, recordedAt: 0n });
    return { data: r.data ?? {} };
  }
  before(block: typeof G09V2): string[] {
    return (block.handler?.beforePerform as (v: HandlerView) => { message: string }[])(this.view()).map((p) => p.message);
  }
}
const eq = (...refs: [string, string][]) => ({ id: 'p', equipment: refs.map(([ref, use]) => ({ ref, use })) });
const use = (equipmentRef: string) => ({ kind: 'EQUIPMENT_USE', equipmentRef, equipmentCode: 'PRESS-01', useId: U1 });

describe('G-09@2 equipment use', () => {
  it('[PR-23][INV-12] only the units the step checks, each once, with the plant use; PERFORMED needs every one', () => {
    const w = new World(eq(['BAL', 'STATUS_CHECK'], ['MIX', 'USE'], ['PRESS', 'STATUS_CHECK']));
    expect(w.rec(G09V2, use('MIX')).refused).toBe('MIX is not equipment this step checks (BAL, PRESS) (G09-EQUIPMENT; PR-23, PR-22)');
    expect(w.before(G09V2)).toEqual(['Start the use of BAL, PRESS first (G09-INCOMPLETE; PR-23)']);
    expect(w.rec(G09V2, use('BAL')).data).toStrictEqual({ equipmentRef: 'BAL', equipmentCode: 'PRESS-01', useId: U1, recordedBy: 'OP1' });
    expect(w.rec(G09V2, use('BAL')).refused).toBe('The unit for BAL is already recorded at p@ (G09-TWICE; PR-23)');
    expect(w.before(G09V2)).toEqual(['Start the use of PRESS first (G09-INCOMPLETE; PR-23)']);
    expect(w.rec(G09V2, use('PRESS')).refused).toBeUndefined();
    expect(w.before(G09V2)).toEqual([]);
  });

  it('[PR-23] a step naming no unit to check takes any unit, and needs at least one', () => {
    const w = new World(eq(['MIX', 'USE']));
    expect(w.before(G09V2)).toEqual(['Start the use of the equipment of p first (G09-INCOMPLETE; PR-23)']);
    expect(w.rec(G09V2, use('ANY')).refused).toBeUndefined();
    expect(w.rec(G09V2, use('OTHER')).refused).toBeUndefined();
    expect(w.rec(G09V2, use('ANY')).refused).toMatch(/G09-TWICE/);
    expect(w.before(G09V2)).toEqual([]);
  });

  it('[PR-23] the nominal entries use each checked unit, or one stand-in, with a plant code and a use id', () => {
    const nominal = (phase: Json) => G09V2.simulatorModel?.nominalEntries?.({ phase } as never) as Json[];
    expect(nominal(eq(['B.A-L', 'STATUS_CHECK'], ['P2', 'STATUS_CHECK']))).toEqual([
      { kind: 'EQUIPMENT_USE', equipmentRef: 'B.A-L', equipmentCode: 'TEST-BA-L', useId: U1 },
      { kind: 'EQUIPMENT_USE', equipmentRef: 'P2', equipmentCode: 'TEST-P2', useId: '00000000-0000-4000-9000-000000000002' },
    ]);
    expect(nominal(eq())).toEqual([{ kind: 'EQUIPMENT_USE', equipmentRef: 'EQUIPMENT', equipmentCode: 'TEST-EQUIPMENT', useId: U1 }]);
    expect((nominal(eq(['X'.repeat(80), 'STATUS_CHECK']))[0]?.['equipmentCode'] as string).length).toBe(64);
  });
});

describe('G-10@2 area occupancy', () => {
  it('[PR-34][IN-21] one occupied area, needed before PERFORMED; a clearance names its checker', () => {
    const w = new World({ id: 'p', equipment: [] });
    expect(w.before(G10V2)).toEqual(['Record the cleared room or line the batch occupies first (G10-INCOMPLETE; PR-34, IN-21)']);
    expect(w.rec(G10V2, { kind: 'AREA_OCCUPANCY', areaCode: 'ROOM-1', occupancyId: U1 }).data).toStrictEqual({ areaCode: 'ROOM-1', occupancyId: U1, recordedBy: 'OP1' });
    expect(w.rec(G10V2, { kind: 'AREA_OCCUPANCY', areaCode: 'ROOM-2', occupancyId: U1 }).refused).toBe('The area of p@ is already recorded (G10-TWICE; PR-34)');
    expect(w.before(G10V2)).toEqual([]);
    const check = (signatures: Json) => G10V2.checkConfig?.({ id: 'p', signatures } as unknown as PhaseNode, {}, {} as never);
    expect(check({ check: { role: 'VERIFIER' } })).toEqual([]);
    expect(check({})).toEqual([{ code: 'G10-NO-CHECKER', severity: 'ERROR', message: 'Clearance step p names no checker: a clearance is a significant step with an independent checker', controls: ['PR-14', 'PR-34'] }]);
    expect(G10V2.handler?.meanings).toEqual({ perform: ['LINE_CLEARANCE_PERFORMED'], check: ['LINE_CLEARANCE_VERIFIED'] });
    expect(G10V2.simulatorModel?.nominalEntries?.({} as never)).toEqual([{ kind: 'AREA_OCCUPANCY', areaCode: 'TEST-ROOM', occupancyId: '00000000-0000-4000-9000-000000000101' }]);
  });
});
