/**
 * Block entries over HTTP (Phase 3 slice 6, D-S6-2): the BLOCK_ENTRY forms a step offers carry the block's own schema as
 * JSON; the members a block marks serverFilled are exactly those the server fills (SERVER_FILLED), a BLOCK_ENTRY that
 * names one is refused before anything is read or written, and the members the server reads from the database are filled
 * by it, never taken from the browser.
 */
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { BlockEntryFormView, TABLET_ENTRY_KINDS_BY_BLOCK, TYPED_ENTRY_KINDS, type TabletEntryKind } from '@ebmr/api-contract';
import { tabletsBlockRegistry } from '../../src/features/edition-blocks.ts';
import { blockEntryForms, resolveBlockEntry, SERVER_FILLED, serverFilledMembers } from '../../src/features/execution/block-entries.ts';
import { HttpRefusal } from '../../src/platform/http/refusal.ts';

const registry = tabletsBlockRegistry();
const blockOf = (key: string) => {
  const [type, version] = key.split('@');
  const b = registry.get(type ?? '', version ?? '');
  if (!b) throw new Error(`no block ${key}`);
  return b;
};

/** A client that answers the server's database reads by the SQL text (and fails on anything else). */
function fakeClient(answers: Record<string, unknown>): pg.PoolClient {
  const query = (sql: string) => {
    const key = Object.keys(answers).find((k) => sql.includes(k));
    if (!key) throw new Error(`unexpected query: ${sql}`);
    return Promise.resolve({ rows: [{ r: answers[key] }] });
  };
  return { query } as unknown as pg.PoolClient;
}

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e instanceof HttpRefusal ? e.refusal.code : String(e);
  }
};

describe('BLOCK_ENTRY forms and server-filled members (slice 6)', () => {
  it('every tablet block, G-06@1, G-21@1 and G-24@2 offers its BLOCK_ENTRY kinds with the block\'s own schema as JSON; patterns travel as their source text; the typed kinds are never offered', () => {
    for (const key of Object.keys(TABLET_ENTRY_KINDS_BY_BLOCK)) {
      const block = blockOf(key);
      const forms = blockEntryForms(block);
      const expected = Object.keys(block.dataSchema?.entries ?? {}).filter((k) => !TYPED_ENTRY_KINDS.includes(k as TabletEntryKind));
      expect(forms.map((f) => f.kind), key).toEqual(expected);
      for (const f of forms) {
        expect(BlockEntryFormView.safeParse(JSON.parse(JSON.stringify(f))).success, `${key} ${f.kind}`).toBe(true);
        const schema = block.dataSchema?.entries[f.kind];
        if (!schema) throw new Error('no schema');
        for (const [name, field] of Object.entries(schema.fields)) {
          const wire = f.schema.fields[name];
          expect(wire?.type, `${key} ${f.kind}.${name}`).toBe(field.type);
          if (field.type === 'string' && field.pattern && wire?.type === 'string') expect(new RegExp(wire.pattern ?? '').source).toBe(field.pattern.source);
          expect(wire?.serverFilled === true, `${key} ${f.kind}.${name}`).toBe(field.serverFilled === true);
        }
      }
    }
    expect(blockEntryForms(blockOf('G-07@1'))).toEqual([]);
    expect(blockEntryForms(blockOf('TB-01@1')).map((f) => f.kind)).toEqual([]);
  });

  it('[DI-32][DI-31] the members the blocks mark serverFilled are exactly those the server fills, and a BLOCK_ENTRY that names one is refused before anything is read', async () => {
    const flagged = new Map<string, Set<string>>();
    for (const b of registry.all()) {
      for (const [kind, schema] of Object.entries(b.dataSchema?.entries ?? {})) {
        for (const m of serverFilledMembers(schema)) flagged.set(kind, new Set([...(flagged.get(kind) ?? []), m]));
      }
    }
    const asObject = (m: Map<string, Set<string>>): Record<string, string[]> => Object.fromEntries([...m.entries()].map(([k, v]): [string, string[]] => [k, [...v].sort()]));
    expect(asObject(flagged)).toEqual(Object.fromEntries(Object.entries(SERVER_FILLED).map(([k, v]): [string, string[]] => [k, Object.keys(v).sort()])));

    // Each flagged member of each BLOCK_ENTRY kind, sent by a client: refused, with no database read (the client throws).
    const none = fakeClient({});
    for (const key of Object.keys(TABLET_ENTRY_KINDS_BY_BLOCK)) {
      const block = blockOf(key);
      for (const f of blockEntryForms(block)) {
        for (const m of serverFilledMembers(block.dataSchema?.entries[f.kind] ?? { type: 'object', description: '', fields: {} })) {
          const code = await codeOf(resolveBlockEntry({ client: none, batchId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', stepKey: 'p@', block }, f.kind, { [m]: 'x' }));
          expect(code, `${key} ${f.kind}.${m}`).toBe('EBMR-API-SERVER-FILLED');
        }
      }
    }
    expect(await codeOf(resolveBlockEntry({ client: none, batchId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', stepKey: 'p@', block: blockOf('TB-01@1') }, 'CONTAINER_WEIGHING', {}))).toBe('EBMR-API-BLOCK-ENTRY-TYPED');
  });

  it('[DI-32] the server fills an addition\'s source facts and its authoriser, and a first print\'s job, from the database', async () => {
    const container = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
    const authorisation = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
    const facts = { container, sourceBatchId: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f', product: 'P', strength: '1', stage: 'GRANULATION', unit: 'kg', generatedAtUs: '1', manufacturedAtUs: '1', containsRecovered: false, remaining: '5' };
    const client = fakeClient({ 'recipe.source_container_facts': facts, 'recipe.reprocessing_authorisation_facts': { signedBy: '4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a' }, 'tab.print_job': 'JOB-7' });
    const add = await resolveBlockEntry({ client, batchId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', stepKey: 'p-add@', block: blockOf('G-24@2') }, 'ADDITION', {
      container,
      authorisation,
      quantity: { value: '1.5', unit: 'kg' },
    });
    expect(add).toMatchObject({ kind: 'ADDITION', container, source: facts, authorisedBy: '4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a' });
    const print = await resolveBlockEntry({ client, batchId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', stepKey: 'p-pack@', block: blockOf('G-21@1') }, 'FIRST_PRINT', { device: 'PRN-1', approved: true });
    expect(print).toEqual({ kind: 'FIRST_PRINT', device: 'PRN-1', approved: true, job: 'JOB-7' });
  });
});
