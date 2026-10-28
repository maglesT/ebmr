/**
 * R13 (owner, 25 October 2026: "Can I see the potency calculation before dispensing?"): what each potency-adjusted
 * dispensing step (TB-01) of a batch will calculate for the lots reserved for the batch, before anyone weighs. Each lot
 * is taken alone, with its current approved result (tab.lot_assay_of) and the step's MBR configuration, through the
 * block's own calculation (potencyTargets). A preview only: nothing is recorded, and the weighing step recalculates from
 * the lots it is given (the floor never types a potency or a target; PR-19, DI-33).
 */
import type { BatchPotencyPreviewView } from '@ebmr/api-contract';
import type { z } from 'zod';
import { potencyTargets } from '../../blocks/dispensing/potency.ts';
import { potencyInput, tb01Config } from '../../blocks/tb-01.ts';
import { bomMaterialName } from './potency-view.ts';
import { resolveLot } from './lots.ts';
import { runContext, type Db } from './runs.ts';
import { engine } from '@ebmr/recipe-core';

type View = z.infer<typeof BatchPotencyPreviewView>;
type Json = Record<string, unknown>;

/** The preview of batch `batchId`; `extraLot` is a lot not reserved yet (the lot being reserved), shown as well. */
export async function potencyPreview(db: Db, batchId: string, extraLot?: string): Promise<View> {
  const run = await runContext(db, batchId);
  const def = run.def;
  const numbering = engine.numberingOf(def);
  const steps: View['steps'] = [];
  for (const [stepId, stepDef] of def.steps) {
    const node = stepDef.node;
    if (node.kind !== 'phase' || node.block.type !== 'TB-01') continue;
    let c;
    try {
      c = tb01Config(stepDef.config);
    } catch {
      continue;
    }
    const line = def.mbr.bom.find((b) => b.id === c.active.bomLine);
    const ref = line ? def.mbr.references.find((r) => r.id === line.material) : undefined;
    const materialCode = ref?.code ?? line?.material ?? '';
    const reserved = run.batch.installation === 'GMP'
      ? (
          await db.query<{ code: string }>(
            `select distinct l.lot_code as code from site.lot_reservation r join site.material_lot l on l.id = r.lot_id
              where r.batch_id = $1 and l.material_code = $2 and r.expires_at > clock_timestamp()
                and not exists (select 1 from site.lot_reservation_revocation x where x.reservation_id = r.id) order by 1`,
            [batchId, materialCode],
          )
        ).rows.map((x) => x.code)
      : [];
    const codes = [...new Set([...reserved, ...(extraLot ? [extraLot] : [])])];
    const lots: View['steps'][number]['lots'] = [];
    for (const code of codes) {
      const facts = await resolveLot(db, code, batchId);
      if (!facts || facts.materialCode !== materialCode) continue;
      const assay = (await db.query<{ a: Json | null }>('select tab.lot_assay_of($1, $2::uuid) as a', [code, batchId])).rows[0]?.a ?? null;
      const base = { lotCode: code, reserved: reserved.includes(code), status: facts.status };
      if (!assay) {
        lots.push({ ...base, assay: null, asIs: null, activeTarget: null, excipientTarget: null, total: null, problem: 'No approved assay result: QC records one before the lot can be calculated.' });
        continue;
      }
      const values = { assay: typeof assay['assay'] === 'string' ? assay['assay'] : '', water: typeof assay['water'] === 'string' ? assay['water'] : null, basis: typeof assay['basis'] === 'string' ? assay['basis'] : '' };
      if (values.basis !== c.active.basis) {
        lots.push({ ...base, assay: values.assay, asIs: null, activeTarget: null, excipientTarget: null, total: null, problem: `The result is on the ${values.basis.toLowerCase().replace(/_/g, ' ')} basis; the MBR calculates on ${c.active.basis.toLowerCase().replace(/_/g, ' ')}.` });
        continue;
      }
      const r = potencyTargets(potencyInput(c, def.mbr, [{ assay }]));
      if (!r.ok) {
        lots.push({ ...base, assay: values.assay, asIs: null, activeTarget: null, excipientTarget: null, total: null, problem: r.message });
        continue;
      }
      lots.push({
        ...base,
        assay: values.assay,
        asIs: r.result.lots[0]?.asIsAssay ?? null,
        activeTarget: r.result.lots[0]?.target ?? null,
        excipientTarget: r.result.excipient?.target ?? null,
        total: r.result.total.target,
        problem: facts.status === 'RELEASED' ? null : `The lot is ${facts.status.toLowerCase()}: only a released lot can be dispensed.`,
      });
    }
    const exc = c.excipient ? def.mbr.bom.find((b) => b.id === c.excipient?.bomLine) : undefined;
    steps.push({
      stepId,
      number: numbering.byId.get(stepId)?.number ?? '',
      title: node.name,
      active: { bomLine: c.active.bomLine, material: bomMaterialName(def.mbr, c.active.bomLine), standard: line?.quantity.value ?? '', unit: line?.quantity.unit ?? '' },
      excipient: c.excipient && exc ? { bomLine: c.excipient.bomLine, material: bomMaterialName(def.mbr, c.excipient.bomLine), standard: exc.quantity.value, unit: exc.quantity.unit } : null,
      lots,
    });
  }
  return { batchId, batchNumber: run.batch.batchNumber, note: 'Preview: the weighing step recalculates from the lots it is given; nothing here is recorded.', steps };
}
