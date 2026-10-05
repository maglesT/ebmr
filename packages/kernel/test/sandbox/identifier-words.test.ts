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

/**
 * What the readings of kernels 1030 to 1110 read in each text as a real batch or lot number: the words of the identifier
 * alphabet that sandbox.real_identifiers returns, as the application role asks. Since kernel 1120 it also returns, whole,
 * every word that holds a digit and a character outside the alphabet (readWhole, below); the tests of the earlier
 * kernels' readings leave those out, and the kernel 1120 tests read them.
 */
async function readText(texts: readonly string[]): Promise<Record<string, string[]>> {
  const out = await readWhole(texts);
  for (const t of texts) out[t] = (out[t] ?? []).filter((w) => /^[A-Za-z0-9/.-]+$/.test(w));
  return out;
}

/** Everything sandbox.real_identifiers returns for each text, as the application role asks (kernel 1120 included). */
async function readWhole(texts: readonly string[]): Promise<Record<string, string[]>> {
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

  it('[DI-05][DI-30][INV-18] kernel 1050: honest text is still not read as the identifier alphabet: prose with an emoji and its variation selector, a soft hyphen in a long word without digits, Hindi prose with Devanagari and ASCII digits and the danda, Tamil, Greek, Japanese and Korean prose with a number, a fraction and a date, TEST- identifiers (kernel 1120 also reads, whole, a word among them that joins a digit to a character outside the alphabet: decision F12.14)', async () => {
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
    const { rows: counts } = await gmp.app.query<{ basis: string; n: number }>(
      // Kernel 1050's own bases (1060 and 1070 add others, counted in their tests).
      "select basis, count(*)::int as n from sandbox.look_alike where basis in ('DASH_PUNCTUATION', 'DECIMAL_DIGIT', 'UTS39_CONFUSABLE', 'UTS39_DECOMPOSED') group by basis order by basis",
    );
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

  it('[DI-05][DI-30][INV-18] kernel 1060: letters and digits that Unicode names and no other table reads are read: L2409-0017 with a small capital L, a regional indicator L or a negative squared L, and in dingbat circled digits; sandbox.look_alike holds 372 such characters with no decomposition (UNICODE_NAME), each read as what its name says, alone and between a letter and digits; the flag of India, two regional indicators, away from a number is not read', async () => {
    const texts = {
      smallCapital: `${ch(0x29f)}2409-0017`,
      regionalIndicator: `${ch(0x1f1f1)}2409-0017`,
      negativeSquared: `${ch(0x1f17b)}2409-0017`,
      dingbatDigits: `L${ch(0x2777)}${ch(0x2779)}${ch(0x24ff)}${ch(0x277e)}-0017`,
      flag: `Export to ${ch(0x1f1ee)}${ch(0x1f1f3)} in 2026`,
    };
    const read = await readText(Object.values(texts));
    expect(Object.fromEntries(Object.entries(texts).map(([k, t]) => [k, read[t]]))).toEqual({
      smallCapital: ['L2409-0017'],
      regionalIndicator: ['L2409-0017'],
      negativeSquared: ['L2409-0017'],
      dingbatDigits: ['L2409-0017'],
      flag: [],
    });
    const { rows: named } = await gmp.app.query<{ n: number; unread: number }>(
      `select count(*)::int as n,
              count(*) filter (where sandbox.look_alikes_read(chr(l.code_point)) <> l.reads_as
                                  or not exists (select 1 from sandbox.real_identifiers('Q' || chr(l.code_point) || '24')))::int as unread
         from sandbox.look_alike l where l.basis = 'UNICODE_NAME'`,
    );
    expect(named).toEqual([{ n: 372, unread: 0 }]);
    const { rows: samples } = await gmp.app.query<{ code_point: number; reads_as: string }>(
      "select code_point, reads_as from sandbox.look_alike where basis = 'UNICODE_NAME' and code_point = any ($1::int[]) order by 1",
      [[0x29f, 0x1d0d, 0x1f1f1, 0x1f17b, 0x2776, 0x1369, 0x26c]],
    );
    expect(Object.fromEntries(samples.map((r) => [r.code_point, r.reads_as]))).toEqual({ [0x26c]: 'l', [0x29f]: 'L', [0x1369]: '1', [0x1d0d]: 'M', [0x2776]: '1', [0x1f17b]: 'L', [0x1f1f1]: 'L' });
  });
});

/**
 * UTS #39 confusables.txt 18.0.0: the class of U+30FC KATAKANA-HIRAGANA PROLONGED SOUND MARK, the prototype it gives
 * U+2014 EM DASH, U+2015 HORIZONTAL BAR and U+FF0D FULLWIDTH HYPHEN-MINUS, which the reading reads as '-' (kernel 1070).
 */
const PROLONGED_SOUND_MARK_CLASS = [
  0x1173, 0x1bc7, 0x2014, 0x2015, 0x2500, 0x2501, 0x2f00, 0x30fc, 0x3161, 0x3192, 0x31d0, 0x4e00, 0xa7f7, 0xff0d, 0xff70,
  0xffda, 0x1104b,
];
/** Kernel 1070: the dashes read by name (UnicodeData.txt 18.0.0) or as Chromium 141 draws them (a stroke at hyphen height). */
const DASHES = [
  0x0c7c, 0x1680, 0x172d, 0x1b78, 0x1c7c, 0x23af, 0x23e4, 0x2504, 0x2505, 0x2508, 0x2509, 0x254c, 0x254d, 0x2574, 0x2576,
  0x2578, 0x257a, 0x257c, 0x257e, 0x29ff, 0x2d67, 0x2e43, 0x3127, 0x10110, 0x10d8f, 0x11049, 0x11052, 0x110be, 0x1bc03,
  0x1bc08, 0x1bc0d, 0x1ce0d, 0x1ce0e, 0x1d01a, 0x1d047, 0x1d116, 0x1d13c, 0x1d2e5, 0x1fb78, 0x1fb79, 0x1fb7a,
];
/** Kernel 1070: the solidi read by name or as Chromium 141 draws them (a stroke along the rising diagonal). */
const SOLIDI = [0x0f3c, 0x2e4a, 0xa6f3, 0xa937, 0x10462, 0x1aff0, 0x1bc4f, 0x1f67c];
/** Kernel 1080: the full stops read as Chromium 141 draws them (one dot on the baseline) or by name (U+2E3C). */
const FULL_STOPS = [0x1390, 0x2e3c, 0x10100, 0x1bc94, 0x1d085, 0x1d147];
const HAIR_SPACE = ch(0x200a);
const SIX_PER_EM_SPACE = ch(0x2006);
const THIN_SPACE = ch(0x2009);
const OGHAM_SPACE_MARK = ch(0x1680);

describe('the identifier rule reads the look-alikes of the separators as a class (kernel 1070)', () => {
  it('[DI-05][DI-30][INV-18] kernel 1070: every member of the UTS #39 class of U+30FC (the class of the em dash and the fullwidth hyphen-minus: box-drawing horizontals, the prolonged sound mark, CJK one, Hangul eu, the Brahmi line) and every listed dash is read as - between letters and digits, and every listed solidus as /: LOT─2409─0017, LOTー2409ー0017, LOT⎯2409⎯0017, B─24─0001 and BATCH🙼2409🙼0017 are read; the Ogham space mark, drawn as a stroke, is a dash; the hair space and the six-per-em space show no gap and the thin space still does', async () => {
    const probes = {
      boxHorizontal: 'LOT─2409─0017',
      heavyBoxHorizontal: 'LOT━2409━0017',
      prolongedSoundMark: 'LOTー2409ー0017',
      cjkStroke: 'LOT㇐2409㇐0017',
      lineExtension: 'LOT⎯2409⎯0017',
      batchNumber: 'B─24─0001',
      tripleDash: 'LOT┄2409┄0017',
      verySolidus: `BATCH${ch(0x1f67c)}2409${ch(0x1f67c)}0017`,
      ogham: `L${OGHAM_SPACE_MARK}2409${OGHAM_SPACE_MARK}0017`,
      hairSpace: `Drum of lot L${HAIR_SPACE}2409-0017 set aside`,
      sixPerEmSpace: `Drum of lot L${SIX_PER_EM_SPACE}2409-0017 set aside`,
      // A residual (decision F12.11): the thin space, a fifth of an em, separates a number from its unit in honest text.
      thinSpace: `Drum of lot L${THIN_SPACE}2409-0017 set aside`,
    };
    const read = await readText(Object.values(probes));
    expect(Object.fromEntries(Object.entries(probes).map(([k, t]) => [k, read[t]]))).toEqual({
      boxHorizontal: ['LOT-2409-0017'],
      heavyBoxHorizontal: ['LOT-2409-0017'],
      prolongedSoundMark: ['LOT-2409-0017'],
      cjkStroke: ['LOT-2409-0017'],
      lineExtension: ['LOT-2409-0017'],
      batchNumber: ['B-24-0001'],
      tripleDash: ['LOT-2409-0017'],
      verySolidus: ['BATCH/2409/0017'],
      ogham: ['L-2409-0017'],
      hairSpace: ['L2409-0017'],
      sixPerEmSpace: ['L2409-0017'],
      thinSpace: [],
    });
    // The whole class and every listed separator: a test that fails as soon as one of them is not folded.
    const unread: string[] = [];
    for (const [cps, sep, head] of [[PROLONGED_SOUND_MARK_CLASS, '-', 'LOT'], [DASHES, '-', 'LOT'], [SOLIDI, '/', 'BATCH']] as const) {
      for (const cp of cps) {
        const c = ch(cp);
        const words = (await readText([`${head}${c}2409${c}0017`]))[`${head}${c}2409${c}0017`] ?? [];
        if (!words.includes(`${head}${sep}2409${sep}0017`)) unread.push(`U+${cp.toString(16).toUpperCase()}`);
      }
    }
    expect(unread).toEqual([]);
  });

  it('[DI-05][DI-30][INV-18] kernel 1070: a letter drawn with a dot or an apostrophe in one character (U+013F, U+0140, U+14B7, U+0491) and the letters UTS #39 gives the look of a letter the reading reads by name (Cyrillic в, к and т, Greek κ and τ, Cherokee small letters) are read as that letter; the compatibility forms of Unicode 18.0.0 that PostgreSQL 16 does not decompose are read through their decomposition; sandbox.look_alike holds kernel 1070\'s 179 rows, each read alone and between a letter and digits; the application role cannot write them', async () => {
    const probes = {
      lWithMiddleDot: `${ch(0x13f)}2409-0017`,
      smallLWithMiddleDot: `${ch(0x140)}2409-0017`,
      syllabicsLWithDot: `${ch(0x14b7)}2409-0017`,
      cyrillicVe: `${ch(0x432)}24-0001`,
      cyrillicKa: `${ch(0x43a)}24-0001`,
      greekKappa: `${ch(0x3ba)}24-0001`,
      cyrillicTe: `LO${ch(0x442)}-2409-0017`,
      cherokeeSmallTle: `${ch(0xabae)}2409-0017`,
      modifierCapitalS: `${ch(0xa7f1)}24-0001`,
    };
    const read = await readText(Object.values(probes));
    expect(Object.fromEntries(Object.entries(probes).map(([k, t]) => [k, read[t]]))).toEqual({
      lWithMiddleDot: ['L2409-0017'],
      smallLWithMiddleDot: ['l2409-0017'],
      syllabicsLWithDot: ['L2409-0017'],
      cyrillicVe: ['B24-0001'],
      cyrillicKa: ['K24-0001'],
      greekKappa: ['K24-0001'],
      cyrillicTe: ['LOT-2409-0017'],
      cherokeeSmallTle: ['L2409-0017'],
      modifierCapitalS: ['S24-0001'],
    });
    const { rows: counts } = await gmp.app.query<{ basis: string; n: number; unread: number }>(
      `select basis, count(*)::int as n,
              count(*) filter (where sandbox.look_alikes_read(chr(l.code_point)) <> l.reads_as
                                  or not exists (select 1 from sandbox.real_identifiers('Q' || chr(l.code_point) || '24')))::int as unread
         from sandbox.look_alike l
        where basis in ('LETTER_WITH_SIGN', 'SEPARATOR_SHAPE', 'UCD_COMPATIBILITY', 'UTS39_PROTOTYPE_CLASS')
        group by basis order by basis`,
    );
    expect(counts).toEqual([
      { basis: 'LETTER_WITH_SIGN', n: 27, unread: 0 },
      // 49 of kernel 1070 and the 6 full stops of kernel 1080.
      { basis: 'SEPARATOR_SHAPE', n: 55, unread: 0 },
      { basis: 'UCD_COMPATIBILITY', n: 34, unread: 0 },
      { basis: 'UTS39_PROTOTYPE_CLASS', n: 69, unread: 0 },
    ]);
    await expect(gmp.app.query("insert into sandbox.look_alike (code_point, reads_as, basis) values (12290, '.', 'SEPARATOR_SHAPE')")).rejects.toThrow(/permission denied/);
    await expect(gmp.app.query("delete from sandbox.look_alike where code_point = 12540")).rejects.toThrow(/permission denied/);
  });

  it('[DI-05][DI-30][INV-18] kernel 1070: honest text is still not read as the identifier alphabet: Japanese prose with the prolonged sound mark, Chinese prose with the ideograph one, Korean prose with the letter eu, Greek prose with kappa and tau, a number and its unit written with a thin space or a narrow no-break space, an emoji, TEST- identifiers; the same texts naming LOTー2409ー0017 or L─24─0001 are read (kernel 1120 also reads, whole, a word among them that joins a digit to a character outside the alphabet: decision F12.14)', async () => {
    const texts = [
      'ローラーを清掃し、データ 3 件を記録しました。',
      '一号滚筒已称重，共 3 桶。',
      '드럼 3개 확인 ㅡ 이상 없음',
      'Το κουτί 3 ζυγίστηκε στις 10:15',
      `250${THIN_SPACE}mg and 12${ch(0x202f)}kg weighed ${ch(0x2714)}${ch(0xfe0f)}`,
      'Drum TEST-L26-0101 ー TEST-B26-0001 一 done',
    ];
    expect(await readText(texts)).toEqual(Object.fromEntries(texts.map((t) => [t, []])));
    const named = texts.flatMap((t) => [`${t} LOTー2409ー0017`, `L─24─0001 ${t}`]);
    const read = await readText(named);
    expect(Object.entries(read).filter(([t, w]) => !w.includes(t.startsWith('L─') ? 'L-24-0001' : 'LOT-2409-0017')).map(([t]) => t)).toEqual([]);
  });

  it('[DI-05][DI-30][INV-18] kernel 1070: sandbox.guard_free_text refuses in a sandbox a row whose text holds LOT─2409─0017, Ŀ2409-0017 or L2409-0017 with a hair space after the L (EBMR-SBX-024) without the word in the refusal, and a sandbox person whose employee reference holds Ŀ2409-0017 (EBMR-SBX-024); a GMP installation keeps them; honest text with the prolonged sound mark is stored', async () => {
    const table = `
      create schema a4_sep;
      create table a4_sep.note (id serial primary key, title text);
      create trigger ac_sandbox_free_text before insert on a4_sep.note for each row execute function sandbox.guard_free_text('title');
      grant usage on schema a4_sep to ebmr_app;
      grant select, insert on a4_sep.note to ebmr_app;
      grant usage on all sequences in schema a4_sep to ebmr_app;`;
    await gmp.admin.query(table);
    await sbx.admin.query(table);
    await sbx.admin.query('select sandbox.mirror_application_privileges()');
    const insert = 'insert into a4_sep.note (title) values ($1)';
    const outcome = async (db: { query: (q: string, v: unknown[]) => Promise<unknown> }, title: string): Promise<string> => {
      try {
        await db.query(insert, [title]);
        return 'ok';
      } catch (error) {
        return (error as Error).message;
      }
    };
    const FREE_TEXT = /^a4_sep\.note title holds a word of the form of a batch or lot number that is not a test one: .*\[EBMR-SBX-024\]$/;
    for (const title of ['Drum of LOT─2409─0017', `Drum of ${ch(0x13f)}2409-0017`, `Drum of L${HAIR_SPACE}2409-0017`, 'Drum of LOTー2409ー0017']) {
      const m = await outcome(sbx.sandbox, title);
      expect(m, title).toMatch(FREE_TEXT);
      expect(m, title).not.toMatch(/2409/);
    }
    expect(await outcome(sbx.sandbox, 'Drum TEST-L26-0101 ー データ 3 件')).toBe('ok');
    expect((await sbx.admin.query("select 1 from a4_sep.note where title like '%2409%'")).rowCount).toBe(0);
    for (const title of ['Drum of LOT─2409─0017', `Drum of ${ch(0x13f)}2409-0017`]) expect(await outcome(gmp.app, title)).toBe('ok');
    // The person register reads names as the stubs do (kernel 1040): a person label allows ASCII only after TEST-.
    const c = await sbx.admin.connect();
    try {
      await c.query('begin');
      await c.query(`select kernel.set_actor_context(jsonb_build_object(
        'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
        'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
        'site_zone', 'UTC', 'correlation_id', gen_random_uuid(), 'legal_name', 'Software release (test fixture)',
        'reason_code', 'SOFTWARE_RELEASE', 'reason_text', 'kernel 1070 test'))`);
      await expect(c.query("insert into iam.person (kind, legal_name, employee_ref) values ('NATURAL', 'TEST-Asha Rao', $1)", [`ref ${ch(0x13f)}2409-0017`])).rejects.toThrow(
        /^iam\.person employee_ref holds a word of the form of a batch or lot number that is not a test one: .*\[EBMR-SBX-024\]$/,
      );
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
  it('[DI-05][DI-30][INV-18] kernel 1080: the look-alikes of the full stop are read as a class too: L.2409-0017 written with a glyph Chromium 141 draws as one dot on the baseline (U+1390, U+10100, U+1BC94, U+1D085, U+1D147) or with U+2E3C STENOGRAPHIC FULL STOP is read; a Braille dot, drawn with the gap of its cell, and the ypogegrammeni, drawn below the line like a comma, stay separators', async () => {
    const unread: string[] = [];
    for (const cp of FULL_STOPS) {
      const t = `Drum of lot L${ch(cp)}2409-0017`;
      if (!((await readText([t]))[t] ?? []).includes('L.2409-0017')) unread.push(`U+${cp.toString(16).toUpperCase()}`);
    }
    expect(unread).toEqual([]);
    const separators = [`L${ch(0x2840)}2409-0017`, `L${ch(0x37a)}2409-0017`];
    expect(await readText(separators)).toEqual(Object.fromEntries(separators.map((t) => [t, []])));
    const { rows } = await gmp.app.query<{ code_point: number; reads_as: string; basis: string }>(
      'select code_point, reads_as, basis from sandbox.look_alike where code_point = any ($1::int[]) order by 1',
      [FULL_STOPS],
    );
    expect(rows).toEqual(FULL_STOPS.map((cp) => ({ code_point: cp, reads_as: '.', basis: 'SEPARATOR_SHAPE' })));
  });
});

/** Kernel 1090: the characters Chromium 141 lays out with no advance after a Latin letter, other than the spacing marks. */
const NO_ADVANCE = [0xa717, 0xa718, 0xa719, 0xa71a, 0xa8fa, 0xfffc, 0x1193f, 0x11941, 0x11a3a, 0x11a86, 0x11a87, 0x11a88, 0x11a89, 0x11d46];
/** Every spacing combining mark (general category Mc) of the runtime's Unicode tables (17.0; kernel 1090 holds 18.0's 477). */
const SPACING_MARKS: number[] = [];
for (let cp = 0x80; cp <= 0x10ffff; cp++) if ((cp < 0xd800 || cp > 0xdfff) && /\p{Mc}/u.test(String.fromCodePoint(cp))) SPACING_MARKS.push(cp);
const OBJECT_REPLACEMENT = ch(0xfffc);
/** Kernel 1100: U+1D1A0 MUSICAL SYMBOL ORNAMENT STROKE-6, laid out with an advance of at most a pixel between digits. */
const ORNAMENT_STROKE_6 = 0x1d1a0;

describe('the identifier rule reads what takes no room in the E2E browser as nothing (kernel 1090)', () => {
  it('[DI-05][DI-30][INV-18] kernel 1090: L2409-0017 and B24-0001 with U+FFFC after the letter (laid out with no advance and no ink), and L2409-0017 with a spacing mark after the L (U+1031 and U+102B drawn before it, U+0C03 on it, U+0903 with an advance), are read; every spacing mark and every other character laid out with no advance is read as nothing between a letter and digits; the class holds the 477 spacing marks of Unicode 18.0.0 and 14 others', async () => {
    const probes = {
      objectReplacement: `Drum L${OBJECT_REPLACEMENT}2409-0017 set aside`,
      objectReplacementBatch: `after batch B${OBJECT_REPLACEMENT}24-0001`,
      myanmarE: `Drum L${ch(0x1031)}2409-0017`,
      myanmarTallAa: `Drum L${ch(0x102b)}2409-0017`,
      teluguVisarga: `Drum L${ch(0xc03)}2409-0017`,
      devanagariVisarga: `Drum L${ch(0x903)}2409-0017`,
    };
    const read = await readText(Object.values(probes));
    expect(Object.fromEntries(Object.entries(probes).map(([k, t]) => [k, read[t]]))).toEqual({
      objectReplacement: ['L2409-0017'],
      objectReplacementBatch: ['B24-0001'],
      myanmarE: ['L2409-0017'],
      myanmarTallAa: ['L2409-0017'],
      teluguVisarga: ['L2409-0017'],
      devanagariVisarga: ['L2409-0017'],
    });
    // Every one of them between Q and 24, which is read as an identifier only when the character is read as nothing.
    const { rows: unread } = await gmp.app.query<{ cp: number }>(
      "select cp from unnest($1::int[]) cp where not exists (select 1 from sandbox.real_identifiers('Q' || chr(cp) || '24'))",
      [[...NO_ADVANCE, ...SPACING_MARKS]],
    );
    expect(unread.map((r) => `U+${r.cp.toString(16).toUpperCase()}`)).toEqual([]);
    const { rows: count } = await gmp.app.query<{ n: number; fffc: boolean; mc: number }>(
      `select count(*)::int as n, bool_or(g = 65532) as fffc, count(*) filter (where g <> all ($1::int[]))::int as mc
         from generate_series(128, 1114111) g where (g < 55296 or g > 57343) and chr(g) ~ sandbox.no_advance_class()`,
      [[...NO_ADVANCE, ORNAMENT_STROKE_6]],
    );
    // Kernel 1100 adds U+1D1A0 to the class (its own test reads it).
    expect(count).toEqual([{ n: 492, fffc: true, mc: 477 }]);
  });

  it('[DI-05][DI-30][INV-18] kernel 1090: honest text is still not read as the identifier alphabet: Hindi prose with its vowel signs, Devanagari and ASCII digits and a number written against a word (25वां), Tamil and Telugu prose with a number, an emoji and its variation selector, a soft hyphen in a long word, TEST- identifiers (kernel 1120 also reads, whole, a word among them that joins a digit to a character outside the alphabet: decision F12.14)', async () => {
    const texts = [
      'बैच के २५ ड्रम तौले गए। कुल वज़न 250 किलो है। यह 25वां बैच है।',
      'ड्रम को साफ़ किया गया और 3 नमूने लिए गए।',
      'டிரம் 3 எடை பார்க்கப்பட்டது',
      'డ్రమ్ 3 బరువు చూశారు: సరే',
      `Booth cleaned ${ch(0x2714)}${ch(0xfe0f)}, pharma${SOFT_HYPHEN}ceutical grade, TEST-L26-0101 and TEST-B26-0001`,
    ];
    expect(await readText(texts)).toEqual(Object.fromEntries(texts.map((t) => [t, []])));
  });

  it('[DI-05][DI-30][INV-18] kernel 1090: in a sandbox sandbox.guard_free_text refuses a row whose text holds L2409-0017 with U+FFFC, U+1031 or U+0C03 after the L (EBMR-SBX-024) without the word in the refusal, and a person whose employee reference holds L U+FFFC 2409-0017; a GMP installation keeps them; honest Hindi prose and a TEST- identifier are stored', async () => {
    const table = `
      create schema a4_room;
      create table a4_room.note (id serial primary key, title text);
      create trigger ac_sandbox_free_text before insert on a4_room.note for each row execute function sandbox.guard_free_text('title');
      grant usage on schema a4_room to ebmr_app;
      grant select, insert on a4_room.note to ebmr_app;
      grant usage on all sequences in schema a4_room to ebmr_app;`;
    await gmp.admin.query(table);
    await sbx.admin.query(table);
    await sbx.admin.query('select sandbox.mirror_application_privileges()');
    const outcome = async (db: { query: (q: string, v: unknown[]) => Promise<unknown> }, title: string): Promise<string> => {
      try {
        await db.query('insert into a4_room.note (title) values ($1)', [title]);
        return 'ok';
      } catch (error) {
        return (error as Error).message;
      }
    };
    const FREE_TEXT = /^a4_room\.note title holds a word of the form of a batch or lot number that is not a test one: .*\[EBMR-SBX-024\]$/;
    const probes = [`Drum of L${OBJECT_REPLACEMENT}2409-0017`, `Drum of L${ch(0x1031)}2409-0017`, `Drum of L${ch(0xc03)}2409-0017`];
    for (const title of probes) {
      const m = await outcome(sbx.sandbox, title);
      expect(m, title).toMatch(FREE_TEXT);
      expect(m, title).not.toMatch(/2409/);
    }
    // A number joined to a Devanagari word (25वां) is refused in a sandbox since kernel 1120 (decision F12.14): the number
    // stands apart here.
    expect(await outcome(sbx.sandbox, 'ड्रम TEST-L26-0101 को साफ़ किया गया, बैच 25')).toBe('ok');
    expect((await sbx.admin.query("select 1 from a4_room.note where title like '%2409%'")).rowCount).toBe(0);
    for (const title of probes) expect(await outcome(gmp.app, title)).toBe('ok');
    const c = await sbx.admin.connect();
    try {
      await c.query('begin');
      await c.query(`select kernel.set_actor_context(jsonb_build_object(
        'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
        'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
        'site_zone', 'UTC', 'correlation_id', gen_random_uuid(), 'legal_name', 'Software release (test fixture)',
        'reason_code', 'SOFTWARE_RELEASE', 'reason_text', 'kernel 1090 test'))`);
      await expect(c.query("insert into iam.person (kind, legal_name, employee_ref) values ('NATURAL', 'TEST-Asha Rao', $1)", [`ref L${OBJECT_REPLACEMENT}2409-0017`])).rejects.toThrow(
        /^iam\.person employee_ref holds a word of the form of a batch or lot number that is not a test one: .*\[EBMR-SBX-024\]$/,
      );
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});

/** Kernel 1100: punctuation drawn close to a letter with a mark, left out (a separator, as the danda). */
const PUNCTUATION_DRAWN_AS_LETTERS = [0x230a, 0x230b, 0xff3b];

describe('the identifier rule reads letters and digits as the E2E browser draws them (kernel 1100)', () => {
  it('[DI-05][DI-30][INV-18] kernel 1100: letters UTS #39 does not list but Chromium 141 draws as the alphabet are read: U+053C ARMENIAN CAPITAL LETTER LIWN as L in L2409-0017 and L24-0001, U+14AB CANADIAN SYLLABICS MAA as L with a dot; sandbox.look_alike holds 58 such characters (LETTER_SHAPE), each read alone and between a letter and digits; punctuation drawn close to a letter stays a separator; U+1D1A0, laid out with no room between digits, is read as nothing', async () => {
    const probes = {
      armenianLiwn: `${ch(0x53c)}2409-0017`,
      armenianLiwnBatch: `after lot ${ch(0x53c)}24-0001`,
      syllabicsMaa: `${ch(0x14ab)}2409-0017`,
      gothicHagl: `Drum ${ch(0x10337)}24-0001 weighed`,
      ornamentStroke: `Drum L${ch(ORNAMENT_STROKE_6)}2409-0017`,
      floor: `Q${ch(0x230a)}24`,
    };
    const read = await readText(Object.values(probes));
    expect(Object.fromEntries(Object.entries(probes).map(([k, t]) => [k, read[t]]))).toEqual({
      armenianLiwn: ['L2409-0017'],
      armenianLiwnBatch: ['L24-0001'],
      syllabicsMaa: ['L2409-0017'],
      gothicHagl: ['h24-0001'],
      ornamentStroke: ['L2409-0017'],
      floor: [],
    });
    const { rows: counts } = await gmp.app.query<{ n: number; unread: number }>(
      `select count(*)::int as n,
              count(*) filter (where sandbox.look_alikes_read(chr(l.code_point)) <> l.reads_as
                                  or not exists (select 1 from sandbox.real_identifiers('Q' || chr(l.code_point) || '24')))::int as unread
         from sandbox.look_alike l where l.basis = 'LETTER_SHAPE'`,
    );
    // Kernel 1100's 58 and the 84 kernel 1110 adds (its own test reads them).
    expect(counts).toEqual([{ n: 58 + 84, unread: 0 }]);
    const { rows: samples } = await gmp.app.query<{ code_point: number; reads_as: string }>(
      "select code_point, reads_as from sandbox.look_alike where basis = 'LETTER_SHAPE' and code_point = any ($1::int[]) order by 1",
      [[0x43f, 0x53c, 0x5d7, 0x7d7, 0x14ab, 0x18ba, 0x2758, 0x4e28, 0x10337]],
    );
    expect(Object.fromEntries(samples.map((r) => [r.code_point, r.reads_as]))).toEqual({
      [0x43f]: 'n', [0x53c]: 'L', [0x5d7]: 'n', [0x7d7]: '1', [0x14ab]: 'L', [0x18ba]: 'L', [0x2758]: 'l', [0x4e28]: 'l', [0x10337]: 'h',
    });
    expect((await gmp.app.query('select 1 from sandbox.look_alike where code_point = any ($1::int[])', [PUNCTUATION_DRAWN_AS_LETTERS])).rowCount).toBe(0);
    await expect(gmp.app.query("insert into sandbox.look_alike (code_point, reads_as, basis) values (1329, 'A', 'LETTER_SHAPE')")).rejects.toThrow(/permission denied/);
  });

  it('[DI-05][DI-30][INV-18] kernel 1100: honest text is still not read as the identifier alphabet: Hindi, Tamil and Telugu prose with numbers (no letter of their scripts is drawn as the alphabet), Greek, Japanese, Chinese and Korean prose, an emoji, TEST- identifiers; Japanese prose that joins a Latin letter to a number with the prolonged sound mark (ラインAー1) is read as A-1 and so refused in a test run (decision F12.12 (4) corrected) (kernel 1120 also reads, whole, a word among them that joins a digit to a character outside the alphabet: decision F12.14)', async () => {
    const texts = [
      'बैच के २५ ड्रम तौले गए। कुल वज़न 250 किलो है। यह 25वां बैच है।',
      'டிரம் 3 எடை பார்க்கப்பட்டது',
      'డ్రమ్ 3 బరువు చూశారు',
      'Το δοχείο 3 ζυγίστηκε στις 10:15',
      'ドラム 3 本を計量しました',
      '一号滚筒已称重，共 3 桶。',
      '드럼 3개 확인',
      `Booth cleaned ${ch(0x2714)}${ch(0xfe0f)}, TEST-L26-0101 and TEST-B26-0001`,
    ];
    expect(await readText(texts)).toEqual(Object.fromEntries(texts.map((t) => [t, []])));
    expect(await readText(['ラインAー1を清掃しました'])).toEqual({ 'ラインAー1を清掃しました': ['A-1'] });
  });

  it('[DI-05][DI-30][INV-18] kernel 1100: in a sandbox sandbox.guard_free_text refuses a row whose text holds U+053C 2409-0017 or U+14AB 2409-0017 (EBMR-SBX-024) without the word in the refusal, and a person whose employee reference holds U+053C 2409-0017; a GMP installation keeps them; honest text is stored', async () => {
    const table = `
      create schema a4_drawn;
      create table a4_drawn.note (id serial primary key, title text);
      create trigger ac_sandbox_free_text before insert on a4_drawn.note for each row execute function sandbox.guard_free_text('title');
      grant usage on schema a4_drawn to ebmr_app;
      grant select, insert on a4_drawn.note to ebmr_app;
      grant usage on all sequences in schema a4_drawn to ebmr_app;`;
    await gmp.admin.query(table);
    await sbx.admin.query(table);
    await sbx.admin.query('select sandbox.mirror_application_privileges()');
    const outcome = async (db: { query: (q: string, v: unknown[]) => Promise<unknown> }, title: string): Promise<string> => {
      try {
        await db.query('insert into a4_drawn.note (title) values ($1)', [title]);
        return 'ok';
      } catch (error) {
        return (error as Error).message;
      }
    };
    const FREE_TEXT = /^a4_drawn\.note title holds a word of the form of a batch or lot number that is not a test one: .*\[EBMR-SBX-024\]$/;
    const probes = [`Drum of ${ch(0x53c)}2409-0017`, `Drum of ${ch(0x14ab)}2409-0017`, `Drum of L${ch(ORNAMENT_STROKE_6)}2409-0017`];
    for (const title of probes) {
      const m = await outcome(sbx.sandbox, title);
      expect(m, title).toMatch(FREE_TEXT);
      expect(m, title).not.toMatch(/2409/);
    }
    expect(await outcome(sbx.sandbox, 'Drum TEST-L26-0101 ड्रम 3 டிரம் 3')).toBe('ok');
    expect((await sbx.admin.query("select 1 from a4_drawn.note where title like '%2409%'")).rowCount).toBe(0);
    for (const title of probes) expect(await outcome(gmp.app, title)).toBe('ok');
    const c = await sbx.admin.connect();
    try {
      await c.query('begin');
      await c.query(`select kernel.set_actor_context(jsonb_build_object(
        'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
        'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
        'site_zone', 'UTC', 'correlation_id', gen_random_uuid(), 'legal_name', 'Software release (test fixture)',
        'reason_code', 'SOFTWARE_RELEASE', 'reason_text', 'kernel 1100 test'))`);
      await expect(c.query("insert into iam.person (kind, legal_name, employee_ref) values ('NATURAL', 'TEST-Asha Rao', $1)", [`ref ${ch(0x53c)}2409-0017`])).rejects.toThrow(
        /^iam\.person employee_ref holds a word of the form of a batch or lot number that is not a test one: .*\[EBMR-SBX-024\]$/,
      );
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});

describe('the identifier rule reads letters and digits as the E2E browser draws them at every weight of free text, compared in full (kernel 1110)', () => {
  it('[DI-05][DI-30][INV-18] kernel 1110: letters Chromium 141 draws as the alphabet at the regular weight that kernel 1100\'s first cut missed (Old Italic HE as B, the turned h as u, the Old Polish O as O) and those it draws so at the semibold and bold weights the product shows free text in (the schwa as a, Cyrillic Ғ as F, the Masaram Gondi letter E and the Mro letter YO as L) are read; sandbox.look_alike holds 84 more LETTER_SHAPE rows, each read alone and between a letter and digits; the punctuation and kernel 1100\'s rows are not listed again', async () => {
    const probes = {
      oldItalicHe: `after batch ${ch(0x10307)}24-0001`,
      turnedH: `Drum ${ch(0x265)}24-0001`,
      oldPolishO: `L${ch(0xa7c0)}409-0017`,
      schwa: `Drum ${ch(0x259)}24-0001`,
      gheWithStroke: `Drum ${ch(0x492)}24-0001`,
      masaramGondiE: `${ch(0x11d06)}2409-0017`,
      mroYo: `after lot ${ch(0x16a42)}24-0001`,
    };
    const read = await readText(Object.values(probes));
    expect(Object.fromEntries(Object.entries(probes).map(([k, t]) => [k, read[t]]))).toEqual({
      oldItalicHe: ['B24-0001'],
      turnedH: ['u24-0001'],
      oldPolishO: ['LO409-0017'],
      schwa: ['a24-0001'],
      gheWithStroke: ['F24-0001'],
      masaramGondiE: ['L2409-0017'],
      mroYo: ['L24-0001'],
    });
    const { rows: counts } = await gmp.app.query<{ n: number; unread: number }>(
      `select count(*)::int as n,
              count(*) filter (where sandbox.look_alikes_read(chr(l.code_point)) <> l.reads_as
                                  or not exists (select 1 from sandbox.real_identifiers('Q' || chr(l.code_point) || '24')))::int as unread
         from sandbox.look_alike l where l.basis = 'LETTER_SHAPE'`,
    );
    // Kernel 1100's 58 and kernel 1110's 84.
    expect(counts).toEqual([{ n: 58 + 84, unread: 0 }]);
    const { rows: added } = await gmp.app.query<{ code_point: number; reads_as: string }>(
      "select code_point, reads_as from sandbox.look_alike where basis = 'LETTER_SHAPE' and code_point = any ($1::int[]) order by 1",
      [[0x259, 0x265, 0x393, 0x42d, 0x492, 0xe01, 0x10307, 0x11d06, 0x16a42]],
    );
    expect(Object.fromEntries(added.map((r) => [r.code_point, r.reads_as]))).toEqual({
      [0x259]: 'a', [0x265]: 'u', [0x393]: 'l', [0x42d]: '3', [0x492]: 'F', [0xe01]: 'n', [0x10307]: 'B', [0x11d06]: 'L', [0x16a42]: 'L',
    });
    expect((await gmp.app.query('select 1 from sandbox.look_alike where code_point = any ($1::int[])', [[...PUNCTUATION_DRAWN_AS_LETTERS, 0x11a9b]])).rowCount).toBe(0);
  });

  it('[DI-05][DI-30][INV-18] kernel 1110: honest text is still not read as the identifier alphabet: Hindi, Tamil, Telugu, Greek, Japanese, Chinese and Korean prose with numbers, an emoji, TEST- identifiers (kernel 1120 also reads, whole, a word among them that joins a digit to a character outside the alphabet: decision F12.14)', async () => {
    const texts = [
      'बैच के २५ ड्रम तौले गए। कुल वज़न 250 किलो है। यह 25वां बैच है।',
      'ड्रम को साफ़ किया गया और 3 नमूने लिए गए।',
      'டிரம் 3 எடை பார்க்கப்பட்டது',
      'డ్రమ్ 3 బరువు చూశారు',
      'Το δοχείο 3 ζυγίστηκε στις 10:15',
      'ドラム 3 本を計量しました',
      '一号滚筒已称重，共 3 桶。',
      '드럼 3개 확인',
      `Booth cleaned ${ch(0x2714)}${ch(0xfe0f)}, TEST-L26-0101 and TEST-B26-0001`,
    ];
    expect(await readText(texts)).toEqual(Object.fromEntries(texts.map((t) => [t, []])));
  });

  it('[DI-05][DI-30][INV-18] kernel 1110: in a sandbox sandbox.guard_free_text refuses a row whose text holds B24-0001 written with the Old Italic HE or L2409-0017 written with the Masaram Gondi letter E (EBMR-SBX-024) without the word in the refusal, and a person whose employee reference holds the latter; a GMP installation keeps them', async () => {
    const table = `
      create schema a4_weights;
      create table a4_weights.note (id serial primary key, title text);
      create trigger ac_sandbox_free_text before insert on a4_weights.note for each row execute function sandbox.guard_free_text('title');
      grant usage on schema a4_weights to ebmr_app;
      grant select, insert on a4_weights.note to ebmr_app;
      grant usage on all sequences in schema a4_weights to ebmr_app;`;
    await gmp.admin.query(table);
    await sbx.admin.query(table);
    await sbx.admin.query('select sandbox.mirror_application_privileges()');
    const outcome = async (db: { query: (q: string, v: unknown[]) => Promise<unknown> }, title: string): Promise<string> => {
      try {
        await db.query('insert into a4_weights.note (title) values ($1)', [title]);
        return 'ok';
      } catch (error) {
        return (error as Error).message;
      }
    };
    const FREE_TEXT = /^a4_weights\.note title holds a word of the form of a batch or lot number that is not a test one: .*\[EBMR-SBX-024\]$/;
    const probes = [`after batch ${ch(0x10307)}24-0001`, `Drum of ${ch(0x11d06)}2409-0017`];
    for (const title of probes) {
      const m = await outcome(sbx.sandbox, title);
      expect(m, title).toMatch(FREE_TEXT);
      // The refusal's own example, TEST-L24-0001, is not the probe.
      expect(m.replaceAll('TEST-L24-0001', ''), title).not.toMatch(/2409|24-0001/);
    }
    expect((await sbx.admin.query("select 1 from a4_weights.note where title like '%2409%' or title like '%24-0001%'")).rowCount).toBe(0);
    for (const title of probes) expect(await outcome(gmp.app, title)).toBe('ok');
    const c = await sbx.admin.connect();
    try {
      await c.query('begin');
      await c.query(`select kernel.set_actor_context(jsonb_build_object(
        'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
        'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
        'site_zone', 'UTC', 'correlation_id', gen_random_uuid(), 'legal_name', 'Software release (test fixture)',
        'reason_code', 'SOFTWARE_RELEASE', 'reason_text', 'kernel 1110 test'))`);
      await expect(c.query("insert into iam.person (kind, legal_name, employee_ref) values ('NATURAL', 'TEST-Asha Rao', $1)", [`ref ${ch(0x11d06)}2409-0017`])).rejects.toThrow(
        /^iam\.person employee_ref holds a word of the form of a batch or lot number that is not a test one: .*\[EBMR-SBX-024\]$/,
      );
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});

/**
 * Kernel 1120 (the verification of the lane's round 7, lane round 3, closed with its structural alternative, decision
 * F12.14): the characters it found drawn as a Latin letter or digit that no table lists. In the product's sans-serif face
 * at 400 to 700: U+0460 (W), U+A646 (I), U+056A (d), U+104FB (z), U+2AEE (l), U+04FD, U+13A6, U+1456, U+1D03, U+28B8 and
 * U+A666; in the monospace face of the signed text: U+03D8 (Q), U+053A and U+10EB (d), U+0252 (o), U+057F (m), U+10DC and
 * U+1E9F (6). From kernel 1120 on, in a sandbox, a word that holds a digit is written with ASCII letters, ASCII digits,
 * '/', '.' and '-' only, whatever a table lists.
 */
const UNLISTED_DRAWN = [0x0460, 0xa646, 0x056a, 0x104fb, 0x2aee, 0x04fd, 0x13a6, 0x1456, 0x1d03, 0x28b8, 0xa666, 0x03d8, 0x053a, 0x10eb, 0x0252, 0x057f, 0x10dc, 0x1e9f];
const hexOf = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

describe('in a sandbox a word that holds a digit is plain ASCII (kernel 1120)', () => {
  it('[DI-05][DI-30][INV-18] kernel 1120: a word ends only at Unicode White_Space or ASCII punctuation other than / . - (sandbox.text_words); each character the verification of round 7 found drawn as a Latin letter or digit and listed by no table (U+0460, U+A646, U+056A, U+104FB, U+2AEE, U+04FD, U+13A6, U+1456, U+1D03, U+28B8, U+A666; in the monospace face U+03D8, U+053A, U+10EB, U+0252, U+057F, U+10DC, U+1E9F) is read as nothing alone, and a word that glues it to digits, before or after, is read whole; so is a word with a digit that holds an invisible character, a bidirectional control, a mark or a digit of another script', async () => {
    // Alone: no table reads them, and a word without a digit is not held to ASCII.
    expect(Object.values(await readWhole(UNLISTED_DRAWN.map(ch))).flat()).toEqual([]);
    const glued: Record<string, string[]> = {};
    const expected: Record<string, string[]> = {};
    for (const cp of UNLISTED_DRAWN) {
      const c = ch(cp);
      const texts = [`Drum of ${c}24-0001 set aside`, `lot ${c}2409-0017.`, `drum 2409-0017${c} found`];
      const read = await readWhole(texts);
      glued[hexOf(cp)] = texts.flatMap((t) => read[t] ?? []);
      expected[hexOf(cp)] = [`${c}24-0001`, `${c}2409-0017`, `2409-0017${c}`];
    }
    expect(glued).toEqual(expected);
    // Inside a word with a digit, what kernels 1050 to 1090 read as nothing or as the alphabet makes the word read whole,
    // besides what those readings read.
    const inside = {
      invisible: `L${ch(0x200b)}2409-0017`,
      bidi: `L${ch(0x202e)}7100-9042${ch(0x202c)}`,
      combiningMark: `L${ch(0x301)}2409-0017`,
      spacingMark: `L${ch(0x1031)}2409-0017`,
      devanagariDigits: 'L२४०९-००१७',
    };
    const read = await readWhole(Object.values(inside).map((w) => `Drum of ${w} set aside`));
    for (const [name, w] of Object.entries(inside)) expect(read[`Drum of ${w} set aside`], name).toContain(w);
    expect(read[`Drum of ${inside.invisible} set aside`]).toEqual(['L2409-0017', inside.invisible].sort());
    // The one boundary of a word: White_Space and ASCII punctuation other than '/', '.' and '-'; a zero-width space, a soft
    // hyphen, the danda and a hyphen look-alike stay inside the word.
    const boundary = `a!b"c#d$e%f&g'h(i)j*k+l,m-n.o/p:q;r<s=t>u?v@w[x\\y]z^A_B\`C{D|E}F~G H\tI${ch(0xa0)}J${ch(0x2009)}K${ch(0x3000)}L${ch(0x200b)}M${SOFT_HYPHEN}N${ch(0x964)}O${ch(0x2010)}P`;
    const { rows: words } = await gmp.app.query<{ w: string }>('select w from sandbox.text_words($1) w', [boundary]);
    expect(words.map((r) => r.w)).toEqual([...'abcdefghijkl', 'm-n.o/p', ...'qrstuvwxyzABCDEFGHIJK', `L${ch(0x200b)}M${SOFT_HYPHEN}N${ch(0x964)}O${ch(0x2010)}P`]);
  });

  it('[DI-05][DI-30][INV-18] kernel 1120: honest text is still not read: Hindi prose with ASCII digits apart from its words (बैच 24 का वज़न 12.5 kg), Tamil, Japanese, Korean and Greek prose with a number apart, an emoji with its variation selector next to a word, a soft hyphen in a long word without digits, TEST- identifiers, dates and quantities in ASCII; the accepted cost of decision F12.14 is read whole: digits of another script, a number joined to a word of another script or to a sign, a vulgar fraction, a keycap, a hyphen look-alike in a word with a digit, a word with a letter a table reads as a digit', async () => {
    const honest = [
      'बैच 24 का वज़न 12.5 kg',
      'ड्रम को साफ़ किया गया और 3 नमूने लिए गए। कुल वज़न 250 किलो है।',
      'டிரம் 3 எடை பார்க்கப்பட்டது',
      'ドラム 3 本を計量しました',
      '드럼 3 개 확인',
      'Το δοχείο 3 ζυγίστηκε στις 10:15',
      `Booth cleaned ${ch(0x2714)}${ch(0xfe0f)} by the operator ${ch(0x1f44d)}${ch(0x1f3fd)}, 2 of 3 drums weighed`,
      `Booth${ch(0x2714)}${ch(0xfe0f)}cleaned, 2 of 3 drums weighed`,
      `pharma${SOFT_HYPHEN}ceutical ingre${SOFT_HYPHEN}dients weighed`,
      'Drum TEST-L26-0101 of batch TEST-B26-0001',
      'Weighed on 2026-10-05 at 10:15: 12.5 kg, then 250 mg',
      `250${THIN_SPACE}mg and 12${ch(0x202f)}kg weighed`,
    ];
    expect(await readWhole(honest)).toEqual(Object.fromEntries(honest.map((t) => [t, []])));
    // Refused in a test run from kernel 1120 on although honest (decision F12.14): the refusal says to write the number
    // with the digits 0 to 9 and a space.
    const cost: Record<string, string> = {
      'बैच के २५ ड्रम तौले गए': '२५',
      'कुल वज़न २४किलो': '२४किलो',
      'यह 25वां बैच है': '25वां',
      'दिनांक 04/10/2026।': '04/10/2026।',
      '드럼 3개 확인': '3개',
      'ドラム3本を計量しました': 'ドラム3本を計量しました',
      'Store below 25°C': '25°C',
      '12.5 g ±0.1 g': '±0.1',
      'range 2–8 °C': '2–8',
      [`${ch(0xbd)} of a drum`]: ch(0xbd),
      [`keycap 3${ch(0xfe0f)}${ch(0x20e3)}`]: `3${ch(0xfe0f)}${ch(0x20e3)}`,
      [`moved to DISP${ch(0x2010)}1`]: `DISP${ch(0x2010)}1`,
      'бутылка': 'бутылка',
    };
    const read = await readWhole(Object.keys(cost));
    for (const [t, w] of Object.entries(cost)) expect(read[t], t).toContain(w);
  });

  it('[DI-05][DI-30][INV-18] kernel 1120: in a sandbox sandbox.guard_free_text refuses a row whose text holds <U+0460>24-0001, <U+A646>2409-0017, <U+10EB>2409-0017, <U+03D8>2409-0017, <U+056A>2409-0017 or Devanagari digits joined to a word (EBMR-SBX-024), naming the column and saying to write ASCII digits, never the word; a person label holding one is refused (EBMR-SBX-022), an employee reference holding one too (EBMR-SBX-024); a GMP installation keeps them; honest text is stored', async () => {
    const table = `
      create schema a4_digits;
      create table a4_digits.note (id serial primary key, title text);
      create trigger ac_sandbox_free_text before insert on a4_digits.note for each row execute function sandbox.guard_free_text('title');
      grant usage on schema a4_digits to ebmr_app;
      grant select, insert on a4_digits.note to ebmr_app;
      grant usage on all sequences in schema a4_digits to ebmr_app;`;
    await gmp.admin.query(table);
    await sbx.admin.query(table);
    await sbx.admin.query('select sandbox.mirror_application_privileges()');
    const outcome = async (db: { query: (q: string, v: unknown[]) => Promise<unknown> }, title: string): Promise<string> => {
      try {
        await db.query('insert into a4_digits.note (title) values ($1)', [title]);
        return 'ok';
      } catch (error) {
        return (error as Error).message;
      }
    };
    const ASCII_ONLY = /^a4_digits\.note title holds a word that holds a digit and a character other than an ASCII letter, an ASCII digit, '\/', '\.' or '-': .*Write a number with the digits 0 to 9, and put a space between a number and a word of another script or a sign \(DI-05, INV-18\)\. \[EBMR-SBX-024\]$/;
    const probes = [
      `Drum of ${ch(0x460)}24-0001 set aside`,
      `Drum of ${ch(0xa646)}2409-0017 set aside`,
      `Drum ${ch(0x10eb)}2409-0017 re-checked; no impact.`,
      `Drum ${ch(0x3d8)}2409-0017 re-checked`,
      `Drum ${ch(0x56a)}2409-0017 re-checked`,
      'कुल वज़न २४०९किलो',
    ];
    for (const title of probes) {
      const m = await outcome(sbx.sandbox, title);
      expect(m, title).toMatch(ASCII_ONLY);
      expect(m, title).not.toMatch(/2409|24-0001|२४०९/);
    }
    expect((await sbx.admin.query("select 1 from a4_digits.note where title ~ '2409|24-0001|२४०९'")).rowCount).toBe(0);
    expect(await outcome(sbx.sandbox, 'बैच 24 का वज़न 12.5 kg, TEST-L26-0101')).toBe('ok');
    for (const title of probes) expect(await outcome(gmp.app, title), title).toBe('ok');
    const asRelease = async (db: { admin: { connect: () => Promise<pg.PoolClient> } }, name: string, ref: string): Promise<string> => {
      const c = await db.admin.connect();
      try {
        await c.query('begin');
        await c.query(`select kernel.set_actor_context(jsonb_build_object(
          'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
          'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
          'site_zone', 'UTC', 'correlation_id', gen_random_uuid(), 'legal_name', 'Software release (test fixture)',
          'reason_code', 'SOFTWARE_RELEASE', 'reason_text', 'kernel 1120 test'))`);
        await c.query("insert into iam.person (kind, legal_name, employee_ref) values ('NATURAL', $1, $2)", [name, ref]);
        await c.query('commit');
        return 'ok';
      } catch (error) {
        await c.query('rollback');
        return (error as Error).message;
      } finally {
        c.release();
      }
    };
    expect(await asRelease(sbx, `TEST-Asha ${ch(0x460)}24-0001`, 'EMP 7')).toMatch(/is not a test person label: .*\[EBMR-SBX-022\]$/);
    const employeeRef = await asRelease(sbx, 'TEST-Asha Rao', `ref ${ch(0x10eb)}2409-0017`);
    expect(employeeRef).toMatch(/^iam\.person employee_ref holds a word that holds a digit and a character other than an ASCII letter, .*\[EBMR-SBX-024\]$/);
    expect(employeeRef).not.toMatch(/2409/);
    expect((await sbx.admin.query("select 1 from iam.person where employee_ref like '%2409%' or legal_name like '%24-0001%'")).rowCount).toBe(0);
    expect(await asRelease(sbx, 'TEST-Asha Rao', 'EMP 2409 stores')).toBe('ok');
    expect(await asRelease(gmp, `Asha ${ch(0x460)}24-0001`, `ref ${ch(0x10eb)}2409-0017`)).toBe('ok');
  });
});

/**
 * Kernel 1130 (the verification of the lane's round 8): a text that can display in another order is read in every
 * arrangement of its runs, the runs of characters outside ASCII included. Kernel 1050's arrangement joined only runs of
 * ASCII letters to runs of digits, so kernel 1120 never saw a word a line displays joined although it is stored apart:
 * 'बैच <U+0460><U+200F> 24-0001 मिला' (a right-to-left mark after the letter, then a space) is drawn by Chromium 141 as
 * 'बैच Ѡ24-0001  मिला', the space moved after the digits, and the U+05D0 form as 'Ѡ24-0001 א'. Each character of
 * UNLISTED_DRAWN is probed so; the prose is Hindi or Tamil, so that no ASCII word is read by kernel 1050's arrangement.
 */
const RIGHT_TO_LEFT_MARK = ch(0x200f);
const HEBREW_ALEF = ch(0x5d0);
const reorderedProbes = (c: string): Record<string, string> => ({
  [`बैच ${c}${RIGHT_TO_LEFT_MARK} 24-0001 मिला`]: `${c}24`,
  [`बैच ${c}${HEBREW_ALEF} 24-0001 मिला`]: `${c}${HEBREW_ALEF}24`,
  [`டிரம் ${c}${RIGHT_TO_LEFT_MARK} 2409-0017 கிடைத்தது`]: `${c}2409`,
  // A comma between the mark and the digits takes the right-to-left direction too (UAX #9, N1) and is drawn after them.
  [`बैच ${c}${RIGHT_TO_LEFT_MARK}, 24-0001 मिला`]: `${c}24`,
});

describe('in a sandbox a word that holds a digit is plain ASCII also as a line that can display in another order shows it (kernel 1130)', () => {
  it('[DI-05][DI-30][INV-18] kernel 1130: a text that holds a right-to-left mark or letter is read in every arrangement of its runs, the runs of characters outside ASCII joined to every run of digits: बैच <c><U+200F> 24-0001 मिला, बैच <c><U+05D0> 24-0001 मिला, the same with a comma after the mark, and Tamil prose with <c><U+200F> 2409-0017 (drawn as <c>24-0001 and <c>2409-0017) are read for each of the 18 characters the verification of round 7 listed; the same prose without the mark or the letter, which displays as it is stored, is not', async () => {
    const read: Record<string, string[]> = {};
    const expected: Record<string, string[]> = {};
    for (const cp of UNLISTED_DRAWN) {
      const c = ch(cp);
      const probes = reorderedProbes(c);
      const got = await readWhole(Object.keys(probes));
      for (const [t, w] of Object.entries(probes)) {
        read[`${hexOf(cp)} ${t}`] = (got[t] ?? []).filter((x) => x === w);
        expected[`${hexOf(cp)} ${t}`] = [w];
      }
    }
    expect(read).toEqual(expected);
    // What a probe is read as: the letter with the mark (as stored) and without it (as it shows), each joined to each run
    // of digits; the Hindi words joined to them too (the accepted cost of decision F12.15).
    const omega = `बैच ${ch(0x460)}${RIGHT_TO_LEFT_MARK} 24-0001 मिला`;
    expect((await readWhole([omega]))[omega]).toEqual(
      expect.arrayContaining([`${ch(0x460)}24`, `${ch(0x460)}0001`, `${ch(0x460)}${RIGHT_TO_LEFT_MARK}24`, `${ch(0x460)}${RIGHT_TO_LEFT_MARK}0001`, 'बैच24', 'मिला0001']),
    );
    // Without a character that can reorder the line, the text displays as stored: a space keeps the letter apart.
    const apart = UNLISTED_DRAWN.flatMap((cp) => [`बैच ${ch(cp)} 24-0001 मिला`, `டிரம் ${ch(cp)} 2409-0017 கிடைத்தது`]);
    expect(Object.values(await readWhole(apart)).flat()).toEqual([]);
  });

  it('[DI-05][DI-30][INV-18] kernel 1130: honest text is still not read: Hindi, Tamil, Japanese, Korean and Greek prose with ASCII digits apart from its words, an emoji with its variation selector, TEST- identifiers, Hebrew and Urdu prose without a number; the accepted cost of decision F12.15 is read: Urdu or Hebrew prose with a number, and any text with a direction mark and a number', async () => {
    const honest = [
      'बैच 24 का वज़न 12.5 kg',
      'டிரம் 3 எடை பார்க்கப்பட்டது',
      'ドラム 3 本を計量しました',
      '드럼 3 개 확인',
      'Το δοχείο 3 ζυγίστηκε στις 10:15',
      `Booth cleaned ${ch(0x2714)}${ch(0xfe0f)}, 2 of 3 drums weighed`,
      'Drum TEST-L26-0101 of batch TEST-B26-0001 on 2026-10-05, 12.5 kg',
      'התוף נשקל ונבדק',
      'ڈرم کا وزن کیا گیا',
    ];
    expect(await readWhole(honest)).toEqual(Object.fromEntries(honest.map((t) => [t, []])));
    // Hindi prose with a number apart and a right-to-left mark anywhere: read since kernel 1130 only (its words are joined to
    // the number, as a reordered line could show them); the others were read by kernel 1050's arrangement already.
    const cost = [`बैच 24 का वज़न${RIGHT_TO_LEFT_MARK}`, 'התוף 3 נשקל', 'ڈرم 24 کا وزن', `Weighed${ch(0x200e)} 12.5 kg`, `${ch(0x2067)}Drum${ch(0x2069)} weighed, 12.5 kg`];
    const read = await readWhole(cost);
    for (const t of cost) expect(read[t]?.length ?? 0, t).toBeGreaterThan(0);
  });

  it('[DI-05][DI-30][INV-18] kernel 1130: in a sandbox sandbox.guard_free_text refuses a row whose text holds <U+0460>, <U+A646>, <U+10EB>, <U+03D8> or <U+056A> before a right-to-left mark or a Hebrew letter and, after a space, 24-0001 or 2409-0017 (EBMR-SBX-024), naming the column, never the word; an employee reference <U+0460><U+05D0> 24-0001 is refused (EBMR-SBX-024); a GMP installation keeps them; honest prose is stored', async () => {
    const table = `
      create schema a4_order;
      create table a4_order.note (id serial primary key, title text);
      create trigger ac_sandbox_free_text before insert on a4_order.note for each row execute function sandbox.guard_free_text('title');
      grant usage on schema a4_order to ebmr_app;
      grant select, insert on a4_order.note to ebmr_app;
      grant usage on all sequences in schema a4_order to ebmr_app;`;
    await gmp.admin.query(table);
    await sbx.admin.query(table);
    await sbx.admin.query('select sandbox.mirror_application_privileges()');
    const outcome = async (db: { query: (q: string, v: unknown[]) => Promise<unknown> }, title: string): Promise<string> => {
      try {
        await db.query('insert into a4_order.note (title) values ($1)', [title]);
        return 'ok';
      } catch (error) {
        return (error as Error).message;
      }
    };
    const ASCII_ONLY = /^a4_order\.note title holds a word that holds a digit and a character other than an ASCII letter, an ASCII digit, '\/', '\.' or '-': .*\[EBMR-SBX-024\]$/;
    const probes = [0x460, 0xa646, 0x10eb, 0x3d8, 0x56a].flatMap((cp) => Object.keys(reorderedProbes(ch(cp))));
    for (const title of probes) {
      const m = await outcome(sbx.sandbox, title);
      expect(m, title).toMatch(ASCII_ONLY);
      expect(m, title).not.toMatch(/2409|0017|24-0001/);
    }
    expect((await sbx.admin.query("select 1 from a4_order.note where title ~ '2409|24-0001'")).rowCount).toBe(0);
    expect(await outcome(sbx.sandbox, 'बैच 24 का वज़न 12.5 kg, TEST-L26-0101')).toBe('ok');
    expect(await outcome(sbx.sandbox, 'התוף נשקל ונבדק')).toBe('ok');
    for (const title of probes) expect(await outcome(gmp.app, title), title).toBe('ok');
    const asRelease = async (db: { admin: { connect: () => Promise<pg.PoolClient> } }, name: string, ref: string): Promise<string> => {
      const c = await db.admin.connect();
      try {
        await c.query('begin');
        await c.query(`select kernel.set_actor_context(jsonb_build_object(
          'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
          'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
          'site_zone', 'UTC', 'correlation_id', gen_random_uuid(), 'legal_name', 'Software release (test fixture)',
          'reason_code', 'SOFTWARE_RELEASE', 'reason_text', 'kernel 1130 test'))`);
        await c.query("insert into iam.person (kind, legal_name, employee_ref) values ('NATURAL', $1, $2)", [name, ref]);
        await c.query('commit');
        return 'ok';
      } catch (error) {
        await c.query('rollback');
        return (error as Error).message;
      } finally {
        c.release();
      }
    };
    const employeeRef = await asRelease(sbx, 'TEST-Asha Rao', `${ch(0x460)}${HEBREW_ALEF} 24-0001`);
    expect(employeeRef).toMatch(/^iam\.person employee_ref holds a word that holds a digit and a character other than an ASCII letter, .*\[EBMR-SBX-024\]$/);
    expect(employeeRef).not.toMatch(/24-0001/);
    expect((await sbx.admin.query("select 1 from iam.person where employee_ref like '%24-0001%'")).rowCount).toBe(0);
    expect(await asRelease(sbx, 'TEST-Asha Rao', `${ch(0x460)} 24-0001`)).toBe('ok');
    expect(await asRelease(gmp, 'Asha Rao', `${ch(0x460)}${HEBREW_ALEF} 24-0001`)).toBe('ok');
  });
});
