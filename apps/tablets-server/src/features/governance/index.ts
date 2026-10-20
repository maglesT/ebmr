/**
 * Feature `governance` (Phase 6 slice 6f, GMP; contract ns/support.ts): vendor support grants (kernel 1202, DI-08) and the
 * contract giver's read-only access (kernel 1204, recipe-core 1060, IN-30). Every rule is the database's; each route runs
 * the person's own command.
 *
 *  - support: IT's administrator requests a grant for one named VENDOR_SUPPORT account; QA and IT approve it with the
 *    signable action SUPPORT_ACT (support_grant <grant id>, SUPPORT_ACCESS_QA_APPROVED / SUPPORT_ACCESS_IT_APPROVED,
 *    state PENDING; the content is read through tablets 1275, a support grant being a GOVERNANCE record); the second
 *    approval opens the window. A support login outside a live grant is refused and logged by the kernel.
 *  - contractGiver: QA grants and revokes a reviewer's access to the batches of one loan licence; the reviewer's session
 *    reaches only its own two routes (bind.ts) and each batch it opens is logged by the database.
 */
import { routes, type ContractGiverAccessView, type ContractGiverBatchView, type ContractGiverRecordView, type SignableAction, type SignableContentView, type SupportGrantView } from '@ebmr/api-contract';
import { commands, type ActorContext } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { permissionBeforeTap, withActorCommand, withIdempotentActorCommand, withReadCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import type { SignableActionHandler, SignableActionRegistry } from '../../platform/ports.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';
import { contentNotFound, contentOf, type EsigSignableContext } from '../esig/content.ts';
import { refusedOutcome } from '../esig/db-acts.ts';
import { meaningInfo } from '../esig/views.ts';

type Db = Pick<pg.Pool, 'query'>;
type SupportAct = Extract<SignableAction, { kind: 'SUPPORT_ACT' }>;

const notFound = (what: string) =>
  refusal(404, { code: 'EBMR-API-NOT-FOUND', kind: 'STALE', whatHappened: `The ${what} was not found.`, why: `No such ${what}.`, whatYouCanDo: ['Reload the list.'] });

// ---------------------------------------------------------------------------------------------
// Support grants

interface GrantRow {
  id: string;
  account_id: string;
  login_name: string;
  person_id: string;
  vendor_name: string;
  purpose: string;
  valid_hours: number;
  requested_by_person: string;
  requested_us: string;
  state: SupportGrantView['state'];
  approvals: { kind: 'QA' | 'IT'; person: string; us: string; signature: string }[];
  from_us: string | null;
  to_us: string | null;
  revocation: { reason: string; by: string; us: string } | null;
  sessions: number;
}

async function grantViews(app: AppContext, db: Db, id?: string): Promise<SupportGrantView[]> {
  const { rows } = await db.query<GrantRow>(
    `select g.id, g.account_id, a.login_name, g.person_id, g.vendor_name, g.purpose, g.valid_hours, g.requested_by_person,
            ${usOf('g.requested_at')} as requested_us, iam.support_grant_state(g.id) as state,
            coalesce((select jsonb_agg(jsonb_build_object('kind', p.kind, 'person', p.person_id, 'us', ${usOf('p.recorded_at')}, 'signature', p.signature_id) order by p.kind)
                        from iam.support_grant_approval p where p.grant_id = g.id), '[]'::jsonb) as approvals,
            case when v.grant_id is null then null else ${usOf('v.valid_from')} end as from_us,
            case when v.grant_id is null then null else ${usOf('v.valid_to')} end as to_us,
            (select jsonb_build_object('reason', r.reason, 'by', r.revoked_by_person, 'us', ${usOf('r.recorded_at')})
               from iam.support_grant_revocation r where r.grant_id = g.id) as revocation,
            (select count(*) from iam.support_session s where s.grant_id = g.id)::integer as sessions
       from iam.support_grant g join iam.account a on a.id = g.account_id
       left join iam.support_grant_activation v on v.grant_id = g.id
      where ($1::uuid is null or g.id = $1::uuid)
      order by g.requested_at desc, g.id
      limit 500`,
    [id ?? null],
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.person_id, r.requested_by_person, r.revocation?.by, ...r.approvals.map((a) => a.person)]));
  return rows.map((r) => ({
    grantId: r.id,
    accountId: r.account_id,
    loginName: r.login_name,
    engineer: personRef(people, r.person_id, 'VENDOR_SUPPORT'),
    vendor: r.vendor_name,
    purpose: r.purpose,
    validHours: r.valid_hours,
    requestedBy: personRef(people, r.requested_by_person, 'SYSTEM_ADMINISTRATOR'),
    requestedAt: app.formatInstant(r.requested_us),
    state: r.state,
    approvals: r.approvals.map((a) => ({ kind: a.kind, by: personRef(people, a.person, a.kind === 'QA' ? 'QA' : 'PROCESS_OWNER'), at: app.formatInstant(a.us), signatureId: a.signature })),
    validFrom: r.from_us === null ? null : app.formatInstant(r.from_us),
    validTo: r.to_us === null ? null : app.formatInstant(r.to_us),
    revocation: r.revocation ? { reason: r.revocation.reason, by: personRef(people, r.revocation.by, ''), at: app.formatInstant(r.revocation.us) } : null,
    sessions: r.sessions,
  }));
}

async function supportAccounts(db: Db): Promise<{ accountId: string; loginName: string; engineer: ReturnType<typeof personRef> }[]> {
  const { rows } = await db.query<{ id: string; login_name: string; person_id: string }>(
    `select a.id, a.login_name, a.person_id from iam.account a where a.status = 'ACTIVE' and iam.is_support_account(a.id) order by a.login_name`,
  );
  const people = await peopleOf(db, rows.map((r) => r.person_id));
  return rows.map((r) => ({ accountId: r.id, loginName: r.login_name, engineer: personRef(people, r.person_id, 'VENDOR_SUPPORT') }));
}

const MEANING: Readonly<Record<SupportAct['act'], string>> = { QA_APPROVE: 'SUPPORT_ACCESS_QA_APPROVED', IT_APPROVE: 'SUPPORT_ACCESS_IT_APPROVED' };

/** SUPPORT_ACT: QA's or IT's approval of a support grant, signed through the ceremony (DI-08). */
export function supportActHandler(app: AppContext): SignableActionHandler<SupportAct> {
  const content = async (client: pg.PoolClient, a: SupportAct) => {
    const { rows } = await client.query<{ r: Record<string, unknown> }>('select tab.support_grant_signing_content($1, $2) as r', [a.grantId, MEANING[a.act]]);
    return contentOf('support_grant', a.grantId, rows[0]?.r ?? {});
  };
  return {
    kind: 'SUPPORT_ACT',
    aggregateTypes: ['support_grant'],
    describe: (a) => ({ aggregateType: 'support_grant', aggregateId: a.grantId, meaning: MEANING[a.act], expectedState: 'PENDING' }),
    async previewContent(ctx, query): Promise<SignableContentView> {
      const meaning = await meaningInfo(app.pools.app, query.intent);
      const { rows } = await app.pools.app.query<{ r: Record<string, unknown> }>('select tab.support_grant_preview($1, $2::uuid, $3) as r', [
        (ctx as Partial<EsigSignableContext>).tokenHash ?? '',
        query.aggregateId,
        meaning.code,
      ]);
      const c = contentOf(query.aggregateType, query.aggregateId, rows[0]?.r ?? {});
      if (!c.exists || !c.canonical || !c.contentHash || !c.contentVersion) throw contentNotFound(query.aggregateType, query.aggregateId);
      const body = (JSON.parse(c.canonical) as { content?: Record<string, unknown> }).content ?? {};
      return {
        aggregateType: query.aggregateType,
        aggregateId: query.aggregateId,
        contentVersion: c.contentVersion,
        canonicalText: c.canonical,
        contentHash: c.contentHash,
        meaning: meaning.code,
        meaningText: meaning.text,
        title: `${meaning.title}: ${typeof body['title'] === 'string' ? body['title'] : `support grant ${query.aggregateId}`}`,
        preview: false,
        rendering: { kind: 'fallback', state: c.state ?? null, content: body },
      };
    },
    async prepareForChallenge(client, _ctx, a) {
      const c = await content(client, a);
      return { contentVersion: c.contentVersion ?? '0', contentHash: c.contentHash ?? '', changed: false };
    },
    async dryRun(client, _ctx, a) {
      const c = await content(client, a);
      if (!c.exists || !c.contentHash || !c.contentVersion) {
        return refusedOutcome(404, 'EBMR-API-NO-RECORD', 'The support grant was not found. Nothing was signed.', `support_grant ${a.grantId} does not exist.`, ['DI-08'], ['Reload the list.']);
      }
      return { accepted: true, contentHash: c.contentHash, contentVersion: c.contentVersion };
    },
    async apply(client, _ctx, a, signature) {
      const { rows } = await client.query<{ s: string }>('select iam.approve_support_grant($1, $2) as s', [a.grantId, signature.signatureId]);
      return { act: a.act, grantId: a.grantId, state: rows[0]?.s ?? null };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Contract giver

interface AccessRow {
  accessId: string;
  loanLicenceId: string;
  loanLicenceNumber: string;
  holderName: string;
  accountId: string;
  personId: string;
  loginName: string;
  validFrom: string;
  validTo: string;
  reason: string;
  grantedBy: string;
  live: boolean;
  reads: number;
}

async function accessViews(app: AppContext, pool: pg.Pool, who: ActorContext, id?: string): Promise<ContractGiverAccessView[]> {
  const list = await withReadCommand(pool, who, ['CONTRACT_GIVER_ACCESS.GRANT'], async (c) => (await c.query<{ r: AccessRow[] }>('select recipe.contract_giver_accesses() as r')).rows[0]?.r ?? []);
  const mine = id ? list.filter((a) => a.accessId === id) : list;
  const us = await pool.query<{ i: string; f: string; t: string }>(
    `select x ->> 'accessId' as i, ${usOf("(x ->> 'validFrom')::timestamptz")} as f, ${usOf("(x ->> 'validTo')::timestamptz")} as t from jsonb_array_elements($1::jsonb) x`,
    [JSON.stringify(mine)],
  );
  const byId = new Map(us.rows.map((r) => [r.i, r]));
  const people = await peopleOf(pool, mine.flatMap((a) => [a.personId, a.grantedBy]));
  return mine.map((a) => ({
    accessId: a.accessId,
    loanLicenceId: a.loanLicenceId,
    loanLicenceNumber: a.loanLicenceNumber,
    holderName: a.holderName,
    accountId: a.accountId,
    loginName: a.loginName,
    reviewer: personRef(people, a.personId, 'CONTRACT_GIVER_REVIEWER'),
    validFrom: app.formatInstant(byId.get(a.accessId)?.f ?? '0'),
    validTo: app.formatInstant(byId.get(a.accessId)?.t ?? '0'),
    reason: a.reason,
    grantedBy: personRef(people, a.grantedBy, 'QA_REVIEWER'),
    live: a.live,
    reads: Number(a.reads),
  }));
}

/** A reviewer's read: its own command (the database checks the role, read-only and the live access, and logs the read). */
async function asReviewer<T>(pool: pg.Pool, who: ActorContext, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  try {
    // D-P7R-18 (F2): the read's permission before the kiosk's badge tap.
    await permissionBeforeTap(pool, who, ['CONTRACT_GIVER.READ']);
    return await withActorCommand(pool, who, work);
  } catch (error) {
    throw commands.asKernelError(error);
  }
}

interface BatchJson {
  batchId: string;
  batchNumber: string;
  product: { code?: string; name?: string } | null;
  status: string | null;
  reviewState: string | null;
  loanLicenceNumber: string;
  hostLicenceNumber: string;
  issuedAt: string;
  accessValidTo?: string;
}

async function instants(pool: pg.Pool, values: readonly string[]): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ v: string; u: string }>(`select v, ${usOf('v::timestamptz')} as u from unnest($1::text[]) v`, [values]);
  return new Map(rows.map((r) => [r.v, r.u]));
}

const decimalText = (v: unknown): string => {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (!v || typeof v !== 'object') return '';
  const o = v as Record<string, unknown>;
  if (Array.isArray(o['values'])) return `${(o['values'] as unknown[]).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ')} ${typeof o['unit'] === 'string' ? o['unit'] : ''}`.trim();
  if ('value' in o) return `${typeof o['value'] === 'string' ? o['value'] : JSON.stringify(o['value'])}${typeof o['unit'] === 'string' ? ` ${o['unit']}` : ''}`;
  return JSON.stringify(o);
};

// ---------------------------------------------------------------------------------------------
// Routes

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.installation !== 'GMP') return;
  registry.register(supportActHandler(app));
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  bindRoutes(scope, app, routes.support, {
    grants: async ({ requireSession }) => {
      requireSession();
      return { grants: await grantViews(app, pool), accounts: await supportAccounts(pool) };
    },
    requestGrant: async ({ body, actor, idempotencyKey, requestHash }) => {
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        const { rows } = await c.query<{ id: string }>('select iam.request_support_grant($1, $2, $3, $4) as id', [body.accountId, body.vendor, body.purpose, body.hours]);
        return rows[0]?.id ?? '';
      });
      const [v] = await grantViews(app, pool, out.result);
      if (!v) throw notFound('support grant');
      return v;
    },
    revokeGrant: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await c.query('select iam.revoke_support_grant($1, $2)', [params.grantId, body.reason]);
        return null;
      });
      const [v] = await grantViews(app, pool, params.grantId);
      if (!v) throw notFound('support grant');
      return v;
    },
  });
  bindRoutes(scope, app, routes.contractGiver, {
    accesses: async ({ actor }) => ({ accesses: await accessViews(app, pool, actor()) }),
    grantAccess: async ({ body, actor, idempotencyKey, requestHash }) => {
      const who = actor();
      const out = await withIdempotentActorCommand(pool, who, idempotencyKey ?? '', requestHash, async (c) => {
        const { rows } = await c.query<{ id: string }>('select recipe.grant_contract_giver_access($1, $2, $3::timestamptz, $4) as id', [body.loanLicenceId, body.accountId, body.validTo, body.reason]);
        return rows[0]?.id ?? '';
      });
      const [v] = await accessViews(app, pool, actor(), out.result);
      if (!v) throw notFound('contract-giver access');
      return v;
    },
    revokeAccess: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await c.query('select recipe.revoke_contract_giver_access($1, $2)', [params.accessId, body.reason]);
        return null;
      });
      const [v] = await accessViews(app, pool, actor(), params.accessId);
      if (!v) throw notFound('contract-giver access');
      return v;
    },
    batches: async ({ actor }) => {
      const list = await asReviewer(pool, actor(), async (c) => (await c.query<{ r: BatchJson[] }>('select recipe.contract_giver_batches() as r')).rows[0]?.r ?? []);
      const at = await instants(pool, list.flatMap((b) => [b.issuedAt, b.accessValidTo ?? b.issuedAt]));
      const batches: ContractGiverBatchView[] = list.map((b) => ({
        batchId: b.batchId,
        batchNumber: b.batchNumber,
        productCode: b.product?.code ?? null,
        productName: b.product?.name ?? null,
        status: b.status,
        reviewState: b.reviewState,
        loanLicenceNumber: b.loanLicenceNumber,
        hostLicenceNumber: b.hostLicenceNumber,
        issuedAt: app.formatInstant(at.get(b.issuedAt) ?? '0'),
        accessValidTo: app.formatInstant(at.get(b.accessValidTo ?? b.issuedAt) ?? '0'),
      }));
      return { batches };
    },
    batch: async ({ params, actor }) => {
      const r = await asReviewer(pool, actor(), async (c) =>
        (await c.query<{ r: BatchJson & { batchSize: string; technicalAgreement: string | null; loanHolderName: string | null; stages: Record<string, Record<string, unknown>>; steps: Record<string, Record<string, unknown>>; points: Record<string, Record<string, unknown>>; stateHash: string | null } }>(
          'select recipe.read_contract_giver_batch($1) as r',
          [params.batchId],
        )).rows[0]?.r,
      );
      if (!r) throw notFound('batch');
      const at = await instants(pool, [r.issuedAt]);
      const view: ContractGiverRecordView = {
        batchId: r.batchId,
        batchNumber: r.batchNumber,
        productCode: r.product?.code ?? null,
        productName: r.product?.name ?? null,
        status: r.status,
        reviewState: r.reviewState,
        loanLicenceNumber: r.loanLicenceNumber,
        hostLicenceNumber: r.hostLicenceNumber,
        issuedAt: app.formatInstant(at.get(r.issuedAt) ?? '0'),
        batchSize: r.batchSize,
        technicalAgreement: r.technicalAgreement,
        loanHolderName: r.loanHolderName,
        stages: Object.entries(r.stages ?? {}).map(([key, s]) => ({ key, name: typeof s['stage'] === 'string' ? s['stage'] : null, status: s['endedAt'] ? 'ENDED' : s['awaitingSignOff'] ? 'AWAITING_SIGN_OFF' : 'OPEN' })),
        steps: Object.entries(r.steps ?? {}).map(([key, s]) => ({ key, name: typeof s['step'] === 'string' ? s['step'] : null, status: typeof s['status'] === 'string' ? s['status'] : null })),
        values: Object.values(r.points ?? {})
          .filter((p) => p['kind'] === 'VALUE')
          .map((p) => ({ item: String(p['item']), step: String(p['stepKey']), value: decimalText(p['value']), status: String(p['status']) })),
        stateHash: r.stateHash,
      };
      return view;
    },
  });
  return Promise.resolve();
}
