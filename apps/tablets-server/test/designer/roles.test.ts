/**
 * Who may act where an MBR names a role (Phase 2 exit review F48, F49; PR-45, INV-26, PR-14).
 *
 * F48: the designer offered every engine role as the releaser of a "QA hold point" and the validation gate (which
 * startVerification records as DI-04 evidence) passed a master whose hold point a production operator releases.
 * F49: a role outside the engine vocabulary (the kernel role QA_SHOP_FLOOR, shown like the engine role QA) passed the
 * gate too, though no session ever carries it, so the batch would stop at that step for good.
 *
 * Now the gate refuses both (the validator's FLOW-ROLES with the installation's engine roles read from this database;
 * the engine's definition ENG-DEF-HOLD-ROLE), and the database refuses to store such content whoever writes it
 * (recipe-core 0324, EBMR-RCP-123): each refusal below is the application role calling recipe.save_content itself.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import { identity } from '@ebmr/kernel';
import { ENGINE_ROLES, PINNED_POLICY_ROLES, routes, type VersionView } from '@ebmr/api-contract';
import { engine, flow } from '@ebmr/recipe-core/pure';
import { openPersonaSession } from '@ebmr/test-kit';
import { engineRoles } from '../../src/features/designer/adapters/expressions.ts';
import { analyse } from '../../src/features/designer/validation.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { createFamily, refusalOf, saveContent, startDesignerServer, templateMbr } from './support.ts';

let server: TestServer;
let author: TestBrowser;

beforeAll(async () => {
  server = await startDesignerServer();
  author = await server.asPersona('author');
});
afterAll(async () => {
  await server?.close();
});

type Json = Record<string, unknown>;

/** The node with id `id` of raw content (procedure body or a library body). */
function nodeOf(content: Json, id: string): Json {
  let found: Json | undefined;
  const visit = (v: unknown): void => {
    if (found || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(visit);
    const o = v as Json;
    if (o['id'] === id && typeof o['kind'] === 'string') found = o;
    else Object.values(o).forEach(visit);
  };
  visit(content);
  if (!found) throw new Error(`SETUP: no node ${id}`);
  return found;
}

/** dc-mini (or a version's content) as raw JSON with `edit` applied (no parser in between, as an API caller could send it). */
function rawMini(edit: (c: Json) => void, base: unknown = templateMbr()): Json {
  const c = JSON.parse(JSON.stringify(base)) as Json;
  edit(c);
  return c;
}

const hold = (role: unknown) => (c: Json) => void (nodeOf(c, 'H-BLEND')['role'] = role);
const performer = (role: unknown) => (c: Json) => void ((nodeOf(c, 'p-disp-sop')['signatures'] as { perform: { role: unknown } }).perform.role = role);
const checker = (role: unknown) => (c: Json) => void ((nodeOf(c, 'p-disp-clear')['signatures'] as { check: { role: unknown } }).check.role = role);
const responsible = (role: unknown) => (c: Json) => void (nodeOf(c, 'S-BLEND')['responsibleRole'] = role);
/** The SOP step of the dispensing preparation becomes one branch of an operator choice that `roles` may make. */
const chooser = (roles: unknown[]) => (c: Json) => {
  const op = nodeOf(c, 'O-DISP-PREP')['body'] as { children: Json[] };
  const i = op.children.findIndex((x) => x['id'] === 'p-disp-sop');
  const sop = op.children[i] as Json;
  op.children[i] = { kind: 'alternative', id: 'ALT-SOP', decision: { mode: 'OPERATOR_CHOICE', roles, reasonRequired: true }, branches: [{ id: 'b-read', name: 'Read the SOP', body: sop }, { id: 'b-skip', name: 'Already read today' }] };
};
/** The SOP step, performed by `role`, inside a construct of `kind` (the database walks every body a construct holds). */
const wrapped = (kind: 'loop' | 'replicate' | 'parallel', role: unknown) => (c: Json) => {
  performer(role)(c);
  const op = nodeOf(c, 'O-DISP-PREP')['body'] as { children: Json[] };
  const i = op.children.findIndex((x) => x['id'] === 'p-disp-sop');
  const sop = op.children[i] as Json;
  op.children[i] =
    kind === 'loop'
      ? { kind, id: 'L-SOP', name: 'Read until understood', body: sop, maxIterations: 3, exit: { condition: 'true', endpoint: 'x' } }
      : kind === 'replicate'
        ? { kind, id: 'R-SOP', name: 'Per sub-lot', body: sop, count: { mode: 'RUNTIME', min: 1, max: 2, reasonRequired: true }, instances: 'SEQUENTIAL', subLotPrefix: 'SL' }
        : { kind, id: 'P-SOP', branches: [{ id: 'b-1', name: 'Read', body: sop }, { id: 'b-2', name: 'Other', body: { kind: 'sequence', id: 'empty', children: [] } }] };
};
/** A library element (not called) whose step is performed by `role`: the database checks every body it holds. */
const libraryStep = (role: unknown) => (c: Json) => {
  const step = JSON.parse(JSON.stringify(nodeOf(c, 'p-disp-sop'))) as Json;
  step['id'] = 'lib-sop';
  (step['signatures'] as { perform: { role: unknown } }).perform.role = role;
  c['library'] = [{ ref: 'LIB-SOP', level: 'OPERATION', symbols: [], body: step }];
};

async function gateOf(content: Json) {
  const parsed = flow.parseMbr(content);
  if (!parsed.ok) throw new Error(`SETUP: ${JSON.stringify(parsed.problems)}`);
  return analyse(server.db.app, parsed.mbr, []);
}

describe('who releases a QA hold point, and roles outside the engine vocabulary (F48, F49)', () => {
  it('[PR-45] control: the dc-mini template passes as it is (QA releases H-BLEND)', async () => {
    const a = await analyse(server.db.app, templateMbr(), []);
    expect(a.gate.errors).toBe(0);
    expect(a.gate.passed).toBe(true);
  });

  it('[PR-45] a "QA hold point" released by a production operator fails the gate (ENG-DEF-HOLD-ROLE on H-BLEND)', async () => {
    const a = await gateOf(rawMini(hold('PRODUCTION_OPERATOR')));
    expect(a.findings.filter((f) => f.subject === 'H-BLEND' && f.severity === 'ERROR').map((f) => f.rule)).toEqual(['ENG-DEF-HOLD-ROLE']);
    expect(a.gate.passed).toBe(false);
  });

  it('[INV-26][PR-14] a role outside the engine vocabulary fails the gate (FLOW-ROLES), wherever the master names it', async () => {
    const cases: [string, (c: Json) => void, string][] = [
      ['hold point releaser QA_SHOP_FLOOR', hold('QA_SHOP_FLOOR'), 'H-BLEND'],
      ['performer OPERATOR', performer('OPERATOR'), 'p-disp-sop'],
      ['checker VERIFIER', checker('VERIFIER'), 'p-disp-clear'],
      ['stage responsible SHIFT_SUPERVISOR', responsible('SHIFT_SUPERVISOR'), 'S-BLEND'],
      ['chooser SHIFT_SUPERVISOR', chooser(['SHIFT_SUPERVISOR']), 'ALT-SOP'],
    ];
    for (const [what, edit, subject] of cases) {
      const a = await gateOf(rawMini(edit));
      expect(
        a.findings.filter((f) => f.rule === 'FLOW-ROLES').map((f) => f.subject),
        what,
      ).toEqual([subject]);
      expect(a.gate.passed, what).toBe(false);
    }
  });

  it('[PR-45][INV-26] the database refuses to store content naming a role that cannot act there, whoever writes it (EBMR-RCP-123)', async () => {
    const v: VersionView = await createFamily(author, { familyCode: 'PCM500-F48', batchSizes: [{ quantity: '79.000', unit: 'kg' }] });
    const actor = { ...(await openPersonaSession(server.db, server.seed, 'author')), reasonCode: 'TEST', reasonText: 'F48 F49 direct write' };
    const write = (content: Json) =>
      identity.withGuardedCommand(server.db.app, actor, (c) => c.query('select recipe.save_content($1, $2::jsonb, $3, $4) as r', [v.versionId, JSON.stringify(content), sha256Hex(canonicalJson(content)), 'roles changed directly']));
    const refusals: [string, (c: Json) => void, RegExp][] = [
      ['hold point released by a production operator', hold('PRODUCTION_OPERATOR'), /hold point H-BLEND is released by PRODUCTION_OPERATOR; a QA hold point is released only by QA \(PR-45\)/],
      ['hold point released by the kernel role QA_SHOP_FLOOR', hold('QA_SHOP_FLOOR'), /the releaser of H-BLEND is "QA_SHOP_FLOOR", which is not an engine role/],
      ['hold point releaser that is not text', hold(7), /the releaser of H-BLEND is 7, which is not an engine role/],
      ['performer OPERATOR', performer('OPERATOR'), /the performer of p-disp-sop is "OPERATOR", which is not an engine role/],
      ['checker VERIFIER', checker('VERIFIER'), /the checker of p-disp-clear is "VERIFIER", which is not an engine role/],
      ['stage responsible SHIFT_SUPERVISOR', responsible('SHIFT_SUPERVISOR'), /the person responsible for S-BLEND is "SHIFT_SUPERVISOR"/],
      ['chooser SHIFT_SUPERVISOR', chooser(['PRODUCTION_SUPERVISOR', 'SHIFT_SUPERVISOR']), /a role allowed to choose a branch of ALT-SOP is "SHIFT_SUPERVISOR"/],
      ['performer of a library element step', libraryStep('OPERATOR'), /the performer of lib-sop is "OPERATOR"/],
      ['performer inside an alternative branch', (c) => (chooser(['PRODUCTION_SUPERVISOR'])(c), performer('OPERATOR')(c)), /the performer of p-disp-sop is "OPERATOR"/],
      ['performer inside a loop', wrapped('loop', 'OPERATOR'), /the performer of p-disp-sop is "OPERATOR"/],
      ['performer inside a replicate section', wrapped('replicate', 'OPERATOR'), /the performer of p-disp-sop is "OPERATOR"/],
      ['performer inside a parallel branch', wrapped('parallel', 'OPERATOR'), /the performer of p-disp-sop is "OPERATOR"/],
    ];
    for (const [what, edit, message] of refusals) {
      const err = await write(rawMini(edit, v.content)).then(
        () => null,
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      expect(err, what).toMatch(message);
      expect(err, what).toMatch(/\[EBMR-RCP-123\]$/);
    }
    const stored = await server.db.admin.query<{ n: string }>('select count(*)::text as n from recipe.mbr_content where version_id = $1', [v.versionId]);
    expect(stored.rows[0]?.n).toBe('1');
    // Control: the same path stores content whose roles can all act (so each refusal above is the role's).
    await expect(write(rawMini(chooser(['PRODUCTION_SUPERVISOR']), v.content))).resolves.toBeDefined();
  });

  it('[PR-45][INV-26] the designer\'s save of such content is refused with the database\'s reason and guidance', async () => {
    const v: VersionView = await createFamily(author, { familyCode: 'PCM500-F49', batchSizes: [{ quantity: '81.000', unit: 'kg' }] });
    const r = refusalOf(await saveContent(author, v, rawMini(hold('PRODUCTION_OPERATOR'), v.content), 'releaser changed'));
    expect(r.status).toBe(422);
    expect(r.code).toBe('EBMR-RCP-123');
    expect(r.controls).toEqual(expect.arrayContaining(['PR-45']));
    const after = await author.call(routes.designer.version, { params: { versionId: v.versionId } });
    expect(after.ok && after.value.revision).toBe(1);
  });

  it('[INV-26][PR-45] the TypeScript checks read the same roles as the database: engine roles, and QA alone releases a hold point', async () => {
    expect(await engineRoles(server.db.app)).toEqual([...ENGINE_ROLES].sort());
    const { rows } = await server.db.admin.query<{ r: string }>('select r from recipe.hold_point_release_roles() r order by r');
    expect(rows.map((x) => x.r)).toEqual([...engine.DEFAULT_POLICY.qaRoles]);
    expect([...PINNED_POLICY_ROLES.qaRoles]).toEqual([...engine.DEFAULT_POLICY.qaRoles]);
  });
});
