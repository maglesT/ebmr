/**
 * Demo finding of 13 November 2026 (MGL-SR-BL, main 621671d, report r13 bug 1): stages 3 and 4 of a processing master,
 * added with the designer's "Add the stage", had rooms but no stage equipment. The validator said "no errors, no
 * warnings" and the master was approved. On the floor the stage's equipment-status step (G-09@2) checked no unit: the
 * kiosk offered nothing to start, the step could not be signed (G09-INCOMPLETE), and a unit typed by hand was refused
 * because the stage binds none (EBMR-EXE-210), so the batch could never continue. The validator now refuses it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MbrContent, PhaseNode, SequenceNode, StageNode } from '../../src/flow/model.ts';
import { parseMbr } from '../../src/flow/parse.ts';
import { errors, findNode, findPhase, validate } from '../flow/support.ts';

function load(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
}

/** dc-mini with the designer's new stage (fixture designer-new-stage.json: rooms, no equipment) after its first stage. */
function withNewStage(): MbrContent {
  const r = parseMbr(load('dc-mini.mbr.json'));
  if (!r.ok) throw new Error('SETUP: dc-mini does not parse');
  const m = r.mbr;
  (m.procedure.body as SequenceNode).children.splice(1, 0, load('designer-new-stage.json') as StageNode);
  return m;
}

const RULE = 'GMP-EQUIPMENT-STATUS-UNITS';
const unitFindings = (m: MbrContent): string[] => errors(validate(m)).filter((f) => f.rule === RULE).map((f) => `${f.subject}: ${f.message}`);
const stage = (m: MbrContent): StageNode => findNode(m, 'S-LAYER-2-GRANULATION') as StageNode;
const status = (m: MbrContent): PhaseNode => findPhase(m, 'p-g-09');
const PRESS = { ref: 'PRESS', equipmentClass: 'EQC-PRESS', kind: 'PROCESS' } as const;

describe('an equipment-status step that checks no unit (demo finding 13 November 2026, r13 bug 1)', () => {
  it('[PR-23][PR-03][IN-25] a stage with rooms but no equipment, whose G-09@2 step checks nothing, is refused with the stage and what to add', () => {
    const m = withNewStage();
    expect(stage(m).binding.equipment).toEqual([]);
    expect(unitFindings(m)).toEqual([
      expect.stringMatching(/^p-g-09: .*p-g-09.* checks the status of no unit, and its stage .*S-LAYER-2-GRANULATION.* binds no equipment: add the stage's equipment .* and tick "checks its status" for it on this step/),
    ]);
  });

  it('[PR-23][PR-03] a stage that binds equipment while its G-09@2 step checks none is refused, naming the units to tick', () => {
    const m = withNewStage();
    stage(m).binding.equipment = [PRESS];
    expect(unitFindings(m)).toEqual([expect.stringMatching(/^p-g-09: .* checks the status of no unit: tick "checks its status" on this step for the stage's PRESS/)]);
  });

  it('[PR-23][PR-03] once the step checks a unit the stage binds, the rule is satisfied', () => {
    const m = withNewStage();
    stage(m).binding.equipment = [PRESS];
    status(m).equipment = [{ ref: 'PRESS', use: 'STATUS_CHECK' }];
    expect(unitFindings(m)).toEqual([]);
  });

  it('[PR-23] the sandbox attestation G-09@1, where an empty list means any unit the person names, is not affected', () => {
    const m = withNewStage();
    status(m).block = { type: 'G-09', version: '1' };
    expect(unitFindings(m)).toEqual([]);
  });
});
