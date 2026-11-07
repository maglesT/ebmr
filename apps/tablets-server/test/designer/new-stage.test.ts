/**
 * Demo finding D-1 (bilayer MGL-SR-BL, 7 November 2026): a stage added in the designer passes the full validator against
 * the real adapters. The stage is the designer's own `newStage` output (fixture designer-new-stage.json, which
 * apps/tablets-web/test/designer/stage-ops.test.ts proves newStage builds; a server test does not import the web app).
 * Its room clearance and equipment status sit in an operation of the stage, never directly in it (FLOW-LEVELS, DI-34),
 * and the stage takes its own yield step there: the library yield block, as the designer inserts it
 * (library.libraryPhase with the definition carried, ADD_LIBRARY_BLOCK).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { librarySeed } from '@ebmr/recipe-core';
import { flow, library, validator } from '@ebmr/recipe-core/pure';
import stageFixture from '../../../../packages/recipe-core/test/fixtures/designer-new-stage.json' with { type: 'json' };
import dcMini from '../../../../packages/recipe-core/test/fixtures/dc-mini.mbr.json' with { type: 'json' };
import { loadValidationContext } from '../../src/features/designer/adapters/expressions.ts';
import type { TestServer } from '../support/harness.ts';
import { startDesignerServer } from './support.ts';

let server: TestServer;

beforeAll(async () => {
  server = await startDesignerServer();
});
afterAll(async () => {
  await server?.close();
});

type Content = flow.MbrContent;
const YIELD = librarySeed.SEED_CATALOGUE.find((i) => i.definition.code === 'CTRL-YIELD');

function base(): Content {
  const r = flow.parseMbr(structuredClone(dcMini));
  if (!r.ok) throw new Error('the dc-mini fixture does not parse');
  return r.mbr;
}

async function findings(c: Content): Promise<validator.ValidationReport['findings']> {
  const { context } = await loadValidationContext(server.db.app, c);
  return validator.validateMbr(c, context).findings;
}

/** The content with the designer's new stage after the first stage (ADD_STAGE). */
function withStage(c: Content, after: 'first' | 'last' = 'first'): Content {
  const out = structuredClone(c);
  const seq = out.procedure.body as flow.SequenceNode;
  const at = after === 'first' ? 1 : seq.children.length;
  seq.children.splice(at, 0, structuredClone(stageFixture) as unknown as flow.StageNode);
  return out;
}

/** The library yield block at the end of the stage's operation, with the product's limits or none (ADD_LIBRARY_BLOCK). */
function withYield(c: Content, limits: boolean): Content {
  const out = structuredClone(c);
  const def = YIELD?.definition as library.BlockDefinition;
  let op: flow.SequenceNode | undefined;
  flow.walk(out.procedure.body, (n) => {
    if (n.kind === 'operation' && n.id === 'O-LAYER-2-GRANULATION-PREP' && n.body.kind === 'sequence') op = n.body;
  });
  if (!op) throw new Error('the new stage has no preparation operation');
  const step = library.libraryPhase(def, 'p-l2-yield', 'MEDIUM');
  if (limits) Object.assign(step.config, structuredClone(YIELD?.exampleUse));
  op.children.push(step);
  out.blockDefinitions = library.withSnapshot(out, def);
  return out;
}

describe('a new stage in the designer (demo finding D-1)', () => {
  it('[DI-34][PR-03] the stage the designer adds passes the full validator: its clearance and status are in an operation, at the latest block versions', async () => {
    const c = base();
    expect(await findings(c)).toEqual([]);
    // The fixture holds the latest G-10 and G-09 the installation registers (the palette offers the latest).
    const { context } = await loadValidationContext(server.db.app, c);
    const latest = (t: string): string => [...(context.blocks.describe(t)?.versions ?? [])].sort((a, b) => Number(b) - Number(a))[0] ?? '';
    const used: string[] = [];
    flow.walk(stageFixture as unknown as flow.StageNode, (n) => {
      if (n.kind === 'phase') used.push(`${n.block.type}@${n.block.version}`);
    });
    expect(used).toEqual([`G-10@${latest('G-10')}`, `G-09@${latest('G-09')}`]);
    const staged = withStage(c);
    expect((await findings(staged)).map((f) => f.rule)).toEqual(['GMP-STAGE-YIELD']);
    // Its own yield: without the product's limits the yield has no minimum and maximum (PR-31) and is refused.
    expect((await findings(withYield(staged, false))).map((f) => `${f.rule} ${f.subject}`)).toEqual(['GMP-YIELDS p-l2-yield', 'GMP-YIELDS p-l2-yield']);
    expect(await findings(withYield(staged, true))).toEqual([]);
  });

  // The designer is shared by every edition (capsules are the tablets edition with a capsule dosage form).
  it.each([
    ['injectables', 'Injection'],
    ['substance', 'API'],
    ['tablets', 'Hard capsule'],
  ] as const)('[DI-34][PR-03] edition %s, dosage form %s: a new stage with its yield step adds no finding', async (edition, dosageForm) => {
    const c = base();
    c.header.edition = edition;
    c.header.product.dosageForm = dosageForm;
    const keys = async (x: Content): Promise<string[]> => (await findings(x)).map((f) => f.key).sort();
    expect(await keys(withYield(withStage(c, 'last'), true))).toEqual(await keys(c));
  });
});
