/**
 * What the server resolves for a TB-01 step (potency-adjusted dispensing; Phase 3 slice 3b): the facts the browser must
 * not supply, read inside the command's transaction.
 *  - POTENCY_CALCULATION: each lot by code from this installation's lot register (tablets 0801), with its current
 *    approved assay result (tab.lot_assay_of, tablets 0841): a typed value is impossible, a missing one blocks
 *    (EBMR-EXE-243; PR-19).
 *  - CONTAINER_WEIGHING: the first-expiring usable lot of the material (tab.tb01_first_expiring, tablets 0843): another
 *    lot, not yet dispensed at the step for the line, needs the dispenser's reason, and a reason is refused for the
 *    first-expiring lot (EBMR-EXE-244; PR-18). On GMP, once the engine is known to accept the entry, the dispensed net
 *    is consumed from the batch's open reservation of the lot through recipe.consume_lot (recipe-core 0430; genealogy
 *    INV-13, INV-14) and the entry names the consumption (EBMR-EXE-245 when there is no reservation with enough left).
 * The database checks every one of these again in the row's own transaction (tablets 0843, EBMR-EXE-240).
 */
import { blocks, engine, type flow } from '@ebmr/recipe-core';
import type pg from 'pg';
import { dbNowUs } from '../../platform/db/commands.ts';
import { refusal } from '../../platform/http/refusal.ts';
import type { AppContext } from '../../platform/context.ts';

type JsonRecord = Record<string, unknown>;

/** What these resolutions read of intents.ts's IntentContext (structurally the same members). */
interface IntentContext {
  client: pg.PoolClient;
  app: AppContext;
  def: engine.BatchDefinition;
  state: engine.BatchState;
  actor: engine.Actor;
  commandId: string;
  expectedVersion: number;
}
import { lotForEngine, resolveLot, type LotFacts } from './lots.ts';

function refuse(code: string, whatHappened: string, why: string, controls: string[], whatYouCanDo: string[]): Error {
  return refusal(422, { code, kind: code === 'EBMR-EXE-244' ? 'INVALID_INPUT' : 'NOT_ALLOWED', whatHappened, why, controls, whatYouCanDo, whoCanHelp: ['The shift supervisor'] });
}

/** The lots of a calculation with their facts and approved results, as the block takes them. */
export async function tb01Lots(
  client: pg.PoolClient,
  batchId: string,
  lots: readonly { lotCode: string; baseEquivalent?: string | undefined }[],
  installation: 'GMP' | 'SANDBOX',
): Promise<{ entry: JsonRecord[] }> {
  const entry: JsonRecord[] = [];
  for (const l of lots) {
    const facts = await resolveLot(client, l.lotCode, batchId);
    if (!facts) {
      throw refuse(
        'EBMR-EXE-072',
        `Lot ${l.lotCode.slice(0, 64)} is not known on this installation. Nothing was saved.`,
        installation === 'SANDBOX' ? 'Only registered TEST- lots are calculated in a test run (PR-18).' : "Only material lots of this site's lot register are calculated in a GMP batch (PR-18).",
        ['PR-18', 'DI-05'],
        ['Scan the lot label again, or ask for the lot to be registered.'],
      );
    }
    const { rows } = await client.query<{ a: JsonRecord | null }>('select tab.lot_assay_of($1, $2::uuid) as a', [l.lotCode, batchId]);
    const assay = rows[0]?.a;
    if (!assay) {
      throw refuse(
        'EBMR-EXE-243',
        `Lot ${l.lotCode.slice(0, 64)} has no approved assay result, so its target cannot be calculated. Nothing was saved.`,
        'The potency calculation takes the assay of each lot from its approved result; a typed value is impossible and a missing one blocks the calculation (PR-19).',
        ['PR-19'],
        ['Choose a lot with an approved result, or ask QC to record the result of this lot.'],
      );
    }
    entry.push({ lot: lotForEngine(facts), assay, ...(l.baseEquivalent !== undefined ? { baseEquivalent: l.baseEquivalent } : {}) });
  }
  return { entry };
}

/** The lots already dispensed for `bomLine` at the step instance. */
function usedLots(ctx: IntentContext, target: { step: string; context: flow.Frame[] }, bomLine: string): string[] {
  const key = engine.stepKey(target.step, target.context);
  return [
    ...new Set(
      Object.values(ctx.state.entries)
        .filter((e) => e.stepKey === key && e.kind === 'CONTAINER_WEIGHING' && e.data['bomLine'] === bomLine)
        .map((e) => String((e.data['lot'] as JsonRecord | undefined)?.['id'])),
    ),
  ];
}

/** PR-18: another lot than the first-expiring usable one needs a reason, and only it. */
export async function tb01FefoCheck(ctx: IntentContext, target: { step: string; context: flow.Frame[] }, bomLine: string, lot: LotFacts, reason: string | undefined): Promise<void> {
  const used = usedLots(ctx, target, bomLine);
  const { rows } = await ctx.client.query<{ f: string | null }>('select tab.tb01_first_expiring($1::uuid, $2, $3::text[], clock_timestamp()) as f', [ctx.state.header.batchId, lot.materialCode, used]);
  const first = rows[0]?.f ?? null;
  const needed = lot.lotCode !== first && !used.includes(lot.lotCode);
  if (needed && (reason === undefined || reason.trim() === '')) {
    throw refuse(
      'EBMR-EXE-244',
      `Lot ${first ?? '(none usable)'} expires before lot ${lot.lotCode.slice(0, 64)}. Nothing was saved.`,
      `The first-expiring usable lot of ${lot.materialCode} is ${first ?? 'none'}; dispensing another lot needs your reason, which goes to the stock-rotation report (PR-18).`,
      ['PR-18'],
      [`Dispense from lot ${first ?? 'the first-expiring lot'}, or give your reason for lot ${lot.lotCode.slice(0, 64)}.`],
    );
  }
  if (!needed && reason !== undefined) {
    throw refuse(
      'EBMR-EXE-244',
      `Lot ${lot.lotCode.slice(0, 64)} is the first-expiring usable lot (or one already dispensed here), so no reason is recorded for it. Nothing was saved.`,
      'A stock-rotation reason is recorded only for a lot other than the first-expiring usable one (PR-18).',
      ['PR-18'],
      ['Leave the reason empty.'],
    );
  }
}

const PLACEHOLDER = '00000000-0000-4000-8000-000000000000';

/**
 * INV-13, INV-14 (GMP): consumes the entry's net from the batch's open reservation of the lot, once the engine is known
 * to accept the entry as it will be sent (the same command with a placeholder consumption id, run on a copy of the
 * state): an entry the engine refuses is recorded as refused and consumes nothing.
 */
export async function tb01Consumption(
  ctx: IntentContext,
  target: { step: string; context: flow.Frame[] },
  entry: JsonRecord & { kind: string },
  lot: LotFacts,
): Promise<{ id: string } | undefined> {
  const dry: engine.Command = { type: 'RECORD_ENTRY', commandId: ctx.commandId, actor: ctx.actor, expectedVersion: ctx.expectedVersion, step: target.step, context: target.context, entry: { ...entry, consumption: PLACEHOLDER } };
  const r = engine.step(ctx.def, ctx.state, dry, { nowUs: await dbNowUs(ctx.client) });
  if (!r.accepted) return undefined;
  const net = blocks.netOf(String(entry['gross']), String(entry['tare']));
  if (!net.ok) return undefined;
  const batchId = ctx.state.header.batchId;
  const { rows } = await ctx.client.query<{ r: JsonRecord | null }>('select tab.tb01_reservation_for($1::uuid, $2, $3::numeric, $4) as r', [batchId, lot.lotCode, net.net, String(entry['unit'])]);
  const reservation = rows[0]?.r;
  if (!reservation) {
    throw refuse(
      'EBMR-EXE-245',
      `Lot ${lot.lotCode.slice(0, 64)} has no reservation for this batch with ${net.net} ${String(entry['unit'])} left. Nothing was saved.`,
      'On GMP every dispensed container is consumed from the batch\'s reservation of the lot in the same command, so the lot\'s stock and its genealogy follow the record (INV-13, INV-14).',
      ['INV-13', 'INV-14'],
      ['Ask stores to reserve the lot for this batch, then weigh again.'],
    );
  }
  const { rows: used } = await ctx.client.query<{ r: JsonRecord }>('select recipe.consume_lot($1::uuid, $2::uuid, $3, $4::numeric, $5) as r', [
    batchId,
    reservation['reservationId'],
    reservation['materialCode'],
    reservation['quantity'],
    reservation['unit'],
  ]);
  const id = String(used[0]?.r['consumption_id']);
  return { id };
}
