/**
 * Capsules edition C3 (docs/build-plan/capsules/plan.md, section 4): the two post-fill duties the validator holds a
 * master to. An OTC two-piece hard capsule is banded or sealed (21 CFR 211.132(b)(2), PR-41); printed capsules wait at a
 * hold point for QC approval before packaging (Schedule M Part VIII 6, IN-37).
 */
import { describe, expect, it } from 'vitest';
import type { FlowNode, HoldPointNode, MbrContent } from '../../src/flow/model.ts';
import { errors, mbrWith, phase, validate } from '../flow/support.ts';

const lib = (id: string, code: string) => phase(id, { name: code, block: { type: `LIB-${code}`, version: '1' } });
const hold = (id: string): HoldPointNode => ({ kind: 'holdPoint', id, name: 'QC approval of the printed capsules', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] });
const seq = (...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id: 'ops', children });

function master(body: FlowNode, dosageForm: string, predicates: Record<string, boolean> = {}): MbrContent {
  const m = mbrWith(body);
  return { ...m, header: { ...m.header, product: { ...m.header.product, dosageForm }, predicates } };
}

const found = (m: MbrContent, rule: string): string[] => errors(validate(m)).filter((f) => f.rule === rule).map((f) => f.message);

describe('capsule post-fill duties in the validator (Capsules C3)', () => {
  it('[PR-41] a master for US OTC retail packs of a two-piece hard capsule is refused without a banding or sealing step on every path; banded, a soft gel, a tablet or a non-OTC capsule pass', () => {
    const otc = { usOtcRetail: true };
    const unbanded = seq(lib('p-fill', 'PROC-CAPS-FILL'), lib('p-polish', 'PROC-CAPS-POLISH'));
    expect(found(master(unbanded, 'Hard gelatin capsule', otc), 'GMP-CAPSULE-SEAL').join(' ')).toMatch(/US OTC retail packs of a two-piece hard capsule \(Hard gelatin capsule\) and does not band or seal.*PROC-CAPS-BAND/);
    expect(found(master(seq(lib('p-fill', 'PROC-CAPS-FILL'), lib('p-band', 'PROC-CAPS-BAND'), lib('p-leak', 'IPC-CAPS-SEAL-LEAK')), 'Hard gelatin capsule', otc), 'GMP-CAPSULE-SEAL')).toEqual([]);
    expect(found(master(unbanded, 'Soft gelatin capsule', otc), 'GMP-CAPSULE-SEAL')).toEqual([]);
    expect(found(master(unbanded, 'Film-coated tablet', otc), 'GMP-CAPSULE-SEAL')).toEqual([]);
    expect(found(master(unbanded, 'Hard gelatin capsule'), 'GMP-CAPSULE-SEAL')).toEqual([]);
    expect(found(master(unbanded, 'Softgel capsule', otc), 'GMP-CAPSULE-SEAL')).toEqual([]);
    // A band on one branch of an alternative only is not on every path.
    const oneBranch = seq(lib('p-fill', 'PROC-CAPS-FILL'), { kind: 'alternative', id: 'alt', decision: { mode: 'DATA' }, branches: [{ id: 'b1', name: 'Banded', guard: 'true', body: lib('p-band', 'PROC-CAPS-BAND') }, { id: 'b2', name: 'Not banded', otherwise: true, body: lib('p-polish', 'PROC-CAPS-POLISH') }] } as never);
    expect(found(master(oneBranch, 'Hard gelatin capsule', otc), 'GMP-CAPSULE-SEAL')).toHaveLength(1);
  });

  it('[IN-37] a capsule printing step must be followed by a hold point every completing path passes (QC approval before packaging); printing after the last hold point, or with none, is refused', () => {
    expect(found(master(seq(lib('p-print', 'PROC-CAPS-PRINT'), hold('H-PACK')), 'Hard gelatin capsule'), 'GMP-CAPSULE-PRINT-HELD')).toEqual([]);
    expect(found(master(seq(lib('p-print', 'PROC-CAPS-PRINT'), lib('p-inspect', 'PROC-CAPS-INSPECT'), hold('H-PACK')), 'Hard gelatin capsule'), 'GMP-CAPSULE-PRINT-HELD')).toEqual([]);
    expect(found(master(seq(lib('p-print', 'PROC-CAPS-PRINT')), 'Hard gelatin capsule'), 'GMP-CAPSULE-PRINT-HELD').join(' ')).toMatch(/"PROC-CAPS-PRINT" \(p-print\) prints the capsules, and on some path no hold point after it holds them for QC approval/);
    expect(found(master(seq(hold('H-BLEND'), lib('p-print', 'PROC-CAPS-PRINT')), 'Hard gelatin capsule'), 'GMP-CAPSULE-PRINT-HELD')).toHaveLength(1);
    // Branches: printing on one branch only, held after the join, passes; so does a hold inside each branch. A branch that
    // prints after its own hold while the other holds is refused.
    const alt = (b1: FlowNode, b2: FlowNode): FlowNode => ({ kind: 'alternative', id: 'alt', decision: { mode: 'DATA' }, branches: [{ id: 'b1', name: 'Printed', guard: 'true', body: b1 }, { id: 'b2', name: 'Plain', otherwise: true, body: b2 }] }) as never;
    expect(found(master(seq(alt(lib('p-print', 'PROC-CAPS-PRINT'), lib('p-inspect', 'PROC-CAPS-INSPECT')), hold('H-PACK')), 'Hard gelatin capsule'), 'GMP-CAPSULE-PRINT-HELD')).toEqual([]);
    expect(found(master(seq(lib('p-print', 'PROC-CAPS-PRINT'), alt(hold('H-A'), hold('H-B'))), 'Hard gelatin capsule'), 'GMP-CAPSULE-PRINT-HELD')).toEqual([]);
    expect(found(master(seq(lib('p-print', 'PROC-CAPS-PRINT'), alt(hold('H-A'), lib('p-inspect', 'PROC-CAPS-INSPECT'))), 'Hard gelatin capsule'), 'GMP-CAPSULE-PRINT-HELD')).toHaveLength(1);
    expect(found(master(seq(alt(seq(hold('H-A'), lib('p-print', 'PROC-CAPS-PRINT')), hold('H-B'))), 'Hard gelatin capsule'), 'GMP-CAPSULE-PRINT-HELD')).toHaveLength(1);
    // A master without printing has nothing to hold.
    expect(found(master(seq(lib('p-fill', 'PROC-CAPS-FILL')), 'Hard gelatin capsule'), 'GMP-CAPSULE-PRINT-HELD')).toEqual([]);
  });
});
