/**
 * Phase 3 slice 3c (builder A): the compression blocks TB-09, TB-10 and TB-17 through the engine with the tablets
 * registry and catalogue: the block contract, each golden fixture, and each block's rules (definition checks, entry
 * refusals, exceptions, the close). The database's copy of the rules, and the registers they stand on, are proven in
 * db-guards.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { blocks } from '@ebmr/recipe-core/pure';
import { COMPRESSION_BLOCK_VERSIONS, TB09, TB10, TB17 } from '../../../src/blocks/compression/index.ts';
import { REQUIRED_CHECKS } from '../../../src/blocks/tb-10.ts';
import { tabletsBlockCatalog, tabletsBlockRegistry } from '../../../src/features/edition-blocks.ts';
import { blockMbr, definitionCodes, fixturePhase, OP1, runGolden, sig, startRun, VER1 } from './support.ts';
import { engine } from '@ebmr/recipe-core/pure';

type Json = Record<string, unknown>;
type Entry = Json & { kind: string };
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const perform = (run: ReturnType<typeof startRun>) => run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p', context: [], signature: sig(engine.performMeaning(run.def, 'p'), OP1) });
const refusal = (run: ReturnType<typeof startRun>, entry: Entry) => run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry }).code;

describe('the compression block versions (contract)', () => {
  it('[DI-10][DI-34] TB-09@1, TB-10@1 and TB-17@1 are registered in the tablets registry with every execution part of the block contract, are known to the edition catalogue as significant steps, and declare every exception type their handlers raise; TB-10 and TB-17 take G-06 unchanged', () => {
    const reg = tabletsBlockRegistry();
    expect(reg.all().map((b) => `${b.type}@${b.version}`)).toEqual(expect.arrayContaining(['TB-09@1', 'TB-10@1', 'TB-17@1']));
    for (const r of reg.report().filter((x) => COMPRESSION_BLOCK_VERSIONS.some((b) => b.type === x.type))) {
      expect(r.missingExecutionParts, r.key).toEqual([]);
      expect([...r.missing].sort(), r.key).toEqual([...blocks.RENDERING_PARTS].sort());
    }
    for (const b of COMPRESSION_BLOCK_VERSIONS) {
      const d = tabletsBlockCatalog.describe(b.type);
      expect([d?.edition, d?.significant, d?.phase.allowed], b.type).toEqual(['tablets', true, true]);
    }
    for (const b of [TB10, TB17]) {
      for (const k of Object.keys(blocks.G06.dataSchema?.entries ?? {})) expect(b.dataSchema?.entries[k], `${b.type} ${k}`).toBe(blocks.G06.dataSchema?.entries[k]);
      for (const k of Object.keys(blocks.G06.configSchema?.fields ?? {})) expect(b.configSchema?.fields[k], `${b.type} ${k}`).toBe(blocks.G06.configSchema?.fields[k]);
    }
  });
});

describe('golden fixtures of the compression blocks', () => {
  for (const b of COMPRESSION_BLOCK_VERSIONS) {
    const f = b.goldenFixture;
    if (!f) continue;
    const tags = [...new Set(['DI-34', ...(f.controls ?? b.controls.slice(0, 1))])].map((c) => `[${c}]`).join('');
    it(`${tags} ${b.type} ${b.title}: ${f.description}`, () => {
      const out = runGolden(b);
      expect(out.performRefusal).toBe(f.expect.performRefusal);
      expect(out.run.exceptions().map((e) => e.type).sort()).toEqual(f.expect.exceptions);
      expect(out.run.status('p')).toBe(f.expect.status);
      const declared = new Set([...(b.simulatorModel?.exceptionTypes(out.run.def.steps.get('p')?.node as never) ?? []), ...(b.exceptionRules ?? []).map((r) => r.type)]);
      for (const t of out.run.exceptions().map((e) => e.type)) expect(declared.has(t), `${b.type} raised ${t}`).toBe(true);
    });
  }
});

describe('TB-09 tooling custody', () => {
  const issuePart = () => blockMbr(TB09, fixturePhase(TB09, { config: { part: 'ISSUE', specification: { type: 'B', shape: 'Round 8 mm', upperEmbossing: 'A1', lowerEmbossing: 'PLAIN', score: 'NONE' } } }));
  const inspected = (result = 'PASS', when = 'BEFORE', set = 'SET-01'): Entry => ({ kind: 'TOOLING_INSPECTED', set, inspectionId: U(1), when, result });
  const issued = (set = 'SET-01'): Entry => ({ kind: 'TOOLING_ISSUED', set, issueId: U(2), press: 'PRESS-01' });
  const returned = (extra: Json = {}): Entry => ({ kind: 'TOOLING_RETURNED', set: 'SET-01', issueId: U(2), strokes: '1000', strokeSource: 'PRESS_COUNTER', countMismatch: false, limitExceeded: false, ...extra });

  it('[PR-27][IN-36] an issue step names the approved tooling specification of the product', () => {
    expect(definitionCodes(issuePart())).toEqual([]);
    expect(definitionCodes(blockMbr(TB09, fixturePhase(TB09, { config: { part: 'ISSUE' } })))).toEqual(['TB09-NO-SPECIFICATION']);
  });

  it('[IN-36][INV-24] a set is issued only after a passing inspection before use in the step, once; a failed one raises TOOLING_FAILED_BEFORE_USE; the issue step closes only with a set issued', () => {
    const run = startRun(TB09, issuePart());
    expect(refusal(run, issued())).toBe('TB09-NOT-INSPECTED');
    expect(refusal(run, inspected('PASS', 'AFTER'))).toBe('TB09-PART');
    expect(refusal(run, returned())).toBe('TB09-PART');
    run.entry('p', inspected('FAIL'));
    expect(run.exceptions().map((e) => e.type)).toEqual(['TOOLING_FAILED_BEFORE_USE']);
    expect(refusal(run, issued())).toBe('TB09-NOT-INSPECTED');
    expect(perform(run).refusal?.code).toBe('TB09-NOT-ISSUED');
    run.entry('p', inspected('PASS'));
    run.entry('p', issued());
    expect(refusal(run, issued())).toBe('TB09-ISSUED-TWICE');
    expect(perform(run).accepted).toBe(true);
  });

  it('[IN-36][INV-24] the return step inspects a set only after its return, closes only with every returned set inspected after use (IN-36 catalogue test); a missing punch or die and a passed usage limit wait for a deviation', () => {
    const run = startRun(TB09, blockMbr(TB09, fixturePhase(TB09, { config: { part: 'RETURN' } })));
    expect(refusal(run, inspected('PASS', 'AFTER'))).toBe('TB09-NOT-RETURNED');
    expect(refusal(run, inspected('PASS', 'BEFORE'))).toBe('TB09-PART');
    expect(perform(run).refusal?.code).toBe('TB09-NOT-RETURNED');
    run.entry('p', returned({ limitExceeded: true }));
    expect(refusal(run, returned())).toBe('TB09-RETURNED-TWICE');
    expect(perform(run).refusal?.code).toBe('TB09-AFTER-CHECK-MISSING');
    run.entry('p', inspected('PASS', 'AFTER'));
    expect(refusal(run, inspected('PASS', 'AFTER'))).toBe('TB09-INSPECTED-TWICE');
    const ex = run.exceptions()[0];
    expect([ex?.type, ex?.severity, ex?.deviationRequired]).toEqual(['TOOLING_LIMIT_EXCEEDED', 'ACTION', true]);
    expect(perform(run).accepted).toBe(true);
  });
});

describe('TB-10 compression set-up and first-off', () => {
  const setup: Entry = { kind: 'PRESS_SETUP', press: 'PRESS-01', useId: U(10), issueId: U(2) };
  const checklist = (ok = true): Entry => ({ kind: 'PRE_USE_CHECKLIST', items: REQUIRED_CHECKS.map((item, i) => ({ item, ok: ok || i > 0 })) });

  it('[PR-23][PR-22] a set-up step names the press it uses; setting ranges are listed once with their minimum not above their maximum', () => {
    expect(definitionCodes(blockMbr(TB10))).toEqual([]);
    expect(definitionCodes(blockMbr(TB10, fixturePhase(TB10, { equipment: [] })))).toEqual(['TB10-NO-EQUIPMENT']);
    const twice = fixturePhase(TB10, { config: { settingRanges: [{ tag: 'force.main_kN', unit: 'kN', min: '16', max: '12' }, { tag: 'force.main_kN', unit: 'kN', min: '1', max: '2' }] } });
    expect(definitionCodes(blockMbr(TB10, twice)).sort()).toEqual(['TB10-DUPLICATE-SETTING', 'TB10-SETTING-RANGE']);
  });

  it('[PR-23][IN-26][INV-24] the first-off waits for the set-up, a checklist with every required item all in order, and a charge by scan; routine compression (the close) needs a passing first-off; the first-off makes the step need its approval check', () => {
    const run = startRun(TB10);
    expect(refusal(run, { kind: 'FIRST_OFF', result: 'PASS' })).toBe('TB10-NO-SETUP');
    expect(refusal(run, { kind: 'HOPPER_CHARGE', chargeId: U(11) })).toBe('TB10-NO-SETUP');
    run.entry('p', setup);
    expect(refusal(run, setup)).toBe('TB10-SETUP-TWICE');
    expect(refusal(run, { kind: 'PRE_USE_CHECKLIST', items: [{ item: 'DUST_EXTRACTION', ok: true }] })).toBe('TB10-CHECKLIST');
    run.entry('p', checklist(false));
    expect(refusal(run, { kind: 'FIRST_OFF', result: 'PASS' })).toBe('TB10-CHECKLIST-OPEN');
    run.entry('p', checklist());
    expect(refusal(run, { kind: 'FIRST_OFF', result: 'PASS' })).toBe('TB10-NOT-CHARGED');
    run.entry('p', { kind: 'HOPPER_CHARGE', chargeId: U(11) });
    run.entry('p', { kind: 'FIRST_OFF', result: 'FAIL' });
    expect(perform(run).refusal?.code).toBe('TB10-FIRST-OFF');
    run.entry('p', { kind: 'FIRST_OFF', result: 'PASS' });
    expect(perform(run).accepted).toBe(true);
    expect(run.status('p')).toBe('AWAITING_VERIFICATION');
    expect(run.verify('p', [], VER1).accepted).toBe(true);
  });

  it('[PR-08][PR-23] a setting changed during the run needs an approved range and its unit; outside the range it waits for a deviation', () => {
    const run = startRun(TB10);
    run.entry('p', setup);
    const change = (tag: string, value: string, unit = 'kN'): Entry => ({ kind: 'SETTING_CHANGE', tag, value, unit, reason: 'Hardness low' });
    expect(refusal(run, change('fill.depth_mm', '8.0', 'mm'))).toBe('TB10-SETTING-TAG');
    expect(refusal(run, change('force.main_kN', '12', 'N'))).toBe('TB10-SETTING-UNIT');
    run.entry('p', change('force.main_kN', '15.0'));
    expect(run.exceptions()).toEqual([]);
    run.entry('p', change('force.main_kN', '15.1'));
    expect(run.exceptions().map((e) => [e.type, e.severity, e.deviationRequired])).toEqual([['SETTING_OUT_OF_RANGE', 'ACTION', true]]);
  });
});

describe('TB-17 reject and detection devices', () => {
  const challenge = (timing: string, passed = true, device = 'METAL_DETECTOR'): Entry => ({ kind: 'CHALLENGE', challengeId: U(20), device, timing, passed });

  it('[IN-36][IN-35] a step configures a metal detector with its test pieces, or a reject gate', () => {
    expect(definitionCodes(blockMbr(TB17))).toEqual([]);
    expect(definitionCodes(blockMbr(TB17, fixturePhase(TB17, { config: { metalDetector: null, deDuster: 'DD-01' } })))).toContain('TB17-NO-DEVICE');
  });

  it('[IN-36][IN-35] the first challenge is at START and none follows END; a late or failed challenge waits for a deviation; the step closes only with a passing END challenge of every device, its rejects counted and the de-duster in use', () => {
    const run = startRun(TB17);
    expect(refusal(run, challenge('INTERVAL'))).toBe('TB17-START-FIRST');
    expect(refusal(run, challenge('START', true, 'REJECT_GATE'))).toBe('TB17-DEVICE');
    run.entry('p', challenge('START'));
    expect(refusal(run, challenge('START'))).toBe('TB17-START-FIRST');
    run.advance(7_200_000_000n);
    run.entry('p', challenge('INTERVAL'));
    expect(run.exceptions()).toEqual([]);
    run.advance(7_200_000_001n);
    run.entry('p', challenge('INTERVAL'));
    expect(run.exceptions().map((e) => e.type)).toEqual(['CHALLENGE_OVERDUE']);
    expect(perform(run).refusal?.code).toBe('TB17-END-CHALLENGE');
    run.entry('p', challenge('END', false));
    expect(run.exceptions().map((e) => e.type)).toEqual(['CHALLENGE_OVERDUE', 'DETECTOR_CHALLENGE_FAILED']);
    expect(refusal(run, challenge('INTERVAL'))).toBe('TB17-AFTER-END');
    expect(perform(run).refusal?.code).toBe('TB17-END-CHALLENGE');
  });

  it('[IN-35] rejects are counted per configured device and destroyed (no return to the good stream: the schema refuses it); only the MBR\'s de-duster is recorded', () => {
    const run = startRun(TB17);
    expect(refusal(run, { kind: 'REJECT_COUNT', device: 'REJECT_GATE', count: '4', disposition: 'DESTRUCTION' })).toBe('TB17-DEVICE');
    expect(refusal(run, { kind: 'DEDUSTING', deDuster: 'DD-99', inUse: true })).toBe('TB17-DEDUSTER');
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: { kind: 'REJECT_COUNT', device: 'METAL_DETECTOR', count: '4', disposition: 'RETURN_TO_GOOD' } }).code).toMatch(/^ENG-/);
    run.entry('p', { kind: 'REJECT_COUNT', device: 'SETUP', count: '120', disposition: 'DESTRUCTION' });
    run.entry('p', challenge('START'));
    run.entry('p', challenge('END'));
    expect(perform(run).refusal?.code).toBe('TB17-NO-REJECT-COUNT');
    run.entry('p', { kind: 'REJECT_COUNT', device: 'METAL_DETECTOR', count: '3', disposition: 'INSPECTION_THEN_DESTRUCTION' });
    expect(perform(run).refusal?.code).toBe('TB17-NO-DEDUSTING');
    run.entry('p', { kind: 'DEDUSTING', deDuster: 'DD-01', inUse: true });
    expect(perform(run).accepted).toBe(true);
  });
});
