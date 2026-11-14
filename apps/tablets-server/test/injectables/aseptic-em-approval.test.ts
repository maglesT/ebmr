/**
 * Injectables I-6, INV-23 (b) (lead ruling, 14 November 2026; 21 CFR 211.42(c)(10)(iv)): the database re-checks at QA
 * approval what the validator's rule INJ-ASEPTIC-EM refuses on screen. A master with a filling step (role FILLING) and
 * no terminal sterilisation step (role TERMINAL_STERILISATION) fills aseptically, and QA's approval is refused
 * (EBMR-RCP-439, editions/injectables/sql 3080) unless it has a step that monitors the environment during the
 * operation (EM_IN_OPERATION) and one after the fill that enters the counts (EM_COUNTS).
 * The bypass: the lifecycle world records the validator's evidence as a passing report (stub evidence, as a client
 * that skipped or forged the validator would), so only the database stands between the master and its approval.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes } from '@ebmr/api-contract';
import type { flow, library } from '@ebmr/recipe-core/pure';
import type { World } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { INJECTABLE_SEEDS } from '../../../../packages/recipe-core/src/library/seed/injectables.ts';
import { INJECTABLE_ASEPTIC_SEEDS } from '../../../../packages/recipe-core/src/library/seed/injectables-aseptic.ts';
import { startSigningServer, valueOf } from '../esig/support.ts';
import type { ExecServer } from '../execution/support.ts';
import { gmpContent, gmpLifecycleWorld } from '../support/gmp-world.ts';
import { confirmErpPending } from '../support/signed-acts.ts';
import { phaseOf, signAs, stage, type Json } from '../substance/support.ts';

const TAG = randomUUID().slice(0, 6).toUpperCase();
/** One product per master (one family per product, form and sizes). */
const PRODUCTS = [1, 2, 3, 4, 5].map((i) => ({ code: `INJEM${i}-${TAG}`, name: `Demoinj monitored ${i} mg/2 mL vials`, strength: `${i} mg/2 mL` }));
const seed = (code: string) => {
  const item = [...INJECTABLE_SEEDS, ...INJECTABLE_ASEPTIC_SEEDS].find((s) => s.definition.code === code);
  if (!item) throw new Error(`no injectables seed ${code}`);
  return item;
};
const FILL = seed('INJ-FILL');
const TERMINAL = seed('INJ-TERMINAL-STERILISE');
const EM = seed('INJ-EM');
const COUNTS = seed('INJ-EM-COUNTS');
/** The firm's own terminal sterilisation block: another code, the role TERMINAL_STERILISATION. */
const OWN_TERMINAL: library.BlockDefinition = {
  code: `FIRMTS-${TAG}`, version: 1, title: 'Our terminal sterilisation of the filled load', category: 'PROCESS', edition: 'injectables', roles: ['PARAMETER_RECORD', 'TERMINAL_STERILISATION'],
  description: 'The filled load sterilised in its final container.', instructions: 'Run the validated cycle.',
  sections: [{ id: 'cycle', title: 'Cycle', fields: [{ id: 'cyclePassed', label: 'Cycle passed', type: 'YES_NO', expected: true }] }],
  signatures: [{ meaning: 'PERFORMED', role: 'PRODUCTION_OPERATOR' }, { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' }],
};

let n = 0;
/** A processing master of the product (a family of its own each time), one stage per step. */
function master(title: string, steps: [string, library.BlockDefinition, Json][]): flow.MbrContent {
  n += 1;
  const product = PRODUCTS[n - 1];
  if (!product) throw new Error('add a product for this master');
  return gmpContent((m) => {
    const header = m['header'] as Json;
    header['family'] = `INJ-EMA-${TAG}-${n}`;
    header['edition'] = 'injectables';
    header['recordKind'] = 'PROCESSING';
    header['title'] = `${product.name}: ${title}`;
    header['product'] = { code: product.code, name: product.name, strength: product.strength, dosageForm: 'Injection' };
    delete header['unitMassMg'];
    const body = (m['procedure'] as Json)['body'] as Json;
    const like = (body['children'] as Json[])[0] as Json;
    body['children'] = steps.map(([id, def, use]) => stage(like, `S-${id.toUpperCase()}`, def.title, [phaseOf(def, id, use)]));
    for (const k of ['parameters', 'calculations', 'yieldCheckpoints', 'timeConstraints', 'goldenCases', 'intermediates', 'riskReductions', 'inputs']) m[k] = [];
    m['blockDefinitions'] = [...new Map(steps.map(([, def]) => [def.code, def])).values()];
  });
}
const use = (item: { exampleUse: unknown }) => item.exampleUse as Json;

let gmp: ExecServer;
let world: World;

/** QA's approval of the master past the validator (stub evidence): the refusal's message, or null when approved. */
async function approval(content: flow.MbrContent): Promise<string | null> {
  try {
    await world.approvedVersion(content);
    return null;
  } catch (e) {
    return String((e as Error).message);
  }
}

beforeAll(async () => {
  gmp = await startSigningServer('GMP', { stub: false });
  vi.useFakeTimers({ toFake: ['performance'] });
  const steward = await gmp.asPersona('steward');
  for (const p of PRODUCTS) {
    valueOf(await steward.call(routes.masterData.enterProduct, { body: { productCode: p.code, strength: p.strength, productName: p.name, dosageForm: 'Injection', betaLactam: false, shelfLifeMonths: 24, changeReason: 'Injectables I-6 INV-23 (b)' } }));
  }
  await confirmErpPending(gmp);
  const [author, approver] = await Promise.all([gmp.asPersona('author'), gmp.asPersona('approver')]);
  for (const def of [FILL.definition, TERMINAL.definition, EM.definition, COUNTS.definition, OWN_TERMINAL]) {
    const { block } = valueOf(await author.call(routes.library.draft, { body: { definition: def as unknown as Json } }));
    await signAs(gmp, approver, 'approver', { kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: block.blockId });
  }
  world = await gmpLifecycleWorld(gmp);
}, 900_000);
afterAll(async () => {
  vi.useRealTimers();
  await gmp?.close();
});

describe('Injectables I-6: the database refuses QA approval of an aseptic fill without its environmental monitoring (INV-23 (b))', () => {
  it('[INV-23] database bypass: an aseptic master with no EM step during the operation is refused at QA approval with EBMR-RCP-439, though its validator evidence passes; with EM during the operation but no counts after the fill it is refused too', async () => {
    expect(await approval(master('aseptic fill, no EM', [['p-fill', FILL.definition, use(FILL)]]))).toMatch(/EBMR-RCP-439 .*filling step p-fill fills aseptically .*no step that monitors the environment during the operation/);
    expect(await approval(master('aseptic fill, counts before', [['p-em', EM.definition, use(EM)], ['p-counts', COUNTS.definition, use(COUNTS)], ['p-fill', FILL.definition, use(FILL)]])))
      .toMatch(/EBMR-RCP-439 .*filling step p-fill fills aseptically and no step after it enters the environmental monitoring counts/);
  });

  it('[INV-23] an aseptic master with EM during the operation and the counts after the fill is approved', async () => {
    expect(await approval(master('aseptic fill with EM', [['p-em', EM.definition, use(EM)], ['p-fill', FILL.definition, use(FILL)], ['p-counts', COUNTS.definition, use(COUNTS)]]))).toBeNull();
  });

  it('[INV-23] a terminally sterilised master needs no EM step: with the catalogue terminal sterilisation, or the firm\'s own block of the role TERMINAL_STERILISATION, it is approved', async () => {
    expect(await approval(master('terminally sterilised', [['p-fill', FILL.definition, use(FILL)], ['p-ts', TERMINAL.definition, use(TERMINAL)]]))).toBeNull();
    expect(await approval(master('terminally sterilised, own block', [['p-fill', FILL.definition, use(FILL)], ['p-ts', OWN_TERMINAL, {}]]))).toBeNull();
  });
});
