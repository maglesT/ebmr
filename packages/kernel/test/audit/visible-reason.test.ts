/**
 * A reason half says something a person can read (outline 5.4; DI-22, DI-24; kernel 0960; review findings V1 and
 * P29). The audit trigger refuses an update or a removal of an audited row unless the command's reason code and
 * reason text are both non-blank by kernel.is_blank (EBMR-AUDIT-002). That test matched only what the database's
 * locale calls white space, which in C.UTF-8 is ASCII: a reason of no-break spaces, zero-width spaces, bidirectional
 * marks or annotation marks was recorded as if it said something. Now a text is blank when it holds only
 * characters that show nothing on their own: controls, Unicode white space, format characters, default-ignorable
 * code points and the Braille blank. records.is_blank is the same test. The recipe-core test audit-reason.test.ts
 * compares the class with the execution engine's over every code point.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seededTestActor } from '../support/seeded-actor.ts';

let db: TestDatabase;
let base: ActorContext;
beforeAll(async () => {
  db = await createTestDatabase();
  base = await seededTestActor(db, { legalName: 'Test Operator' });
});
afterAll(async () => {
  await db.drop();
});

/** Written as code points, so the source holds no invisible character. */
const cp = (...codes: number[]): string => String.fromCodePoint(...codes);

/** Texts that show nothing: white space and controls, format characters, default-ignorable code points, fillers. */
const SHOWS_NOTHING: Record<string, string> = {
  empty: '',
  asciiSpace: ' \t\r\n\v\f',
  nextLine: cp(0x85),
  noBreakSpaces: cp(0xa0, 0x2007, 0x202f),
  ideographicSpace: cp(0x3000),
  lineSeparators: cp(0x2028, 0x2029),
  softHyphen: cp(0xad),
  zeroWidth: cp(0x200b, 0x200c, 0x200d),
  bidiMarks: cp(0x200e, 0x200f, 0x061c, 0x202a, 0x202e, 0x2066, 0x2069),
  wordJoinerAndInvisibleOperators: cp(0x2060, 0x2061, 0x2064),
  byteOrderMark: cp(0xfeff),
  interlinearAnnotation: cp(0xfff9, 0xfffa, 0xfffb),
  hieroglyphFormatControls: cp(0x13430, 0x1343f),
  prependedMarks: cp(0x0600, 0x0605, 0x06dd, 0x070f, 0x0890, 0x0891, 0x08e2, 0x110bd, 0x110cd),
  mongolian: cp(0x180e, 0x180b),
  variationSelectors: cp(0xfe0f, 0xe0100),
  hangulFillers: cp(0x115f, 0x1160, 0x3164, 0xffa0),
  brailleBlank: cp(0x2800),
  shorthandAndMusicalFormat: cp(0x1bca0, 0x1d173, 0x1d17a),
  tags: cp(0xe0001, 0xe0020, 0xe007f),
  mixed: `${cp(0xa0)} ${cp(0x200b)}${cp(0xfff9)}\t${cp(0x13430)}${cp(0x3000)}`,
};

/** Texts with a character a person can read, in any script, among invisible ones or not. */
const SAYS_SOMETHING = ['x', '.', '0', 'पंजीकरण रद्द', '登録取消', `${cp(0x200b)}x${cp(0xfff9)}`, `${cp(0xa0)}wrong digit${cp(0x3000)}`, cp(0x2801), cp(0xfffc)];

describe('a reason half says something a person can read (kernel 0960)', () => {
  it('[DI-22][DI-24] kernel.is_blank and records.is_blank count a text as blank when it holds only characters that show nothing, and never a text with a readable character', async () => {
    const texts = [null, ...Object.values(SHOWS_NOTHING), ...SAYS_SOMETHING];
    const { rows } = await db.admin.query<{ p: string | null; kernel: boolean; records: boolean }>(
      'select p, kernel.is_blank(p) as kernel, records.is_blank(p) as records from unnest($1::text[]) with ordinality u (p, i) order by i',
      [texts],
    );
    const expected = texts.map((p) => ({ p, kernel: !SAYS_SOMETHING.includes(p as string), records: !SAYS_SOMETHING.includes(p as string) }));
    expect(rows).toEqual(expected);
  });

  it('[DI-22][DI-24][INV-07] an update or removal whose reason code or reason text shows nothing is refused (EBMR-AUDIT-002) and changes nothing; a reason with a readable character among invisible ones is recorded exactly as given', async () => {
    const batch = randomUUID();
    const id = await withCommand(db.app, { ...base, correlationId: randomUUID() }, async (c) => {
      const { rows } = await c.query<{ id: string }>('insert into testgmp.sample (batch_id, value) values ($1, 10.0) returning id', [batch]);
      return rows[0]?.id ?? '';
    });
    const valueNow = async () => (await db.admin.query<{ value: string }>('select value::text from testgmp.sample where id = $1', [id])).rows;
    for (const [name, blank] of Object.entries(SHOWS_NOTHING)) {
      for (const reason of [{ reasonCode: 'TRANSCRIPTION_ERROR', reasonText: blank }, { reasonCode: blank, reasonText: 'wrong digit' }]) {
        const ctx = { ...base, correlationId: randomUUID(), ...reason };
        await expect(withCommand(db.app, ctx, (c) => c.query('update testgmp.sample set value = 10.5 where id = $1', [id])), name).rejects.toThrow(
          /^EBMR-AUDIT-002 a reason is required to update testgmp\.sample: give a reason code and a reason text$/,
        );
        await expect(withCommand(db.app, ctx, (c) => c.query('delete from testgmp.sample where id = $1', [id])), name).rejects.toThrow(
          /^EBMR-AUDIT-002 a reason is required to delete testgmp\.sample: give a reason code and a reason text$/,
        );
        expect((await db.admin.query('select id from kernel.audit_event where correlation_id = $1', [ctx.correlationId])).rows, name).toEqual([]);
      }
    }
    expect(await valueNow()).toEqual([{ value: '10.0' }]);

    const ctx = { ...base, correlationId: randomUUID(), reasonCode: 'TRANSCRIPTION_ERROR', reasonText: `${cp(0x200b)}wrong digit${cp(0xa0)}` };
    await withCommand(db.app, ctx, (c) => c.query('update testgmp.sample set value = 10.5 where id = $1', [id]));
    expect(await valueNow()).toEqual([{ value: '10.5' }]);
    const { rows } = await db.admin.query<{ reason_code: string; reason_text: string }>(
      "select payload ->> 'reason_code' as reason_code, payload ->> 'reason_text' as reason_text from kernel.audit_event where correlation_id = $1 and action = 'UPDATE'",
      [ctx.correlationId],
    );
    expect(rows).toEqual([{ reason_code: 'TRANSCRIPTION_ERROR', reason_text: `${cp(0x200b)}wrong digit${cp(0xa0)}` }]);
  });

  it('[DI-22][DI-24] the blank tests keep their privileges: kernel.is_blank is the application\'s, records.is_blank and the reason guard stay private to the owner, and none runs with its owner\'s rights', async () => {
    const { rows } = await db.admin.query<{ fn: string; app: boolean; definer: boolean; volatility: string }>(
      `select p.oid::regprocedure::text as fn, has_function_privilege('ebmr_app', p.oid, 'execute') as app, p.prosecdef as definer, p.provolatile::text as volatility
         from pg_catalog.pg_proc p
        where p.oid in ('kernel.is_blank(text)'::regprocedure, 'records.is_blank(text)'::regprocedure,
                        'platform.guard_reason_given(text, uuid, jsonb, jsonb, jsonb)'::regprocedure)
        order by 1`,
    );
    expect(rows).toEqual([
      { fn: 'kernel.is_blank(text)', app: true, definer: false, volatility: 'i' },
      { fn: 'platform.guard_reason_given(text,uuid,jsonb,jsonb,jsonb)', app: false, definer: false, volatility: 's' },
      { fn: 'records.is_blank(text)', app: false, definer: false, volatility: 'i' },
    ]);
  });
});
