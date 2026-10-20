/**
 * The GMP batch family over HTTP (Phase 3 slice 6a; D-S6-1, D-S6-2): a GMP batch runs under /api/batches/* and a test
 * batch under /api/test-runs/* (the other installation answers 404); no route deletes an entry (a void keeps the attempt,
 * with the person's reason and QA's approval of the act proposed); a BLOCK_ENTRY of every tablet block reaches the engine
 * as the block's own entry; the TabletEntryKind enum is the block registry's; every new route answers what its contract
 * schema parses (the typed client parses each answer with the route's own schema).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allRoutes, buildPath, ClientEntry, routes, TABLET_ENTRY_KINDS_BY_BLOCK, TabletEntryKind, type AnyRoute, type ClientIntent } from '@ebmr/api-contract';
import { blocks } from '@ebmr/recipe-core';
import { tabletsBlockRegistry } from '../../src/features/edition-blocks.ts';
import { resolveBlockEntry, serverFilledMembers } from '../../src/features/execution/block-entries.ts';
import { personaIn, refusalOf, sessionOfBrowser, tapFor, valueOf } from '../esig/support.ts';
import type { TestBrowser } from '../support/harness.ts';
import { startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import { signAction } from '../support/signed-acts.ts';
import { RunDriver, startExecServer, type ExecServer } from './support.ts';

let w: GmpBatchWorld;
let sbx: ExecServer;
let issuer: TestBrowser;
let operator: TestBrowser;
let batchId: string;

const registry = tabletsBlockRegistry();

beforeAll(async () => {
  [w, sbx] = await Promise.all([startGmpBatchWorld(), startExecServer()]);
  [issuer, operator] = await Promise.all([w.gmp.asPersona('issuer'), w.gmp.asPersona('operator1')]);
  batchId = await w.issued(issuer);
}, 600_000);
afterAll(async () => {
  await Promise.all([w?.close(), sbx?.close()]);
});

const U = '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
const sample: Record<string, string> = { batchId: U, runId: U, formulaId: U, id: U, allocationId: U, stepKey: 'p-disp-sop@', code: 'RMG-01', occupancyId: U, useId: U, issueId: U, set: 'TS-01' };
const inject = (server: { app: { inject: (o: Record<string, unknown>) => Promise<{ statusCode: number }> }; config: { publicOrigin: string } }, route: AnyRoute) =>
  server.app.inject({ method: route.method, url: buildPath(route.path, sample), headers: { origin: server.config.publicOrigin, 'sec-fetch-site': 'same-origin' } });

describe('GMP batch routes (slice 6a, D-S6-1)', () => {
  it('[DI-24] no route deletes a batch entry: a DELETE answers 404 and a void needs a reason', async () => {
    expect(allRoutes(routes).filter((r) => r.method === 'DELETE')).toEqual([]);
    for (const url of [`/api/batches/${batchId}`, `/api/batches/${batchId}/commands`, `/api/batches/${batchId}/steps/p-disp-sop@`, `/api/batches/${batchId}/steps/p-disp-sop@/entries/EN-1`]) {
      const res = await w.gmp.app.inject({ method: 'DELETE', url, headers: { origin: w.gmp.config.publicOrigin, 'sec-fetch-site': 'same-origin' } });
      expect(res.statusCode, url).toBe(404);
    }
    const d = new RunDriver(w.gmp, batchId, { issuer, operator1: operator });
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-sop@' });
    // Without a reason the void is not even a request (the contract refuses it; nothing is recorded).
    const noReason = await d.command('operator1', { type: 'VOID_ATTEMPT', stepKey: 'p-disp-sop@', item: 'x' } as unknown as ClientIntent);
    expect(noReason.ok).toBe(false);
    expect(refusalOf(noReason)?.code).not.toMatch(/^ENG-|^EBMR-EXE/);
    // With a reason but without QA's approval: the engine refuses it, and the refusal is recorded (DI-34), nothing deleted.
    const unapproved = await d.command('operator1', { type: 'VOID_ATTEMPT', stepKey: 'p-disp-sop@', item: 'readConfirmed', reason: 'Wrong step opened' });
    expect(unapproved.ok).toBe(false);
    expect(refusalOf(unapproved)?.code).toMatch(/^ENG-/);
    const { rows } = await w.gmp.db.admin.query<{ command_type: string; accepted: boolean }>(
      "select command_type, accepted from recipe.execution_command where batch_id = $1 and kind = 'COMMAND' order by seq",
      [batchId],
    );
    expect(rows.at(-1)).toEqual({ command_type: 'VOID_ATTEMPT', accepted: false });
    // The act proposed for QA's approval; its requester cannot approve it.
    const actBody = { intent: { type: 'VOID_ATTEMPT' as const, stepKey: 'p-disp-sop@', item: 'readConfirmed', reason: 'Wrong step opened' } };
    const tap = await tapFor(operator, personaIn(w.gmp, 'operator1'), 'POST', `/api/batches/${batchId}/acts`, actBody);
    const act = valueOf(await operator.call(routes.batches.proposeAct, { params: { batchId }, body: actBody, attribution: tap }));
    expect(act).toMatchObject({ batchId, commandType: 'VOID_ATTEMPT', meaning: 'VOID_AUTHORISED', aggregateType: 'batch_act' });
    expect(act.actId.startsWith(`${batchId}:act@`)).toBe(true);
    const own = await signAction(w.gmp, operator, 'operator1', { kind: 'ACT_APPROVAL', batchId, actId: act.actId });
    expect(own.ok).toBe(false);
  }, 300_000);

  it('[DI-05][INV-18] GMP routes answer 404 on the sandbox and test-run routes 404 on GMP', async () => {
    for (const route of Object.values(routes.batches)) expect((await inject(sbx, route)).statusCode, route.id).toBe(404);
    const testRuns = [routes.execution.runs, routes.execution.run, routes.execution.step, routes.execution.timeline, routes.execution.verifyReplay, routes.execution.command];
    for (const route of testRuns) expect((await inject(w.gmp, route)).statusCode, route.id).toBe(404);
    for (const route of [...Object.values(routes.planning), ...Object.values(routes.masterData), ...Object.values(routes.plant)]) {
      expect((await inject(sbx, route)).statusCode, route.id).toBe(404);
    }
  });

  it('the TabletEntryKind enum equals the block registry', () => {
    for (const [key, kinds] of Object.entries(TABLET_ENTRY_KINDS_BY_BLOCK)) {
      const [type, version] = key.split('@');
      const b = registry.get(type ?? '', version ?? '');
      expect(Object.keys(b?.dataSchema?.entries ?? {}), key).toEqual([...kinds]);
    }
    const all = new Set<string>();
    for (const b of registry.all()) {
      const key = `${b.type}@${b.version}`;
      if (b.edition === 'tablets' || key in TABLET_ENTRY_KINDS_BY_BLOCK) for (const k of Object.keys(b.dataSchema?.entries ?? {})) all.add(k);
    }
    expect([...TabletEntryKind.options].sort()).toEqual([...all].sort());
  });

  it('a BLOCK_ENTRY for each tablet block reaches the engine (one per block, the golden fixture\'s first entry)', async () => {
    const client = { query: () => Promise.resolve({ rows: [{ r: null }] }) } as never;
    let checked = 0;
    for (const key of Object.keys(TABLET_ENTRY_KINDS_BY_BLOCK)) {
      const [type, version] = key.split('@');
      const b = registry.get(type ?? '', version ?? '');
      const first = b?.goldenFixture?.script.find((s): s is { entry: Record<string, unknown> & { kind: string } } => 'entry' in s);
      if (!b || !first) continue;
      const { kind, ...rest } = first.entry;
      const schema = b.dataSchema?.entries[kind];
      if (!schema) throw new Error(`${key}: no schema for ${kind}`);
      const data = Object.fromEntries(Object.entries(rest).filter(([k]) => !serverFilledMembers(schema).includes(k)));
      const wire = ClientEntry.safeParse({ kind: 'BLOCK_ENTRY', entryKind: kind, data });
      if (kind === 'CONTAINER_WEIGHING' || kind === 'POTENCY_CALCULATION') continue;
      expect(wire.success, `${key} ${kind}: ${wire.success ? '' : JSON.stringify(wire.error.issues.slice(0, 2))}`).toBe(true);
      if (!wire.success || wire.data.kind !== 'BLOCK_ENTRY') continue;
      const entry = await resolveBlockEntry({ client, batchId, stepKey: 'p@', block: b }, wire.data.entryKind, wire.data.data);
      // The engine's first check of an entry: the block version's own schema (the database's guards decide the rest).
      const schemaOnly = Object.fromEntries(Object.entries(entry).filter(([k]) => k !== 'kind'));
      const problems = blocks.validateSchema({ ...schema, fields: Object.fromEntries(Object.entries(schema.fields).filter(([k]) => !serverFilledMembers(schema).includes(k))) }, schemaOnly);
      expect(problems, `${key} ${kind}`).toEqual([]);
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(20);
    // Over HTTP on a GMP batch: a BLOCK_ENTRY on a step whose block does not take that kind is the engine's refusal,
    // recorded with the batch (not a server's or contract's refusal).
    const d = new RunDriver(w.gmp, batchId, { issuer, operator1: operator });
    const r = await d.command('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-disp-sop@', entry: { kind: 'BLOCK_ENTRY', entryKind: 'SHIPPER', data: { sscc: '389012340000000012', packs: '48', part: false } } });
    expect(refusalOf(r)?.code).toMatch(/^ENG-/);
    const { rows } = await w.gmp.db.admin.query<{ command_type: string; accepted: boolean; command: { entry?: { kind?: string } } }>(
      "select command_type, accepted, command from recipe.execution_command where batch_id = $1 and kind = 'COMMAND' order by seq desc limit 1",
      [batchId],
    );
    expect(rows[0]).toMatchObject({ command_type: 'RECORD_ENTRY', accepted: false, command: { entry: { kind: 'SHIPPER' } } });
  }, 120_000);

  it('[DI-17] the planning read is the batch issuer\'s: a session whose role holds no BATCH.ISSUE is refused, by route and in the database', async () => {
    const analyst = await w.gmp.asPersona('qcAnalyst');
    expect(refusalOf(await analyst.call(routes.planning.orders))?.code).toBe('EBMR-IAM-040');
    expect(refusalOf(await operator.call(routes.planning.orders))?.code).toBe('EBMR-IAM-040');
    expect(valueOf(await issuer.call(routes.planning.orders)).orders.length).toBeGreaterThan(0);
    // As the application role: the session read refuses the analyst's token, and the site-wide reader is the owner's only.
    const token = (await sessionOfBrowser(w.gmp, analyst)).tokenHash;
    await expect(w.gmp.db.app.query('select tab.planning_orders($1)', [token])).rejects.toThrow(/EBMR-IAM-040.*BATCH\.ISSUE/);
    await expect(w.gmp.db.app.query("select recipe.planning_orders('SITE-1')")).rejects.toThrow(/permission denied/);
  }, 120_000);

  it('every new route parses with its contract schema', async () => {
    const qa = await w.gmp.asPersona('qaInvestigator');
    const steward = await w.gmp.asPersona('steward');
    valueOf(await issuer.call(routes.batches.list, { query: {} }));
    valueOf(await issuer.call(routes.batches.batch, { params: { batchId } }));
    valueOf(await operator.call(routes.batches.step, { params: { batchId, stepKey: 'p-disp-sop@' } }));
    valueOf(await operator.call(routes.batches.workQueue, { params: { batchId } }));
    valueOf(await issuer.call(routes.batches.timeline, { params: { batchId } }));
    expect(valueOf(await issuer.call(routes.batches.verifyReplay, { params: { batchId }, body: {} })).identical).toBe(true);
    expect(valueOf(await issuer.call(routes.batches.sscc, { params: { batchId } })).ssccs).toEqual([]);
    // The SSCC is issued for a TB-24 step only (the database refuses another step).
    const ssccTap = await tapFor(operator, personaIn(w.gmp, 'operator1'), 'POST', `/api/batches/${batchId}/steps/${encodeURIComponent('p-disp-sop@')}/sscc`, {});
    expect(refusalOf(await operator.call(routes.batches.issueSscc, { params: { batchId, stepKey: 'p-disp-sop@' }, body: {}, attribution: ssccTap }))?.code).toBe('EBMR-TAB-383');
    expect(refusalOf(await qa.call(routes.batches.additionSources, { params: { batchId, stepKey: 'p-disp-sop@' } }))?.code).toBe('EBMR-API-NOT-ADDITION');
    const orders = valueOf(await issuer.call(routes.planning.orders)).orders;
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.some((o) => o.batches.some((b) => b.batchId === batchId))).toBe(true);
    for (const r of [routes.quality.deviations, routes.quality.erpOrders, routes.quality.erpProducts, routes.quality.erpMaterials, routes.quality.lots, routes.quality.reprocessingRequests]) {
      valueOf(await qa.call(r as typeof routes.quality.erpOrders));
    }
    valueOf(await qa.call(routes.quality.extraTesting, { params: { batchId } }));
    valueOf(await steward.call(routes.masterData.formulas));
    for (const r of [routes.plant.areas, routes.plant.equipmentClasses, routes.plant.equipment, routes.plant.toolingSets, routes.plant.detectors, routes.plant.testPieces, routes.plant.utilities, routes.plant.pendingVerifications]) {
      valueOf(await steward.call(r as typeof routes.plant.areas));
    }
  }, 120_000);
});
