/**
 * The sources a TB-08 or G-24@2 addition of a GMP batch's step may take (Phase 3 slice 6; backlog 5b): closed output
 * containers of the batch's product and strength, neither charged nor merged, with the facts the database reads for each
 * (recipe.source_container_facts: case, remaining, expiry) and the signed reprocessing authorisation that covers the step
 * or the container's use. Read-only: the addition entry names a container, and the server fills its facts again at the
 * moment of use; the database's guards decide (recipe-core 0622, tablets 1021).
 */
import type pg from 'pg';
import type { AdditionSourceView } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';

interface Row {
  id: string;
  label_code: string;
  batch_number: string;
  product_code: string;
  stage: string;
  unit: string;
  facts: Record<string, unknown> | null;
  reserved_us: string | null;
  authorisation_id: string | null;
}

export async function additionSources(app: AppContext, db: pg.Pool, batchId: string, stepId: string, product: { code: string; strength: string }): Promise<AdditionSourceView[]> {
  const { rows } = await db.query<Row>(
    `select o.id, o.label_code, o.batch_number, o.product_code, o.stage, o.quantity_unit as unit,
            recipe.source_container_facts(o.id, $1) as facts,
            (extract(epoch from rr.reserved_at) * 1000000)::numeric(20, 0)::text as reserved_us,
            (select a.id from recipe.reprocessing_authorisation a join recipe.reprocessing_authorisation_signature s on s.authorisation_id = a.id
              where a.batch_id = $1 and a.step_id = $2 and (a.scope = 'STEP' or a.container_id = o.id)
              order by a.proposed_at desc limit 1) as authorisation_id
       from plant.output_container o
       join plant.container_close x on x.container_id = o.id
       left join recipe.residue_reservation rr on rr.container_id = o.id
      where o.batch_id <> $1 and o.product_code = $3 and o.strength = $4
        and not exists (select 1 from plant.container_charge c where c.container_id = o.id)
        and not exists (select 1 from plant.container_merge m where m.source_id = o.id)
      order by x.closed_at, o.id limit 200`,
    [batchId, stepId, product.code, product.strength],
  );
  return rows.map((r) => {
    const f = r.facts ?? {};
    const expiry = typeof f['expiry'] === 'string' ? f['expiry'] : null;
    const remaining = typeof f['remaining'] === 'string' ? f['remaining'] : '0';
    const problem =
      f['case'] === undefined
        ? 'Neither reserved residue nor material released by QA: it is no source for an addition (PR-47).'
        : remaining === '0'
          ? 'Nothing is left in the container.'
          : r.authorisation_id === null && f['case'] === 'REPROCESSING_ADDITION'
            ? 'No signed reprocessing authorisation covers this step or this container (PR-47).'
            : null;
    return {
      containerId: r.id,
      label: r.label_code,
      sourceBatchNumber: r.batch_number,
      product: r.product_code,
      intermediate: r.stage,
      remaining,
      unit: r.unit,
      sourceExpiry: expiry ? app.formatInstant((BigInt(Date.parse(`${expiry}-01T00:00:00Z`)) * 1000n).toString()) : null,
      reservedAt: r.reserved_us ? app.formatInstant(r.reserved_us) : null,
      authorisationId: r.authorisation_id,
      problem,
    };
  });
}
