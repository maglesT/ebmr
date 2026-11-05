/**
 * Earlier-step values on a GMP server (decision 0026 STEP_VALUE; injectables I-1 finding, lead 5 November 2026): a
 * master whose library step reads a value recorded by an earlier library step (as potency-adjusted dispensing reads the
 * LOD of the lot). The batch runs both steps from the master's snapshots; the server computes the later step's figure
 * from the earlier step's completed record and stores it with its evaluation record, the value read among its inputs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { library } from '@ebmr/recipe-core/pure';
import { valueOf } from '../esig/support.ts';
import { RunDriver } from '../execution/support.ts';
import type { TestServer } from '../support/harness.ts';
import { gmpContent, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import { signAction } from '../support/signed-acts.ts';

type Json = Record<string, unknown>;
let w: GmpBatchWorld;

const LOD = {
  code: 'IPC-LOD-SV',
  version: 1,
  title: 'Loss on drying of the lot',
  category: 'TEST_IPC',
  sections: [{ id: 'test', title: 'Test', fields: [{ id: 'lod', label: 'LOD', type: 'NUMBER', unit: '%' }] }],
  signatures: [{ meaning: 'PERFORMED', role: 'PRODUCTION_OPERATOR' }],
};
const WET = {
  code: 'PROC-WET-SV',
  version: 1,
  title: 'Quantity on the as-is basis',
  category: 'PROCESS',
  inputs: [{ id: 'lodLot', label: 'LOD of the lot', kind: 'STEP_VALUE', unit: '%', slot: 'lodSource' }],
  sections: [
    {
      id: 'calc',
      title: 'Calculation',
      fields: [
        { id: 'dry', label: 'Quantity on the dried basis', type: 'NUMBER', unit: 'kg' },
        { id: 'asIs', label: 'Quantity as is', type: 'CALC', expression: 'dry * 100 [%] / (100 [%] - lodLot)', unit: 'kg' },
      ],
    },
  ],
  signatures: [{ meaning: 'PERFORMED', role: 'PRODUCTION_OPERATOR' }],
};
const hash = (d: object): string => library.definitionHash(d as unknown as library.BlockDefinition);

const phase = (id: string, def: { code: string }, config: Json): Json => ({
  kind: 'phase', id, name: id, block: { type: `LIB-${def.code}`, version: '1' }, config: { hash: hash(def), ...config },
  records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [], signatures: { perform: { role: 'PRODUCTION_OPERATOR' } }, significant: false, riskClass: 'HIGH',
});

/** dc-mini as a GMP master with, first in its dispensing preparation, the LOD step and then the step that reads it. */
const content = () =>
  gmpContent((m) => {
    const stage = ((((m['procedure'] as Json)['body'] as Json)['children'] as Json[])[0] as Json)['body'] as Json;
    const prep = ((stage['children'] as Json[])[0] as Json)['body'] as Json;
    prep['children'] = [phase('p-lod', LOD, {}), phase('p-wet', WET, { stepValues: { lodSource: { step: 'p-lod', field: 'lod' } } }), ...(prep['children'] as Json[])];
    m['blockDefinitions'] = [LOD, WET];
  });

async function approvedLibraryBlocks(gmp: TestServer): Promise<void> {
  const [author, approver] = await Promise.all([gmp.asPersona('author'), gmp.asPersona('approver')]);
  for (const definition of [LOD, WET]) {
    const { block } = valueOf(await author.call(routes.library.draft, { body: { definition } }));
    const signed = await signAction(gmp, approver, 'approver', { kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: block.blockId });
    if (!signed.ok) throw new Error(`the library block was not approved: ${JSON.stringify(signed.error)}`);
  }
}

beforeAll(async () => {
  w = await startGmpBatchWorld(content(), {}, { beforeApproval: approvedLibraryBlocks });
  vi.useFakeTimers({ toFake: ['performance'] });
}, 600_000);
afterAll(async () => {
  vi.useRealTimers();
  await w?.close();
});

describe('an earlier-step value in a GMP batch', () => {
  it('[DI-33][PR-19] the later library step computes from the value the completed earlier step recorded: 9.8 kg dried at 2 % LOD is 10 kg as is', async () => {
    const issuer = await w.gmp.asPersona('issuer');
    const batchId = await w.issued(issuer);
    const d = new RunDriver(w.gmp, batchId, { operator1: await w.gmp.asPersona('operator1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-lod@' });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-lod@', entry: { kind: 'LIBRARY_ENTRY', entryKind: 'test', data: { lod: '2' } } });
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-lod@' });
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-wet@' });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-wet@', entry: { kind: 'LIBRARY_ENTRY', entryKind: 'calc', data: { dry: '9.8' } } });
    const { rows } = await w.gmp.db.admin.query<{ s: { entries: Record<string, Json> } }>('select state as s from recipe.execution_state where batch_id = $1', [batchId]);
    const entry = Object.values(rows[0]?.s.entries ?? {}).find((e) => e['stepKey'] === 'p-wet@' && e['kind'] === 'calc');
    const asIs = ((entry?.['data'] as Json)['computed'] as Record<string, Json>)['asIs'];
    expect(asIs?.['value']).toBe('10');
    expect((asIs?.['inputs'] as Record<string, Json>)['lodLot']).toMatchObject({ value: '2', unit: '%' });
  });
});
