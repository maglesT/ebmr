import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MbrContent, StageNode } from '../../src/flow/model.ts';
import { parseMbr } from '../../src/flow/parse.ts';
import { GENERIC_BLOCK_VERSIONS, MATERIAL_BLOCKS } from '../../src/blocks/generic/index.ts';
import { checkMeaning } from '../../src/engine/actions.ts';
import type { ValidationContext } from '../../src/validator/types.ts';
import { CONTENT_RULES } from '../../src/validator/rules-content.ts';
import { gate, validateMbr } from '../../src/validator/validate.ts';
import { define, param as engineParam, Run, T0 } from '../engine/support.ts';
import { clone, context, errors, findNode, findPhase, loadFixture, mbrWith, phase as mbrPhase, removeNode, TEST_ROLES, validate, type FixtureName } from '../flow/support.ts';

interface Deletion {
  item: string;
  fixture: FixtureName;
  remove: (m: MbrContent) => void;
  rule: string;
  names: RegExp;
}

/** dc-mini, the designer's shipped template (its copy among the fixtures; template-fixture.test.ts keeps them equal). */
function dcMini(): MbrContent {
  const r = parseMbr(JSON.parse(readFileSync(new URL('../fixtures/dc-mini.mbr.json', import.meta.url), 'utf8')));
  if (!r.ok) throw new Error(`dc-mini does not parse: ${JSON.stringify(r.problems.slice(0, 3))}`);
  return r.mbr;
}

function param(m: MbrContent, id: string): MbrContent['parameters'][number] {
  const p = m.parameters.find((x) => x.id === id);
  if (!p) throw new Error(`no parameter ${id}`);
  return p;
}

/** Mandatory items of a complete master, each deleted on its own (PR-03 catalog test). */
const DELETIONS: Deletion[] = [
  { item: 'unit of a data-entry field', fixture: 'tablet-granulation-compression', remove: (m) => delete param(m, 'driedNet').unit, rule: 'GMP-TYPED-FIELDS', names: /Parameter "Dried granules \(net, sub-lot\)" \(driedNet\) has no unit/ },
  { item: 'precision of a data-entry field', fixture: 'tablet-granulation-compression', remove: (m) => delete param(m, 'blendNet').precision, rule: 'GMP-TYPED-FIELDS', names: /\(blendNet\) has no precision/ },
  { item: 'value list of a choice field', fixture: 'tablet-blister-packaging', remove: (m) => delete param(m, 'leakResult').categories, rule: 'GMP-TYPED-FIELDS', names: /\(leakResult\) is a choice but lists fewer than two distinct values/ },
  { item: 'limits of a CPP', fixture: 'tablet-granulation-compression', remove: (m) => delete param(m, 'inletTemp').limits, rule: 'GMP-CRITICAL-PARAMETERS', names: /"Inlet air temperature \(drying\)" \(inletTemp\) is a critical parameter but has no limits/ },
  { item: 'limits of an IPC', fixture: 'tablet-granulation-compression', remove: (m) => delete param(m, 'hardness').limits, rule: 'GMP-CRITICAL-PARAMETERS', names: /"Breaking force" \(hardness\) is an in-process control but has no limits/ },
  { item: 'accuracy check of a critical manual entry', fixture: 'tablet-granulation-compression', remove: (m) => delete param(m, 'binderTemp').accuracyCheck, rule: 'GMP-CRITICAL-PARAMETERS', names: /\(binderTemp\) is critical and entered by hand, but no accuracy check/ },
  {
    item: 'minimum and maximum of a yield checkpoint',
    fixture: 'tablet-granulation-compression',
    remove: (m) => {
      const y = m.yieldCheckpoints.find((x) => x.id === 'Y-GRAN');
      if (y) delete y.limits;
    },
    rule: 'GMP-YIELDS',
    names: /Yield checkpoint "Granulation and drying yield" \(Y-GRAN\) has no minimum and maximum/,
  },
  {
    item: 'reconciliation limits of printed materials',
    fixture: 'tablet-blister-packaging',
    remove: (m) => {
      const y = m.yieldCheckpoints.find((x) => x.id === 'Y-CARTON');
      if (y) delete y.limits;
    },
    rule: 'GMP-YIELDS',
    names: /"Printed carton reconciliation" \(Y-CARTON\) has no minimum and maximum/,
  },
  {
    item: 'hold time of an intermediate',
    fixture: 'tablet-granulation-compression',
    remove: (m) => {
      const i = m.intermediates.find((x) => x.id === 'I-WET');
      if (i) delete i.holdTime;
    },
    rule: 'GMP-INTERMEDIATES',
    names: /Intermediate "Wet mass" \(I-WET\) has no hold time/,
  },
  {
    item: 'validation reference of a timer',
    fixture: 'tablet-granulation-compression',
    remove: (m) => {
      const t = m.timeConstraints.find((x) => x.id === 'TC-DRYMIX');
      if (t) delete t.source;
    },
    rule: 'GMP-TIMERS',
    names: /Timer "Dry mixing time" \(TC-DRYMIX\) lacks a validation reference/,
  },
  {
    item: 'specimen of a printed component',
    fixture: 'tablet-blister-packaging',
    remove: (m) => {
      const b = m.bom.find((x) => x.id === 'BOM-CARTON');
      if (b) delete b.specimen;
    },
    rule: 'GMP-SPECIMENS',
    names: /Printed component BOM-CARTON has no approved specimen/,
  },
  { item: 'clearance at the start of a stage', fixture: 'tablet-granulation-compression', remove: (m) => removeNode(m, 'p-comp-clear'), rule: 'GMP-STAGE-CLEARANCE', names: /Stage "Compression" \(S-COMP\) has no line or room clearance step/ },
  { item: 'yield at the end of a stage', fixture: 'tablet-granulation-compression', remove: (m) => removeNode(m, 'p-blend-yield'), rule: 'GMP-STAGE-YIELD', names: /Stage "Blending and lubrication" \(S-BLEND\) can end without a yield or reconciliation step/ },
  { item: 'equipment status check before use', fixture: 'tablet-granulation-compression', remove: (m) => removeNode(m, 'p-comp-status'), rule: 'GMP-EQUIPMENT-STATUS', names: /uses PRESS before its status/ },
  {
    item: 'consumption of a BOM line',
    fixture: 'tablet-granulation-compression',
    remove: (m) => {
      const p = findPhase(m, 'p-disp-exc');
      p.consumes = p.consumes.filter((c) => c !== 'BOM-MGS');
    },
    rule: 'GMP-BOM-CONSUMED',
    names: /BOM line BOM-MGS is never consumed/,
  },
  {
    item: 'second person on a significant step',
    fixture: 'tablet-granulation-compression',
    remove: (m) => delete findPhase(m, 'p-disp-api').signatures.check,
    rule: 'GMP-SIGNIFICANT-STEPS',
    names: /"Dispense atorvastatin calcium" \(p-disp-api\) is a significant step \(weighing and dispensing\) and needs a checker/,
  },
  {
    item: 'hash pinning a reference',
    fixture: 'tablet-granulation-compression',
    remove: (m) => {
      const r = m.references.find((x) => x.id === 'SOP-IPC');
      if (r) delete r.hash;
    },
    rule: 'GMP-REFERENCES',
    names: /Reference SOP-IPC \(sop SOP-QA-021 v5\) is not pinned by hash/,
  },
  {
    item: 'recipe version an automated step relies on',
    fixture: 'tablet-granulation-compression',
    remove: (m) => {
      const s = findPhase(m, 'p-compress').system;
      if (s) delete s.recipeVersion;
    },
    rule: 'GMP-SYSTEMS',
    names: /"Compress" \(p-compress\) runs on PLC SYS-PRS but does not name the recipe and recipe version/,
  },
  {
    item: 'rationale of a risk-based reduction',
    fixture: 'tablet-granulation-compression',
    remove: (m) => {
      const r = m.riskReductions.find((x) => x.id === 'RR-DRYMIX-1V');
      if (r) delete r.rationale;
    },
    rule: 'GMP-RISK',
    names: /Risk-based reduction RR-DRYMIX-1V \(one verifier\) has no linked risk assessment with a written rationale/,
  },
  {
    item: 'pharmacopoeia edition of a compendial limit',
    fixture: 'tablet-granulation-compression',
    remove: (m) => {
      const c = m.acceptanceSchemes[0]?.criteria.find((x) => x.id === 'IP-AVG');
      if (c) delete c.range.pharmacopoeia;
    },
    rule: 'GMP-ACCEPTANCE-SCHEMES',
    names: /Criterion IP-AVG of AS-UOW: the registered range comes from a pharmacopoeia but does not name the pharmacopoeia and edition/,
  },
];

/** The test installation's context without its roles (FLOW-ROLES then fails closed). */
function withoutRoles(): ValidationContext {
  const ctx = context();
  delete ctx.roles;
  return ctx;
}

describe('GMP content gates', () => {
  it.each(['tablet-granulation-compression', 'tablet-blister-packaging'] as const)('[PR-03] the complete test master %s passes every gate', (name) => {
    const report = validate(loadFixture(name));
    expect(report.findings).toEqual([]);
    expect(gate(report).passed).toBe(true);
  });

  it.each(DELETIONS.map((d) => [d.item, d] as const))('[PR-03] deleting the %s refuses approval and names the missing item', (_item, d) => {
    const m = clone(loadFixture(d.fixture));
    d.remove(m);
    const report = validate(m);
    expect(gate(report).passed).toBe(false);
    const hit = errors(report).filter((f) => f.rule === d.rule);
    expect(hit.map((f) => f.message)).toEqual(expect.arrayContaining([expect.stringMatching(d.names)]));
    // Plain language first, then the rule and the controls.
    for (const f of hit) expect(f.message).toMatch(new RegExp(`\\(${d.rule}; [A-Z]{2}-\\d{2}`));
  });

  it('[INV-34] an MBR cannot pass the gate unless every intermediate has a hold time and every timer and yield checkpoint has limits and a source', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    for (const i of m.intermediates) delete i.holdTime;
    for (const t of m.timeConstraints) delete t.source;
    for (const y of m.yieldCheckpoints) delete y.limits;
    const report = validate(m);
    const inv34 = errors(report).filter((f) => f.controls.includes('INV-34'));
    expect(inv34.filter((f) => f.rule === 'GMP-INTERMEDIATES')).toHaveLength(m.intermediates.length);
    expect(inv34.filter((f) => f.rule === 'GMP-TIMERS')).toHaveLength(m.timeConstraints.length);
    expect(inv34.filter((f) => f.rule === 'GMP-YIELDS' && /no minimum and maximum/.test(f.message))).toHaveLength(m.yieldCheckpoints.length);
    expect(gate(report).passed).toBe(false);
  });

  it('[INV-34][IN-13] R-rest A9: a hold time cites a hold-time study or validation report, or process data or a company SOP with a warning, in every edition; a registration is refused', () => {
    for (const edition of ['tablets', 'injectables', 'substance'] as const) {
      const m = clone(loadFixture('tablet-granulation-compression'));
      m.header.edition = edition;
      const i = m.intermediates.find((x) => x.id === 'I-BLEND');
      const of = (mbr: MbrContent): string[] => validate(mbr).findings.filter((f) => f.rule === 'GMP-INTERMEDIATES' && f.subject === 'I-BLEND').map((f) => `${f.severity}: ${f.message}`);
      if (!i?.holdTime) throw new Error('SETUP: I-BLEND has no hold time');
      for (const kind of ['COMPANY_STANDARD', 'PROCESS_DATA'] as const) {
        i.holdTime.source = { kind, ref: 'SOP-IPC' };
        expect(of(m)).toEqual([expect.stringMatching(/^WARNING: The hold time of Intermediate "Lubricated blend" \(I-BLEND\) cites .*keep the written basis/)]);
      }
      i.holdTime.source = { kind: 'REGISTRATION', ref: 'SOP-IPC' };
      expect(of(m)).toEqual([expect.stringMatching(/^ERROR: The hold time of .*\(I-BLEND\) cites a registration; it must cite/)]);
    }
  });

  it('[INV-34][IN-13] R-rest A9: a timer may cite process data or a company SOP, with a warning', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    const t = m.timeConstraints[0];
    if (!t?.source) throw new Error('SETUP: no timer with a source');
    t.source = { ...t.source, kind: 'PROCESS_DATA' };
    expect(validate(m).findings.filter((f) => f.rule === 'GMP-TIMERS' && f.subject === t.id).map((f) => `${f.severity}: ${f.message}`)).toEqual([expect.stringMatching(/^WARNING: Timer .* cites process data; keep the written basis/)]);
  });

  it('[PR-08] limit tiers must nest: an alert limit outside the action limit is refused', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    const alert = param(m, 'hardness').limits?.ranges.find((r) => r.tier === 'ALERT');
    if (alert?.high) alert.high.value = '130';
    expect(errors(validate(m)).find((f) => f.rule === 'GMP-LIMITS')?.message).toMatch(/alert limit \(>= 70 and <= 130\) is not inside the internal action limit \(>= 60 and <= 120\)/);
  });

  it('[PR-08] limit tiers must also nest after rounding: an inner tier with fewer decimals is refused', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    const alert = param(m, 'lod').limits?.ranges.find((r) => r.tier === 'ALERT');
    if (alert?.low && alert.high) {
      alert.low.value = '2';
      alert.high.value = '3';
    }
    expect(errors(validate(m)).find((f) => f.rule === 'GMP-LIMITS')?.message).toMatch(/After rounding, the alert limit accepts 1\.5, which the validated range rejects/);
  });

  it('[PR-08] a registered limit must cite the registration or the pharmacopoeia; a validated range a validation report', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    const r = param(m, 'inletTemp').limits?.ranges[0];
    if (r) r.source = { kind: 'COMPANY_STANDARD', ref: 'SOP-IPC' };
    expect(errors(validate(m)).map((f) => f.message).join(' ')).toMatch(/the validated range must cite a validation report/);
  });

  it('[PR-03] WITNESSED is required where a critical value is typed by hand with no objective evidence', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    findPhase(m, 'p-binder-prep').signatures.check = { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' };
    expect(errors(validate(m)).find((f) => f.rule === 'GMP-WITNESS')?.message).toMatch(/records binderTemp by hand with no device capture, scan, photo or printout, so the checker must witness the act/);
  });

  it('[PR-03][DI-30][PR-14][DI-35] T12.DOC: a later review (VERIFIED) of a critical value typed by hand from a printout or photo is warned about (GMP-WITNESS-NO-ATTACHMENT): in this release the check runs as a timed witness, and once none is possible as the later review with an exception for QA; never where the MBR already asks for the witness (the shipped dc-mini template does), nor for an uncritical value', () => {
    // The shipped template asks for the witness itself (since T12.DOC); an author who makes the check a later review is warned.
    const template = dcMini();
    const m = clone(template);
    findPhase(m, 'p-blend').signatures.check = { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' };
    const found = (mbr: MbrContent) => validate(mbr).findings.filter((f) => f.rule === 'GMP-WITNESS-NO-ATTACHMENT').map((f) => ({ severity: f.severity, subject: f.subject, key: f.key, message: f.message }));
    expect(found(m)).toEqual([
      {
        severity: 'WARNING',
        subject: 'p-blend',
        key: 'GMP-WITNESS-NO-ATTACHMENT@p-blend',
        message:
          '"Blend" (p-blend) records blendTime, blenderSpeed by hand from the printout or photo the MBR names as their evidence, and its check is a later review (VERIFIED). In this release no printout or photo can be attached to a value typed by hand, so this check runs as a witness (WITNESSED): a second person holding PRODUCTION_VERIFIER (STEP.WITNESS) watches the entry within the site\'s witness window (5 minutes by default) after the step is signed performed, and before the run moves on. Once no witness is possible, the later review by a person holding PRODUCTION_VERIFIER (STEP.VERIFY) completes the step and records an exception (WITNESS_LATE) that QA must disposition (GMP-WITNESS-NO-ATTACHMENT; PR-03, DI-30, PR-14, DI-35)',
      },
    ]);
    // The packaging master's photo of the India codes is the same case where its check is a later review (the fixture
    // asks for the witness, since T12.DOC).
    const packaging = clone(loadFixture('tablet-blister-packaging'));
    expect(found(packaging)).toEqual([]);
    findPhase(packaging, 'p-india-codes').signatures.check = { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' };
    expect(found(packaging).map((f) => f.subject)).toEqual(['p-india-codes']);
    // Not where the MBR already asks for the witness, nor for a value that is not critical (a value captured by a device
    // is typed by hand in this release all the same: the next test).
    const witnessed = template;
    expect(findPhase(witnessed, 'p-blend').signatures.check?.meaning).toBe('WITNESSED');
    const uncritical = clone(m);
    for (const id of ['blendTime', 'blenderSpeed']) param(uncritical, id).criticality = 'NON_CRITICAL';
    expect({ witnessed: found(witnessed), uncritical: found(uncritical) }).toEqual({ witnessed: [], uncritical: [] });
    // A warning, so the MBR can be approved once the author justifies it, as every warning (lifecycle START_VERIFICATION).
    expect(errors(validate(m)).filter((f) => f.rule === 'GMP-WITNESS-NO-ATTACHMENT')).toEqual([]);
  });

  it('[PR-03][DI-30][PR-14][DI-35] T12.DOC round 2: in this release every value of a step is typed by hand whatever capture the MBR names, so the later review of a critical value whose MBR names a printout or photo is warned about for device, scan, LIMS and automation capture too, saying so; never for a quantity the step\'s block computes from its weighings', () => {
    const m = clone(dcMini());
    findPhase(m, 'p-blend').signatures.check = { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' };
    const found = (mbr: MbrContent) => validate(mbr).findings.filter((f) => f.rule === 'GMP-WITNESS-NO-ATTACHMENT').map((f) => ({ severity: f.severity, subject: f.subject, message: f.message }));
    const RUNS =
      'In this release no printout or photo can be attached to a value typed by hand, so this check runs as a witness (WITNESSED): a second person holding PRODUCTION_VERIFIER (STEP.WITNESS) watches the entry within the site\'s witness window (5 minutes by default) after the step is signed performed, and before the run moves on. Once no witness is possible, the later review by a person holding PRODUCTION_VERIFIER (STEP.VERIFY) completes the step and records an exception (WITNESS_LATE) that QA must disposition (GMP-WITNESS-NO-ATTACHMENT; PR-03, DI-30, PR-14, DI-35)';
    const HOW = { DEVICE: 'from a device', SCAN: 'by scanning', LIMS: 'from LIMS', AUTOMATION: 'from the automation system' } as const;
    for (const [capture, how] of Object.entries(HOW) as [keyof typeof HOW, string][]) {
      const v = clone(m);
      param(v, 'blendTime').capture = capture;
      expect(found(v), capture).toEqual([
        {
          severity: 'WARNING',
          subject: 'p-blend',
          message: `"Blend" (p-blend) records blendTime, blenderSpeed by hand from the printout or photo the MBR names as their evidence, and its check is a later review (VERIFIED). The MBR captures blendTime ${how}, but in this release every value of a step is typed by hand on the step screen (a scanned code is recorded as typed by hand). ${RUNS}`,
        },
      ]);
    }
    const both = clone(m);
    param(both, 'blendTime').capture = 'DEVICE';
    param(both, 'blenderSpeed').capture = 'AUTOMATION';
    expect(found(both).map((f) => f.message)).toEqual([
      `"Blend" (p-blend) records blendTime, blenderSpeed by hand from the printout or photo the MBR names as their evidence, and its check is a later review (VERIFIED). The MBR captures blendTime from a device and blenderSpeed from the automation system, but in this release every value of a step is typed by hand on the step screen (a scanned code is recorded as typed by hand). ${RUNS}`,
    ]);
    // A dispensed or output quantity is computed by its block from the container weighings (never typed by hand), so its
    // step keeps the later review the MBR names, printout or not: nothing to warn about.
    const weighed = clone(dcMini());
    for (const id of ['pcmDispensed', 'excDispensed', 'blendNet']) param(weighed, id).evidence = 'PRINTOUT';
    expect(found(weighed)).toEqual([]);
  });

  it('[DI-30][PR-14][DI-35] T12.DOC round 2: the warning agrees with the engine for every capture mode (a critical value whose MBR names a printout, typed by hand as this release records every value, is checked by a witness) and for the quantities a weighing step computes (no witness)', () => {
    for (const capture of ['MANUAL', 'DEVICE', 'SCAN', 'LIMS', 'AUTOMATION'] as const) {
      const mbr = mbrWith({ kind: 'sequence', id: 'ops', children: [mbrPhase('p', { records: ['t'] }), mbrPhase('after')] }, {
        parameters: [engineParam('t', { unit: 'min', capture, evidence: 'PRINTOUT', accuracyCheck: 'SECOND_PERSON' })],
      });
      const warned = validate(mbr).findings.some((f) => f.rule === 'GMP-WITNESS-NO-ATTACHMENT' && f.subject === 'p');
      const run = Run.issue(define(mbr), {}, T0);
      run.start('p');
      run.record('p', 't', { kind: 'DECIMAL', value: '15', unit: 'min' }, { source: { mode: 'MANUAL' } });
      run.perform('p');
      expect({ capture, warned, engine: checkMeaning(run.def, run.inst('p'), 'p', run.state, run.nowUs) }).toEqual({ capture, warned: true, engine: 'WITNESSED' });
    }
    // The quantities the validator leaves out are those the engine's definition computes at the weighing steps, read
    // from the same handlers: every generic block version that computes items is one computedItemsOf reads.
    expect(GENERIC_BLOCK_VERSIONS.filter((b) => b.handler?.computedItems !== undefined).map((b) => `${b.type}@${b.version}`)).toEqual(
      MATERIAL_BLOCKS.filter((b) => b.handler?.computedItems !== undefined).map((b) => `${b.type}@${b.version}`),
    );
    const weighed = clone(dcMini());
    for (const id of ['pcmDispensed', 'excDispensed', 'blendNet']) param(weighed, id).evidence = 'PRINTOUT';
    const def = define(weighed);
    expect(['p-disp-pcm', 'p-disp-exc', 'p-blend-out'].map((s) => [...(def.steps.get(s)?.computedItems ?? [])])).toEqual([['pcmDispensed'], ['excDispensed'], ['blendNet']]);
  });

  it('[PR-03][DI-30][PR-14][DI-35] T12.DOC round 3: a phase whose MBR names no check is checked all the same where it records a critical value whose MBR names a printout or photo, whatever its capture: the validator warns (GMP-WITNESS-NO-ATTACHMENT) and says how, as the engine runs it (a witness while possible, then the later review with WITNESS_LATE), exactly as for a phase whose check is a later review', () => {
    const RUNS_NO_CHECK =
      'In this release no printout or photo can be attached to a value typed by hand, so the step is checked all the same, as a witness (WITNESSED), by a person in one of the engine\'s verifier roles where the MBR names no check (PRODUCTION_VERIFIER, PRODUCTION_SUPERVISOR and QA) whose role holds the check\'s permission: a second person holding PRODUCTION_VERIFIER or QA (STEP.WITNESS) watches the entry within the site\'s witness window (5 minutes by default) after the step is signed performed, and before the run moves on. Once no witness is possible, the later review by a person holding PRODUCTION_VERIFIER (STEP.VERIFY) completes the step and records an exception (WITNESS_LATE) that QA must disposition (GMP-WITNESS-NO-ATTACHMENT; PR-03, DI-30, PR-14, DI-35)';
    const RUNS_REVIEW =
      'In this release no printout or photo can be attached to a value typed by hand, so this check runs as a witness (WITNESSED): a second person holding VERIFIER (STEP.WITNESS) watches the entry within the site\'s witness window (5 minutes by default) after the step is signed performed, and before the run moves on. Once no witness is possible, the later review by a person holding VERIFIER (STEP.VERIFY) completes the step and records an exception (WITNESS_LATE) that QA must disposition (GMP-WITNESS-NO-ATTACHMENT; PR-03, DI-30, PR-14, DI-35)';
    const HOW = { MANUAL: undefined, DEVICE: 'from a device', SCAN: 'by scanning', LIMS: 'from LIMS', AUTOMATION: 'from the automation system' } as const;
    const CHECKS = { 'no check': undefined, 'a later review': { meaning: 'VERIFIED', role: 'VERIFIER' } } as const;
    for (const [capture, how] of Object.entries(HOW) as [keyof typeof HOW, string | undefined][]) {
      for (const [named, check] of Object.entries(CHECKS) as [keyof typeof CHECKS, (typeof CHECKS)[keyof typeof CHECKS]][]) {
        const mbr = mbrWith({ kind: 'sequence', id: 'ops', children: [mbrPhase('p', { records: ['t'], signatures: { perform: { role: 'OPERATOR' }, ...(check ? { check } : {}) } }), mbrPhase('after')] }, {
          parameters: [engineParam('t', { unit: 'min', capture, evidence: 'PRINTOUT', accuracyCheck: 'SECOND_PERSON' })],
        });
        const captured = how === undefined ? '' : ` The MBR captures t ${how}, but in this release every value of a step is typed by hand on the step screen (a scanned code is recorded as typed by hand).`;
        const warned = validate(mbr)
          .findings.filter((f) => f.rule === 'GMP-WITNESS-NO-ATTACHMENT')
          .map((f) => ({ severity: f.severity, subject: f.subject, message: f.message }));
        // The engine, as the floor runs it: the value typed by hand, the step signed performed; a witness while one is
        // possible, then the later review, which records WITNESS_LATE for QA.
        const run = Run.issue(define(mbr), {}, T0);
        run.start('p');
        run.record('p', 't', { kind: 'DECIMAL', value: '15', unit: 'min' }, { source: { mode: 'MANUAL' } });
        run.perform('p');
        const awaiting = run.status('p');
        const atOnce = checkMeaning(run.def, run.inst('p'), 'p', run.state, run.nowUs);
        run.advance(400_000_000n);
        const later = checkMeaning(run.def, run.inst('p'), 'p', run.state, run.nowUs);
        run.verify('p');
        expect({ capture, named, warned, engine: { awaiting, atOnce, later, completed: run.status('p'), late: run.exceptions('WITNESS_LATE').map((e) => e.source.stepKey) } }).toEqual({
          capture,
          named,
          warned: [
            {
              severity: 'WARNING',
              subject: 'p',
              message:
                check === undefined
                  ? `"Step p" (p) records t by hand from the printout or photo the MBR names as its evidence, and the MBR names no check for it.${captured} ${RUNS_NO_CHECK}`
                  : `"Step p" (p) records t by hand from the printout or photo the MBR names as its evidence, and its check is a later review (VERIFIED).${captured} ${RUNS_REVIEW}`,
            },
          ],
          engine: { awaiting: 'AWAITING_VERIFICATION', atOnce: 'WITNESSED', later: 'VERIFIED', completed: 'COMPLETED', late: ['p@'] },
        });
      }
    }
    // Where the MBR asks for the witness, or the value is not critical, nothing to warn about: the witness the MBR names
    // runs as named, and an uncritical value the MBR has typed by hand needs no check at all (the step completes on its
    // performed signature). (A value whose MBR names another capture, typed by hand, raises MANUAL_ENTRY_FALLBACK and is
    // reviewed later, never witnessed: outside this rule, decision T12.3.)
    for (const variant of ['witnessed', 'uncritical'] as const) {
      const mbr = mbrWith(
        {
          kind: 'sequence',
          id: 'ops',
          children: [mbrPhase('p', { records: ['t'], signatures: variant === 'witnessed' ? { perform: { role: 'OPERATOR' }, check: { meaning: 'WITNESSED', role: 'VERIFIER' } } : { perform: { role: 'OPERATOR' } } }), mbrPhase('after')],
        },
        { parameters: [engineParam('t', { unit: 'min', capture: variant === 'uncritical' ? 'MANUAL' : 'DEVICE', evidence: 'PRINTOUT', ...(variant === 'uncritical' ? { criticality: 'NON_CRITICAL' as const } : {}) })] },
      );
      const run = Run.issue(define(mbr), {}, T0);
      run.start('p');
      run.record('p', 't', { kind: 'DECIMAL', value: '15', unit: 'min' }, { source: { mode: 'MANUAL' } });
      run.perform('p');
      expect({ variant, warned: validate(mbr).findings.filter((f) => f.rule === 'GMP-WITNESS-NO-ATTACHMENT').length, status: run.status('p') }).toEqual({
        variant,
        warned: 0,
        status: variant === 'witnessed' ? 'AWAITING_VERIFICATION' : 'COMPLETED',
      });
    }
  });

  it('[PR-03][DI-30][PR-14][DI-35][INV-26] T12.DOC round 4: the warning names the people the run accepts, the roles the check names narrowed to those whose role holds the permission each check is signed with (a witness STEP.WITNESS, the later review STEP.VERIFY): a production verifier or QA witnesses and only a production verifier reviews later where the MBR names no check, never a production supervisor; where no role may give one, it says so', () => {
    const TAIL = 'watches the entry within the site\'s witness window (5 minutes by default) after the step is signed performed, and before the run moves on.';
    const LATE = 'completes the step and records an exception (WITNESS_LATE) that QA must disposition (GMP-WITNESS-NO-ATTACHMENT; PR-03, DI-30, PR-14, DI-35)';
    const FALLBACK = 'the step is checked all the same, as a witness (WITNESSED), by a person in one of the engine\'s verifier roles where the MBR names no check (PRODUCTION_VERIFIER, PRODUCTION_SUPERVISOR and QA) whose role holds the check\'s permission';
    const mbrOf = (check?: { meaning: 'VERIFIED'; role: string }) =>
      mbrWith({ kind: 'sequence', id: 'ops', children: [mbrPhase('p', { records: ['t'], signatures: { perform: { role: 'OPERATOR' }, ...(check ? { check } : {}) } }), mbrPhase('after')] }, {
        parameters: [engineParam('t', { unit: 'min', capture: 'LIMS', evidence: 'PRINTOUT', accuracyCheck: 'SECOND_PERSON' })],
      });
    const how = (mbr: MbrContent, ctx: ValidationContext = context()): string[] =>
      validateMbr(mbr, ctx)
        .findings.filter((f) => f.rule === 'GMP-WITNESS-NO-ATTACHMENT')
        .map((f) => f.message.slice(f.message.indexOf('In this release no printout')));
    const installation = (witness: string[], review: string[]): ValidationContext => context({ roles: { engineRoles: TEST_ROLES.engineRoles, checkers: { witness, review } } });
    const OPENING = 'In this release no printout or photo can be attached to a value typed by hand, so';
    expect({
      // As delivered (the server reads it from tab.engine_role_map and the kernel role permissions; apps/tablets-server
      // test execution/witness-without-printout holds it to the database and to the run's refusals).
      delivered: how(mbrOf()),
      // An installation where no fallback verifier role holds STEP.WITNESS: nobody can witness, the later review follows.
      noWitness: how(mbrOf(), installation([], ['PRODUCTION_VERIFIER'])),
      // One that gave production supervisors STEP.WITNESS too: they are named, as the run then accepts them.
      supervisorsWitness: how(mbrOf(), installation(['PRODUCTION_VERIFIER', 'PRODUCTION_SUPERVISOR', 'QA'], ['PRODUCTION_VERIFIER'])),
      // A later review the MBR gives to QA: QA may witness, but nobody may give the later review (GMP-CHECK-PERMISSION too).
      qaReview: how(mbrOf({ meaning: 'VERIFIED', role: 'QA' })),
      // Without the installation's roles (FLOW-ROLES fails closed): the roles the check names, with each permission.
      unknown: how(mbrOf(), withoutRoles()),
    }).toEqual({
      delivered: [`${OPENING} ${FALLBACK}: a second person holding PRODUCTION_VERIFIER or QA (STEP.WITNESS) ${TAIL} Once no witness is possible, the later review by a person holding PRODUCTION_VERIFIER (STEP.VERIFY) ${LATE}`],
      noWitness: [
        `${OPENING} ${FALLBACK}: no person may witness it, as no role of this installation that carries PRODUCTION_VERIFIER, PRODUCTION_SUPERVISOR or QA holds STEP.WITNESS; the step waits until the site's witness window (5 minutes by default) has passed or the run moved on. Once no witness is possible, the later review by a person holding PRODUCTION_VERIFIER (STEP.VERIFY) ${LATE}`,
      ],
      supervisorsWitness: [`${OPENING} ${FALLBACK}: a second person holding PRODUCTION_VERIFIER, PRODUCTION_SUPERVISOR or QA (STEP.WITNESS) ${TAIL} Once no witness is possible, the later review by a person holding PRODUCTION_VERIFIER (STEP.VERIFY) ${LATE}`],
      qaReview: [
        `${OPENING} this check runs as a witness (WITNESSED): a second person holding QA (STEP.WITNESS) ${TAIL} Once no witness is possible, no person may give the later review that completes the step, as no role of this installation that carries QA holds STEP.VERIFY: the run cannot complete this step (GMP-WITNESS-NO-ATTACHMENT; PR-03, DI-30, PR-14, DI-35)`,
      ],
      unknown: [
        `${OPENING} ${FALLBACK}: a second person holding PRODUCTION_VERIFIER, PRODUCTION_SUPERVISOR or QA whose role holds STEP.WITNESS ${TAIL} Once no witness is possible, the later review by a person holding PRODUCTION_VERIFIER, PRODUCTION_SUPERVISOR or QA whose role holds STEP.VERIFY ${LATE}`,
      ],
    });
  });

  it('[PR-14][DI-35][INV-26] T12.DOC round 4: a check the MBR names that no person of this installation may give is refused (GMP-CHECK-PERMISSION, an error): a later review by a production supervisor or QA, a witness by a production supervisor; a witness by QA, either check by a production verifier and the shipped fixtures pass', () => {
    const checked = (meaning: 'VERIFIED' | 'WITNESSED', role: string) =>
      mbrWith({ kind: 'sequence', id: 'ops', children: [mbrPhase('p', { signatures: { perform: { role: 'OPERATOR' }, check: { meaning, role } } }), mbrPhase('after')] });
    const refused = (mbr: MbrContent, ctx: ValidationContext = context()) =>
      validateMbr(mbr, ctx)
        .findings.filter((f) => f.rule === 'GMP-CHECK-PERMISSION')
        .map((f) => `${f.severity} ${f.subject}: ${f.message}`);
    expect({
      supervisorReviews: refused(checked('VERIFIED', 'PRODUCTION_SUPERVISOR')),
      qaReviews: refused(checked('VERIFIED', 'QA')),
      supervisorWitnesses: refused(checked('WITNESSED', 'PRODUCTION_SUPERVISOR')),
      qaWitnesses: refused(checked('WITNESSED', 'QA')),
      verifierReviews: refused(checked('VERIFIED', 'PRODUCTION_VERIFIER')),
      verifierWitnesses: refused(checked('WITNESSED', 'PRODUCTION_VERIFIER')),
      // A role outside the vocabulary is FLOW-ROLES' error, and without the installation's roles FLOW-ROLES fails closed.
      unknownRole: refused(checked('VERIFIED', 'NOBODY')),
      noRoles: refused(checked('VERIFIED', 'QA'), withoutRoles()),
      fixtures: [dcMini(), loadFixture('tablet-granulation-compression'), loadFixture('tablet-blister-packaging')].flatMap((m) => refused(m)),
    }).toEqual({
      supervisorReviews: [
        'ERROR p: "Step p" (p) is checked VERIFIED by PRODUCTION_SUPERVISOR, but no role of this installation that carries PRODUCTION_SUPERVISOR holds STEP.VERIFY, the permission a later review is signed with, so no person could ever give this check and the run would stop at this step (GMP-CHECK-PERMISSION; PR-14, DI-35, INV-26)',
      ],
      qaReviews: [
        'ERROR p: "Step p" (p) is checked VERIFIED by QA, but no role of this installation that carries QA holds STEP.VERIFY, the permission a later review is signed with, so no person could ever give this check and the run would stop at this step (GMP-CHECK-PERMISSION; PR-14, DI-35, INV-26)',
      ],
      supervisorWitnesses: [
        'ERROR p: "Step p" (p) is checked WITNESSED by PRODUCTION_SUPERVISOR, but no role of this installation that carries PRODUCTION_SUPERVISOR holds STEP.WITNESS, the permission a witness is signed with, so no person could ever give this check and the run would stop at this step (GMP-CHECK-PERMISSION; PR-14, DI-35, INV-26)',
      ],
      qaWitnesses: [],
      verifierReviews: [],
      verifierWitnesses: [],
      unknownRole: [],
      noRoles: [],
      fixtures: [],
    });
  });

  it('[PR-03][PR-31] processing after a stage yield is a warning (R-flow item 4): no clause forbids it, the yield then does not close the stage', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    const seq = m.procedure.body.kind === 'sequence' ? m.procedure.body.children.find((c) => c.id === 'S-BLEND') : undefined;
    if (seq?.kind !== 'stage' || seq.body.kind !== 'sequence') throw new Error('fixture changed');
    const out = seq.body.children.find((c) => c.id === 'O-BLEND-OUT');
    if (out?.kind !== 'operation' || out.body.kind !== 'sequence') throw new Error('fixture changed');
    out.body.children.reverse();
    const found = validate(m).findings.filter((f) => f.rule === 'GMP-STAGE-YIELD');
    expect(found.map((f) => [f.severity, f.subject])).toEqual([['WARNING', 'p-blend-out']]);
    expect(found[0]?.message).toMatch(/"Discharge and weigh the blend" \(p-blend-out\) can run after the yield of stage .* the yield does not close/);
  });

  it('[PR-03][PR-31] a material stage may have no yield when the stage says why (21 CFR 211.103: each appropriate phase; R-flow item 4); a blank reason is no reason', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    removeNode(m, 'p-blend-yield');
    const stage = m.procedure.body.kind === 'sequence' ? m.procedure.body.children.find((c) => c.id === 'S-BLEND') : undefined;
    if (stage?.kind !== 'stage') throw new Error('fixture changed');
    const yieldErrors = (): string[] => errors(validate(m)).filter((f) => f.rule === 'GMP-STAGE-YIELD').map((f) => f.subject);
    expect(yieldErrors()).toEqual(['S-BLEND']);
    stage.noYieldReason = '   ';
    expect(yieldErrors()).toEqual(['S-BLEND']);
    stage.noYieldReason = 'The blend is compressed in the next stage without discharge; its yield is taken there';
    expect(yieldErrors()).toEqual([]);
    const parsed = parseMbr(JSON.parse(JSON.stringify(m)));
    expect(parsed.ok && parsed.mbr.procedure.body.kind === 'sequence' && parsed.mbr.procedure.body.children.find((c) => c.id === 'S-BLEND')).toMatchObject({ noYieldReason: stage.noYieldReason });
  });

  it('[PR-14][PR-47] R-flow item 8: the significant-step rule cites PR-14, the reprocessing rule PR-47 and IN-19', () => {
    const controls = (id: string): readonly string[] | undefined => CONTENT_RULES.find((r) => r.id === id)?.controls;
    expect(controls('GMP-SIGNIFICANT-STEPS')).toEqual(['PR-14']);
    expect(controls('GMP-REPROCESSING')).toEqual(['PR-47', 'IN-19']);
  });

  it('[PR-03] a non-material stage may not move material', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    const stage = m.procedure.body.kind === 'sequence' ? m.procedure.body.children.find((c) => c.id === 'S-DISP') : undefined;
    if (stage?.kind === 'stage') stage.purpose = 'NON_MATERIAL';
    expect(errors(validate(m)).find((f) => f.rule === 'GMP-STAGE-NON-MATERIAL')?.message).toMatch(/declared non-material/);
  });

  it('[PR-03][PR-47][IN-19] R-rest A10: a recovery step declares its case and the maximum percentage the engine judges it by; the age and source-batch caps are optional; a re-treatment outside a loop is a warning', () => {
    for (const edition of ['tablets', 'injectables', 'substance'] as const) {
      const m = clone(loadFixture('tablet-granulation-compression'));
      m.header.edition = edition;
      const of = (): string[] => validate(m).findings.filter((f) => f.rule === 'GMP-REPROCESSING').map((f) => `${f.severity}: ${f.message}`);
      findPhase(m, 'p-blend-charge').reprocessing = { case: 'RECOVERY' };
      expect(of()).toEqual([expect.stringMatching(/^ERROR: .*does not set the maximum percentage of the batch it may add/)]);
      findPhase(m, 'p-blend-charge').reprocessing = { case: 'RECOVERY', maxPercent: '3' };
      expect(of()).toEqual([]);
      findPhase(m, 'p-blend-charge').reprocessing = { case: 'VALIDATED_RETREATMENT' };
      expect(of()).toEqual([expect.stringMatching(/^WARNING: .*is a validated re-treatment outside a loop/)]);
    }
  });

  it('[PR-03][PR-08] the sampling plan of an ALL_APPLY scheme must serve every criterion (the union)', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    findPhase(m, 'p-first-off').sampling = [{ point: 'first-off', purpose: 'weight', units: 10, destructive: false }];
    expect(errors(validate(m)).find((f) => f.rule === 'GMP-ACCEPTANCE-SCHEMES')?.message).toMatch(/takes 10 unit\(s\) for weight at first-off, but criteria IP-AVG of AS-UOW need 20/);
  });

  it('[DI-04] an MBR relying on a reference that is not effective cannot pass', () => {
    const report = validate(loadFixture('tablet-blister-packaging'), {}, undefined);
    expect(report.errors).toBe(0);
    const superseded = validate(loadFixture('tablet-blister-packaging'), { references: { status: (r) => (r.id === 'SOP-PACK' ? 'SUPERSEDED' : 'EFFECTIVE') } });
    expect(errors(superseded).map((f) => f.message)).toEqual([expect.stringMatching(/Reference SOP-PACK \(sop SOP-PK-012 v6\) has been superseded on 2026-09-28/)]);
  });

  it('[DI-04] automated steps name the computerised system they rely on; a PAT step without acceptance criteria cannot be approved', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    delete findPhase(m, 'p-blend').system;
    findPhase(m, 'p-bu-sample').pat = { method: 'NIR blend monitoring', model: 'NIR-BU', modelVersion: '2' };
    const text = errors(validate(m)).map((f) => `${f.rule}: ${f.message}`).join('\n');
    expect(text).toMatch(/GMP-SYSTEMS: "Pre-lubrication blending" \(p-blend\) relies on automated equipment but names no computerised system/);
    expect(text).toMatch(/GMP-PAT: "Blend uniformity sampling" \(p-bu-sample\) is a PAT step without acceptance criteria; it cannot be approved/);
  });
});

describe('risk-based reductions (IN-02)', () => {
  it('[IN-02] classifying a parameter as non-critical (minor) without a risk class and rationale is refused', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    m.riskReductions = m.riskReductions.filter((r) => r.id !== 'RR-SPEED-MINOR');
    expect(errors(validate(m)).find((f) => f.rule === 'GMP-RISK')?.message).toMatch(/"Press speed" \(machineSpeed\) is classified non-critical without a linked risk-based reduction/);
  });

  it('[IN-02] R-rest A11: a criticality assessment named on the master stands as the rationale for every non-critical item, in every edition; it must be a pinned risk assessment', () => {
    for (const edition of ['tablets', 'injectables', 'substance'] as const) {
      const m = clone(loadFixture('tablet-granulation-compression'));
      m.header.edition = edition;
      m.riskReductions = m.riskReductions.filter((r) => r.kind !== 'MINOR_CLASSIFICATION');
      const risk = (): string[] => errors(validate(m)).filter((f) => f.rule === 'GMP-RISK').map((f) => f.message);
      expect(risk().some((t) => /is classified non-critical without/.test(t))).toBe(true);
      const ra = m.references.find((r) => r.kind === 'RISK_ASSESSMENT');
      if (!ra) throw new Error('SETUP: no risk assessment');
      m.header.criticalityAssessment = ra.id;
      expect(risk()).toEqual([]);
      const parsed = parseMbr(JSON.parse(JSON.stringify(m)));
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
      expect(parsed.mbr.header.criticalityAssessment).toBe(ra.id);
      m.header.criticalityAssessment = m.references.find((r) => r.kind !== 'RISK_ASSESSMENT')?.id ?? 'NOT-A-REF';
      expect(risk()).toEqual(expect.arrayContaining([expect.stringMatching(/criticality assessment .* is not a pinned risk assessment/), expect.stringMatching(/is classified non-critical without/)]));
    }
  });

  it('[IN-02] a risk-based reduction cannot be saved without a risk class from the controlled scale', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    const r = m.riskReductions[0];
    if (r) delete r.riskClass;
    expect(errors(validate(m)).find((f) => f.rule === 'GMP-RISK')?.message).toMatch(/has no risk class; a reduction cannot be saved without one/);
    if (r) r.riskClass = 'NEGLIGIBLE';
    expect(errors(validate(m)).find((f) => f.rule === 'GMP-RISK')?.message).toMatch(/risk class "NEGLIGIBLE", which is not on the controlled risk scale/);
  });

  it('[IN-02] one-verifier mode (S5a) needs a declared reduction; without it the automated step is refused', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    m.riskReductions = m.riskReductions.filter((r) => r.id !== 'RR-DRYMIX-1V');
    expect(errors(validate(m)).find((f) => f.rule === 'GMP-SIGNIFICANT-STEPS')?.message).toMatch(/checked by one person only \(one-verifier mode, S5a\).*needs a declared reduction/);
  });

  it('[IN-02][PR-14] R-rest A5: a processing clearance not marked significant needs one person in every edition; marked significant it needs a checker or the declared S24 reduction', () => {
    for (const edition of ['tablets', 'injectables', 'substance'] as const) {
      const m = clone(loadFixture('tablet-granulation-compression'));
      m.header.edition = edition;
      // The author unticks "Significant step" (the G-10 block's default) and removes the checker.
      delete findPhase(m, 'p-blend-clear').signatures.check;
      findPhase(m, 'p-blend-clear').significant = false;
      expect(errors(validate(m))).toEqual([]);
      findPhase(m, 'p-blend-clear').significant = true;
      expect(errors(validate(m)).find((f) => f.rule === 'GMP-SIGNIFICANT-STEPS')?.message).toMatch(/line clearance without a second person; that is a risk-based reduction \(S24\)/);
      m.riskReductions.push({ id: 'RR-S24', kind: 'NO_SECOND_PERSON_CLEARANCE', subjects: ['p-blend-clear'], riskClass: 'LOW', rationale: 'RA-GRAN-01' });
      expect(errors(validate(m))).toEqual([]);
    }
  });

  it('[IN-02][PR-14] R-rest A5: a tablets packaging clearance keeps its second person even unmarked (Schedule M Part VIII 7.1), or the declared S24 reduction; an injectables or API packaging clearance needs one person', () => {
    for (const edition of ['injectables', 'substance'] as const) {
      const other = clone(loadFixture('tablet-blister-packaging'));
      other.header.edition = edition;
      delete findPhase(other, 'p-pri-clear').signatures.check;
      findPhase(other, 'p-pri-clear').significant = false;
      expect(errors(validate(other)).filter((f) => f.rule === 'GMP-SIGNIFICANT-STEPS')).toEqual([]);
    }
    const m = clone(loadFixture('tablet-blister-packaging'));
    const clear = findPhase(m, 'p-pri-clear');
    delete clear.signatures.check;
    clear.significant = false;
    expect(errors(validate(m)).find((f) => f.rule === 'GMP-SIGNIFICANT-STEPS')?.message).toMatch(/line clearance without a second person; that is a risk-based reduction \(S24\)/);
    m.riskReductions.push({ id: 'RR-S24', kind: 'NO_SECOND_PERSON_CLEARANCE', subjects: ['p-pri-clear'], riskClass: 'LOW', rationale: m.riskReductions[0]?.rationale ?? 'RA-PACK-01' });
    expect(errors(validate(m)).filter((f) => f.rule === 'GMP-SIGNIFICANT-STEPS')).toEqual([]);
  });

  it('[PR-52] review by exception on a step without a validation reference is an error at configuration time', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    m.riskReductions.push({ id: 'RR-RBE', kind: 'REVIEW_BY_EXCEPTION', subjects: ['p-blend-clear'], riskClass: 'LOW', rationale: 'RA-GRAN-01' });
    expect(errors(validate(m)).find((f) => f.rule === 'GMP-RISK')?.message).toMatch(/RR-RBE \(review by exception\) has no validation reference.*PR-52/);
    m.riskReductions[m.riskReductions.length - 1] = { id: 'RR-RBE', kind: 'REVIEW_BY_EXCEPTION', subjects: ['p-blend-clear'], riskClass: 'LOW', rationale: 'RA-GRAN-01', validationRef: 'PV-RBE-01' };
    expect(errors(validate(m))).toEqual([]);
  });

  it('[IN-02] a reduction cannot apply to a step of the wrong kind (one-verifier mode on a manual step)', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    m.riskReductions.push({ id: 'RR-BAD', kind: 'ONE_VERIFIER', subjects: ['p-disp-api'], riskClass: 'LOW', rationale: 'RA-GRAN-01' });
    expect(errors(validate(m)).find((f) => f.rule === 'GMP-RISK')?.message).toMatch(/RR-BAD \(one verifier\) cannot apply to "Dispense atorvastatin calcium"/);
  });

  it('[PR-14][IN-02] automated (one-verifier) mode on a labelling step is refused at configuration time: the visual check of the codes and the issue of printed labels keep their two persons', () => {
    const base = loadFixture('tablet-blister-packaging');
    expect(errors(validate(base))).toEqual([]);
    for (const [step, name] of [
      ['p-india-codes', 'Check dates, MRP and codes on India packs'],
      ['p-carton-issue', 'Issue cartons and leaflets'],
      ['p-foil-issue', 'Issue printed lidding foil'],
    ] as const) {
      // The reduction declared with a risk class and rationale, exactly as on the automated cartoner: refused on a labelling step.
      const m = clone(base);
      m.riskReductions.push({ id: 'RR-LABEL-1V', kind: 'ONE_VERIFIER', subjects: [step], riskClass: 'LOW', rationale: 'RA-CART-01' });
      expect(errors(validate(m)).map((f) => f.message)).toContainEqual(expect.stringMatching(new RegExp(`RR-LABEL-1V \\(one verifier\\) cannot apply to "${name}"`)));
      // Without its performer (the step reduced to one checker), the step is refused whatever the reduction says.
      delete findPhase(m, step).signatures.perform;
      expect(errors(validate(m)).map((f) => f.message)).toContainEqual(expect.stringMatching(new RegExp(`"${name}" \\(${step}\\) has no performer signature`)));
    }
  });

  it('[PR-31] a yield step without a verifier cannot be approved: each yield and reconciliation step of the master needs a checker who is not the performer', () => {
    const base = loadFixture('tablet-granulation-compression');
    expect(errors(validate(base))).toEqual([]);
    for (const [step, name] of [
      ['p-gran-yield', 'Granulation and drying yield'],
      ['p-blend-yield', 'Blending yield'],
      ['p-comp-yield', 'Compression yield'],
    ] as const) {
      const m = clone(base);
      delete findPhase(m, step).signatures.check;
      expect(errors(validate(m)).map((f) => f.message)).toContainEqual(expect.stringMatching(new RegExp(`"${name}" \\(${step}\\) is a significant step \\(yield and reconciliation\\) and needs a checker who is not the performer`)));
    }
  });

  it('[IN-02] changing a parameter to critical changes its verification requirements (a checker becomes mandatory)', () => {
    const m = clone(loadFixture('tablet-blister-packaging'));
    const p = m.parameters.find((x) => x.id === 'bulkRemaining');
    if (p) p.capture = 'MANUAL';
    if (p) p.accuracyCheck = 'SECOND_PERSON';
    delete findPhase(m, 'p-bulk-weigh').signatures.check;
    delete findPhase(m, 'p-bulk-weigh').system;
    expect(errors(validate(m)).find((f) => f.rule === 'GMP-SIGNIFICANT-STEPS')?.message).toMatch(/is a significant step \(critical data entered by hand\) and needs a checker/);
  });
});

describe('critical free text (R-rest A4)', () => {
  it('[PR-03][DI-30] a critical text field is a warning in every edition; entered by hand it still needs its accuracy check', () => {
    for (const edition of ['tablets', 'injectables', 'substance'] as const) {
      const m = clone(loadFixture('tablet-granulation-compression'));
      m.header.edition = edition;
      const base = Object.fromEntries(Object.entries(param(m, 'driedNet')).filter(([k]) => !['unit', 'precision', 'limits'].includes(k))) as MbrContent['parameters'][number];
      m.parameters.push({ ...base, id: 'lotRef', name: 'Granulation lot reference', valueType: 'TEXT', criticality: 'CRITICAL', capture: 'MANUAL', accuracyCheck: 'SECOND_PERSON' });
      const of = (mbr: MbrContent, rule: string) => validate(mbr).findings.filter((f) => f.rule === rule && f.subject === 'lotRef').map((f) => `${f.severity}: ${f.message}`);
      expect(of(m, 'GMP-TYPED-FIELDS')).toEqual([expect.stringMatching(/^WARNING: .*\(lotRef\) is critical but free text/)]);
      expect(of(m, 'GMP-CRITICAL-PARAMETERS')).toEqual([]);
      delete param(m, 'lotRef').accuracyCheck;
      expect(of(m, 'GMP-CRITICAL-PARAMETERS')).toEqual([expect.stringMatching(/^ERROR: .*no accuracy check/)]);
    }
  });
});

describe('a stage that continues an earlier clearance (R-rest A6)', () => {
  const stage = (m: MbrContent, id: string): StageNode => findNode(m, id) as StageNode;
  const clearanceFindings = (m: MbrContent): string[] => errors(validate(m)).filter((f) => f.rule === 'GMP-STAGE-CLEARANCE').map((f) => f.message);

  it('[PR-03] a stage in the same room as an earlier one may continue its clearance, in every edition; the key round-trips', () => {
    for (const edition of ['tablets', 'injectables', 'substance'] as const) {
      const m = clone(loadFixture('tablet-granulation-compression'));
      m.header.edition = edition;
      removeNode(m, 'p-comp-clear');
      expect(clearanceFindings(m)).toEqual([expect.stringMatching(/Stage "Compression" \(S-COMP\) has no line or room clearance step/)]);
      stage(m, 'S-COMP').binding.rooms = ['BLND-01'];
      stage(m, 'S-COMP').clearanceFrom = 'S-BLEND';
      expect(clearanceFindings(m)).toEqual([]);
      const parsed = parseMbr(JSON.parse(JSON.stringify(m)));
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
      expect((findNode(parsed.mbr, 'S-COMP') as StageNode).clearanceFrom).toBe('S-BLEND');
    }
  });

  it('[PR-03] it is refused for another area, a node that is no stage, and a stage that runs later', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    removeNode(m, 'p-comp-clear');
    stage(m, 'S-COMP').clearanceFrom = 'S-BLEND';
    expect(clearanceFindings(m)).toEqual([expect.stringMatching(/continues the clearance of .*S-BLEND.*share no room or line/)]);
    stage(m, 'S-COMP').clearanceFrom = 'p-blend-clear';
    expect(clearanceFindings(m)).toEqual([expect.stringMatching(/continues the clearance of p-blend-clear, which is not another stage/)]);
    const later = clone(loadFixture('tablet-granulation-compression'));
    removeNode(later, 'p-blend-clear');
    stage(later, 'S-BLEND').binding.rooms = ['COMP-01'];
    stage(later, 'S-BLEND').clearanceFrom = 'S-COMP';
    expect(clearanceFindings(later).length).toBeGreaterThan(0);
    expect(clearanceFindings(later).every((t) => /can run before the clearance of stage .*S-COMP/.test(t))).toBe(true);
  });
});

describe('an earlier equipment status check in the same room (R-rest A7)', () => {
  // The compression stage weighs on SCALE2, the blending stage's balance, and does not check it again.
  const shared = (rooms: string[], cls = 'EQC-BAL'): MbrContent => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    const comp = findNode(m, 'S-COMP') as StageNode;
    comp.binding.rooms = rooms;
    comp.binding.equipment = comp.binding.equipment.map((e) => (e.ref === 'SCALE3' ? { ...e, ref: 'SCALE2', equipmentClass: cls } : e));
    const status = findPhase(m, 'p-comp-status');
    status.equipment = status.equipment.filter((e) => e.ref !== 'SCALE3');
    const charge = findPhase(m, 'p-comp-charge');
    charge.equipment = charge.equipment.map((e) => (e.ref === 'SCALE3' ? { ...e, ref: 'SCALE2' } : e));
    return m;
  };
  const statusFindings = (m: MbrContent): string[] => errors(validate(m)).filter((f) => f.rule === 'GMP-EQUIPMENT-STATUS').map((f) => f.message);

  it('[PR-03] a check of the same equipment in an earlier stage in the same room counts, in every edition', () => {
    for (const edition of ['tablets', 'injectables', 'substance'] as const) {
      const m = shared(['BLND-01']);
      m.header.edition = edition;
      expect(statusFindings(m)).toEqual([]);
    }
  });

  it('[PR-03] it does not count from another room, or for equipment of another class under the same name', () => {
    expect(statusFindings(shared(['COMP-01']))).toEqual([expect.stringMatching(/p-comp-charge\) uses SCALE2 before its status .* is checked in stage .*S-COMP.*, or earlier in the same room/)]);
    expect(statusFindings(shared(['BLND-01'], 'EQC-SCALE-FLOOR'))).toEqual([expect.stringMatching(/uses SCALE2 before its status/)]);
  });
});

describe('a BOM line consumed on some paths only (R-rest A8)', () => {
  it('[PR-03] a line consumed only in one branch of an alternative is a warning in every edition; a line never consumed stays an error', () => {
    for (const edition of ['tablets', 'injectables', 'substance'] as const) {
      const m = clone(loadFixture('tablet-granulation-compression'));
      m.header.edition = edition;
      const mgs = m.bom.find((b) => b.id === 'BOM-MGS');
      if (!mgs) throw new Error('SETUP: no BOM-MGS');
      m.bom.push({ ...mgs, id: 'BOM-IPA-EXTRA' });
      findPhase(m, 'p-extra-ipa').consumes = ['BOM-IPA-EXTRA'];
      const bom = validate(m).findings.filter((f) => f.rule === 'GMP-BOM-CONSUMED').map((f) => `${f.severity}: ${f.message}`);
      expect(bom).toEqual([expect.stringMatching(/^WARNING: BOM line BOM-IPA-EXTRA is consumed on some paths only/)]);
      findPhase(m, 'p-extra-ipa').consumes = [];
      expect(errors(validate(m)).filter((f) => f.rule === 'GMP-BOM-CONSUMED').map((f) => f.message)).toEqual([expect.stringMatching(/BOM line BOM-IPA-EXTRA is never consumed/)]);
    }
  });
});
