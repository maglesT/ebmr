/**
 * Review P22 (INV-26, DI-17, decision D4; recipe-core 0270), the positive path of recipe.issue_execution: the engine
 * roles an issue request gives the issuer are derived in the database from the evaluations stored in the issuing
 * command (in the declared role, at the actor's location, through recipe.engine_role_map), and the ISSUE row stores
 * that evidence. The shipped map gives the issuing role no engine role, so an honest issue stores []; this file
 * applies, as a software release of an edition would, a map row for the issuing role and shows the evidence the
 * database derives and stores. (A separate file: the release changes this copy's configuration for good.)
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { execution } from '@ebmr/recipe-core';
import { engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, codeOf } from './db-guards-support.ts';
import { dcMini, importAndIssue, personaIn, startExecServer, violations, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

/** An edition release that maps the kernel role BATCH_ISSUER to an engine role through BATCH.ISSUE (insert-only configuration). */
async function releaseIssuerMapping(): Promise<void> {
  const c = await sbx.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local role ebmr_owner');
    await c.query(
      `select kernel.set_actor_context(jsonb_build_object(
         'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
         'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
         'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
         'legal_name', 'Software release (test edition: the issuing role carries an engine role)',
         'reason_code', 'SOFTWARE_RELEASE', 'reason_text', 'an edition that maps its issuing role (INV-26, D4)'))`,
    );
    await c.query("insert into recipe.engine_role_permission (engine_role, permission) values ('BATCH_ISSUER', 'BATCH.ISSUE')");
    await c.query("insert into recipe.engine_role_map (kernel_role, engine_role, via_permission) values ('BATCH_ISSUER', 'BATCH_ISSUER', 'BATCH.ISSUE')");
    await c.query('select kernel.set_actor_context(null)');
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

describe('P22: the issuer\'s engine roles come from the evaluations of the issuing command', () => {
  it('[INV-26][DI-17][D4] an issue whose request gives the issuer a mapped engine role stores the evaluation behind it; an unmapped one is refused', async () => {
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
    const run = await runContext(sbx.db.admin, runId);
    await releaseIssuerMapping();
    const who = personaIn(sbx, 'issuer');
    const issueWith = async (roles: string[]): Promise<{ batchId: string; correlationId: string }> => {
      const actor = await actorOf(sbx, issuer, 'issuer');
      const batchId = randomUUID();
      await withCommand(sbx.db.app, actor, async (c) => {
        // The edition's own map (tab.engine_role_map) is not changed: the server would still derive no role here.
        if ((await engineRoles(c)).length !== 0) throw new Error('SETUP: the edition map gives the issuer an engine role');
        await execution.issueBatch(c, {
          def: run.def,
          batchId,
          packageHash: run.batch.packageHash,
          request: { batchSize: run.batch.batchSize, marketSet: ['IN'], purpose: 'VALIDATION', variants: {}, inputs: { tabletsPerBatch: { value: { kind: 'COUNT', value: '100000' }, source: 'Keyed at issue for this regression test' } }, issuedBy: { id: who.personId, kind: 'PERSON', roles } },
        });
      });
      return { batchId, correlationId: actor.correlationId ?? '' };
    };

    expect(await codeOf(issueWith(['BATCH_ISSUER', 'QA']))).toBe('EBMR-EXE-037');
    const { batchId, correlationId } = await issueWith(['BATCH_ISSUER']);
    const { rows } = await sbx.db.admin.query<{ roles: { role: string; permission: string; evaluationId: string }[] }>("select roles from recipe.execution_command where batch_id = $1 and kind = 'ISSUE'", [batchId]);
    expect(rows.map((r) => r.roles.map((e) => `${e.role}/${e.permission}`))).toEqual([['BATCH_ISSUER/BATCH.ISSUE']]);
    const evaluationId = rows[0]?.roles[0]?.evaluationId;
    // The stored evidence is the allowed evaluation of BATCH.ISSUE made in the issuing command, in the declared
    // role and at the issuer's location (the session's site and room).
    const ev = await sbx.db.admin.query<{ allowed: boolean; person_id: string; permission_code: string; role_filter: string; role_code: string; correlation_id: string; scope: Record<string, string> }>(
      'select allowed, person_id, permission_code, role_filter, role_code, correlation_id, scope from iam.authority_evaluation where id = $1',
      [evaluationId],
    );
    const site = await sbx.db.admin.query<{ site_code: string }>('select site_code from recipe.batch_execution where id = $1', [batchId]);
    expect(ev.rows[0]).toMatchObject({ allowed: true, person_id: who.personId, permission_code: 'BATCH.ISSUE', role_filter: 'BATCH_ISSUER', role_code: 'BATCH_ISSUER', correlation_id: correlationId });
    expect(ev.rows[0]?.scope['site']).toBe(site.rows[0]?.site_code);
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);
});
