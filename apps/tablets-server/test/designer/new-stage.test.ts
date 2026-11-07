/**
 * Demo finding D-1 (bilayer MGL-SR-BL, 7 November 2026): a stage added in the designer (newStage, the "Add a stage"
 * form) passes the full validator against the real adapters. Its room clearance and equipment status sit in an
 * operation of the stage, never directly in it (FLOW-LEVELS, DI-34), and the stage takes its own yield step there.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { librarySeed } from '@ebmr/recipe-core';
import { flow, type library, validator } from '@ebmr/recipe-core/pure';
import { applyOp, newStage, type Content, type PaletteEntry } from '../../../tablets-web/src/features/designer/model/ops.ts';
import { loadValidationContext } from '../../src/features/designer/adapters/expressions.ts';
import type { TestServer } from '../support/harness.ts';
import { startDesignerServer, templateMbr } from './support.ts';

let server: TestServer;

beforeAll(async () => {
  server = await startDesignerServer();
});
afterAll(async () => {
  await server?.close();
});

const stagesOf = (c: Content): flow.StageNode[] => (c.procedure.body as flow.SequenceNode).children.filter((n): n is flow.StageNode => n.kind === 'stage');

async function findings(c: Content): Promise<validator.ValidationReport['findings']> {
  const { context } = await loadValidationContext(server.db.app, c);
  return validator.validateMbr(c, context).findings;
}

async function palette(c: Content): Promise<PaletteEntry[]> {
  const { context } = await loadValidationContext(server.db.app, c);
  return ['G-09', 'G-10'].flatMap((type) => (context.blocks.describe(type)?.versions ?? []).map((version) => ({ key: `${type}@${version}`, type, version, plainName: type, level: 'PHASE' as const, significant: type === 'G-10', defaultConfig: {} })));
}

describe('a new stage in the designer (demo finding D-1)', () => {
  it('[DI-34][PR-03] a stage added to a valid master passes the full validator: its clearance and status are in an operation', async () => {
    const base = templateMbr();
    expect(await findings(base)).toEqual([]);
    const stage = newStage(base, await palette(base), 'Layer 2 granulation', 'GRAN-2');
    const body = stage.body as flow.SequenceNode;
    expect(body.children.map((n) => n.kind)).toEqual(['operation']);
    const c = applyOp(base, { kind: 'ADD_STAGE', afterStageId: (stagesOf(base)[0] as flow.StageNode).id, stage });
    expect((await findings(c)).map((f) => f.rule)).toEqual(['GMP-STAGE-YIELD']);
    // The stage's own yield: the library yield block at the end of its operation.
    const item = librarySeed.SEED_CATALOGUE.find((i) => i.definition.code === 'CTRL-YIELD');
    const yieldBlock = item?.definition as library.BlockDefinition;
    const seq = ((stagesOf(c).find((s) => s.id === stage.id) as flow.StageNode).body as flow.SequenceNode).children[0] as flow.OperationNode;
    const opSeq = seq.body as flow.SequenceNode;
    const withYield = applyOp(c, { kind: 'ADD_LIBRARY_BLOCK', sequenceId: opSeq.id, index: opSeq.children.length, stepId: 'p-l2-yield', definition: yieldBlock });
    // Without its limits the yield step has no minimum and maximum (PR-31): refused.
    expect((await findings(withYield)).map((f) => `${f.rule} ${f.subject}`)).toEqual(['GMP-YIELDS p-l2-yield', 'GMP-YIELDS p-l2-yield']);
    // With the product's limits (the catalogue's example use) the stage carries its own yield and the master passes.
    let step: flow.PhaseNode | undefined;
    flow.walk(withYield.procedure.body, (n) => {
      if (n.kind === 'phase' && n.id === 'p-l2-yield') step = n;
    });
    if (!step) throw new Error('the yield step was not inserted');
    Object.assign(step.config, structuredClone(item?.exampleUse));
    expect(await findings(withYield)).toEqual([]);
  });

  // The designer is shared by every edition (capsules are the tablets edition with a capsule dosage form).
  it.each([
    ['injectables', 'Injection'],
    ['substance', 'API'],
    ['tablets', 'Hard capsule'],
  ] as const)('[DI-34][PR-03] edition %s, dosage form %s: a new stage with its yield step adds no finding', async (edition, dosageForm) => {
    const base = templateMbr();
    base.header.edition = edition;
    base.header.product.dosageForm = dosageForm;
    const keys = async (c: Content): Promise<string[]> => (await findings(c)).map((f) => f.key).sort();
    const before = await keys(base);
    const stage = newStage(base, await palette(base), 'Pellets B', 'GRAN-2');
    let c = applyOp(base, { kind: 'ADD_STAGE', afterStageId: null, stage });
    const opSeq = ((stage.body as flow.SequenceNode).children[0] as flow.OperationNode).body as flow.SequenceNode;
    const item = librarySeed.SEED_CATALOGUE.find((i) => i.definition.code === 'CTRL-YIELD');
    c = applyOp(c, { kind: 'ADD_LIBRARY_BLOCK', sequenceId: opSeq.id, index: opSeq.children.length, stepId: 'p-b-yield', definition: item?.definition as library.BlockDefinition });
    flow.walk(c.procedure.body, (n) => {
      if (n.kind === 'phase' && n.id === 'p-b-yield') Object.assign(n.config, structuredClone(item?.exampleUse));
    });
    expect(await keys(c)).toEqual(before);
  });
});
