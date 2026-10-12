/**
 * Feature `india` (Phase 4 slice 6a, GMP; contract ns/india.ts): manufacturing and loan licences, export permissions, the
 * issue check, the allocation register, the India-domestic label particulars and the Schedule H2 payload stub, the
 * stability basis of a shelf life and hazard classes. Each route runs the person's own command through the site-services
 * and recipe-core definers (site services 0885, 0886; recipe-core 0890 to 0895); every rule is the database's. The
 * signed acts are INDIA_ACT (LICENCE_APPROVED, EXPORT_PERMISSION_APPROVED by QA, never the recorder).
 *
 * The demo seed gives the demo products (PCM500 and GB-T-01's product) the licence and export permissions their demo
 * batches are issued under, recorded by the regulatory signer and approved by QA with real signatures (D-6-1, D-6-2).
 */
import {
  routes,
  type AllocationEntryView,
  type ExportPermissionView,
  type HazardView,
  type IndiaLabelView,
  type LicenceView,
  type ShelfLifeBasisView,
  type SignableAction,
} from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import type { SignableActionHandler, SignableActionRegistry } from '../../platform/ports.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';
import { dbActHandler } from '../esig/db-acts.ts';
import type { FeatureSeedContext } from '../types.ts';

type Db = Pick<pg.Pool, 'query'>;
type IndiaAct = Extract<SignableAction, { kind: 'INDIA_ACT' }>;

const notFound = (what: string) =>
  refusal(404, { code: 'EBMR-API-NOT-FOUND', kind: 'STALE', whatHappened: `The ${what} was not found.`, why: `No such ${what}.`, whatYouCanDo: ['Reload the list.'] });

// ---------------------------------------------------------------------------------------------
// Reads

interface SuspensionRow {
  reason: string;
  by: string;
  us: string;
}

interface LicenceRow {
  id: string;
  site_code: string;
  licence_kind: LicenceView['licenceKind'];
  form: LicenceView['form'];
  licence_number: string;
  holder_name: string;
  holder_address: string;
  host_licence_id: string | null;
  host_number: string | null;
  technical_agreement_ref: string | null;
  from_us: string;
  until_us: string | null;
  products: LicenceView['products'];
  state: LicenceView['state'];
  current: boolean;
  recorded_by: string;
  recorded_us: string;
  approved_by: string | null;
  approved_us: string | null;
  suspension: SuspensionRow | null;
}

async function licences(app: AppContext, db: Db, id?: string): Promise<LicenceView[]> {
  const { rows } = await db.query<LicenceRow>(
    `select l.id, l.site_code, l.licence_kind, l.form, l.licence_number, l.holder_name, l.holder_address, l.host_licence_id, h.licence_number as host_number,
            l.technical_agreement_ref, ${usOf('l.valid_from')} as from_us, case when l.valid_until is null then null else ${usOf('l.valid_until')} end as until_us,
            (select coalesce(jsonb_agg(jsonb_build_object('productCode', p.product_code, 'strength', p.strength) order by p.product_code, p.strength), '[]'::jsonb)
               from site.licence_product p where p.licence_id = l.id) as products,
            site.licence_state(l.id) as state, site.licence_current(l.id, clock_timestamp()) as current,
            l.recorded_by_person as recorded_by, ${usOf('l.recorded_at')} as recorded_us,
            a.approved_by_person as approved_by, case when a.approved_at is null then null else ${usOf('a.approved_at')} end as approved_us,
            (select jsonb_build_object('reason', s.reason_text, 'by', s.suspended_by_person, 'us', ${usOf('s.suspended_at')})
               from site.licence_suspension s where s.licence_id = l.id) as suspension
       from site.manufacturing_licence l
       left join site.manufacturing_licence h on h.id = l.host_licence_id
       left join site.licence_approval a on a.licence_id = l.id
      where ($1::uuid is null or l.id = $1)
      order by l.recorded_at desc, l.id limit 500`,
    [id ?? null],
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.recorded_by, r.approved_by, r.suspension?.by]));
  return rows.map((r) => ({
    licenceId: r.id,
    siteCode: r.site_code,
    licenceKind: r.licence_kind,
    form: r.form,
    licenceNumber: r.licence_number,
    holderName: r.holder_name,
    holderAddress: r.holder_address,
    hostLicenceId: r.host_licence_id,
    hostLicenceNumber: r.host_number,
    technicalAgreement: r.technical_agreement_ref,
    validFrom: app.formatInstant(r.from_us),
    validUntil: r.until_us ? app.formatInstant(r.until_us) : null,
    products: r.products,
    state: r.state,
    current: r.current,
    recordedBy: personRef(people, r.recorded_by, 'RECORDER'),
    recordedAt: app.formatInstant(r.recorded_us),
    approvedBy: r.approved_by ? personRef(people, r.approved_by, 'APPROVER') : null,
    approvedAt: r.approved_us ? app.formatInstant(r.approved_us) : null,
    suspension: r.suspension ? { reason: r.suspension.reason, suspendedBy: personRef(people, r.suspension.by, 'APPROVER'), suspendedAt: app.formatInstant(r.suspension.us) } : null,
  }));
}

interface PermissionRow {
  id: string;
  site_code: string;
  product_code: string;
  strength: string;
  destination: string;
  permission_number: string;
  issuing_authority: string;
  from_us: string;
  until_us: string;
  state: ExportPermissionView['state'];
  current: boolean;
  recorded_by: string;
  recorded_us: string;
  approved_by: string | null;
  approved_us: string | null;
  suspension: SuspensionRow | null;
}

async function permissions(app: AppContext, db: Db, id?: string): Promise<ExportPermissionView[]> {
  const { rows } = await db.query<PermissionRow>(
    `select e.id, e.site_code, e.product_code, e.strength, e.destination, e.permission_number, e.issuing_authority,
            ${usOf('e.valid_from')} as from_us, ${usOf('e.valid_until')} as until_us, site.export_permission_state(e.id) as state,
            site.export_permission_current(e.site_code, e.product_code, e.strength, e.destination, clock_timestamp()) is not distinct from e.id as current,
            e.recorded_by_person as recorded_by, ${usOf('e.recorded_at')} as recorded_us,
            a.approved_by_person as approved_by, case when a.approved_at is null then null else ${usOf('a.approved_at')} end as approved_us,
            (select jsonb_build_object('reason', s.reason_text, 'by', s.suspended_by_person, 'us', ${usOf('s.suspended_at')})
               from site.export_permission_suspension s where s.permission_id = e.id) as suspension
       from site.export_permission e left join site.export_permission_approval a on a.permission_id = e.id
      where ($1::uuid is null or e.id = $1)
      order by e.recorded_at desc, e.id limit 500`,
    [id ?? null],
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.recorded_by, r.approved_by, r.suspension?.by]));
  return rows.map((r) => ({
    permissionId: r.id,
    siteCode: r.site_code,
    productCode: r.product_code,
    strength: r.strength,
    destination: r.destination,
    permissionNumber: r.permission_number,
    issuingAuthority: r.issuing_authority,
    validFrom: app.formatInstant(r.from_us),
    validUntil: app.formatInstant(r.until_us),
    state: r.state,
    current: r.current,
    recordedBy: personRef(people, r.recorded_by, 'RECORDER'),
    recordedAt: app.formatInstant(r.recorded_us),
    approvedBy: r.approved_by ? personRef(people, r.approved_by, 'APPROVER') : null,
    approvedAt: r.approved_us ? app.formatInstant(r.approved_us) : null,
    suspension: r.suspension ? { reason: r.suspension.reason, suspendedBy: personRef(people, r.suspension.by, 'APPROVER'), suspendedAt: app.formatInstant(r.suspension.us) } : null,
  }));
}

async function bases(app: AppContext, db: Db, id?: string): Promise<ShelfLifeBasisView[]> {
  const { rows } = await db.query<{ id: string; product_code: string; strength: string; months: number; ref: string; tentative: boolean; by: string; us: string }>(
    `select s.id, s.product_code, s.strength, s.shelf_life_months as months, s.stability_reference as ref, s.tentative, s.recorded_by_person as by, ${usOf('s.recorded_at')} as us
       from site.shelf_life_stability s where ($1::uuid is null or s.id = $1) order by s.recorded_at desc, s.id limit 500`,
    [id ?? null],
  );
  const people = await peopleOf(db, rows.map((r) => r.by));
  return rows.map((r) => ({
    basisId: r.id, productCode: r.product_code, strength: r.strength, shelfLifeMonths: r.months, stabilityReference: r.ref, tentative: r.tentative,
    recordedBy: personRef(people, r.by, 'RECORDER'), recordedAt: app.formatInstant(r.us),
  }));
}

async function hazards(app: AppContext, db: Db): Promise<HazardView> {
  const p = await db.query<{ product_code: string; hazard_class: HazardView['products'][number]['hazardClass']; ref: string; us: string }>(
    `select h.product_code, h.hazard_class, h.risk_assessment_ref as ref, ${usOf('h.recorded_at')} as us from plant.product_hazard h order by h.recorded_at desc, h.id limit 500`,
  );
  const a = await db.query<{ area_code: string; hazard_class: HazardView['areas'][number]['hazardClass']; dedicated: boolean; breathing_air: 'NOT_USED' | 'BACKED_UP'; justification: string; us: string }>(
    `select d.area_code, d.hazard_class, d.dedicated, d.breathing_air, d.justification, ${usOf('d.recorded_at')} as us from plant.area_dedication d order by d.recorded_at desc, d.id limit 500`,
  );
  return {
    products: p.rows.map((r) => ({ productCode: r.product_code, hazardClass: r.hazard_class, riskAssessmentRef: r.ref, recordedAt: app.formatInstant(r.us) })),
    areas: a.rows.map((r) => ({ areaCode: r.area_code, hazardClass: r.hazard_class, dedicated: r.dedicated, breathingAir: r.breathing_air, justification: r.justification, recordedAt: app.formatInstant(r.us) })),
  };
}

async function label(db: Db, batchId: string): Promise<IndiaLabelView> {
  const exists = await db.query<{ n: number; layout: { version: string; status: string } }>(
    'select (select count(*)::int from recipe.h2_payload_issue i where i.batch_id = $1) as n, recipe.h2_layout() as layout from recipe.batch_execution b where b.id = $1',
    [batchId],
  );
  const e = exists.rows[0];
  if (!e) throw notFound('batch');
  let particulars: IndiaLabelView['particulars'] = null;
  let payload: string | null = null;
  let problem: string | null = null;
  try {
    const { rows } = await db.query<{ p: Record<string, unknown>; h2: string }>('select recipe.india_label_particulars($1) as p, recipe.h2_payload($1) as h2', [batchId]);
    const p = rows[0]?.p ?? {};
    particulars = {
      batchNumber: String(p['batchNumber']), productCode: String(p['productCode']), drugName: String(p['drugName']), strength: String(p['strength']),
      dosageForm: String(p['dosageForm']), manufactureDate: String(p['manufactureDate']), manufactureLabel: String(p['manufactureLabel']),
      expiryDate: String(p['expiryDate']), expiryLabel: String(p['expiryLabel']), shelfLifeMonths: Number(p['shelfLifeMonths']),
      tentativeShelfLife: p['tentativeShelfLife'] === true,
      manufacturer: p['manufacturer'] as NonNullable<IndiaLabelView['particulars']>['manufacturer'],
      loanLicensee: (p['loanLicensee'] ?? null) as NonNullable<IndiaLabelView['particulars']>['loanLicensee'],
    };
    payload = rows[0]?.h2 ?? null;
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err);
  }
  return { batchId, particulars, problem, h2: { layoutVersion: e.layout.version, layoutStatus: e.layout.status, payload, issuedCount: e.n } };
}

// ---------------------------------------------------------------------------------------------
// INDIA_ACT

const ACTS: Readonly<Record<IndiaAct['act'], { aggregateType: string; meaning: string; sql: string }>> = {
  LICENCE_APPROVE: { aggregateType: 'manufacturing_licence', meaning: 'LICENCE_APPROVED', sql: 'select site.approve_manufacturing_licence($1, $2)' },
  EXPORT_PERMISSION_APPROVE: { aggregateType: 'export_permission', meaning: 'EXPORT_PERMISSION_APPROVED', sql: 'select site.approve_export_permission($1, $2)' },
};

export function indiaActHandler(app: AppContext): SignableActionHandler<IndiaAct> {
  return dbActHandler<IndiaAct>(app, {
    kind: 'INDIA_ACT',
    aggregateTypes: ['manufacturing_licence', 'export_permission'],
    target: (a) => ({ aggregateType: ACTS[a.act].aggregateType, aggregateId: a.subjectId, meaning: ACTS[a.act].meaning, expectedState: 'DRAFT' }),
    async apply(client, _ctx, a, signatureId) {
      await client.query(ACTS[a.act].sql, [a.subjectId, signatureId]);
      return { act: a.act, subjectId: a.subjectId };
    },
  });
}

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.installation !== 'GMP') return;
  registry.register(indiaActHandler(app));
}

// ---------------------------------------------------------------------------------------------
// Routes

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  const one = async <T>(list: Promise<T[]>, what: string): Promise<T> => {
    const [v] = await list;
    if (!v) throw notFound(what);
    return v;
  };
  bindRoutes(scope, app, routes.india, {
    licences: async ({ requireSession }) => {
      requireSession();
      return { licences: await licences(app, pool) };
    },
    recordLicence: async ({ body, actor, idempotencyKey, requestHash }) => {
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        const { rows } = await c.query<{ id: string }>('select site.record_manufacturing_licence($1::jsonb) as id', [JSON.stringify(body)]);
        return rows[0]?.id ?? '';
      });
      return one(licences(app, pool, out.result), 'licence');
    },
    suspendLicence: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await c.query('select site.suspend_manufacturing_licence($1, $2)', [params.licenceId, body.reason]);
        return null;
      });
      return one(licences(app, pool, params.licenceId), 'licence');
    },
    exportPermissions: async ({ requireSession }) => {
      requireSession();
      return { permissions: await permissions(app, pool) };
    },
    recordExportPermission: async ({ body, actor, idempotencyKey, requestHash }) => {
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        const { rows } = await c.query<{ id: string }>('select site.record_export_permission($1::jsonb) as id', [JSON.stringify(body)]);
        return rows[0]?.id ?? '';
      });
      return one(permissions(app, pool, out.result), 'export permission');
    },
    suspendExportPermission: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await c.query('select site.suspend_export_permission($1, $2)', [params.permissionId, body.reason]);
        return null;
      });
      return one(permissions(app, pool, params.permissionId), 'export permission');
    },
    check: async ({ query, requireSession }) => {
      const site = requireSession().siteCode;
      const destinations = (query.destinations ?? '').split(',').filter((d) => d !== '' && d !== 'IN');
      const { rows } = await pool.query<{ problem: string | null; basis: { licenceNumber?: string; loanLicenceNumber?: string } | null }>(
        'select site.licence_problem($1, $2, $3, clock_timestamp()) as problem, site.licence_basis($1, $2, $3, clock_timestamp()) as basis',
        [site, query.productCode, query.strength],
      );
      const exportProblems: { destination: string; problem: string | null }[] = [];
      for (const d of destinations) {
        const e = await pool.query<{ p: string | null }>('select site.export_permission_problem($1, $2, $3, $4, clock_timestamp()) as p', [site, query.productCode, query.strength, d]);
        exportProblems.push({ destination: d, problem: e.rows[0]?.p ?? null });
      }
      return {
        siteCode: site, productCode: query.productCode, strength: query.strength, licenceProblem: rows[0]?.problem ?? null,
        licenceNumber: rows[0]?.basis?.licenceNumber ?? null, loanLicenceNumber: rows[0]?.basis?.loanLicenceNumber ?? null, exportProblems,
      };
    },
    allocationRegister: async ({ query, requireSession }) => {
      const site = requireSession().siteCode;
      const { rows } = await pool.query<{ r: AllocationEntryView[] }>('select recipe.allocation_register($1, $2::timestamptz, $3::timestamptz) as r', [site, query.from ?? null, query.to ?? null]);
      return { siteCode: site, entries: rows[0]?.r ?? [] };
    },
    label: async ({ params, requireSession }) => {
      requireSession();
      return label(pool, params.batchId);
    },
    issueH2: async ({ params, actor, idempotencyKey, requestHash }) => {
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        const { rows } = await c.query<{ r: { issueId: string; payload: string; payloadHash: string; layoutVersion: string } }>('select recipe.issue_h2_payload($1) as r', [params.batchId]);
        return rows[0]?.r ?? { issueId: '', payload: '', payloadHash: '', layoutVersion: '' };
      });
      return { ...out.result, batchId: params.batchId };
    },
    verifyH2: async ({ params, body, requireSession }) => {
      requireSession();
      const { rows } = await pool.query<{ p: string | null }>('select recipe.h2_payload_problem($1, $2) as p', [params.batchId, body.payload]);
      return { batchId: params.batchId, problem: rows[0]?.p ?? null };
    },
    shelfLifeBases: async ({ requireSession }) => {
      requireSession();
      return { bases: await bases(app, pool) };
    },
    recordShelfLifeBasis: async ({ body, actor, idempotencyKey, requestHash }) => {
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        const { rows } = await c.query<{ id: string }>('select site.record_shelf_life_basis($1::jsonb) as id', [JSON.stringify(body)]);
        return rows[0]?.id ?? '';
      });
      return one(bases(app, pool, out.result), 'stability basis');
    },
    hazards: async ({ requireSession }) => {
      requireSession();
      return hazards(app, pool);
    },
    recordHazard: async ({ body, actor, idempotencyKey, requestHash }) => {
      if (!body.product && !body.area) {
        throw refusal(422, { code: 'EBMR-IND-037', kind: 'NOT_ALLOWED', whatHappened: 'Nothing was recorded.', why: 'A hazard record names a product classification or an area dedication.', whatYouCanDo: ['Fill in one of them.'] });
      }
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        if (body.product) await c.query('select plant.record_product_hazard($1::jsonb)', [JSON.stringify(body.product)]);
        if (body.area) await c.query('select plant.record_area_dedication($1::jsonb)', [JSON.stringify(body.area)]);
        return null;
      });
      return hazards(app, pool);
    },
  });
  return Promise.resolve();
}

// ---------------------------------------------------------------------------------------------
// Demo seed (DEMO-ONLY; never production)

/** The demo products and their export markets: PCM500 (dc-mini) and GB-T-01's product (D-P4-15: IN, US and EU). */
export const DEMO_LICENSED_PRODUCTS: readonly { productCode: string; strength: string; destinations: readonly string[] }[] = [
  { productCode: 'PCM500', strength: '500 mg', destinations: ['US', 'EU'] },
  { productCode: 'GBT01-250', strength: '250 mg', destinations: ['US', 'EU'] },
];

export async function seed(ctx: FeatureSeedContext): Promise<void> {
  if (ctx.installation !== 'GMP') return;
  const pool = ctx.pools.app;
  const as = async <T>(persona: string, work: (c: pg.PoolClient) => Promise<T>): Promise<T> =>
    withCommand(pool, { ...(await ctx.actorFor(persona)), correlationId: globalThis.crypto.randomUUID() }, work);
  ctx.log('recording the demo manufacturing licence and export permissions (regulatory signer; QA approves, LICENCE_APPROVED, EXPORT_PERMISSION_APPROVED)');
  const licenceId = await as('regulatory', async (c) =>
    (await c.query<{ id: string }>('select site.record_manufacturing_licence($1::jsonb) as id', [JSON.stringify({
      licenceKind: 'MANUFACTURING', form: '25', licenceNumber: 'DEMO/MH/25/0001', holderName: 'Demo Pharma Ltd (DEMO-ONLY)',
      holderAddress: 'Plot 1, Demo Industrial Area, Pune 411019', validFrom: '2020-01-01T00:00:00+05:30',
      products: DEMO_LICENSED_PRODUCTS.map((p) => ({ productCode: p.productCode, strength: p.strength })),
    })])).rows[0]!.id,
  );
  const sig = await ctx.signAs('approver', { type: 'manufacturing_licence', id: licenceId }, 'LICENCE_APPROVED', 'DRAFT');
  await as('approver', (c) => c.query('select site.approve_manufacturing_licence($1, $2)', [licenceId, sig]));
  for (const p of DEMO_LICENSED_PRODUCTS) {
    for (const destination of p.destinations) {
      const id = await as('regulatory', async (c) =>
        (await c.query<{ id: string }>('select site.record_export_permission($1::jsonb) as id', [JSON.stringify({
          productCode: p.productCode, strength: p.strength, destination, permissionNumber: `DEMO/NOC/${p.productCode}/${destination}`,
          issuingAuthority: 'State Licensing Authority (DEMO-ONLY)', validFrom: '2020-01-01T00:00:00+05:30', validUntil: '2036-01-01T00:00:00+05:30',
        })])).rows[0]!.id,
      );
      const s = await ctx.signAs('approver', { type: 'export_permission', id }, 'EXPORT_PERMISSION_APPROVED', 'DRAFT');
      await as('approver', (c) => c.query('select site.approve_export_permission($1, $2)', [id, s]));
    }
  }
}
