import { describe, expect, it } from 'vitest';
import type { MbrContent } from '../../src/flow/model.ts';
import { gate } from '../../src/validator/validate.ts';
import { clone, errors, findPhase, loadFixture, removeNode, validate, type FixtureName } from '../flow/support.ts';

interface Deletion {
  item: string;
  fixture: FixtureName;
  remove: (m: MbrContent) => void;
  rule: string;
  names: RegExp;
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

  it('[INV-34] a hold time must cite a hold-time study or validation report', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    const i = m.intermediates.find((x) => x.id === 'I-BLEND');
    if (i?.holdTime) i.holdTime.source = { kind: 'COMPANY_STANDARD', ref: 'SOP-IPC' };
    expect(errors(validate(m)).map((f) => f.message).join(' ')).toMatch(/hold time of Intermediate "Lubricated blend" \(I-BLEND\) cites a company standard/);
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

  it('[PR-03] nothing that processes material may run after a stage yield', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    const seq = m.procedure.body.kind === 'sequence' ? m.procedure.body.children.find((c) => c.id === 'S-BLEND') : undefined;
    if (seq?.kind !== 'stage' || seq.body.kind !== 'sequence') throw new Error('fixture changed');
    const out = seq.body.children.find((c) => c.id === 'O-BLEND-OUT');
    if (out?.kind !== 'operation' || out.body.kind !== 'sequence') throw new Error('fixture changed');
    out.body.children.reverse();
    expect(errors(validate(m)).map((f) => `${f.rule}: ${f.message}`).join('\n')).toMatch(/GMP-STAGE-YIELD: "Discharge and weigh the blend" \(p-blend-out\) can run after the yield/);
  });

  it('[PR-03] a non-material stage may not move material', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    const stage = m.procedure.body.kind === 'sequence' ? m.procedure.body.children.find((c) => c.id === 'S-DISP') : undefined;
    if (stage?.kind === 'stage') stage.purpose = 'NON_MATERIAL';
    expect(errors(validate(m)).find((f) => f.rule === 'GMP-STAGE-NON-MATERIAL')?.message).toMatch(/declared non-material/);
  });

  it('[PR-03] every reprocessing or recovery step declares its case and limits', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    findPhase(m, 'p-blend-charge').reprocessing = { case: 'RECOVERY' };
    expect(errors(validate(m)).find((f) => f.rule === 'GMP-REPROCESSING')?.message).toMatch(/does not set the maximum percentage, maximum age and maximum number of source batches/);
    findPhase(m, 'p-blend-charge').reprocessing = { case: 'VALIDATED_RETREATMENT' };
    expect(errors(validate(m)).find((f) => f.rule === 'GMP-REPROCESSING')?.message).toMatch(/must be a bounded loop/);
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

  it('[IN-02] no second person on a clearance (S24) needs a declared reduction; with one it passes', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    delete findPhase(m, 'p-blend-clear').signatures.check;
    expect(errors(validate(m)).find((f) => f.rule === 'GMP-SIGNIFICANT-STEPS')?.message).toMatch(/line clearance without a second person; that is a risk-based reduction \(S24\)/);
    m.riskReductions.push({ id: 'RR-S24', kind: 'NO_SECOND_PERSON_CLEARANCE', subjects: ['p-blend-clear'], riskClass: 'LOW', rationale: 'RA-GRAN-01' });
    expect(errors(validate(m))).toEqual([]);
  });

  it('[IN-02] a reduction cannot apply to a step of the wrong kind (one-verifier mode on a manual step)', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    m.riskReductions.push({ id: 'RR-BAD', kind: 'ONE_VERIFIER', subjects: ['p-disp-api'], riskClass: 'LOW', rationale: 'RA-GRAN-01' });
    expect(errors(validate(m)).find((f) => f.rule === 'GMP-RISK')?.message).toMatch(/RR-BAD \(one verifier\) cannot apply to "Dispense atorvastatin calcium"/);
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
