/**
 * Owner retest of 13 November 2026, item 8: raising a deviation from a batch exception was three requests (raise, link
 * to the batch, attach to the exception); an interruption left DEV-SITE-1-2026-00004 raised and attached to nothing. Now
 * ATTACH_DEVIATION with `raise` raises the deviation, links it to the batch and attaches it in one command: all of it
 * commits or none of it. A refused attachment raises nothing. The deviation's title carries the exception's values at
 * the precision they were judged at, never a 34-digit quotient.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { exceptionTitleAtPrecision } from '../../src/features/execution/exception-deviation.ts';
import { startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import { refusalOf, RunDriver, valueOf } from './support.ts';

let w: GmpBatchWorld;
let batchId: string;
let d: RunDriver;

beforeAll(async () => {
  w = await startGmpBatchWorld();
  const issuer = await w.gmp.asPersona('issuer');
  batchId = await w.issued(issuer);
  d = new RunDriver(w.gmp, batchId, { supervisor1: await w.gmp.asPersona('supervisor1') });
}, 600_000);

afterAll(async () => {
  await w?.close();
});

const deviations = async (): Promise<{ ref: string; title: string; links: number }[]> =>
  (
    await w.gmp.db.admin.query<{ ref: string; title: string; links: number }>(
      `select d.ref, d.title, (select count(*)::int from site.deviation_link l where l.deviation_id = d.id and l.subject_kind = 'BATCH' and l.subject_id = $1) as links
         from site.deviation d order by d.ref_serial`,
      [batchId],
    )
  ).rows;

async function openException(description: string): Promise<string> {
  await d.ok('supervisor1', { type: 'RAISE_EXCEPTION', description, severity: 'ACTION' });
  const run = await d.runView('supervisor1');
  const e = run.exceptions.find((x) => x.title.includes(description));
  if (!e) throw new Error('SETUP: the exception was not raised');
  return e.exceptionId;
}

describe('a deviation raised from a batch exception (owner retest item 8)', () => {
  it('[PR-49][PR-08] one command raises the deviation, links it to the batch and attaches it to the exception', async () => {
    const exception = await openException('Label roll swapped before use');
    const before = (await deviations()).length;
    await d.ok('supervisor1', { type: 'ATTACH_DEVIATION', exception, raise: { classification: 'MAJOR', riskRationale: 'Labels of another strength reached the line' } });
    const after = await deviations();
    expect(after).toHaveLength(before + 1);
    const raised = after.at(-1);
    expect(raised?.links).toBe(1);
    expect(raised?.title).toMatch(/^Batch [A-Z0-9]+: .*Label roll swapped before use/);
    const run = await d.runView('supervisor1');
    expect(run.exceptions.find((x) => x.exceptionId === exception)?.deviationRef).toBe(raised?.ref);
  });

  it('[PR-49][DI-34] an attachment the engine refuses raises nothing: the refusal is recorded and no deviation is left behind', async () => {
    const before = await deviations();
    const r = await d.command('supervisor1', { type: 'ATTACH_DEVIATION', exception: 'X-NO-SUCH', raise: { classification: 'MINOR', riskRationale: 'No exception of that id exists here' } });
    expect(r.ok).toBe(false);
    expect(refusalOf(r)?.code).toMatch(/^ENG-/);
    expect(await deviations()).toEqual(before);
  });

  it('[PR-49][DI-34] when the attachment cannot be recorded, the raise is rolled back with it: no deviation is left raised and unattached', async () => {
    const exception = await openException('Torn label found at the line');
    const before = await deviations();
    const versionBefore = await d.version('supervisor1');
    // Test arrangement: the database refuses the accepted attachment row (as any of its checks would, EBMR-EXE-600 among them).
    await w.gmp.db.admin.query(`create function public.test_refuse_attach() returns trigger language plpgsql as $$
      begin if new.command_type = 'ATTACH_DEVIATION' and new.accepted then raise exception 'test: the attachment row is refused'; end if; return new; end $$`);
    await w.gmp.db.admin.query('create trigger test_refuse_attach before insert on recipe.execution_command for each row execute function public.test_refuse_attach()');
    try {
      const r = await d.command('supervisor1', { type: 'ATTACH_DEVIATION', exception, raise: { classification: 'MINOR', riskRationale: 'Torn label, no mix-up seen' } });
      expect(r.ok).toBe(false);
    } finally {
      await w.gmp.db.admin.query('drop trigger test_refuse_attach on recipe.execution_command');
      await w.gmp.db.admin.query('drop function public.test_refuse_attach()');
    }
    expect(await deviations()).toEqual(before);
    expect((await d.runView('supervisor1')).exceptions.find((x) => x.exceptionId === exception)?.deviationRef).toBeNull();
    expect(await d.version('supervisor1')).toBe(versionBefore);
  });

  it('[PR-49] a reference and a raise together, or neither, is refused before anything is recorded', async () => {
    const exception = await openException('Label count short by two');
    const both = await d.command('supervisor1', { type: 'ATTACH_DEVIATION', exception, deviationRef: 'DEV-SITE-1-2026-00001', raise: { classification: 'MINOR', riskRationale: 'Two labels short at count' } });
    expect(refusalOf(both)?.code).toBe('EBMR-API-DEVIATION-REF');
    const neither = await d.command('supervisor1', { type: 'ATTACH_DEVIATION', exception });
    expect(refusalOf(neither)?.code).toBe('EBMR-API-DEVIATION-REF');
  });

  it('[PR-49] the batch lists its open deviations, so one raised earlier and never attached is attached by its number instead of raising another', async () => {
    const exception = await openException('Label roll from an unreleased lot');
    const qaInv = await w.gmp.asPersona('qaInvestigator');
    const orphan = valueOf(await qaInv.call(routes.quality.raiseDeviation, { body: { kind: 'DEVIATION', title: 'Raised, never attached', classification: 'MINOR', riskRationale: 'Raised and then the screen closed' } }));
    valueOf(await qaInv.call(routes.quality.linkDeviation, { params: { deviationId: orphan.deviationId }, body: { subjectKind: 'BATCH', subjectId: batchId } }));
    const listed = valueOf(await qaInv.call(routes.quality.deviations, { query: { batchId, kind: 'DEVIATION' } }));
    expect(listed.deviations.map((x) => x.ref)).toContain(orphan.ref);
    await d.ok('supervisor1', { type: 'ATTACH_DEVIATION', exception, deviationRef: orphan.ref });
    expect((await d.runView('supervisor1')).exceptions.find((x) => x.exceptionId === exception)?.deviationRef).toBe(orphan.ref);
  });
});

describe('GMP values in exception and deviation titles (owner retest item 8)', () => {
  it('[PR-08] a value the engine wrote in full is shown at the precision it was compared at; other titles are unchanged', () => {
    const demo = 'Yield of the blend 95.42203147353361945636623748211731 % (compared as 95.4) is outside its validated limit (validated low limit): this step and the steps after it wait until a deviation is linked';
    expect(exceptionTitleAtPrecision(demo)).toBe('Yield of the blend 95.4 % is outside its validated limit (validated low limit): this step and the steps after it wait until a deviation is linked');
    expect(exceptionTitleAtPrecision('Assay 99.1 % is outside its validated limit (validated high limit)')).toBe('Assay 99.1 % is outside its validated limit (validated high limit)');
    expect(exceptionTitleAtPrecision('Hardness 12.345678 (compared as 12.3) is outside its internal limit')).toBe('Hardness 12.3 is outside its internal limit');
    expect(exceptionTitleAtPrecision('pH -0.123456 1 (compared as -0.12) low')).toBe('pH -0.12 1 low');
  });
});
