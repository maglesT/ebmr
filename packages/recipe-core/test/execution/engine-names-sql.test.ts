/**
 * The words a test run's record may hold besides a TEST- identifier, bound to the run and to the engine's registers
 * (recipe-core sql/0346 and 0347; Phase 2 exit follow-up F12, the lane's round-11 verification, need 1; DI-05, DI-30).
 *
 * recipe-core 0344 allowed every word of the form of an engine name (EX-<n>, E<n>, S<n>, G<nn>-<WORDS>, control ids ...)
 * in every member of every run. 0346 allows such a word only as the run has it: a name of the engine's registers
 * (recipe.engine_name, kept here equal to the engine's sources and to the control register), a record id the run's
 * state holds, an edge of the run's MBR (recipe.flow_edge_count, kept here equal to the compiler's count), or a compound
 * the engine builds of them. The functions are read here directly; the server tests (db-guards-free-text-bound-names)
 * drive them through the application role.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { GENERIC_BLOCK_VERSIONS } from '../../src/blocks/generic/index.ts';
import { encodeCommand, encodeEvents, encodeState } from '../../src/engine/codec.ts';
import { libraryElementHash } from '../../src/flow/canonical.ts';
import { compileMbr } from '../../src/flow/compile.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { parseMbr } from '../../src/flow/parse.ts';
import { autopilot, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, PACKAGING_SCENARIO, Run } from '../engine/support.ts';
import { clone, loadFixture, mbrWith, phase } from '../flow/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

const ROOT = new URL('../../../../', import.meta.url).pathname;

/** The text of every TypeScript source under `dir`, recipe-core's by default (tests excluded). */
function sources(dir = join(ROOT, 'packages/recipe-core/src')): string {
  return readdirSync(dir, { withFileTypes: true })
    .map((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? readFileSync(join(dir, e.name), 'utf8') : ''))
    .join('\n');
}

async function names(kind: string): Promise<string[]> {
  const { rows } = await db.admin.query<{ name: string }>('select name from recipe.engine_name where kind = $1 order by name collate "C"', [kind]);
  return rows.map((r) => r.name);
}

const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();
const n = (x: object): FlowNode => x as FlowNode;

describe('the names a test run may hold beside TEST- identifiers (recipe-core 0346)', () => {
  it('[DI-05][DI-30] recipe.engine_name holds exactly the block rule codes the engine\'s blocks give, the block types of the registry, the controls of the register (compliance/controls) and the invariants INV-01 to INV-48, the engine\'s schema tag and the member name sha256; every control the engine\'s sources cite is among them; it is insert-only, audited, and the application role reads it and writes nothing (recipe-core 0380)', async () => {
    const src = sources();
    expect(await names('RULE_CODE')).toEqual(sorted([...src.matchAll(/['"`](G\d{2}(?:-[A-Z0-9]+)+)['"`]/g)].map((m) => m[1] ?? '')));
    expect(await names('BLOCK_TYPE')).toEqual(sorted(GENERIC_BLOCK_VERSIONS.map((b) => b.type)));
    // The API edition's AS controls enter recipe.engine_name with the substance namespace (editions/substance/sql 5003),
    // which this template (kernel, site services, recipe-core) does not apply.
    const register = readdirSync(join(ROOT, 'compliance/controls')).filter((f) => f.endsWith('.yaml') && !f.startsWith('AS-')).map((f) => f.slice(0, -5));
    const invariants = sorted([...readFileSync(join(ROOT, 'docs/outline/build-outline.md'), 'utf8').matchAll(/\bINV-\d{2}\b/g)].map((m) => m[0]));
    expect(invariants).toEqual(Array.from({ length: 48 }, (_, i) => `INV-${String(i + 1).padStart(2, '0')}`));
    const controls = await names('CONTROL');
    expect(controls).toEqual(sorted([...register, ...invariants]));
    expect(register).toHaveLength(246);
    const cited = sorted([...src.matchAll(/\b(?:DI|IN|INV|PR|ST)-\d{2}\b/g)].map((m) => m[0]));
    expect(cited.filter((c) => !controls.includes(c))).toEqual([]);
    // The schema tags of the engine's values (the expression engine writes the evaluation's).
    const tagged = `${src}\n${sources(join(ROOT, 'packages/expr/src'))}`;
    expect(await names('SCHEMA_TAG')).toEqual(sorted([...tagged.matchAll(/'(ebmr\.[a-z.-]+\/\d+)'/g)].map((m) => (m[1] ?? '').toUpperCase())));
    expect(await names('MEMBER')).toEqual(['SHA256']);
    await expect(db.admin.query("update recipe.engine_name set name = 'L2409-0017' where name = 'DI-05'")).rejects.toThrow(/EBMR-AUDIT-004 recipe\.engine_name is insert-only/);
    await expect(db.admin.query("delete from recipe.engine_name where name = 'DI-05'")).rejects.toThrow(/EBMR-AUDIT-004/);
    // The application role reads the names, as it reads every recipe table (0380; ADR 0012), and writes none of them.
    expect(Number((await db.app.query<{ n: string }>('select count(*)::text as n from recipe.engine_name')).rows[0]?.n)).toBeGreaterThan(0);
    await expect(db.app.query("insert into recipe.engine_name (name, kind) values ('L2409-0017', 'CONTROL')")).rejects.toThrow(/permission denied/);
    await expect(db.app.query("update recipe.engine_name set kind = 'CONTROL' where name = 'DI-05'")).rejects.toThrow(/permission denied/);
    await expect(db.app.query("delete from recipe.engine_name where name = 'DI-05'")).rejects.toThrow(/permission denied/);
  });

  it('[DI-05] recipe.flow_edge_count equals the number of edges the compiler gives (compileMbr): dc-mini, both golden fixtures (a library call included), and flows of every construct: parallel branches, an alternative with an empty branch, a loop, a replicate section, a nested library call, an empty sequence; never below it when a library call cannot be expanded', async () => {
    const count = async (m: MbrContent): Promise<number> => Number((await db.admin.query<{ n: number }>('select recipe.flow_edge_count($1::jsonb) as n', [JSON.stringify(m)])).rows[0]?.n);
    const dcMiniParsed = parseMbr(JSON.parse(readFileSync(join(ROOT, 'apps/tablets-server/src/features/designer/templates/dc-mini.mbr.json'), 'utf8')));
    if (!dcMiniParsed.ok) throw new Error('dc-mini does not parse');
    const granulation = loadFixture('tablet-granulation-compression');
    const cases: Record<string, MbrContent> = {
      dcMini: dcMiniParsed.mbr,
      granulation,
      packaging: loadFixture('tablet-blister-packaging'),
      constructs: mbrWith(
        n({
          kind: 'sequence',
          id: 'seq',
          children: [
            phase('p1'),
            n({ kind: 'parallel', id: 'par', branches: [{ id: 'a', name: 'A', body: phase('p2') }, { id: 'b', name: 'B', body: n({ kind: 'sequence', id: 'sb', children: [phase('p3'), phase('p4')] }) }] }),
            n({ kind: 'alternative', id: 'alt', decision: { mode: 'DATA' }, branches: [{ id: 'x', name: 'X', guard: 'true', body: phase('p5') }, { id: 'y', name: 'Y', otherwise: true }] }),
            n({ kind: 'loop', id: 'loop', name: 'Loop', body: phase('p6'), maxIterations: 3, exit: { condition: 'true', endpoint: 'e' } }),
            n({ kind: 'replicate', id: 'rep', name: 'Rep', body: n({ kind: 'sequence', id: 'rs', children: [phase('p7'), { kind: 'holdPoint', id: 'h', name: 'H', role: 'QA', dispositions: ['APPROVED'] }] }), count: { kind: 'FIXED', value: 2 }, instances: 'SEQUENTIAL', subLotPrefix: 'SL' }),
            n({ kind: 'sequence', id: 'empty', children: [] }),
            n({ kind: 'loop', id: 'emptyLoop', name: 'Empty loop', body: n({ kind: 'sequence', id: 'el', children: [] }), maxIterations: 2, exit: { condition: 'true', endpoint: 'e' } }),
          ],
        }),
      ),
    };
    // A library call inside a library element (nested), pinned by hash.
    const nested = clone(granulation);
    const element = nested.library[0];
    if (!element) throw new Error('fixture changed');
    const callOf = JSON.stringify(nested.procedure).match(/\{"kind":"libraryCall"[^}]*\}[^}]*\}/)?.[0];
    if (!callOf) throw new Error('fixture changed');
    nested.procedure = JSON.parse(JSON.stringify(nested.procedure).replace(callOf, JSON.stringify({ kind: 'sequence', id: 'twice', children: [JSON.parse(callOf), { ...JSON.parse(callOf), id: 'again' }] }))) as MbrContent['procedure'];
    cases['libraryCalledTwice'] = nested;
    const out: Record<string, [number, number]> = {};
    for (const [name, m] of Object.entries(cases)) out[name] = [compileMbr(m).graph.edges.length, await count(m)];
    expect(Object.fromEntries(Object.entries(out).map(([k, [ts, sql]]) => [k, sql - ts]))).toEqual(Object.fromEntries(Object.keys(out).map((k) => [k, 0])));
    expect(out['dcMini']?.[0]).toBe(29);
    expect(out['granulation']?.[0]).toBe(95);
    // A library call the engine cannot expand (its snapshot no longer matches its pin) compiles to nothing; the count
    // reads it as expanded, so it is never below the engine's.
    const tampered = clone(granulation);
    const body = tampered.library[0]?.body;
    if (body?.kind === 'phase') body.name = 'Tampered';
    expect(libraryElementHash(tampered.library[0] ?? element)).not.toBe(tampered.references.find((r) => r.kind === 'LIBRARY_ELEMENT')?.hash);
    expect(await count(tampered)).toBeGreaterThanOrEqual(compileMbr(tampered).graph.edges.length);
  });

  it('[DI-05][DI-30] a record id is bound only when the state holds it, up to the number of its kind; a word is bound when the run has it, a compound when each part holds a letter and is a word of the run (a part of digits only never, sql 0348), and a compound of the run\'s batch number (a sample\'s or an output container\'s id) only as the state holds it (sql 0347); a refusal\'s path writes <member> for a member name that holds an unbound word, and a chain only up to the id it names', async () => {
    const ids = async (state: object): Promise<string[]> => (await db.admin.query<{ r: string[] }>('select recipe.state_record_ids($1::jsonb) as r', [JSON.stringify(state)])).rows[0]?.r.sort() ?? [];
    expect(await ids({ exceptions: { 'EX-1': {}, 'EX-2': {} }, entries: { 'EN-1': {} }, points: {}, derived: { 'DV-1': {} }, holds: { 'HOLD-1': {} } })).toEqual(['DV-1', 'EN-1', 'EX-1', 'EX-2', 'HOLD-1']);
    // A key the engine never gives, or numbered beyond the records its map holds (a counter forged high).
    expect(await ids({ exceptions: { 'EX-1': {}, 'EX-24090017': {}, 'L2409-0017': {} }, entries: { 'EN-2': {} }, holds: { 'HOLD-0': {} } })).toEqual(['EX-1']);
    expect(await ids({ exceptions: 'EX-1' })).toEqual([]);
    const compounds = async (state: object): Promise<string[]> => (await db.admin.query<{ r: string[] }>('select recipe.state_compound_ids($1::jsonb) as r', [JSON.stringify(state)])).rows[0]?.r.sort() ?? [];
    expect(
      await compounds({
        entries: { 'EN-1': { data: { sampleId: 'TEST-B26-0001/p-sample/S1' } }, 'EN-2': { data: { point: 'TOP' } }, 'EN-3': { data: { sampleId: 7 } } },
        containers: { 'TEST-B26-0001/I-BLEND/0/1': {} },
        subLots: { 'TEST-B26-0001-SL1': {} },
      }),
    ).toEqual(['TEST-B26-0001-SL1', 'TEST-B26-0001/I-BLEND/0/1', 'TEST-B26-0001/P-SAMPLE/S1']);
    expect(await compounds({ entries: [], containers: 'x' })).toEqual([]);

    const bound = async (word: string, words: string[], batch: string | null = 'TEST-B26-0001'): Promise<boolean> =>
      (await db.admin.query<{ b: boolean }>('select recipe.run_word_bound($1, $2::text[], $3) as b', [word, words, batch])).rows[0]?.b ?? false;
    const run = ['EX-1', 'E1', 'E2', 'P-DISP-CLEAR', 'TEST-B26-0001', 'DI-05'];
    expect({
      own: await bound('ex-1', run),
      notHeld: await bound('EX-24090017', run),
      edge: await bound('e2', run),
      edgeBeyond: await bound('E24090017', run),
      // A number in a compound passed by its form until sql 0348 (the lane's round-12 verification, G2).
      compound: await bound('EX-1/2', run),
      compoundOfWords: await bound('EX-1/P-DISP-CLEAR', run),
      compoundUnbound: await bound('E2409/0017', run),
      sample: await bound('TEST-B26-0001/p-disp-clear/S3', run),
      sampleHeld: await bound('TEST-B26-0001/p-disp-clear/S3', [...run, 'TEST-B26-0001/P-DISP-CLEAR/S3']),
      containerForged: await bound('TEST-B26-0001/E1/0/1', run),
      sampleAlone: await bound('S24090017', run),
      sampleNotLast: await bound('TEST-B26-0001/S3/p-disp-clear', run),
      sampleOtherBatch: await bound('B24-0001/p-disp-clear/S3', run),
      sampleNoBatch: await bound('TEST-B26-0001/p-disp-clear/S3', run, null),
      emptyPart: await bound('TEST-B26-0001//S3', run),
      control: await bound('di-05', run),
    }).toEqual({
      own: true, notHeld: false, edge: true, edgeBeyond: false, compound: false, compoundOfWords: true, compoundUnbound: false, sample: false, sampleHeld: true, containerForged: false, sampleAlone: false,
      sampleNotLast: false, sampleOtherBatch: false, sampleNoBatch: false, emptyPart: false, control: true,
    });

    const path = async (value: object, word: string): Promise<string> => (await db.admin.query<{ p: string }>("select recipe.word_path($1::jsonb, $2, array['SOP-DISP-001'], 'TEST-B26-0001') as p", [JSON.stringify(value), word])).rows[0]?.p ?? '';
    expect(await path({ body: { details: { 'Z2409-0018': { x: 'L2409-0017' } } } }, 'L2409-0017')).toBe('$.body.details.<member>.x');
    expect(await path({ body: { details: { 'SOP-DISP-001': { x: 'L2409-0017' } } } }, 'L2409-0017')).toBe('$.body.details.SOP-DISP-001.x');
    expect(await path({ a: { 'drum L2409-0017': 1 } }, 'L2409-0017')).toBe('$.a (the name of one of its members)');
    expect(await path({ a: ['x', 'lot 50%B24-0001'] }, 'B24-0001')).toBe('$.a[1]');

    const shown = async (key: string): Promise<string> => (await db.admin.query<{ s: string }>('select recipe.chain_shown($1) as s', [key])).rows[0]?.s ?? '';
    const run1 = '7a296f4a-1862-4d07-93a1-5c5826f41f2d';
    expect({
      batch: await shown(`batch:${run1}`),
      step: await shown(`batch_step:${run1}:L2409-0017`),
      challenge: await shown(`esig_challenge:batch_step:${run1}:p-disp-clear@`),
      reading: await shown(`device_reading:${run1}`),
      noId: await shown('device_reading:L2409-0017'),
      nothing: await shown('L2409-0017'),
    }).toEqual({
      batch: `batch:${run1}`,
      step: `batch_step:${run1}:...`,
      challenge: `esig_challenge:batch_step:${run1}:...`,
      reading: `device_reading:${run1}`,
      noId: 'device_reading:...',
      nothing: 'an audit chain:...',
    });
  });

  it('[DI-05][DI-30] round 12 (sql 0348): a number in a compound is bound only in the shapes the engine builds: the fragments <n>/<loop or replicate section> of its context keys, n at most the maximum of the section enclosing it, and the compounds its MBR, expanded ids and held containers and samples hold; the round-12 verification\'s BATCH/2409/0017, D/2409/0017, QA/2409/0017, SITE-1/2409/0017, EX-1/2409/0017 and the others are not; every compound of the golden runs of both fixtures (replicate sections, a loop, a library call, output containers, samples) is bound', async () => {
    const TEST_BATCH = 'TEST-B26-0001';
    /** The compounds of `value` that the reading reads as real and that are not bound for a run of `content` with `state` (as the triggers read a row). */
    const unbound = async (content: MbrContent, state: object | null, value: unknown, header: string[] = [TEST_BATCH, 'SITE-1', 'DISP-1']): Promise<string[]> =>
      (
        await db.admin.query<{ u: string[] }>(
          `with b as (select recipe.content_bound_words($1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb) as b)
           select coalesce(array_agg(distinct w order by w), '{}') as u
             from b cross join lateral sandbox.identifier_words($4::jsonb) w
            where strpos(w, '/') > 0
              and not recipe.run_word_bound(w, b.b, $5)
              and exists (select 1 from sandbox.real_identifier_parts(w) p where not recipe.run_word_bound(p, b.b, $5))`,
          [JSON.stringify(content), JSON.stringify(header), JSON.stringify(state), JSON.stringify(value), TEST_BATCH],
        )
      ).rows[0]?.u ?? [];
    const dcMiniParsed = parseMbr(JSON.parse(readFileSync(join(ROOT, 'apps/tablets-server/src/features/designer/templates/dc-mini.mbr.json'), 'utf8')));
    if (!dcMiniParsed.ok) throw new Error('dc-mini does not parse');
    const probes = ['BATCH/2409/0017', 'D/2409/0017', 'H/24/0017', 'QA/2409/0017', 'TABLET/2409/0017', 'SITE-1/2409/0017', 'MG/24/017', 'BAL/2409/0017', 'DISP-1/2409/0017', 'SOP/2409/0017', 'EX-1/2409/0017', '2409/QA', 'DISP-1/0017'];
    const withEx1 = { exceptions: { 'EX-1': {} } };
    expect(await unbound(dcMiniParsed.mbr, withEx1, { description: probes.join(' '), deep: { a: { b: { c: 'BATCH/2409/0017' } } } })).toEqual([...probes].sort());
    // Compounds of the run's words, each holding a letter, a ratio and a date pass.
    expect(await unbound(dcMiniParsed.mbr, withEx1, { description: 'DISP-1/BLEND-1, SOP-DISP-001/SOP-BLEND-002, EX-1/SITE-1, 1/2 of the drum on 04/10/2026' })).toEqual([]);

    // Context-key fragments of the granulation fixture: L-DRY (a loop of at most 5 iterations) lies in R-SUBLOT (a
    // replicate section of at most 2 sub-lots), so a key reads R-SUBLOT=<1..2>/L-DRY=<1..5>.
    const granulation = loadFixture('tablet-granulation-compression');
    const fragments = (await db.admin.query<{ f: string[] }>('select recipe.frame_fragments($1::jsonb) as f', [JSON.stringify(granulation)])).rows[0]?.f.sort();
    expect(fragments).toEqual(['1/L-DRY', '2/L-DRY']);
    expect(await unbound(granulation, {}, { stepKey: 'p-drycycle@R-SUBLOT=2/L-DRY=5', events: ['1/L-DRY'] })).toEqual([]);
    expect(await unbound(granulation, {}, { a: '3/L-DRY', b: '2409/L-DRY', c: '1/R-SUBLOT', d: '0/L-DRY' })).toEqual(['0/L-DRY', '1/R-SUBLOT', '2409/L-DRY', '3/L-DRY']);
    // A section whose id holds a character outside the identifier alphabet: the reading takes the fragment up to it.
    const nested = mbrWith(
      n({
        kind: 'replicate',
        id: 'REP-2',
        name: 'Rep',
        count: { mode: 'RUNTIME', min: 1, max: 3, reasonRequired: true },
        instances: 'SEQUENTIAL',
        subLotPrefix: 'SL',
        body: n({ kind: 'loop', id: 'L-9_a', name: 'Loop', body: phase('p9'), maxIterations: 4, exit: { condition: 'true', endpoint: 'e' } }),
      }),
    );
    expect((await db.admin.query<{ f: string[] }>('select recipe.frame_fragments($1::jsonb) as f', [JSON.stringify(nested)])).rows[0]?.f.sort()).toEqual(['1/L-9', '2/L-9', '3/L-9']);

    // The golden runs: every compound of every row (command, state, events) is bound by the state of the row where it
    // first appears (what the state holds is never taken away, so it stays bound after). The JSON text of a row split at
    // every character outside the identifier alphabet holds every word the reading reads; only those with '/' are sent
    // (sql 0348 changed nothing else).
    const compounds = (value: unknown): string[] => [...new Set(JSON.stringify(value).split(/[^A-Za-z0-9/.-]+/).filter((w) => w.includes('/') && /[A-Za-z]/.test(w) && /[0-9]/.test(w)))];
    const holding = new Set<string>();
    for (const [name, scenario, variants] of [
      ['tablet-granulation-compression', GRANULATION_SCENARIO, {}],
      ['tablet-blister-packaging', PACKAGING_SCENARIO, { packDestination: 'US-EXPORT' }],
    ] as const) {
      const run = Run.issue(fixtureDefinition(name), { inputs: FIXTURE_INPUTS[name], variants, batchNumber: TEST_BATCH });
      expect(autopilot(run, scenario)).toBe('COMPLETE');
      const content = run.def.mbr;
      const found: Record<string, string[]> = {};
      const checked = new Set<string>();
      for (const [i, e] of run.log.entries()) {
        const state = encodeState(e.result.state);
        const value = [encodeCommand(e.command), state, encodeEvents(e.result.events)];
        const words = compounds(value).filter((w) => !checked.has(w));
        if (words.length === 0) continue;
        words.forEach((w) => {
          checked.add(w);
          holding.add(w);
        });
        const u = await unbound(content, state as object, words);
        if (u.length > 0) found[`${name} #${i + 1} ${e.command.type}`] = u;
      }
      expect(found, name).toEqual({});
    }
    // SETUP: the runs hold context fragments and output containers of the run's batch number.
    expect([...holding].filter((w) => /^[12]\/L-DRY$/.test(w)).sort()).toEqual(['1/L-DRY', '2/L-DRY']);
    expect([...holding].some((w) => w.startsWith(`${TEST_BATCH}/`))).toBe(true);
  }, 240_000);
});
