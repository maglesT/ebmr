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

  it('[DI-05][INV-18] prose is not read as an identifier: words, numbers, decimals, dates, times, ranges, fractions, versions, ordinals, percentages, UUIDs, digests and escapes; and what the reading cannot see is stated (digits only, broken by a space or by a visible character outside the identifier alphabet)', async () => {
    const texts = [
      'Booth door found open after the clearance',
      '12.5 g at 100% load, 15-25 C, 1/2 tablet, version 1.5.0',
      'Checked on 2026-10-04 at 10:15 on the 2nd shift, 3rd attempt, 11th edition',
      'signature 3f2a9c1e-1234-5678-9abc-def012345678 over a3f9c2e14b5d6a7f8e9d0c1b2a3f4e5d6c7b8a9f0e1d2c3b4a5f6e7d8c9b0a1f',
      'U+0000 written \\u0000 and %00perform',
      // Not read (kernel 1030's header, as kernel 1050 narrows it): digits only, broken by a space or by a visible character
      // outside the identifier alphabet. Digits of another script are read since kernel 1050 (below).
      'lot 2409-0017',
      'lot L 2409 0017',
      'lot L%2409-0017',
      'lot L#2409-0017',
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
      // Since kernel 1050 the escaped character is read as it shows too: %E2 is U+00E2 (a with a circumflex, read as a),
      // %A2 is U+00A2 (the cent sign, a look-alike of c).
      'lot %E2409001 found': ['E2409001', 'a409001'],
      'ref%A24-0001': ['A24-0001', 'refc4-0001'],
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

/** The character of code point `cp`: the characters below that show nothing, or show as another, are written by number. */
const ch = (cp: number): string => String.fromCodePoint(cp);
const SOFT_HYPHEN = ch(0xad);
const DIVISION_SLASH = ch(0x2215);
const FRACTION_SLASH = ch(0x2044);
/** What shows nothing, by itself, after the L of L2409-0017 (the round-6 verification's characters). */
const INVISIBLE = { 'U+00AD': 0xad, 'U+200B': 0x200b, 'U+200D': 0x200d, 'U+034F': 0x34f, 'U+FE0F': 0xfe0f, 'U+2060': 0x2060 } as const;

describe('the identifier rule reads a text as it shows (kernel 1050)', () => {
  it('[DI-05][DI-30][INV-18] kernel 1050: what shows nothing hides nothing: L2409-0017 with U+00AD, U+200B, U+200D, U+034F, U+FE0F or U+2060 after the L, with a combining mark on the L, with a stroked L, and L 7100-9042 under a right-to-left override, which shows L2409-0017, are read', async () => {
    const texts = {
      ...Object.fromEntries(Object.entries(INVISIBLE).map(([name, cp]) => [name, `Drum of lot L${ch(cp)}2409-0017 set aside`])),
      combiningMark: `L${ch(0x307)}2409-0017`,
      strokedL: `${ch(0x141)}2409-0017`,
      override: `L${ch(0x202e)}7100-9042${ch(0x202c)}`,
    };
    const read = await readText(Object.values(texts));
    expect(Object.fromEntries(Object.entries(texts).map(([k, t]) => [k, read[t]]))).toEqual({
      ...Object.fromEntries(Object.keys(INVISIBLE).map((name) => [name, ['L2409-0017']])),
      combiningMark: ['L2409-0017'],
      strokedL: ['L2409-0017'],
      // As it shows, and every arrangement of its runs (header, item 4): the override reorders the display.
      override: ['L7100', 'L7100-9042', 'L9042'],
    });
  });

  it('[DI-05][DI-30][INV-18] kernel 1050: look-alikes are read as the identifier alphabet: BATCH/2409/0017 with the division or the fraction slash, in Cyrillic or Greek capitals, L2409-0017 with a Cherokee or a mathematical L, in Devanagari, Bengali or Arabic-Indic digits, with an en dash, an em dash or a minus sign; a text a right-to-left letter or mark reorders is read in every arrangement of its runs', async () => {
    const texts = {
      divisionSlash: `BATCH${DIVISION_SLASH}2409${DIVISION_SLASH}0017`,
      fractionSlash: `BATCH${FRACTION_SLASH}2409${FRACTION_SLASH}0017`,
      cyrillic: 'ВАТСН/2409/0017',
      greek: 'ΒΑΤϹΗ/2409/0017',
      cherokee: 'Ꮮ2409-0017',
      mathematical: `${ch(0x1d40b)}2409-0017`,
      devanagari: 'L२४०९-००१७',
      bengali: 'L২৪০৯-০০১৭',
      arabicIndic: 'L٢٤٠٩-٠٠١٧',
      enDash: `L${ch(0x2212)}2409${ch(0x2013)}0017`,
      emDash: `BATCH${ch(0x2014)}2409${ch(0x2014)}0017`,
      // U+05D0 HEBREW LETTER ALEF between the L and the digits shows L2409-0017 followed by the alef (Chromium 141).
      hebrewLetter: `Lot L${ch(0x5d0)}2409-0017`,
      // U+200F RIGHT-TO-LEFT MARK: shows L24-0017.
      rightToLeftMarks: `L${ch(0x200f)}0017${ch(0x200f)}-24`,
    };
    const read = await readText(Object.values(texts));
    expect(Object.fromEntries(Object.entries(texts).map(([k, t]) => [k, read[t]]))).toEqual({
      divisionSlash: ['BATCH/2409/0017'],
      fractionSlash: ['BATCH/2409/0017'],
      cyrillic: ['BATCH/2409/0017'],
      // U+03F9 GREEK CAPITAL LUNATE SIGMA SYMBOL shows as C; NFKC makes it a sigma, so the text as stored is read too.
      greek: ['BATCH/2409/0017', 'H/2409/0017'],
      cherokee: ['L2409-0017'],
      mathematical: ['L2409-0017'],
      devanagari: ['L2409-0017'],
      bengali: ['L2409-0017'],
      arabicIndic: ['L0017', 'L2409', 'L2409-0017'],
      enDash: ['L-2409-0017'],
      emDash: ['BATCH-2409-0017'],
      hebrewLetter: ['L0017', 'L2409', 'Lot0017', 'Lot2409'],
      rightToLeftMarks: ['L0017', 'L0017-24', 'L24'],
    });
  });

  it('[DI-05][DI-30][INV-18] kernel 1050: honest text is still not read: prose with an emoji and its variation selector, a soft hyphen in a long word without digits, Hindi prose with Devanagari and ASCII digits and the danda, Tamil, Greek, Japanese and Korean prose with a number, a fraction and a date, TEST- identifiers', async () => {
    const texts = [
      `Booth cleaned ${ch(0x2714)}${ch(0xfe0f)} by the operator ${ch(0x1f44d)}${ch(0x1f3fd)}, 2 of 3 drums weighed`,
      `pharma${SOFT_HYPHEN}ceutical ingre${SOFT_HYPHEN}dients weighed${SOFT_HYPHEN}`,
      'बैच के २५ ड्रम तौले गए। कुल वज़न 250 किलो। दिनांक 04/10/2026।',
      'டிரம் 3 எடை பார்க்கப்பட்டது',
      'Το δοχείο 3 ζυγίστηκε στις 10:15',
      'ドラム 3 本を計量しました',
      '드럼 3일 보관',
      `${ch(0xbd)} of drum TEST-L26-0101 spilled, 12.5 g ${ch(0xb1)} 0.1 g`,
      'TEST-L26-0101 and TEST-B26-0001',
    ];
    expect(await readText(texts)).toEqual(Object.fromEntries(texts.map((t) => [t, []])));
  });

  it('[DI-05][INV-18] kernel 1050: every look-alike sandbox.look_alike lists is read as what it reads as, alone and between a letter and digits; the table holds the 760 decimal digits of Unicode 18.0.0 by value, 1998 characters of confusables.txt 18.0.0 (86 of them read as their decomposition, a vulgar fraction one half as 1/2) and 19 other dashes, and the characters the verification named; the application role reads it and cannot write it', async () => {
    const { rows: counts } = await gmp.app.query<{ basis: string; n: number }>('select basis, count(*)::int as n from sandbox.look_alike group by basis order by basis');
    expect(counts).toEqual([
      { basis: 'DASH_PUNCTUATION', n: 19 },
      { basis: 'DECIMAL_DIGIT', n: 760 },
      { basis: 'UTS39_CONFUSABLE', n: 1912 },
      { basis: 'UTS39_DECOMPOSED', n: 86 },
    ]);
    // Every listed look-alike is folded: alone, and as the character between Q and 24, which is read only when it is.
    const { rows: unread } = await gmp.app.query<{ code_point: number }>(
      `select l.code_point from sandbox.look_alike l
        where sandbox.look_alikes_read(chr(l.code_point)) <> l.reads_as
           or not exists (select 1 from sandbox.real_identifiers('Q' || chr(l.code_point) || '24'))`,
    );
    expect(unread).toEqual([]);
    const named = { 0x00bd: '1/2', 0x2160: 'I', 0x2215: '/', 0x2044: '/', 0x0410: 'A', 0x0412: 'B', 0x0392: 'B', 0x03f9: 'C', 0x13de: 'L', 0x1d40b: 'L', 0x0966: '0', 0x09ea: '4', 0x0661: '1', 0x2010: '-', 0x2013: '-', 0x2212: '-', 0x2014: '-', 0x2024: '.' };
    const { rows: listed } = await gmp.app.query<{ code_point: number; reads_as: string }>('select code_point, reads_as from sandbox.look_alike where code_point = any ($1::int[]) order by 1', [Object.keys(named).map(Number)]);
    expect(Object.fromEntries(listed.map((r) => [r.code_point, r.reads_as]))).toEqual(Object.fromEntries(Object.entries(named).map(([cp, r]) => [Number(cp), r])));
    // Punctuation is read as the separator it is: the danda ends a Hindi sentence (header, item 2).
    expect((await gmp.app.query('select 1 from sandbox.look_alike where code_point = 2404')).rowCount).toBe(0);
    await expect(gmp.app.query("insert into sandbox.look_alike (code_point, reads_as, basis) values (200, 'x', 'UTS39_CONFUSABLE')")).rejects.toThrow(/permission denied/);
    await expect(gmp.app.query("update sandbox.look_alike set reads_as = 'x' where code_point = 8725")).rejects.toThrow(/permission denied/);
  });

  it('[DI-05][DI-30][INV-18] kernel 1050: in a sandbox a person named TEST-Priya L<soft hyphen>2409-0017 and a login name holding it are refused (EBMR-SBX-022: a person label allows ASCII only after TEST-), and sandbox.guard_free_text refuses an employee reference holding L<soft hyphen>2409-0017 and a row whose text holds it or BATCH/2409/0017 with the division slash (EBMR-SBX-024), without the word in the refusal; a GMP installation keeps them; honest names, references and texts are stored', async () => {
    const table = `
      create schema a4_shown;
      create table a4_shown.note (id serial primary key, title text);
      create trigger ac_sandbox_free_text before insert on a4_shown.note for each row execute function sandbox.guard_free_text('title');
      grant usage on schema a4_shown to ebmr_app;
      grant select, insert on a4_shown.note to ebmr_app;
      grant usage on all sequences in schema a4_shown to ebmr_app;`;
    await gmp.admin.query(table);
    await sbx.admin.query(table);
    const asRelease = async (db: { admin: { connect: () => Promise<pg.PoolClient> } }, work: (c: pg.PoolClient) => Promise<unknown>): Promise<string> => {
      const c = await db.admin.connect();
      try {
        await c.query('begin');
        await c.query(`select kernel.set_actor_context(jsonb_build_object(
          'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
          'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
          'site_zone', 'UTC', 'correlation_id', gen_random_uuid(), 'legal_name', 'Software release (test fixture)',
          'reason_code', 'SOFTWARE_RELEASE', 'reason_text', 'kernel 1050 test'))`);
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
    const record = (title: string) => (c: pg.PoolClient) => c.query('insert into a4_shown.note (title) values ($1)', [title]);
    const hidden = `L${SOFT_HYPHEN}2409-0017`;
    const sandbox = {
      name: await asRelease(sbx, person(`TEST-Priya ${hidden}`)),
      employeeRef: await asRelease(sbx, person('TEST-Asha Rao', hidden)),
      login: await asRelease(sbx, login(`test-asha-${hidden}`)),
      title: await asRelease(sbx, record(`Drum of lot ${hidden}`)),
      slashed: await asRelease(sbx, record(`Drum of BATCH${DIVISION_SLASH}2409${DIVISION_SLASH}0017`)),
      honestName: await asRelease(sbx, person('TEST-Priya Nair', `Pharma${SOFT_HYPHEN}cy stores`)),
      honestTitle: await asRelease(sbx, record(`Drum TEST-L26-0101 weighed ${ch(0x2714)}${ch(0xfe0f)}`)),
    };
    expect(sandbox.name).toMatch(/is not a test person label: .*\[EBMR-SBX-022\]$/);
    const FREE_TEXT = (column: string) => new RegExp(`^${column.replace('.', '\\.')} holds a word of the form of a batch or lot number that is not a test one: .*\\[EBMR-SBX-024\\]$`);
    expect(sandbox.employeeRef).toMatch(FREE_TEXT('iam.person employee_ref'));
    expect(sandbox.login).toMatch(/is not a test person label: .*\[EBMR-SBX-022\]$/);
    expect(sandbox.title).toMatch(FREE_TEXT('a4_shown.note title'));
    expect(sandbox.slashed).toMatch(FREE_TEXT('a4_shown.note title'));
    expect({ honestName: sandbox.honestName, honestTitle: sandbox.honestTitle }).toEqual({ honestName: 'ok', honestTitle: 'ok' });
    // The person label's refusal (kernel 0810) repeats the label; the free-text refusals never repeat the word.
    for (const [k, m] of Object.entries(sandbox)) if (k !== 'name' && k !== 'login') expect(m, k).not.toMatch(/2409/);
    expect((await sbx.admin.query("select 1 from iam.person where legal_name like '%2409%' or employee_ref like '%2409%'")).rowCount).toBe(0);
    expect((await sbx.admin.query("select 1 from iam.issued_identifier where identifier like '%2409%'")).rowCount).toBe(0);
    expect((await sbx.admin.query("select 1 from a4_shown.note where title like '%2409%'")).rowCount).toBe(0);
    // A GMP installation keeps what was written.
    expect(await asRelease(gmp, person(`Priya ${hidden}`, hidden))).toBe('ok');
    expect(await asRelease(gmp, record(`Drum of lot ${hidden}`))).toBe('ok');
  });
});
