/**
 * The identifier rule read in free text (DI-05, INV-18; kernel 1030, Phase 2 exit review F12 closed for the class and
 * follow-up F12.KERNEL): sandbox.identifier_words, sandbox.real_identifier_parts and sandbox.real_identifiers read a text,
 * or every string and member name of a JSON value, for the words 0810's rule reads as real (non-TEST-) batch or lot
 * numbers in a sandbox; sandbox.guard_free_text refuses a row whose named columns hold one, outside a GMP installation.
 *
 * The reading has no definition of its own of what an identifier looks like: a word is read as one when 0810's rule
 * accepts it with the reserved prefix in front and refuses it as it stands. The expected values below are what the
 * PostgreSQL 16 server answered for each input (run against the migrated template).
 *
 * Kernel 1040 (the lane's round-11 verification, needs 2 and 3): a text is read as written as well as with its escapes
 * read, so an escape no longer hides the identifier written right after it; and in a sandbox the person register's
 * names, references and login names are read too.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { provisionTestSandbox, type TestSandbox } from './helpers.ts';

let gmp: TestDatabase;
let sbx: TestSandbox;
beforeAll(async () => {
  [gmp, sbx] = await Promise.all([createTestDatabase(), provisionTestSandbox()]);
}, 300_000);
afterAll(async () => {
  await Promise.all([gmp?.drop(), sbx?.drop()]);
});

/** What sandbox.real_identifiers reads in each text, as the application role asks. */
async function readText(texts: readonly string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const t of texts) {
    const { rows } = await gmp.app.query<{ w: string }>('select w from sandbox.real_identifiers($1::text) w', [t]);
    out[t] = rows.map((r) => r.w).sort();
  }
  return out;
}

describe('the identifier rule read in free text (kernel 1030)', () => {
  it('[DI-05][INV-18] every real format the rule knows is read in prose: a lot or batch number, the body of each kind\'s example, in lower case, in full-width letters, with percent or backslash escapes, at the end of a sentence, glued into a word longer than an identifier, and joined by a slash; TEST- identifiers are not', async () => {
    expect(
      await readText([
        'L2409-0017',
        'Drum of lot L2409-0017.',
        'after batch B24-0001',
        'lot L24-0001',
        'scale SCALE-01',
        'trainee TRAINEE-01',
        'l2409-0017',
        'Ｌ２４０９－００１７',
        '%4C2409-0017',
        '\\u004C2409-0017',
        'drum-L2409-0017-from-the-supplier-warehouse-north',
        'L2409/0017',
        'TEST-L2409-0017 and test-l26-0101',
      ]),
    ).toEqual({
      'L2409-0017': ['L2409-0017'],
      'Drum of lot L2409-0017.': ['L2409-0017'],
      'after batch B24-0001': ['B24-0001'],
      'lot L24-0001': ['L24-0001'],
      'scale SCALE-01': ['SCALE-01'],
      'trainee TRAINEE-01': ['TRAINEE-01'],
      'l2409-0017': ['l2409-0017'],
      'Ｌ２４０９－００１７': ['L2409-0017'],
      // Since kernel 1040 also as written: 4C2409-0017 and u004C2409-0017 are words of the form of one too.
      '%4C2409-0017': ['4C2409-0017', 'L2409-0017'],
      '\\u004C2409-0017': ['L2409-0017', 'u004C2409-0017'],
      // Longer than an identifier can be: every run of its parts that is one, as the server reads it.
      'drum-L2409-0017-from-the-supplier-warehouse-north': [
        '0017-from', '0017-from-the', '0017-from-the-supplier', 'L2409', 'L2409-0017', 'L2409-0017-from', 'L2409-0017-from-the',
        'drum-L2409', 'drum-L2409-0017', 'drum-L2409-0017-from', 'drum-L2409-0017-from-the',
      ],
      'L2409/0017': ['L2409/0017'],
      'TEST-L2409-0017 and test-l26-0101': [],
    });
  });

  it('[DI-05][INV-18] prose is not read as an identifier: words, numbers, decimals, dates, times, ranges, fractions, versions, ordinals, percentages, UUIDs, digests and escapes; and what the reading cannot see is stated (digits only, broken by a space or another character, other digits)', async () => {
    const texts = [
      'Booth door found open after the clearance',
      '12.5 g at 100% load, 15-25 C, 1/2 tablet, version 1.5.0',
      'Checked on 2026-10-04 at 10:15 on the 2nd shift, 3rd attempt, 11th edition',
      'signature 3f2a9c1e-1234-5678-9abc-def012345678 over a3f9c2e14b5d6a7f8e9d0c1b2a3f4e5d6c7b8a9f0e1d2c3b4a5f6e7d8c9b0a1f',
      'U+0000 written \\u0000 and %00perform',
      // Not read (kernel 1030's header): digits only, broken by a space or by a character outside the identifier alphabet.
      'lot 2409-0017',
      'lot L 2409 0017',
      'lot L%2409-0017',
      'lot L٢٤٠٩-٠٠١٧',
    ];
    expect(await readText(texts)).toEqual(Object.fromEntries(texts.map((t) => [t, []])));
  });

  it('[DI-05][INV-18] a JSON value is read in every string and every member name, at any depth', async () => {
    const value = { a: { b: { c: ['fine', { 'L2409-0017': 1 }] } }, d: 'after batch B24-0001', e: [[['lot L24-0001']]], f: 12, g: null, h: true };
    const { rows } = await gmp.app.query<{ w: string }>('select w from sandbox.real_identifiers($1::jsonb) w', [JSON.stringify(value)]);
    expect(rows.map((r) => r.w).sort()).toEqual(['B24-0001', 'L24-0001', 'L2409-0017']);
    const { rows: none } = await gmp.app.query('select w from sandbox.real_identifiers($1::jsonb) w', [JSON.stringify({ note: 'TEST-L26-0101 on the 2nd shift', n: '12.5' })]);
    expect(none).toEqual([]);
  });

  it('[DI-05][INV-18] sandbox.guard_free_text refuses, in a sandbox, a row whose named columns hold a real-format identifier, in text or at any depth of a JSON value (EBMR-SBX-024), naming the column but not the word; a GMP installation keeps the row; a trigger naming no column or a column the table does not have is refused (EBMR-SBX-023)', async () => {
    const table = `
      create schema a4_notes;
      create table a4_notes.note (id serial primary key, body text, details jsonb);
      create trigger ac_sandbox_free_text before insert or update on a4_notes.note
        for each row execute function sandbox.guard_free_text('body', 'details');
      create table a4_notes.broken (id serial primary key, body text);
      create trigger ac_sandbox_free_text before insert on a4_notes.broken
        for each row execute function sandbox.guard_free_text('nope');
      grant usage on schema a4_notes to ebmr_app;
      grant select, insert, update on a4_notes.note, a4_notes.broken to ebmr_app;
      grant usage on all sequences in schema a4_notes to ebmr_app;`;
    await gmp.admin.query(table);
    await sbx.admin.query(table);
    await sbx.admin.query('select sandbox.mirror_application_privileges()');
    const insert = 'insert into a4_notes.note (body, details) values ($1, $2::jsonb)';
    const MESSAGE =
      /^a4_notes\.note (body|details) holds a word of the form of a batch or lot number that is not a test one: in the sandbox a text names a batch, lot or container only by a TEST- identifier \(for example TEST-L24-0001\), or describes it in words, so a real GMP identifier is never reused \(DI-05, INV-18\)\. \[EBMR-SBX-024\]$/;
    await expect(sbx.sandbox.query(insert, ['Drum of lot L2409-0017', '{}'])).rejects.toThrow(MESSAGE);
    await expect(sbx.sandbox.query(insert, ['fine', JSON.stringify({ a: { b: { c: 'B24-0001' } } })])).rejects.toThrow(/a4_notes\.note details holds a word/);
    await expect(sbx.sandbox.query(insert, ['fine', JSON.stringify({ a: { 'L2409-0017': 1 } })])).rejects.toThrow(/a4_notes\.note details holds a word/);
    await expect(sbx.sandbox.query(insert, ['Drum TEST-L26-0101 on the 2nd shift', JSON.stringify({ n: '12.5 g' })])).resolves.toBeDefined();
    await expect(sbx.sandbox.query("update a4_notes.note set body = 'lot L2409-0017'")).rejects.toThrow(MESSAGE);
    expect((await sbx.admin.query("select 1 from a4_notes.note where body like '%2409%' or details::text like '%2409%' or details::text like '%B24%'")).rowCount).toBe(0);
    // A GMP installation keeps what was written.
    await expect(gmp.app.query(insert, ['Drum of lot L2409-0017', JSON.stringify({ a: { b: { c: 'B24-0001' } } })])).resolves.toBeDefined();
    // A misconfigured trigger is refused before anything is read.
    await expect(sbx.sandbox.query("insert into a4_notes.broken (body) values ('x')")).rejects.toThrow(/names column nope, which a4_notes\.broken does not have \(DI-05\)\. \[EBMR-SBX-023\]$/);
  });
  it('[DI-05][INV-18] kernel 1040: an escape never hides the identifier written right after it: the text is read as written and with its escapes read, so 50%B24-0001, lot %E2409001 found and ref%A24-0001 hold B24-0001, E2409001 and A24-0001, and sandbox.guard_free_text refuses them in a sandbox (EBMR-SBX-024) where a GMP installation keeps them; the escapes of U+0000 and of % itself are not words', async () => {
    expect(await readText(['50%B24-0001', 'lot %E2409001 found', 'ref%A24-0001', '%4C2409-0017', 'at 100% load, 50%RH, 100%25 sure, %00perform'])).toEqual({
      '50%B24-0001': ['B24-0001'],
      'lot %E2409001 found': ['E2409001'],
      'ref%A24-0001': ['A24-0001'],
      // As written 4C2409-0017 (a word of the form of one), with its escape read L2409-0017.
      '%4C2409-0017': ['4C2409-0017', 'L2409-0017'],
      'at 100% load, 50%RH, 100%25 sure, %00perform': [],
    });
    const table = `
      create schema a4_escapes;
      create table a4_escapes.note (id serial primary key, body text);
      create trigger ac_sandbox_free_text before insert on a4_escapes.note for each row execute function sandbox.guard_free_text('body');
      grant usage on schema a4_escapes to ebmr_app;
      grant select, insert on a4_escapes.note to ebmr_app;
      grant usage on all sequences in schema a4_escapes to ebmr_app;`;
    await gmp.admin.query(table);
    await sbx.admin.query(table);
    await sbx.admin.query('select sandbox.mirror_application_privileges()');
    const insert = 'insert into a4_escapes.note (body) values ($1)';
    for (const text of ['50%B24-0001', 'lot %E2409001 found', 'ref%A24-0001']) {
      await expect(sbx.sandbox.query(insert, [text]), text).rejects.toThrow(/^a4_escapes\.note body holds a word of the form of a batch or lot number that is not a test one: .*\[EBMR-SBX-024\]$/);
      await expect(gmp.app.query(insert, [text]), text).resolves.toBeDefined();
    }
    await expect(sbx.sandbox.query(insert, ['at 100% load, 50%RH'])).resolves.toBeDefined();
    expect((await sbx.admin.query("select 1 from a4_escapes.note where body like '%B24%' or body like '%E24%' or body like '%A24%'")).rowCount).toBe(0);
  });

  it('[DI-05][INV-18] kernel 1040: in a sandbox the person register holds no real-format identifier after the TEST- prefix: a legal name, an employee reference or a login name holding one is refused (EBMR-SBX-024); TEST- names and login names pass, and a GMP installation keeps its real names', async () => {
    const asRelease = async (db: { admin: { connect: () => Promise<pg.PoolClient> } }, work: (c: pg.PoolClient) => Promise<unknown>): Promise<string> => {
      const c = await db.admin.connect();
      try {
        await c.query('begin');
        await c.query(`select kernel.set_actor_context(jsonb_build_object(
          'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
          'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
          'site_zone', 'UTC', 'correlation_id', gen_random_uuid(), 'legal_name', 'Software release (test fixture)',
          'reason_code', 'SOFTWARE_RELEASE', 'reason_text', 'kernel 1040 test person'))`);
        await work(c);
        await c.query('commit');
        return 'ok';
      } catch (error) {
        await c.query('rollback');
        return (error as Error).message;
      } finally {
        c.release();
      }
    };
    const person = (name: string, ref: string | null = null) => (c: pg.PoolClient) => c.query("insert into iam.person (kind, legal_name, employee_ref) values ('NATURAL', $1, $2)", [name, ref]);
    const login = (identifier: string) => (c: pg.PoolClient) => c.query('insert into iam.issued_identifier (identifier, account_id) values ($1, gen_random_uuid())', [identifier]);
    const REFUSED = /^iam\.(person (legal_name|employee_ref)|issued_identifier identifier) holds a word of the form of a batch or lot number that is not a test one: .*\[EBMR-SBX-024\]$/;
    const sandbox = {
      name: await asRelease(sbx, person('TEST-Priya L2409-0017')),
      lowerCase: await asRelease(sbx, person('TEST-Priya l2409-0017')),
      employeeRef: await asRelease(sbx, person('TEST-Asha Rao', 'L2409-0017')),
      longLogin: await asRelease(sbx, login(`test-${'a'.repeat(30)}-l2409-0017`)),
      testName: await asRelease(sbx, person('TEST-Priya Nair')),
      testNumberedName: await asRelease(sbx, person('TEST-Trainee-01')),
      testLogin: await asRelease(sbx, login('test-operator-1')),
    };
    expect(sandbox.name).toMatch(REFUSED);
    expect(sandbox.lowerCase).toMatch(REFUSED);
    expect(sandbox.employeeRef).toMatch(REFUSED);
    expect(sandbox.longLogin).toMatch(REFUSED);
    expect({ testName: sandbox.testName, testNumberedName: sandbox.testNumberedName, testLogin: sandbox.testLogin }).toEqual({ testName: 'ok', testNumberedName: 'ok', testLogin: 'ok' });
    for (const m of Object.values(sandbox)) expect(m).not.toMatch(/2409/);
    expect((await sbx.admin.query("select 1 from iam.person where legal_name like '%2409%' or employee_ref like '%2409%'")).rowCount).toBe(0);
    // A GMP installation keeps its real names.
    expect(await asRelease(gmp, person('Priya L2409-0017', 'L2409-0017'))).toBe('ok');
  });
});
