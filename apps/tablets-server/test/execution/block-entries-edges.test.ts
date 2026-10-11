/**
 * BLOCK_ENTRY server-filled members (slice 6, D-S6-2) at their edges: values of the wrong shape, the reads the server
 * makes (and only those, with their parameters), what it leaves out when the database has nothing, the refusal bodies,
 * and the schema as JSON with every option. Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { blocks } from '@ebmr/recipe-core';
import { tabletsBlockRegistry } from '../../src/features/edition-blocks.ts';
import { blockEntryForms, objectWire, resolveBlockEntry, serverFilledSent } from '../../src/features/execution/block-entries.ts';
import { HttpRefusal } from '../../src/platform/http/refusal.ts';

const registry = tabletsBlockRegistry();
const blockOf = (key: string): blocks.BlockVersion => {
  const [type, version] = key.split('@');
  const b = registry.get(type ?? '', version ?? '');
  if (!b) throw new Error(`no block ${key}`);
  return b;
};
const BATCH = '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
const CONTAINER = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const AUTH = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
const SIGNER = '4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a';

/** A client answering by SQL text (an answer `undefined` returns no row), recording every read with its parameters. */
function recordingClient(answers: Record<string, unknown>): { client: pg.PoolClient; reads: { key: string; params: unknown[] }[] } {
  const reads: { key: string; params: unknown[] }[] = [];
  const query = (sql: string, params: unknown[]) => {
    const key = Object.keys(answers).find((k) => sql.includes(k));
    if (!key) throw new Error(`unexpected query: ${sql}`);
    reads.push({ key, params });
    return Promise.resolve({ rows: answers[key] === undefined ? [] : [{ r: answers[key] }] });
  };
  return { client: { query } as unknown as pg.PoolClient, reads };
}

const refusalOf = async (p: Promise<unknown>): Promise<HttpRefusal> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpRefusal) return e;
    throw e;
  }
  throw new Error('not refused');
};

const withEntries = (base: blocks.BlockVersion, entries: Record<string, blocks.ObjectSchema>): blocks.BlockVersion => ({ ...base, dataSchema: { ...base.dataSchema, entries } }) as blocks.BlockVersion;

const nested: blocks.ObjectSchema = {
  type: 'object',
  description: 'synthetic',
  fields: {
    reading: { type: 'object', description: 'r', optional: true, fields: { receivedAtUs: { type: 'string', description: 't', serverFilled: true, optional: true } } },
    lines: { type: 'array', description: 'l', optional: true, items: { type: 'object', description: 'i', fields: { lot: { type: 'string', description: 'lot', serverFilled: true, optional: true } } } },
    byKey: { type: 'record', description: 'k', optional: true, values: { type: 'object', description: 'kv', fields: { job: { type: 'string', description: 'j', serverFilled: true, optional: true } } } },
  },
};

describe('server-filled members: shapes the engine decides', () => {
  it('[DI-32][DI-31] a value of the wrong shape (null, text, an array where a record or object stands) names no server-filled member: the engine\'s schema refuses it', () => {
    expect(serverFilledSent(nested, { reading: null })).toEqual([]);
    expect(serverFilledSent(nested, { reading: 'x' })).toEqual([]);
    expect(serverFilledSent(nested, { reading: ['receivedAtUs'] })).toEqual([]);
    expect(serverFilledSent(nested, { byKey: [{ job: 'J-1' }] })).toEqual([]);
    expect(serverFilledSent(nested, { byKey: null })).toEqual([]);
    expect(serverFilledSent(nested, { lines: { 0: { lot: 'L' } } })).toEqual([]);
    expect(serverFilledSent(nested, { byKey: { a: { job: 'J' } }, lines: [{}, { lot: 'L' }] })).toEqual(['lines[1].lot', 'byKey.a.job']);
  });

  it('[DI-32][DI-31] the refusals carry their codes, controls and the help a person can act on; one member is a fact, several are facts', async () => {
    const block = withEntries(blockOf('G-24@2'), { ADDITION: nested });
    const { client } = recordingClient({});
    const one = await refusalOf(resolveBlockEntry({ client, batchId: BATCH, stepKey: 'p@', block }, 'ADDITION', { reading: { receivedAtUs: '1' } }));
    expect(one.status).toBe(422);
    expect(one.refusal).toMatchObject({
      code: 'EBMR-API-SERVER-FILLED',
      kind: 'INVALID_INPUT',
      whatHappened: 'The entry names reading.receivedAtUs, which the system fills itself. Nothing was saved.',
      why: 'reading.receivedAtUs of a ADDITION entry is a fact the server reads from the record or the equipment, never typed (DI-31, DI-32).',
      controls: ['DI-31', 'DI-32'],
      whatYouCanDo: ['Send the entry without these members.'],
      whoCanHelp: ['The shift supervisor'],
    });
    const two = await refusalOf(resolveBlockEntry({ client, batchId: BATCH, stepKey: 'p@', block }, 'ADDITION', { reading: { receivedAtUs: '1' }, lines: [{ lot: 'L' }] }));
    expect(two.refusal.whatHappened).toBe('The entry names reading.receivedAtUs, lines[0].lot, which the system fills itself. Nothing was saved.');
    expect(two.refusal.why).toBe('reading.receivedAtUs, lines[0].lot of a ADDITION entry are facts the server reads from the record or the equipment, never typed (DI-31, DI-32).');
    const typed = await refusalOf(resolveBlockEntry({ client, batchId: BATCH, stepKey: 'p@', block: blockOf('TB-01@1') }, 'CONTAINER_WEIGHING', {}));
    expect(typed.refusal).toMatchObject({
      code: 'EBMR-API-BLOCK-ENTRY-TYPED',
      kind: 'INVALID_INPUT',
      whatHappened: 'A CONTAINER_WEIGHING entry is sent in its own form, not as a block entry.',
      why: 'The server reads the lots and scale readings of this entry kind itself; the browser does not supply them.',
      controls: ['DI-31', 'DI-32'],
      whatYouCanDo: ["Record the CONTAINER_WEIGHING entry from the step screen's own form."],
    });
  });
});

describe('server-filled members: the reads the server makes', () => {
  it('[DI-32] an addition reads the source container and the authoriser with their own identifiers, and only identifiers that are UUID text', async () => {
    const facts = { container: CONTAINER, remaining: '5' };
    const r = recordingClient({ 'recipe.source_container_facts': facts, 'recipe.reprocessing_authorisation_facts': { signedBy: SIGNER } });
    const ctx = { client: r.client, batchId: BATCH, stepKey: 'p-add@', block: blockOf('G-24@2') };
    expect(await resolveBlockEntry(ctx, 'ADDITION', { container: CONTAINER, authorisation: AUTH })).toStrictEqual({ container: CONTAINER, authorisation: AUTH, kind: 'ADDITION', source: facts, authorisedBy: SIGNER });
    expect(r.reads).toEqual([
      { key: 'recipe.source_container_facts', params: [CONTAINER, BATCH] },
      { key: 'recipe.reprocessing_authorisation_facts', params: [AUTH] },
    ]);
    // Not UUID text: nothing is read, nothing is filled.
    const none = recordingClient({});
    const ctx2 = { ...ctx, client: none.client };
    expect(await resolveBlockEntry(ctx2, 'ADDITION', { container: 'C-1', authorisation: 'A-1' })).toStrictEqual({ container: 'C-1', authorisation: 'A-1', kind: 'ADDITION' });
    expect(await resolveBlockEntry(ctx2, 'ADDITION', { container: [CONTAINER], authorisation: [AUTH] })).toStrictEqual({ container: [CONTAINER], authorisation: [AUTH], kind: 'ADDITION' });
    expect(none.reads).toEqual([]);
  });

  it('[DI-32] when the database has no facts, no authoriser or no row, the member stays absent (the engine and the database then refuse the entry)', async () => {
    const ctx = (answers: Record<string, unknown>) => {
      const r = recordingClient(answers);
      return { r, ctx: { client: r.client, batchId: BATCH, stepKey: 'p-add@', block: blockOf('G-24@2') } };
    };
    const a = ctx({ 'recipe.source_container_facts': null, 'recipe.reprocessing_authorisation_facts': {} });
    expect(await resolveBlockEntry(a.ctx, 'ADDITION', { container: CONTAINER, authorisation: AUTH })).toStrictEqual({ container: CONTAINER, authorisation: AUTH, kind: 'ADDITION' });
    const b = ctx({ 'recipe.source_container_facts': undefined, 'recipe.reprocessing_authorisation_facts': undefined });
    expect(await resolveBlockEntry(b.ctx, 'ADDITION', { container: CONTAINER, authorisation: AUTH })).toStrictEqual({ container: CONTAINER, authorisation: AUTH, kind: 'ADDITION' });
    // Without an authorisation, the authoriser is not read.
    const c = ctx({ 'recipe.source_container_facts': { container: CONTAINER } });
    expect(await resolveBlockEntry(c.ctx, 'ADDITION', { container: CONTAINER })).toStrictEqual({ container: CONTAINER, kind: 'ADDITION', source: { container: CONTAINER } });
    expect(c.r.reads.map((x) => x.key)).toEqual(['recipe.source_container_facts']);
  });

  it('[DI-32] a first print reads the loaded job of this batch, step and device; no device text, no read; no job, no member', async () => {
    const r = recordingClient({ 'tab.print_job': 'JOB-7' });
    const ctx = { client: r.client, batchId: BATCH, stepKey: 'p-pack@', block: blockOf('G-21@1') };
    expect(await resolveBlockEntry(ctx, 'FIRST_PRINT', { device: 'PRN-1' })).toStrictEqual({ device: 'PRN-1', kind: 'FIRST_PRINT', job: 'JOB-7' });
    expect(r.reads).toEqual([{ key: 'tab.print_job', params: [BATCH, 'p-pack@', 'PRN-1'] }]);
    const none = recordingClient({});
    expect(await resolveBlockEntry({ ...ctx, client: none.client }, 'FIRST_PRINT', { device: 7 })).toStrictEqual({ device: 7, kind: 'FIRST_PRINT' });
    expect(none.reads).toEqual([]);
    const empty = recordingClient({ 'tab.print_job': null });
    expect(await resolveBlockEntry({ ...ctx, client: empty.client }, 'FIRST_PRINT', { device: 'PRN-1' })).toStrictEqual({ device: 'PRN-1', kind: 'FIRST_PRINT' });
  });

  it('[DI-32] the server reads only for a kind whose block marks the member: no block, no schema, or a kind that does not mark it reads nothing', async () => {
    const none = recordingClient({});
    const base = { client: none.client, batchId: BATCH, stepKey: 'p@' };
    expect(await resolveBlockEntry({ ...base, block: undefined }, 'ADDITION', { container: CONTAINER, authorisation: AUTH })).toStrictEqual({ container: CONTAINER, authorisation: AUTH, kind: 'ADDITION' });
    expect(await resolveBlockEntry({ ...base, block: { ...blockOf('G-24@2'), dataSchema: undefined } as blocks.BlockVersion }, 'ADDITION', { container: CONTAINER })).toStrictEqual({ container: CONTAINER, kind: 'ADDITION' });
    // ADDITION without a server-filled source; another kind marking source and authorisedBy; FIRST_PRINT without job.
    const plain: blocks.ObjectSchema = { type: 'object', description: 'p', fields: { container: { type: 'string', description: 'c' }, authorisation: { type: 'string', description: 'a', optional: true }, device: { type: 'string', description: 'd', optional: true } } };
    const marked: blocks.ObjectSchema = { ...plain, fields: { ...plain.fields, source: { type: 'object', description: 's', serverFilled: true, optional: true, fields: {} }, authorisedBy: { type: 'string', description: 'b', serverFilled: true, optional: true }, job: { type: 'string', description: 'j', serverFilled: true, optional: true } } };
    const sourceOnly: blocks.ObjectSchema = { ...plain, fields: { ...plain.fields, source: { type: 'object', description: 's', serverFilled: true, optional: true, fields: {} } } };
    const block = withEntries(blockOf('G-24@2'), { ADDITION: plain, ISSUE: marked, FIRST_PRINT: plain });
    const data = { container: CONTAINER, authorisation: AUTH, device: 'PRN-1' };
    expect(await resolveBlockEntry({ ...base, block }, 'ADDITION', data)).toStrictEqual({ ...data, kind: 'ADDITION' });
    expect(await resolveBlockEntry({ ...base, block }, 'ISSUE', data)).toStrictEqual({ ...data, kind: 'ISSUE' });
    expect(await resolveBlockEntry({ ...base, block }, 'FIRST_PRINT', data)).toStrictEqual({ ...data, kind: 'FIRST_PRINT' });
    expect(none.reads).toEqual([]);
    // Source marked, authoriser not: only the source is read.
    const r = recordingClient({ 'recipe.source_container_facts': { container: CONTAINER } });
    expect(await resolveBlockEntry({ ...base, client: r.client, block: withEntries(blockOf('G-24@2'), { ADDITION: sourceOnly }) }, 'ADDITION', data)).toStrictEqual({ ...data, kind: 'ADDITION', source: { container: CONTAINER } });
    expect(r.reads.map((x) => x.key)).toEqual(['recipe.source_container_facts']);
  });
});

describe('BLOCK_ENTRY forms as JSON', () => {
  it('[DI-32] every schema option travels: optional, enum, pattern, decimal and integer bounds, boolean defaults, array sizes, records, and the object\'s own flags', () => {
    const s: blocks.ObjectSchema = {
      type: 'object',
      description: 'all',
      optional: true,
      serverFilled: true,
      fields: {
        s: { type: 'string', description: 's', optional: false, enum: ['A', 'B'], pattern: /^[AB]$/ },
        d: { type: 'decimal', description: 'd', min: '0', minExclusive: true },
        i: { type: 'integer', description: 'i', min: 1, max: 9, optional: true },
        b: { type: 'boolean', description: 'b', default: false, defaultText: 'no unless stated' },
        a: { type: 'array', description: 'a', items: { type: 'string', description: 'x' }, minItems: 1, maxItems: 3 },
        r: { type: 'record', description: 'r', values: { type: 'decimal', description: 'v' }, serverFilled: true },
        plain: { type: 'decimal', description: 'p' },
        list: { type: 'array', description: 'l', items: { type: 'integer', description: 'n' } },
      },
    };
    expect(objectWire(s)).toStrictEqual({
      type: 'object',
      description: 'all',
      optional: true,
      serverFilled: true,
      fields: {
        s: { type: 'string', description: 's', optional: false, enum: ['A', 'B'], pattern: '^[AB]$' },
        d: { type: 'decimal', description: 'd', min: '0', minExclusive: true },
        i: { type: 'integer', description: 'i', optional: true, min: 1, max: 9 },
        b: { type: 'boolean', description: 'b', default: false, defaultText: 'no unless stated' },
        a: { type: 'array', description: 'a', items: { type: 'string', description: 'x' }, minItems: 1, maxItems: 3 },
        r: { type: 'record', description: 'r', serverFilled: true, values: { type: 'decimal', description: 'v' } },
        plain: { type: 'decimal', description: 'p' },
        list: { type: 'array', description: 'l', items: { type: 'integer', description: 'n' } },
      },
    });
    expect(objectWire({ type: 'object', description: 'bare', fields: {} })).toStrictEqual({ type: 'object', description: 'bare', fields: {} });
  });

  it('[DI-32] a form is titled from its kind in plain words; a block version outside the list, or without a data schema, offers none', () => {
    const forms = blockEntryForms(blockOf('G-21@1'));
    expect(forms.map((f) => f.title)).toEqual(['Issue', 'Reconciliation', 'First print', 'Challenge', 'Serial pool', 'Serial reconciliation']);
    expect(blockEntryForms(undefined)).toEqual([]);
    expect(blockEntryForms({ ...blockOf('G-21@1'), version: '99' } as blocks.BlockVersion)).toEqual([]);
    expect(blockEntryForms({ ...blockOf('G-21@1'), dataSchema: undefined } as blocks.BlockVersion)).toEqual([]);
  });
});
