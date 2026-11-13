/**
 * Owner retest of 13 November 2026, item 8: a deviation raised from a batch exception is raised, linked to the batch and
 * attached to the exception in one command (one transaction, one badge tap). Before, the screen raised it, linked it to
 * the batch and then sent ATTACH_DEVIATION as three requests; an interruption between them left a deviation linked to
 * nothing of the exception (DEV-SITE-1-2026-00004 on the demo).
 *
 * The deviation is raised only when the engine accepts the attachment (the same command with a placeholder reference, run
 * on a copy of the state, as TB-01 does for consumption): a refused attachment is recorded as refused and raises nothing.
 * Every later failure (the database's checks of the accepted row, EBMR-EXE-600 included) rolls the raise back with it.
 *
 * Its title carries GMP values at the precision they were judged at (exceptionTitleAtPrecision), never an unrounded
 * quotient of exact decimals.
 */
import { engine } from '@ebmr/recipe-core';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { dbNowUs } from '../../platform/db/commands.ts';
import { batchDeviationInDeviations } from '../../platform/deviations.ts';

/** The reference a refused attachment records: nothing was raised for it. */
export const NOT_RAISED = 'not raised';

/**
 * An exception title as people read it: a value the engine wrote in full beside the rounded value it compared ("95.42203…
 * % (compared as 95.4)") is shown as the compared value, at the precision of the limits it was judged against. Display
 * and deviation titles only: the stored exception and its evaluation keep the exact value.
 */
export function exceptionTitleAtPrecision(title: string): string {
  return title.replace(/(-?[0-9]+(?:\.[0-9]+)?)( [^\s(]+)? \(compared as (-?[0-9]+(?:\.[0-9]+)?)\)/g, (_m, _raw: string, unit: string | undefined, rounded: string) => `${rounded}${unit ?? ''}`);
}

interface RaiseContext {
  client: pg.PoolClient;
  app: AppContext;
  def: engine.BatchDefinition;
  state: engine.BatchState;
  actor: engine.Actor;
  commandId: string;
  expectedVersion: number;
}

export interface DeviationToRaise {
  classification: 'MINOR' | 'MAJOR' | 'CRITICAL';
  riskRationale: string;
}

/**
 * The reference of a deviation raised for exception `exceptionId` and linked to the batch, in the command's transaction;
 * NOT_RAISED when the engine would refuse the attachment (the command is then recorded as refused, with nothing raised).
 */
export async function raiseForException(ctx: RaiseContext, exceptionId: string, raise: DeviationToRaise): Promise<string> {
  if (ctx.app.platform?.deviations) throw batchDeviationInDeviations();
  const dry: engine.Command = { type: 'ATTACH_DEVIATION', commandId: ctx.commandId, actor: ctx.actor, expectedVersion: ctx.expectedVersion, exception: exceptionId, deviationRef: 'dry run' };
  if (!engine.step(ctx.def, ctx.state, dry, { nowUs: await dbNowUs(ctx.client) }).accepted) return NOT_RAISED;
  const e = ctx.state.exceptions[exceptionId];
  let title = exceptionTitleAtPrecision(e?.title ?? exceptionId);
  if (e?.raisedBy && title.includes(e.raisedBy)) {
    const { rows } = await ctx.client.query<{ n: string | null }>('select (select p.legal_name from iam.person p where p.id::text = $1) as n', [e.raisedBy]);
    const name = rows[0]?.n;
    if (name) title = title.split(e.raisedBy).join(name);
  }
  const full = `Batch ${ctx.state.header.batchNumber}: ${title}`;
  const { rows } = await ctx.client.query<{ r: { deviationId: string; ref: string } }>('select site.raise_deviation($1::jsonb) as r', [
    JSON.stringify({ kind: 'DEVIATION', title: full.length > 200 ? `${full.slice(0, 199)}…` : full, classification: raise.classification, riskRationale: raise.riskRationale }),
  ]);
  const raised = rows[0]?.r;
  if (!raised) throw new Error('site.raise_deviation returned nothing');
  await ctx.client.query('select site.link_deviation($1::uuid, $2, $3::uuid)', [raised.deviationId, 'BATCH', ctx.state.header.batchId]);
  return raised.ref;
}
