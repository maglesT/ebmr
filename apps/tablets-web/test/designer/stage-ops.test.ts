/**
 * The designer's stage operations (Phase 7 slice 7j, R4; D-7j-8): add, rename, rebind, move and remove stages and their
 * equipment; the content stays well formed (parseMbr) with unique ids, every refusal leaves it as it was.
 */
import { describe, expect, it } from 'vitest';
import { flow, type library } from '@ebmr/recipe-core/pure';
import { CONTROL_SEEDS } from '../../../../packages/recipe-core/src/library/seed/controls.ts';
import granulation from '../../../../packages/recipe-core/test/fixtures/tablet-granulation-compression.mbr.json' with { type: 'json' };
import dcMini from '../../../../packages/recipe-core/test/fixtures/dc-mini.mbr.json' with { type: 'json' };
import newStageFixture from '../../../../packages/recipe-core/test/fixtures/designer-new-stage.json' with { type: 'json' };
import { applyOp, newStage, OpError, treeIds, type Content, type PaletteEntry } from '../../src/features/designer/model/ops.ts';

function parsed(json: unknown): Content {
  const r = flow.parseMbr(json);
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r.mbr;
}

const PALETTE: PaletteEntry[] = [
  { key: 'G-09@1', type: 'G-09', version: '1', plainName: 'Check equipment status', level: 'PHASE', significant: false, defaultConfig: {} },
  { key: 'G-09@2', type: 'G-09', version: '2', plainName: 'Check equipment status', level: 'PHASE', significant: false, defaultConfig: {} },
  { key: 'G-10@2', type: 'G-10', version: '2', plainName: 'Clear the room or line', level: 'PHASE', significant: true, defaultConfig: {} },
  { key: 'TB-07@1', type: 'TB-07', version: '1', plainName: 'Blend and lubricate', level: 'PHASE', significant: true, defaultConfig: {} },
];

const stagesOf = (c: Content): flow.StageNode[] => (c.procedure.body as flow.SequenceNode).children.filter((n): n is flow.StageNode => n.kind === 'stage');
const wellFormed = (c: Content): void => {
  expect(flow.parseMbr(JSON.parse(JSON.stringify(c))).ok).toBe(true);
  const ids = treeIds(c);
  expect(new Set(ids).size).toBe(ids.length);
};

describe('stage operations (slice 7j)', () => {
  const base = parsed(granulation);

  it('[DI-34] demo finding D-1: newStage builds exactly the stage the server test validates (fixture designer-new-stage.json)', () => {
    expect(newStage(parsed(dcMini), PALETTE, 'Layer 2 granulation', 'GRAN-2')).toEqual(newStageFixture);
  });

  it('[PR-03][DI-34] a new stage starts with its room clearance and equipment status (the database-backed versions) and goes where the author puts it', () => {
    const first = stagesOf(base)[0] as flow.StageNode;
    const stage = newStage(base, PALETTE, 'Film coating', 'COAT-1');
    expect(stage.binding.rooms).toEqual(['COAT-1']);
    // Demo finding D-1: the phases sit in an operation of the stage (an optional level, ADR 0004 decision 1 as amended).
    const ops = (stage.body as flow.SequenceNode).children as flow.OperationNode[];
    expect(ops.map((o) => [o.kind, o.name])).toEqual([['operation', 'Film coating: preparation']]);
    const steps = ((ops[0] as flow.OperationNode).body as flow.SequenceNode).children as flow.PhaseNode[];
    expect(steps.map((s) => `${s.block.type}@${s.block.version}`)).toEqual(['G-10@2', 'G-09@2']);
    const c = applyOp(base, { kind: 'ADD_STAGE', afterStageId: first.id, stage });
    wellFormed(c);
    expect(stagesOf(c)[1]?.id).toBe(stage.id);
    expect(stagesOf(c)).toHaveLength(stagesOf(base).length + 1);
    // The same stage twice: its ids are already used.
    expect(() => applyOp(c, { kind: 'ADD_STAGE', afterStageId: null, stage })).toThrow(OpError);
  });

  it('[PR-03][PR-31] R-flow item 4: a stage takes a written reason for having no yield, and loses it with an empty text', () => {
    const [a] = stagesOf(base) as [flow.StageNode];
    const c = applyOp(base, { kind: 'UPDATE_STAGE', stageId: a.id, patch: { noYieldReason: '  Yield taken at the end of the next stage  ' } });
    wellFormed(c);
    expect(stagesOf(c)[0]?.noYieldReason).toBe('Yield taken at the end of the next stage');
    const cleared = applyOp(c, { kind: 'UPDATE_STAGE', stageId: a.id, patch: { noYieldReason: ' ' } });
    expect('noYieldReason' in (stagesOf(cleared)[0] as flow.StageNode)).toBe(false);
    expect(() => applyOp(base, { kind: 'UPDATE_STAGE', stageId: a.id, patch: { noYieldReason: 'x'.repeat(10_000) } })).toThrow(OpError);
  });

  it('[PR-03] R-rest A6: a stage takes the earlier stage whose clearance it continues, and loses it with an empty choice', () => {
    const [a, b] = stagesOf(base) as [flow.StageNode, flow.StageNode];
    const c = applyOp(base, { kind: 'UPDATE_STAGE', stageId: b.id, patch: { clearanceFrom: a.id } });
    wellFormed(c);
    expect(stagesOf(c)[1]?.clearanceFrom).toBe(a.id);
    const cleared = applyOp(c, { kind: 'UPDATE_STAGE', stageId: b.id, patch: { clearanceFrom: '' } });
    expect('clearanceFrom' in (stagesOf(cleared)[1] as flow.StageNode)).toBe(false);
  });

  it('[PR-03] stages move, are renamed and rebound, take and lose equipment by a pinned class, and are removed; refusals change nothing', () => {
    const [a, b] = stagesOf(base) as [flow.StageNode, flow.StageNode];
    let c = applyOp(base, { kind: 'MOVE_STAGE', stageId: b.id, direction: -1 });
    expect(stagesOf(c)[0]?.id).toBe(b.id);
    expect(() => applyOp(c, { kind: 'MOVE_STAGE', stageId: b.id, direction: -1 })).toThrow('already first');
    c = applyOp(c, { kind: 'UPDATE_STAGE', stageId: a.id, patch: { name: 'Dispensing of raw materials', rooms: ['DISP-2', ' DISP-3 '] } });
    expect(stagesOf(c).find((s) => s.id === a.id)?.binding.rooms).toEqual(['DISP-2', 'DISP-3']);
    expect(() => applyOp(c, { kind: 'UPDATE_STAGE', stageId: a.id, patch: { rooms: ['disp 2'] } })).toThrow(OpError);
    const reference: flow.Reference = { id: 'EQC-COATER', kind: 'EQUIPMENT_CLASS', code: 'EQC-COATER', version: '1', hash: 'a'.repeat(64), title: 'Pan coater' };
    c = applyOp(c, { kind: 'ADD_STAGE_EQUIPMENT', stageId: a.id, equipment: { ref: 'COATER', equipmentClass: 'EQC-COATER', kind: 'PROCESS' }, reference });
    expect(c.references.filter((r) => r.id === 'EQC-COATER')).toHaveLength(1);
    expect(() => applyOp(c, { kind: 'ADD_STAGE_EQUIPMENT', stageId: a.id, equipment: { ref: 'X', equipmentClass: 'EQC-NONE', kind: 'PROCESS' } })).toThrow('not an equipment class');
    c = applyOp(c, { kind: 'REMOVE_STAGE_EQUIPMENT', stageId: a.id, ref: 'COATER' });
    expect(stagesOf(c).find((s) => s.id === a.id)?.binding.equipment.some((e) => e.ref === 'COATER')).toBe(false);
    wellFormed(c);
    c = applyOp(c, { kind: 'DELETE_STAGE', stageId: a.id });
    expect(stagesOf(c).some((s) => s.id === a.id)).toBe(false);
    wellFormed(c);
    let only = c;
    while (stagesOf(only).length > 1) only = applyOp(only, { kind: 'DELETE_STAGE', stageId: (stagesOf(only)[0] as flow.StageNode).id });
    expect(() => applyOp(only, { kind: 'DELETE_STAGE', stageId: (stagesOf(only)[0] as flow.StageNode).id })).toThrow('at least one stage');
  });

  it('equipment a step still checks or uses cannot be removed from its stage', () => {
    let used: { stage: string; ref: string } | null = null;
    for (const s of stagesOf(base)) {
      flow.walk(s.body, (n) => {
        if (!used && n.kind === 'phase' && n.equipment.length > 0) used = { stage: s.id, ref: (n.equipment[0] as { ref: string }).ref };
      });
    }
    expect(used).not.toBeNull();
    const u = used as unknown as { stage: string; ref: string };
    expect(() => applyOp(base, { kind: 'REMOVE_STAGE_EQUIPMENT', stageId: u.stage, ref: u.ref })).toThrow('still checks or uses');
  });
});

/**
 * Owner retest N-3 (10 November 2026): a new stage gets its own yield step (an approved yield library block appended at
 * the stage's end), and the author names the formula lines whose scaled sum is its theoretical quantity when the batch
 * size does not convert to the yield's unit (SET_INPUT_LINES); an empty choice removes the binding.
 */
describe('N-3: a stage\'s own yield step and its theoretical quantity', () => {
  const yieldDef = CONTROL_SEEDS.find((x) => x.definition.code === 'CTRL-YIELD')?.definition as library.BlockDefinition;

  it('[PR-03][PR-31] a yield step is added at the end of a new stage, and its theoretical quantity reads the lines the author names', () => {
    const base = parsed(granulation);
    const stage = newStage(base, PALETTE, 'Bilayer compression', 'COMP-1');
    let c = applyOp(base, { kind: 'ADD_STAGE', afterStageId: null, stage });
    const seq = stagesOf(c).find((s) => s.id === stage.id)?.body as flow.SequenceNode;
    c = applyOp(c, { kind: 'ADD_LIBRARY_BLOCK', sequenceId: seq.id, index: seq.children.length, stepId: 'p-ctrl-yield', definition: yieldDef });
    wellFormed(c);
    const steps = (stagesOf(c).find((s) => s.id === stage.id)?.body as flow.SequenceNode).children;
    expect(steps[steps.length - 1]?.id).toBe('p-ctrl-yield');
    const step = (): flow.PhaseNode => {
      let found: flow.PhaseNode | undefined;
      flow.walk(c.procedure.body, (n) => {
        if (n.id === 'p-ctrl-yield' && n.kind === 'phase') found = n;
      });
      return found as flow.PhaseNode;
    };
    c = applyOp(c, { kind: 'SET_INPUT_LINES', stepId: 'p-ctrl-yield', inputId: 'theoretical', lines: ['BOM-ATV', 'BOM-MCC', 'BOM-ATV'] });
    expect((step().config as { inputLines?: unknown }).inputLines).toEqual({ theoretical: ['BOM-ATV', 'BOM-MCC'] });
    wellFormed(c);
    // Refusals change nothing: an unknown line, an input that is not a batch size, a step that is not a library step.
    expect(() => applyOp(c, { kind: 'SET_INPUT_LINES', stepId: 'p-ctrl-yield', inputId: 'theoretical', lines: ['BOM-NONE'] })).toThrow(OpError);
    expect(() => applyOp(c, { kind: 'SET_INPUT_LINES', stepId: 'p-ctrl-yield', inputId: 'output', lines: ['BOM-ATV'] })).toThrow(OpError);
    const clearance = ((stage.body as flow.SequenceNode).children[0] as flow.OperationNode).body as flow.SequenceNode;
    expect(() => applyOp(c, { kind: 'SET_INPUT_LINES', stepId: clearance.children[0]?.id ?? '', inputId: 'theoretical', lines: ['BOM-ATV'] })).toThrow(OpError);
    c = applyOp(c, { kind: 'SET_INPUT_LINES', stepId: 'p-ctrl-yield', inputId: 'theoretical', lines: [] });
    expect((step().config as { inputLines?: unknown }).inputLines).toBeUndefined();
  });
});
