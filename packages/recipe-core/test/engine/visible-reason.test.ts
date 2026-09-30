/**
 * A reason, justification, description or reference a person gives the engine has a visible character (engine 1.1.0;
 * review finding P29 and its round-1 verification; PR-49, DI-37, DI-22, DI-24). requireReason refused only what
 * JavaScript's trim removes, so a disposition justified by zero-width spaces, a word joiner or a soft hyphen was
 * signed and recorded, and the database agreed. Both now refuse a text made only of characters that show nothing:
 * controls, Unicode white space, format characters, default-ignorable code points and the Braille blank
 * (guards.ts BLANK_CODE_POINTS, kernel.is_blank in kernel 0960; audit-reason.test.ts compares the two over every
 * code point).
 */
import { describe, expect, it } from 'vitest';
import { BLANK_CODE_POINTS, isBlankText } from '../../src/engine/guards.ts';
import { FIXTURE_INPUTS, fixtureDefinition, OP1, QA1, Run, sig, SUP1 } from './support.ts';

/** Written as code points, so the source holds no invisible character. */
const cp = (...codes: number[]): string => String.fromCodePoint(...codes);

const SHOWS_NOTHING: Record<string, string> = {
  zeroWidthSpace: cp(0x200b),
  wordJoiner: cp(0x2060),
  softHyphen: cp(0xad),
  mongolianVowelSeparator: cp(0x180e),
  zeroWidthJoiner: cp(0x200d),
  interlinearAnnotation: cp(0xfff9, 0xfffb),
  hieroglyphFormatControl: cp(0x13430),
  arabicNumberSign: cp(0x0600),
  brailleBlank: cp(0x2800),
  tag: cp(0xe0041),
  whiteSpaceAndMarks: `${cp(0x3000)}${cp(0x200b)}\t${cp(0xfeff)}${cp(0x200e)}`,
};

const newRun = (): Run => Run.issue(fixtureDefinition('tablet-granulation-compression'), { inputs: FIXTURE_INPUTS['tablet-granulation-compression'] });

describe('a reason shows something (engine 1.1.0)', () => {
  it('[PR-49][DI-37][DI-22][DI-24] a disposition whose justification shows nothing is refused (ENG-REASON) and the exception stays open; one with a visible character among invisible ones is accepted, kept trimmed as JavaScript trims it', () => {
    const run = newRun();
    run.ok({ type: 'RAISE_EXCEPTION', actor: OP1, description: 'Label printer jammed once; label reprinted', severity: 'ALERT' });
    const ex = Object.values(run.state.exceptions)[0]?.id ?? '';
    for (const [name, justification] of Object.entries(SHOWS_NOTHING)) {
      const r = run.refused({ type: 'DISPOSITION_EXCEPTION', actor: QA1, exception: ex, outcome: 'NO_IMPACT', justification, signature: sig('EXCEPTION_DISPOSITIONED', QA1) }, 'ENG-REASON');
      expect({ name, message: r.message }).toEqual({ name, message: 'A disposition needs a reason (ENG-REASON; DI-22, DI-24)' });
      expect(run.state.exceptions[ex]?.status).toBe('OPEN');
    }
    run.ok({ type: 'DISPOSITION_EXCEPTION', actor: QA1, exception: ex, outcome: 'NO_IMPACT', justification: ` ${cp(0x200b)}Reprint reconciled.\t`, signature: sig('EXCEPTION_DISPOSITIONED', QA1) });
    expect(run.state.exceptions[ex]?.disposition?.justification).toBe(`${cp(0x200b)}Reprint reconciled.`);
  });

  it('[DI-22][DI-24][PR-49] every other reason a person gives the engine is held to the same test: a hold, an exception description and a deviation link that show nothing are refused (ENG-REASON)', () => {
    const run = newRun();
    for (const blank of Object.values(SHOWS_NOTHING)) {
      run.refused({ type: 'HOLD_BATCH', actor: SUP1, holdType: 'SUPERVISOR', reason: blank }, 'ENG-REASON');
      run.refused({ type: 'RAISE_EXCEPTION', actor: OP1, description: blank, severity: 'ALERT' }, 'ENG-REASON');
    }
    expect(run.state.status).toBe('ISSUED');
    expect(Object.keys(run.state.exceptions)).toEqual([]);
    run.ok({ type: 'RAISE_EXCEPTION', actor: OP1, description: 'Granules look lumpy', severity: 'ACTION' });
    const ex = Object.values(run.state.exceptions)[0]?.id ?? '';
    for (const blank of Object.values(SHOWS_NOTHING)) run.refused({ type: 'ATTACH_DEVIATION', actor: SUP1, exception: ex, deviationRef: blank }, 'ENG-REASON');
    expect(run.state.exceptions[ex]?.deviation).toBeUndefined();
    run.ok({ type: 'ATTACH_DEVIATION', actor: SUP1, exception: ex, deviationRef: `${cp(0xfff9)}DEV-11` });
    expect(run.state.exceptions[ex]?.deviation?.ref).toBe(`${cp(0xfff9)}DEV-11`);
  });

  it('[DI-22][DI-24] the class is exactly the controls, Unicode White_Space, the format characters (Cf), the default-ignorable code points and the Braille blank of the runtime\'s Unicode tables (17): if a newer Unicode adds one, kernel.is_blank (a new kernel migration) and BLANK_CODE_POINTS (a new engine version) take it up together', () => {
    const tables = /^[\p{Cc}\p{White_Space}\p{Cf}\p{Default_Ignorable_Code_Point}⠀]$/u;
    const differ: string[] = [];
    for (let c = 0; c <= 0x10ffff; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue;
      const ch = String.fromCodePoint(c);
      if (tables.test(ch) !== isBlankText(ch)) differ.push(c.toString(16));
    }
    expect({ unicode: process.versions['unicode'], differ }).toEqual({ unicode: process.versions['unicode'], differ: [] });
    // The ranges are sorted and apart, so the class reads as written.
    for (let i = 1; i < BLANK_CODE_POINTS.length; i++) expect((BLANK_CODE_POINTS[i]?.[0] ?? 0) > (BLANK_CODE_POINTS[i - 1]?.[1] ?? 0) + 1).toBe(true);
    // A text is blank when every character is; one readable character among them is text.
    expect([isBlankText(''), isBlankText(Object.values(SHOWS_NOTHING).join('')), isBlankText(`${cp(0x200b)}x`), isBlankText('पंजीकरण'), isBlankText(cp(0xd800))]).toEqual([true, true, false, false, false]);
  });
});
