/**
 * Who may act where an MBR names a role (Phase 2 exit review F48, F49; PR-45, INV-26, PR-14).
 *  - FLOW-ROLES (validator): every performer, checker, hold-point releaser, stage responsible and role allowed to choose
 *    a branch is an engine role of the installation (the port `roles`, read from the database on the server); without
 *    the vocabulary the check fails closed.
 *  - ENG-DEF-HOLD-ROLE (engine definition): a QA hold point is released by the policy's QA roles only.
 * The database refuses such content too (sql 0324; apps/tablets-server test designer/roles and
 * execution/db-guards-content-roles).
 */
import { describe, expect, it } from 'vitest';
import { EngineDefinitionError } from '../../src/engine/definition.ts';
import { libraryElementHash } from '../../src/flow/canonical.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { STRUCTURE_RULES } from '../../src/validator/rules-structure.ts';
import { define } from '../engine/support.ts';
import { validateMbr } from '../../src/validator/validate.ts';
import { clone, context, loadFixture, mbrWith, phase, registryOf } from '../flow/support.ts';

const structureOnly = registryOf(STRUCTURE_RULES);
const seq = (id: string, children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const ENGINE = { engineRoles: ['PRODUCTION_OPERATOR', 'DISPENSER', 'PRODUCTION_VERIFIER', 'PRODUCTION_SUPERVISOR', 'STAGE_RESPONSIBLE', 'HEAD_OF_PRODUCTION', 'QA', 'QA_REVIEWER'] };

function roleFindings(mbr: MbrContent, roles: { engineRoles: readonly string[] } | null = ENGINE): { subject: string; message: string }[] {
  const ctx = context();
  if (roles) ctx.roles = roles;
  else delete ctx.roles;
  return validateMbr(mbr, ctx, structureOnly)
    .findings.filter((f) => f.rule === 'FLOW-ROLES')
    .map((f) => ({ subject: f.subject, message: f.message }));
}

function holdMbr(role: string): MbrContent {
  const a = phase('a');
  a.signatures = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };
  const b = phase('b');
  b.signatures = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };
  return mbrWith(seq('o', [a, { kind: 'holdPoint', id: 'H', name: 'Cores approved for coating', role, dispositions: ['APPROVED', 'NOT_APPROVED'] }, b]));
}

describe('FLOW-ROLES: every role an MBR names is an engine role of the installation (F49)', () => {
  it('[INV-26][PR-14] the granulation fixture names engine roles only, and passes', () => {
    expect(roleFindings(loadFixture('tablet-granulation-compression'))).toEqual([]);
  });

  it('[INV-26][PR-45] a hold point released by the kernel role QA_SHOP_FLOOR is refused, naming the role and the vocabulary', () => {
    const found = roleFindings(holdMbr('QA_SHOP_FLOOR'));
    expect(found.map((f) => f.subject)).toEqual(['H']);
    expect(found[0]?.message).toMatch(/^The releaser of hold point "Cores approved for coating" \(H\) is "QA_SHOP_FLOOR", which is not an engine role of this installation \(PRODUCTION_OPERATOR, .*QA, QA_REVIEWER\)/);
    expect(found[0]?.message).toMatch(/\(FLOW-ROLES; INV-26, PR-14, PR-45\)$/);
  });

  it('[INV-26][PR-14] a performer, checker, stage responsible or choosing role outside the vocabulary is refused where it is named, library steps included', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    const visit = (n: FlowNode): void => {
      if (n.kind === 'phase' && n.id === 'p-drymix') n.signatures = { check: { meaning: 'VERIFIED', role: 'VERIFIER' } };
      if (n.kind === 'phase' && n.id === 'p-charge') n.signatures = { perform: { role: 'OPERATOR' } };
      if (n.kind === 'stage' && n.id === m.procedure.body.id) n.responsibleRole = 'SHIFT_SUPERVISOR';
      if (n.kind === 'alternative' && n.decision.mode === 'OPERATOR_CHOICE') n.decision.roles = ['PRODUCTION_SUPERVISOR', 'SUP'];
      if (n.kind === 'stage' && n.responsibleRole === 'HEAD_OF_PRODUCTION') n.responsibleRole = 'HEAD';
      if (n.kind === 'sequence') n.children.forEach(visit);
      else if ('body' in n && n.body) visit(n.body);
      else if (n.kind === 'parallel') n.branches.forEach((b) => visit(b.body));
      else if (n.kind === 'alternative') n.branches.forEach((b) => b.body && visit(b.body));
    };
    visit(m.procedure.body);
    const lib = m.library[0];
    if (lib?.body.kind !== 'phase') throw new Error('fixture changed: LIB-LOD is not a step');
    lib.body.signatures = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'VERIFIER' } };
    const pin = m.references.find((r) => r.id === lib.ref);
    if (!pin) throw new Error('fixture changed: LIB-LOD is not pinned');
    pin.hash = libraryElementHash(lib);
    const subjects = roleFindings(m).map((f) => f.subject);
    // A library element's step is checked where a call brings it in (its expanded id), as the floor runs it.
    expect(subjects).toEqual(expect.arrayContaining(['p-drymix', 'p-charge', 'ALT-IPA', 'c-lod/lod-test']));
    expect(subjects.filter((s) => s.startsWith('S-')).length).toBeGreaterThan(0);
    expect(roleFindings(m).every((f) => /is "(VERIFIER|OPERATOR|SUP|HEAD)", which is not an engine role/.test(f.message))).toBe(true);
  });

  it('[INV-26] without the installation\'s engine roles the check fails closed (one error), never passes', () => {
    const found = roleFindings(loadFixture('tablet-granulation-compression'), null);
    expect(found.map((f) => f.subject)).toEqual(['$']);
    expect(found[0]?.message).toMatch(/^The engine roles of this installation were not supplied, so the roles this master names cannot be checked/);
  });
});

describe('ENG-DEF-HOLD-ROLE: a QA hold point is released by the quality unit (F48)', () => {
  it('[PR-45] the engine refuses to define a batch whose hold point a production operator (or a role no session carries) releases', () => {
    for (const role of ['PRODUCTION_OPERATOR', 'QA_SHOP_FLOOR', 'PRODUCTION_SUPERVISOR']) {
      let problems: { code: string; subject: string; message: string }[] = [];
      try {
        define(holdMbr(role));
      } catch (e) {
        if (!(e instanceof EngineDefinitionError)) throw e;
        problems = e.problems;
      }
      const hold = problems.filter((p) => p.code === 'ENG-DEF-HOLD-ROLE');
      expect(hold.map((p) => p.subject), role).toEqual(['H']);
      expect(hold[0]?.message, role).toMatch(new RegExp(`^Hold point H is released by ${role}; a QA hold point is released by the quality unit \\(QA\\)`));
    }
  });

  it('[PR-45] control: QA releases it; a policy naming another QA role makes that the releaser', () => {
    expect(() => define(holdMbr('QA'))).not.toThrow();
    expect(() => define(holdMbr('QA_LEAD'), { policy: { qaRoles: ['QA_LEAD'] } })).not.toThrow();
  });
});
