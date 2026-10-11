/**
 * Reads of the reprocessing registers for the quality screens (Phase 3 slice 6): whole-batch reprocessing requests,
 * reprocessing authorisations and the closed containers the quality unit may reserve as reusable residue (recipe-core
 * 0621, 0624). Read-only; the signed acts on them are the REPROCESSING_ACT signable action.
 */
import type { PersonRef, ReprocessingAuthorisationView, ReprocessingRequestView, ResidueContainerView } from '@ebmr/api-contract';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';

type Db = Pick<pg.Pool, 'query'>;

/** A person as the record names them (the role they acted in is the act's, shown as the act's title elsewhere). */
const person = (id: string, legal: string | null, login: string | null, role: string): PersonRef => ({ personId: id, legalName: legal ?? 'unknown person', loginName: login ?? 'unknown', role });

const PERSON = (alias: string, col: string) =>
  `(select ip.legal_name from iam.person ip where ip.id = ${alias}.${col}) as ${col}_legal, (select ia.login_name from iam.account ia where ia.person_id = ${alias}.${col} order by ia.login_name limit 1) as ${col}_login`;

export async function reprocessingRequests(app: AppContext, db: Db): Promise<ReprocessingRequestView[]> {
  const { rows } = await db.query<Record<string, string | null> & { parents: { batchId: string; batchNumber: string }[] }>(
    `select r.id, r.family_id, f.code as family_code, r.site_code, r.investigation_ref, r.risk_evaluation_id,
            r.proposed_by_person, ${PERSON('r', 'proposed_by_person')}, (extract(epoch from r.proposed_at) * 1000000)::numeric(20, 0)::text as proposed_us,
            s.signer_person, ${PERSON('s', 'signer_person')}, (extract(epoch from s.recorded_at) * 1000000)::numeric(20, 0)::text as signed_us,
            coalesce((select jsonb_agg(jsonb_build_object('batchId', b.id, 'batchNumber', b.batch_number) order by u.ord)
                        from unnest(r.parent_batch_ids) with ordinality u(id, ord) join recipe.batch_execution b on b.id = u.id), '[]'::jsonb) as parents
       from recipe.reprocessing_request r
       left join recipe.mbr_family f on f.id = r.family_id
       left join recipe.reprocessing_request_signature s on s.request_id = r.id
      order by r.proposed_at desc, r.id limit 500`,
  );
  return rows.map((r) => ({
    requestId: r['id'] ?? '',
    familyId: r['family_id'] ?? '',
    familyCode: r['family_code'] ?? null,
    siteCode: r['site_code'] ?? '',
    parents: r.parents,
    investigationRef: r['investigation_ref'] ?? '',
    riskEvaluationId: r['risk_evaluation_id'] ?? '',
    proposedBy: person(r['proposed_by_person'] ?? '', r['proposed_by_person_legal'] ?? null, r['proposed_by_person_login'] ?? null, 'PROPOSER'),
    proposedAt: app.formatInstant(r['proposed_us'] ?? '0'),
    authorisedBy: r['signer_person'] ? person(r['signer_person'], r['signer_person_legal'] ?? null, r['signer_person_login'] ?? null, 'AUTHORISER') : null,
    authorisedAt: r['signed_us'] ? app.formatInstant(r['signed_us']) : null,
  }));
}

export async function reprocessingAuthorisations(app: AppContext, db: Db, batchId?: string): Promise<ReprocessingAuthorisationView[]> {
  const { rows } = await db.query<Record<string, string | null>>(
    `select a.id, a.batch_id, b.batch_number, a.step_id, a.scope, a.container_id, a.case_code, a.investigation_ref, a.risk_evaluation_ref,
            a.proposed_by_person, ${PERSON('a', 'proposed_by_person')}, (extract(epoch from a.proposed_at) * 1000000)::numeric(20, 0)::text as proposed_us,
            s.signer_person, ${PERSON('s', 'signer_person')}, (extract(epoch from s.recorded_at) * 1000000)::numeric(20, 0)::text as signed_us
       from recipe.reprocessing_authorisation a
       join recipe.batch_execution b on b.id = a.batch_id
       left join recipe.reprocessing_authorisation_signature s on s.authorisation_id = a.id
      where ($1::uuid is null or a.batch_id = $1)
      order by a.proposed_at desc, a.id limit 500`,
    [batchId ?? null],
  );
  return rows.map((r) => ({
    authorisationId: r['id'] ?? '',
    batchId: r['batch_id'] ?? '',
    batchNumber: r['batch_number'] ?? '',
    stepId: r['step_id'] ?? '',
    scope: r['scope'] === 'USE' ? 'USE' : 'STEP',
    containerId: r['container_id'] ?? null,
    caseCode: (r['case_code'] ?? 'RECOVERY') as ReprocessingAuthorisationView['caseCode'],
    investigationRef: r['investigation_ref'] ?? '',
    riskEvaluationRef: r['risk_evaluation_ref'] ?? '',
    proposedBy: person(r['proposed_by_person'] ?? '', r['proposed_by_person_legal'] ?? null, r['proposed_by_person_login'] ?? null, 'PROPOSER'),
    proposedAt: app.formatInstant(r['proposed_us'] ?? '0'),
    authorisedBy: r['signer_person'] ? person(r['signer_person'], r['signer_person_legal'] ?? null, r['signer_person_login'] ?? null, 'AUTHORISER') : null,
    authorisedAt: r['signed_us'] ? app.formatInstant(r['signed_us']) : null,
  }));
}

/** Closed output containers neither charged nor merged (the candidates for a residue reservation, or reserved already). */
export async function residueContainers(app: AppContext, db: Db, product?: string): Promise<ResidueContainerView[]> {
  const { rows } = await db.query<Record<string, string | null>>(
    `select o.id, o.label_code, o.batch_id, o.batch_number, o.product_code, o.strength, o.stage, trim_scale(x.net_quantity)::text as net,
            trim_scale(recipe.container_remaining(o.id))::text as remaining, o.quantity_unit, plant.container_state(o.id) as state,
            (extract(epoch from x.closed_at) * 1000000)::numeric(20, 0)::text as closed_us, (extract(epoch from rr.reserved_at) * 1000000)::numeric(20, 0)::text as reserved_us
       from plant.output_container o
       join plant.container_close x on x.container_id = o.id
       left join recipe.residue_reservation rr on rr.container_id = o.id
      where ($1::text is null or o.product_code = $1)
        and not exists (select 1 from plant.container_charge c where c.container_id = o.id)
        and not exists (select 1 from plant.container_merge m where m.source_id = o.id)
      order by x.closed_at desc, o.id limit 500`,
    [product ?? null],
  );
  return rows.map((r) => ({
    containerId: r['id'] ?? '',
    label: r['label_code'] ?? '',
    batchId: r['batch_id'] ?? '',
    batchNumber: r['batch_number'] ?? '',
    product: r['product_code'] ?? '',
    strength: r['strength'] ?? '',
    stage: r['stage'] ?? '',
    net: r['net'] ?? '0',
    remaining: r['remaining'] ?? '0',
    unit: r['quantity_unit'] ?? '',
    state: r['state'] ?? '',
    closedAt: app.formatInstant(r['closed_us'] ?? '0'),
    reservedAt: r['reserved_us'] ? app.formatInstant(r['reserved_us']) : null,
  }));
}
