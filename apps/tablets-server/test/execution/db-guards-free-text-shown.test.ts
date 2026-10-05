/**
 * Phase 2 exit follow-up F12, the verification of the lane's round 6 (lane round 3): what a test run's record shows is
 * what the identifier rule reads (DI-05, DI-30, INV-18; kernel 1050, recipe-core 0349; ADR 0012).
 *
 * Kernel 1030 and 1040 read the words of a text as the runs of the identifier alphabet in its NFKC form, so a character
 * that shows nothing, a right-to-left override, a look-alike of a letter, a digit or a solidus, and a right-to-left
 * letter that reorders the line each split a real-format identifier into words the rule does not read, while the
 * record showed it whole. The verification recorded over HTTP, through the honest server, L2409-0017 with U+00AD,
 * U+200B, U+200D, U+034F, U+FE0F or U+2060 after the L, L 7100-9042 under U+202E (shown as L2409-0017), and
 * BATCH/2409/0017 with U+2215 or U+2044, in operator1's exception descriptions, supervisor1's hold reasons and business
 * entries the application role appended on the run's chain. Since kernel 1050 every text is also read as it shows
 * (what shows nothing and the combining marks removed), with its look-alikes read (UTS #39 confusables.txt, decimal
 * digits of any script, dashes), and a text that can display in another order in every arrangement of its runs.
 *
 * Kernel 1070 (the verification of the lane's round 7): the look-alikes of the separators are read as a class. UTS #39
 * gives the em dash and the fullwidth hyphen-minus, which 1050 reads as '-', the prototype U+30FC, shared with the
 * box-drawing horizontals, the prolonged sound mark and CJK one; those, the dashes and solidi Unicode names or Chromium
 * draws as such, a letter drawn with a dot (U+013F), a space narrower than the thin space and the Ogham space mark
 * (drawn as a dash) hid L2409-0017 or B24-0001 in records the honest server kept.
 *
 * Kernel 1090 (the verification of the lane's round 7, lane round 2): what Chromium, the E2E browser, lays out with no
 * advance hides nothing. U+FFFC OBJECT REPLACEMENT CHARACTER (no advance, no ink) and the spacing combining marks
 * (U+1031 and U+102B drawn before the L, U+0C03 on it) hid L2409-0017 and B24-0001 in records the honest server kept.
 *
 * Kernel 1100 (the same verification): letters UTS #39 does not list but Chromium draws as the alphabet, U+053C
 * ARMENIAN CAPITAL LETTER LIWN (drawn as L) and U+14AB CANADIAN SYLLABICS MAA (drawn as L with a dot), hid L2409-0017 and
 * L24-0001; our attack on kernel 1090 found U+1D1A0 laid out with no room between digits.
 *
 * Kernel 1110 (our attack on kernel 1100): its scan drew at the regular weight only, while the product draws free text
 * in bold too (an exception banner's title, an audit entry's summary), and its first cut skipped some references; the
 * Masaram Gondi letter E and the Mro letter YO (drawn as L in bold) and the Old Italic HE (drawn as B) hid L2409-0017,
 * L24-0001 and B24-0001.
 *
 * The writer is the application role, through the honest server (HTTP) or with the application's own credentials (a
 * business entry of the audit trail), as in the other db-guards files. Characters that show nothing are written by
 * number. Own file and server: the kiosk's device nonces are rate-limited per terminal and minute.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { actorOf, messageOf } from './db-guards-support.ts';
import { dcMini, importAndIssue, outcomeOf, RunDriver, startExecServer, violations, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

type Json = Record<string, unknown>;
const CLEAR = 'p-disp-clear@';
const REFUSED = '422:EBMR-EXE-147';
const ch = (cp: number): string => String.fromCodePoint(cp);

/** The verification's probes and this round's own (header): each shows a real-format identifier. */
const PROBES: Record<string, string> = {
  'U+00AD': `L${ch(0xad)}2409-0017`,
  'U+200B': `L${ch(0x200b)}2409-0017`,
  'U+200D': `L${ch(0x200d)}2409-0017`,
  'U+034F': `L${ch(0x34f)}2409-0017`,
  'U+FE0F': `L${ch(0xfe0f)}2409-0017`,
  'U+2060': `L${ch(0x2060)}2409-0017`,
  'U+202E': `L${ch(0x202e)}7100-9042${ch(0x202c)}`,
  'U+2215': `BATCH${ch(0x2215)}2409${ch(0x2215)}0017`,
  'U+2044': `BATCH${ch(0x2044)}2409${ch(0x2044)}0017`,
  cyrillic: 'ВАТСН/2409/0017',
  greek: 'ΒΑΤϹΗ/2409/0017',
  // The batch number B24-0001 with a Cyrillic or a Greek capital B, L2409-0017 with a Cyrillic palochka for the L.
  cyrillicB: 'В24-0001',
  greekB: 'Β24-0001',
  cyrillicL: 'Ӏ2409-0017',
  cherokee: 'Ꮮ2409-0017',
  devanagariDigits: 'L२४०९-००१७',
  arabicIndicDigits: 'L٢٤٠٩-٠٠١٧',
  hebrewLetter: `L${ch(0x5d0)}2409-0017`,
};

/** Kernel 1070: separators written with look-alikes, a letter drawn with a dot, a space that shows no gap (header). */
const SEPARATOR_PROBES: Record<string, string> = {
  'U+2500': 'LOT─2409─0017',
  'U+2501': 'LOT━2409━0017',
  'U+30FC': 'LOTー2409ー0017',
  'U+31D0': 'LOT㇐2409㇐0017',
  'U+23AF': 'LOT⎯2409⎯0017',
  'U+2504': 'LOT┄2409┄0017',
  'U+2500 batch': 'B─24─0001',
  'U+1F67C': `BATCH${ch(0x1f67c)}2409${ch(0x1f67c)}0017`,
  'U+013F': `${ch(0x13f)}2409-0017`,
  'U+14B7': `${ch(0x14b7)}2409-0017`,
  'U+0432': `${ch(0x432)}24-0001`,
  'U+200A': `L${ch(0x200a)}2409-0017`,
  'U+1680': `L${ch(0x1680)}2409${ch(0x1680)}0017`,
};

/** Kernel 1090: L2409-0017 or B24-0001 with a character Chromium lays out with no advance after the letter. */
const NO_ADVANCE_PROBES: Record<string, string> = {
  'U+FFFC': `L${ch(0xfffc)}2409-0017`,
  'U+FFFC batch': `B${ch(0xfffc)}24-0001`,
  'U+1031': `L${ch(0x1031)}2409-0017`,
  'U+102B': `L${ch(0x102b)}2409-0017`,
  'U+0C03': `L${ch(0xc03)}2409-0017`,
};

/** Kernel 1100: a letter drawn as L, and a character laid out with no room between digits. */
const DRAWN_PROBES: Record<string, string> = {
  'U+053C': `${ch(0x53c)}2409-0017`,
  'U+053C batch': `${ch(0x53c)}24-0001`,
  'U+14AB': `${ch(0x14ab)}2409-0017`,
  'U+1D1A0': `L${ch(0x1d1a0)}2409-0017`,
};

/** Kernel 1110: letters drawn as the alphabet in bold, or that kernel 1100's first cut missed. */
const WEIGHT_PROBES: Record<string, string> = {
  'U+11D06': `${ch(0x11d06)}2409-0017`,
  'U+16A42': `${ch(0x16a42)}24-0001`,
  'U+10307': `${ch(0x10307)}24-0001`,
};

/** A run of dc-mini issued by the issuer, with the kiosks of operator1 and supervisor1. */
async function issued(): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
  const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), supervisor1: await sbx.asPersona('supervisor1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

/** A business entry the application role appends itself, as operator1 at its kiosk (room DISP-1). */
async function businessEntry(d: RunDriver, chainKey: string, message: string, details: Json = {}): Promise<string> {
  return messageOf(
    withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), (c) => c.query('select kernel.audit_business_event($1, $2, $3::jsonb)', [chainKey, message, JSON.stringify(details)])),
  );
}

/**
 * Where the record of run `runId` holds `text`: rows, events, state, content versions and its audit chains. With
 * `standalone`, only where `text` stands outside a run of hexadecimal digits: the record holds ids and digests whose hex
 * digits can hold a short number such as 2409 by chance (an audit payload of the kernel 1070 test did so once, which
 * failed the check although no probe was stored), while every probe puts a letter, a separator or a look-alike beside
 * its digits.
 */
async function recordHolding(runId: string, text: string, standalone = false): Promise<Record<string, number>> {
  const [op, pattern] = standalone ? ['~', `(^|[^0-9A-Fa-f])${text}($|[^0-9A-Fa-f])`] : ['like', `%${text}%`];
  const count = async (sql: string) => Number((await sbx.db.admin.query<{ n: string }>(sql, [runId, pattern])).rows[0]?.n ?? '0');
  return {
    rows: await count(`select count(*)::text as n from recipe.execution_command where batch_id = $1 and (command::text ${op} $2 or evidence::text ${op} $2 or coalesce(refusal::text, '') ${op} $2)`),
    events: await count(`select count(*)::text as n from recipe.execution_event where batch_id = $1 and event::text ${op} $2`),
    state: await count(`select count(*)::text as n from recipe.execution_state where batch_id = $1 and state::text ${op} $2`),
    contents: await count(`select count(*)::text as n from (
       select content from recipe.execution_step_content where batch_id = $1 union all select content from recipe.execution_stage_content where batch_id = $1
       union all select content from recipe.execution_exception_content where batch_id = $1 union all select content from recipe.execution_point_content where batch_id = $1) x
      where x.content::text ${op} $2`),
    audit: await count(`select count(*)::text as n from kernel.audit_event e
      where (e.chain_key = 'batch:' || $1 or e.chain_key ~ ('^(esig_challenge:|esig_signature:)?batch_(step|stage|exception|point):' || $1 || ':')) and (e.payload::text ${op} $2 or e.chain_key ${op} $2)`),
  };
}

const NOTHING = { rows: 0, events: 0, state: 0, contents: 0, audit: 0 };

describe('F12, round 6 lane round 3: what a test run\'s record shows is what the identifier rule reads (DI-05, DI-30, INV-18)', () => {
  it('[DI-05][DI-30][INV-18] kernel 1050: over HTTP L2409-0017 with U+00AD, U+200B, U+200D, U+034F, U+FE0F or U+2060 after the L, L 7100-9042 under the right-to-left override U+202E, BATCH/2409/0017 with U+2215 or U+2044, in Cyrillic or Greek capitals, B24-0001 with a Cyrillic or Greek B, L2409-0017 with a Cyrillic palochka or a Cherokee L, in Devanagari or Arabic-Indic digits, or with a Hebrew letter that reorders the line, in an exception\'s description and in a hold reason, are refused (EBMR-EXE-147) and nothing holds them; prose with an emoji, a soft hyphen in a long word, Hindi prose with digits and the danda, TEST- identifiers and the run\'s own words written with non-ASCII hyphens are recorded', async () => {
    const d = await issued();
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    const raised: Record<string, string> = {};
    const held: Record<string, string> = {};
    for (const [name, word] of Object.entries(PROBES)) {
      raised[name] = outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: `Drum of ${word} set aside`, severity: 'ALERT' }));
      held[name] = outcomeOf(await d.command('supervisor1', { type: 'HOLD_BATCH', holdType: 'SUPERVISOR', reason: `Hold: drum of ${word} found in the booth` }));
    }
    const names = Object.keys(PROBES);
    expect({ raised, held }).toEqual({ raised: Object.fromEntries(names.map((n) => [n, REFUSED])), held: Object.fromEntries(names.map((n) => [n, REFUSED])) });
    const honest = {
      emoji: outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: `Booth cleaned ${ch(0x2714)}${ch(0xfe0f)} by the operator ${ch(0x1f44d)}${ch(0x1f3fd)}, 2 of 3 drums weighed`, severity: 'ALERT' })),
      softHyphen: outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: `pharma${ch(0xad)}ceutical ingre${ch(0xad)}dients spilled near the booth`, severity: 'ALERT' })),
      hindi: outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'बैच के २५ ड्रम तौले गए। कुल वज़न 250 किलो।', severity: 'ALERT' })),
      // The run's own words (dc-mini's DISP-1, BLEND-1 and SOP-DISP-001) with U+2010 HYPHEN and U+2011 NON-BREAKING HYPHEN:
      // read with the look-alikes, they are the run's words. (As stored, a hyphen look-alike is a separator, so a compound
      // DISP-1/BLEND-1 written with one holds the fragment 1/BLEND, which no source binds: refused, as before kernel 1050.)
      runWords: outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: `Drum TEST-L26-0101 moved from DISP${ch(0x2010)}1 to BLEND${ch(0x2011)}1 per SOP${ch(0x2011)}DISP${ch(0x2011)}001`, severity: 'ALERT' })),
      hold: outcomeOf(await d.command('supervisor1', { type: 'HOLD_BATCH', holdType: 'SUPERVISOR', reason: `Hold: drum TEST-L26-0101 ${ch(0x2714)}${ch(0xfe0f)} moved from DISP${ch(0x2010)}1 to BLEND-1` })),
    };
    expect(honest).toEqual({ emoji: 'ok', softHyphen: 'ok', hindi: 'ok', runWords: 'ok', hold: 'ok' });
    for (const [name, word] of Object.entries(PROBES)) expect(await recordHolding(d.runId, word), name).toEqual(NOTHING);
    expect(await recordHolding(d.runId, '2409', true)).toEqual(NOTHING);
    expect(await recordHolding(d.runId, `DISP${ch(0x2010)}1 to BLEND${ch(0x2011)}1`)).toMatchObject({ rows: 1 });
    expect(await violations(sbx)).toEqual([]);
  }, 600_000);

  it('[DI-05][DI-30][INV-18] kernel 1050: a business entry the application role appends on the run\'s chain holding L2409-0017 with U+00AD, U+200B, U+200D, U+034F, U+FE0F or U+2060 after the L, the override U+202E, or BATCH/2409/0017 with U+2215 or U+2044, in its message or three levels down in its details, is refused (EBMR-EXE-147) at the member that holds it and without the word in the refusal, and nothing holds it; an honest entry with an emoji and a soft hyphen is recorded', async () => {
    const d = await issued();
    const chain = `batch:${d.runId}`;
    const AUDIT = String.raw`, a word of the form of a batch or lot number that is not a test one\. .*\[EBMR-EXE-147\]$`;
    const outcomes: Record<string, { message: string; details: string }> = {};
    for (const name of ['U+00AD', 'U+200B', 'U+200D', 'U+034F', 'U+FE0F', 'U+2060', 'U+202E', 'U+2215', 'U+2044']) {
      const word = PROBES[name] ?? '';
      outcomes[name] = {
        message: await businessEntry(d, chain, `Drum of ${word} moved to the booth`),
        details: await businessEntry(d, chain, 'Drum moved to the booth', { drum: { of: { lot: `lot ${word}` } } }),
      };
    }
    for (const [name, o] of Object.entries(outcomes)) {
      expect(o.message, name).toMatch(new RegExp(String.raw`^This business entry of audit chain batch:${d.runId} of test batch ${d.runId} cannot be recorded: it holds, at \$\.body\.message` + AUDIT));
      expect(o.details, name).toMatch(new RegExp(String.raw`^This business entry of audit chain batch:${d.runId} of test batch ${d.runId} cannot be recorded: it holds, at \$\.body\.details\.drum\.of\.lot` + AUDIT));
      for (const m of [o.message, o.details]) expect(m, name).not.toMatch(/2409|7100|0017/);
    }
    const honest = await businessEntry(d, chain, `Drum TEST-L26-0101 moved ${ch(0x2714)}${ch(0xfe0f)}`, { drum: { note: { text: `pharma${ch(0xad)}ceutical ingre${ch(0xad)}dients` } } });
    expect(honest).toBe('ok');
    for (const name of Object.keys(outcomes)) expect(await recordHolding(d.runId, PROBES[name] ?? ''), name).toEqual(NOTHING);
    expect(await recordHolding(d.runId, '2409', true)).toEqual(NOTHING);
    expect(await recordHolding(d.runId, 'TEST-L26-0101 moved')).toMatchObject({ audit: 1 });
  }, 300_000);

  it('[DI-05][DI-30][INV-18] kernel 1070: over HTTP LOT─2409─0017, LOT━2409━0017, LOTー2409ー0017, LOT㇐2409㇐0017, LOT⎯2409⎯0017, LOT┄2409┄0017, B─24─0001, BATCH🙼2409🙼0017, Ŀ2409-0017, the syllabic L with a dot, в24-0001, L2409-0017 with a hair space after the L, or with Ogham space marks, in an exception\'s description and in a hold reason, and in a business entry the application role appends on the run\'s chain in its message or three levels down in its details, are refused (EBMR-EXE-147) without the word in the refusal, and nothing holds them; Japanese prose with the prolonged sound mark, Chinese prose with the ideograph one, Korean prose with the letter eu and a number with its unit after a thin space are recorded', async () => {
    const d = await issued();
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    const chain = `batch:${d.runId}`;
    const AUDIT = String.raw`, a word of the form of a batch or lot number that is not a test one\. .*\[EBMR-EXE-147\]$`;
    const raised: Record<string, string> = {};
    const held: Record<string, string> = {};
    const entries: Record<string, { message: string; details: string }> = {};
    for (const [name, word] of Object.entries(SEPARATOR_PROBES)) {
      raised[name] = outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: `Drum of ${word} set aside`, severity: 'ALERT' }));
      held[name] = outcomeOf(await d.command('supervisor1', { type: 'HOLD_BATCH', holdType: 'SUPERVISOR', reason: `Hold: drum of ${word} found in the booth` }));
      entries[name] = {
        message: await businessEntry(d, chain, `Drum of ${word} moved to the booth`),
        details: await businessEntry(d, chain, 'Drum moved to the booth', { drum: { of: { lot: `lot ${word}` } } }),
      };
    }
    const names = Object.keys(SEPARATOR_PROBES);
    expect({ raised, held }).toEqual({ raised: Object.fromEntries(names.map((n) => [n, REFUSED])), held: Object.fromEntries(names.map((n) => [n, REFUSED])) });
    for (const [name, o] of Object.entries(entries)) {
      expect(o.message, name).toMatch(new RegExp(String.raw`^This business entry of audit chain batch:${d.runId} of test batch ${d.runId} cannot be recorded: it holds, at \$\.body\.message` + AUDIT));
      expect(o.details, name).toMatch(new RegExp(String.raw`^This business entry of audit chain batch:${d.runId} of test batch ${d.runId} cannot be recorded: it holds, at \$\.body\.details\.drum\.of\.lot` + AUDIT));
      // The run's id (a UUID) is cut out first: its hex digits could hold 2409 by chance. The refusal's own example,
      // TEST-L24-0001, is not the probe B─24─0001.
      for (const m of [o.message, o.details]) expect(m.replaceAll(d.runId, ''), name).not.toMatch(/2409|0017|B\W?24\W?0001/u);
    }
    const honest = {
      japanese: outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'ローラーを清掃し、データ 3 件を記録しました。', severity: 'ALERT' })),
      chinese: outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: '一号滚筒已称重，共 3 桶。', severity: 'ALERT' })),
      korean: outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: '드럼 3개 확인 ㅡ 이상 없음', severity: 'ALERT' })),
      hold: outcomeOf(await d.command('supervisor1', { type: 'HOLD_BATCH', holdType: 'SUPERVISOR', reason: `Hold: 250${ch(0x2009)}mg of TEST-L26-0101 ー checked` })),
      entry: await businessEntry(d, chain, 'Drum TEST-L26-0101 ー データ 3 件', { drum: { note: { text: '一号滚筒 3 桶' } } }),
    };
    expect(honest).toEqual({ japanese: 'ok', chinese: 'ok', korean: 'ok', hold: 'ok', entry: 'ok' });
    for (const [name, word] of Object.entries(SEPARATOR_PROBES)) expect(await recordHolding(d.runId, word), name).toEqual(NOTHING);
    expect(await recordHolding(d.runId, '2409', true)).toEqual(NOTHING);
    expect(await recordHolding(d.runId, 'データ 3 件を記録')).toMatchObject({ rows: 1 });
    expect(await recordHolding(d.runId, '一号滚筒 3 桶')).toMatchObject({ audit: 1 });
    expect(await violations(sbx)).toEqual([]);
  }, 600_000);

  it('[DI-05][DI-30][INV-18] kernel 1090: over HTTP L2409-0017 with U+FFFC after the L, B24-0001 with U+FFFC after the B, and L2409-0017 with the spacing marks U+1031, U+102B or U+0C03 after the L, in an exception\'s description and in a hold reason, and in a business entry the application role appends on the run\'s chain in its message or three levels down in its details, are refused (EBMR-EXE-147) without the word in the refusal, and nothing holds them; Hindi prose with its vowel signs and a number written against a word, Tamil and Telugu prose are recorded', async () => {
    const d = await issued();
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    const chain = `batch:${d.runId}`;
    const AUDIT = String.raw`, a word of the form of a batch or lot number that is not a test one\. .*\[EBMR-EXE-147\]$`;
    const raised: Record<string, string> = {};
    const held: Record<string, string> = {};
    const entries: Record<string, { message: string; details: string }> = {};
    for (const [name, word] of Object.entries(NO_ADVANCE_PROBES)) {
      raised[name] = outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: `Drum of ${word} set aside`, severity: 'ALERT' }));
      held[name] = outcomeOf(await d.command('supervisor1', { type: 'HOLD_BATCH', holdType: 'SUPERVISOR', reason: `Hold: drum of ${word} found in the booth` }));
      entries[name] = {
        message: await businessEntry(d, chain, `Drum of ${word} moved to the booth`),
        details: await businessEntry(d, chain, 'Drum moved to the booth', { drum: { of: { lot: `lot ${word}` } } }),
      };
    }
    const names = Object.keys(NO_ADVANCE_PROBES);
    expect({ raised, held }).toEqual({ raised: Object.fromEntries(names.map((n) => [n, REFUSED])), held: Object.fromEntries(names.map((n) => [n, REFUSED])) });
    for (const [name, o] of Object.entries(entries)) {
      expect(o.message, name).toMatch(new RegExp(String.raw`^This business entry of audit chain batch:${d.runId} of test batch ${d.runId} cannot be recorded: it holds, at \$\.body\.message` + AUDIT));
      expect(o.details, name).toMatch(new RegExp(String.raw`^This business entry of audit chain batch:${d.runId} of test batch ${d.runId} cannot be recorded: it holds, at \$\.body\.details\.drum\.of\.lot` + AUDIT));
      // The run's id (a UUID) is cut out first: its hex digits could hold 2409 by chance. The refusal's own example,
      // TEST-L24-0001, is not the probe B24-0001.
      for (const m of [o.message, o.details]) expect(m.replaceAll(d.runId, ''), name).not.toMatch(/2409|0017|B\W?24\W?0001/u);
    }
    const honest = {
      hindi: outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'ड्रम को साफ़ किया गया और 3 नमूने लिए गए। यह 25वां बैच है।', severity: 'ALERT' })),
      tamil: outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'டிரம் 3 எடை பார்க்கப்பட்டது', severity: 'ALERT' })),
      hold: outcomeOf(await d.command('supervisor1', { type: 'HOLD_BATCH', holdType: 'SUPERVISOR', reason: 'Hold: ड्रम TEST-L26-0101 की जाँच बाकी है' })),
      entry: await businessEntry(d, chain, 'డ్రమ్ 3 బరువు చూశారు', { drum: { note: { text: 'कुल वज़न 250 किलो' } } }),
    };
    expect(honest).toEqual({ hindi: 'ok', tamil: 'ok', hold: 'ok', entry: 'ok' });
    for (const [name, word] of Object.entries(NO_ADVANCE_PROBES)) expect(await recordHolding(d.runId, word), name).toEqual(NOTHING);
    expect(await recordHolding(d.runId, '2409', true)).toEqual(NOTHING);
    expect(await recordHolding(d.runId, 'यह 25वां बैच है')).toMatchObject({ rows: 1 });
    expect(await recordHolding(d.runId, 'कुल वज़न 250 किलो')).toMatchObject({ audit: 1 });
    expect(await violations(sbx)).toEqual([]);
  }, 600_000);

  it('[DI-05][DI-30][INV-18] kernel 1100: over HTTP L2409-0017 and L24-0001 with the Armenian capital LIWN for the L, L2409-0017 with the Canadian syllabic MAA for the L, and L2409-0017 with U+1D1A0 after the L, in an exception\'s description and in a hold reason, and in a business entry the application role appends on the run\'s chain in its message or three levels down in its details, are refused (EBMR-EXE-147) without the word in the refusal, and nothing holds them; Hindi, Greek and Japanese prose with numbers are recorded', async () => {
    const d = await issued();
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    const chain = `batch:${d.runId}`;
    const AUDIT = String.raw`, a word of the form of a batch or lot number that is not a test one\. .*\[EBMR-EXE-147\]$`;
    const raised: Record<string, string> = {};
    const held: Record<string, string> = {};
    const entries: Record<string, { message: string; details: string }> = {};
    for (const [name, word] of Object.entries(DRAWN_PROBES)) {
      raised[name] = outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: `Drum of ${word} set aside`, severity: 'ALERT' }));
      held[name] = outcomeOf(await d.command('supervisor1', { type: 'HOLD_BATCH', holdType: 'SUPERVISOR', reason: `Hold: drum of ${word} found in the booth` }));
      entries[name] = {
        message: await businessEntry(d, chain, `Drum of ${word} moved to the booth`),
        details: await businessEntry(d, chain, 'Drum moved to the booth', { drum: { of: { lot: `lot ${word}` } } }),
      };
    }
    const names = Object.keys(DRAWN_PROBES);
    expect({ raised, held }).toEqual({ raised: Object.fromEntries(names.map((n) => [n, REFUSED])), held: Object.fromEntries(names.map((n) => [n, REFUSED])) });
    for (const [name, o] of Object.entries(entries)) {
      expect(o.message, name).toMatch(new RegExp(String.raw`^This business entry of audit chain batch:${d.runId} of test batch ${d.runId} cannot be recorded: it holds, at \$\.body\.message` + AUDIT));
      expect(o.details, name).toMatch(new RegExp(String.raw`^This business entry of audit chain batch:${d.runId} of test batch ${d.runId} cannot be recorded: it holds, at \$\.body\.details\.drum\.of\.lot` + AUDIT));
      // The run's id (a UUID) is cut out first: its hex digits could hold 2409 by chance. The refusal's own example,
      // TEST-L24-0001, is cut out too: it is not the probe.
      for (const m of [o.message, o.details]) expect(m.replaceAll(d.runId, '').replaceAll('TEST-L24-0001', ''), name).not.toMatch(/2409|0017|24-0001/u);
    }
    const honest = {
      hindi: outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'बैच के २५ ड्रम तौले गए। कुल वज़न 250 किलो है।', severity: 'ALERT' })),
      greek: outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Το δοχείο 3 ζυγίστηκε στις 10:15', severity: 'ALERT' })),
      hold: outcomeOf(await d.command('supervisor1', { type: 'HOLD_BATCH', holdType: 'SUPERVISOR', reason: 'Hold: ドラム 3 本を計量しました, TEST-L26-0101' })),
      entry: await businessEntry(d, chain, 'Drum TEST-L26-0101 weighed', { drum: { note: { text: 'डिब्बा 3 तौला गया' } } }),
    };
    expect(honest).toEqual({ hindi: 'ok', greek: 'ok', hold: 'ok', entry: 'ok' });
    for (const [name, word] of Object.entries(DRAWN_PROBES)) expect(await recordHolding(d.runId, word), name).toEqual(NOTHING);
    expect(await recordHolding(d.runId, '2409', true)).toEqual(NOTHING);
    expect(await recordHolding(d.runId, 'कुल वज़न 250 किलो')).toMatchObject({ rows: 1 });
    expect(await recordHolding(d.runId, 'डिब्बा 3 तौला गया')).toMatchObject({ audit: 1 });
    expect(await violations(sbx)).toEqual([]);
  }, 600_000);

  it('[DI-05][DI-30][INV-18] kernel 1110: over HTTP L2409-0017 written with the Masaram Gondi letter E, L24-0001 with the Mro letter YO (both drawn as L in bold) and B24-0001 with the Old Italic HE (drawn as B), in an exception\'s description and in a hold reason, and in a business entry the application role appends on the run\'s chain in its message or three levels down in its details, are refused (EBMR-EXE-147) without the word in the refusal, and nothing holds them; Hindi and Greek prose with numbers are recorded', async () => {
    const d = await issued();
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    const chain = `batch:${d.runId}`;
    const AUDIT = String.raw`, a word of the form of a batch or lot number that is not a test one\. .*\[EBMR-EXE-147\]$`;
    const raised: Record<string, string> = {};
    const held: Record<string, string> = {};
    const entries: Record<string, { message: string; details: string }> = {};
    for (const [name, word] of Object.entries(WEIGHT_PROBES)) {
      raised[name] = outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: `Drum of ${word} set aside`, severity: 'ALERT' }));
      held[name] = outcomeOf(await d.command('supervisor1', { type: 'HOLD_BATCH', holdType: 'SUPERVISOR', reason: `Hold: drum of ${word} found in the booth` }));
      entries[name] = {
        message: await businessEntry(d, chain, `Drum of ${word} moved to the booth`),
        details: await businessEntry(d, chain, 'Drum moved to the booth', { drum: { of: { lot: `lot ${word}` } } }),
      };
    }
    const names = Object.keys(WEIGHT_PROBES);
    expect({ raised, held }).toEqual({ raised: Object.fromEntries(names.map((n) => [n, REFUSED])), held: Object.fromEntries(names.map((n) => [n, REFUSED])) });
    for (const [name, o] of Object.entries(entries)) {
      expect(o.message, name).toMatch(new RegExp(String.raw`^This business entry of audit chain batch:${d.runId} of test batch ${d.runId} cannot be recorded: it holds, at \$\.body\.message` + AUDIT));
      expect(o.details, name).toMatch(new RegExp(String.raw`^This business entry of audit chain batch:${d.runId} of test batch ${d.runId} cannot be recorded: it holds, at \$\.body\.details\.drum\.of\.lot` + AUDIT));
      // The run's id (a UUID) and the refusal's own example, TEST-L24-0001, are cut out first.
      for (const m of [o.message, o.details]) expect(m.replaceAll(d.runId, '').replaceAll('TEST-L24-0001', ''), name).not.toMatch(/2409|0017|24-0001/u);
    }
    const honest = {
      hindi: outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'ड्रम को साफ़ किया गया और 3 नमूने लिए गए।', severity: 'ALERT' })),
      greek: outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Το δοχείο 3 ζυγίστηκε στις 10:15', severity: 'ALERT' })),
      hold: outcomeOf(await d.command('supervisor1', { type: 'HOLD_BATCH', holdType: 'SUPERVISOR', reason: 'Hold: बैच के २५ ड्रम, TEST-L26-0101' })),
    };
    expect(honest).toEqual({ hindi: 'ok', greek: 'ok', hold: 'ok' });
    for (const [name, word] of Object.entries(WEIGHT_PROBES)) expect(await recordHolding(d.runId, word), name).toEqual(NOTHING);
    expect(await recordHolding(d.runId, '2409', true)).toEqual(NOTHING);
    expect(await recordHolding(d.runId, 'और 3 नमूने लिए गए')).toMatchObject({ rows: 1 });
    expect(await violations(sbx)).toEqual([]);
  }, 600_000);
});
