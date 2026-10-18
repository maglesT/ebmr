/**
 * The `accessGovernance` routes (Phase 7 slice 7g-5, decision 0025; contract ns/access-governance.ts): role-permission
 * requests and their decision, delegations of signing authority, and the US electronic-signature certification letter.
 * Each act is the kernel's own `iam.*` function run as the person's command (packages/kernel/sql 0120 and 0170); the
 * database decides who may and keeps the segregation of duties. The reads show metadata only.
 */
import type { DelegationView, PersonRef, RolePermissionRequestView, RolePermissionsView, UsEsigCertificationView } from '@ebmr/api-contract';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';

type Db = Pick<pg.Pool, 'query'>;
type People = Awaited<ReturnType<typeof peopleOf>>;

const ref = (people: People, id: string | null | undefined, role = ''): PersonRef | null => (id ? personRef(people, id, role) : null);
const at = (app: AppContext, us: string | null) => (us === null ? null : app.formatInstant(us));

// ---------------------------------------------------------------------------------------------
// Role permissions

interface RequestRow {
  id: string;
  role_code: string;
  permission_code: string;
  reason: string;
  status: RolePermissionRequestView['status'];
  requested_by_person: string;
  requested_us: string;
  decided_by_person: string | null;
  decided_us: string | null;
  decision_reason: string | null;
}

export async function requestViews(app: AppContext, db: Db, requestId?: string): Promise<RolePermissionRequestView[]> {
  const { rows } = await db.query<RequestRow>(
    `select r.id, r.role_code, r.permission_code, r.reason, r.status, r.requested_by_person, ${usOf('r.requested_at')} as requested_us,
            r.decided_by_person, case when r.decided_at is null then null else ${usOf('r.decided_at')} end as decided_us, r.decision_reason
       from iam.role_permission_request r
      where ($1::uuid is null or r.id = $1::uuid)
      order by (r.status = 'REQUESTED') desc, r.requested_at desc, r.id
      limit 1000`,
    [requestId ?? null],
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.requested_by_person, r.decided_by_person]));
  return rows.map((r) => ({
    requestId: r.id,
    roleCode: r.role_code,
    permissionCode: r.permission_code,
    reason: r.reason,
    status: r.status,
    requestedBy: personRef(people, r.requested_by_person, 'SYSTEM_ADMINISTRATOR'),
    requestedAt: app.formatInstant(r.requested_us),
    decidedBy: ref(people, r.decided_by_person),
    decidedAt: at(app, r.decided_us),
    decisionReason: r.decision_reason,
  }));
}

export async function rolePermissionsView(app: AppContext, db: Db): Promise<RolePermissionsView> {
  const roles = await db.query<{ code: string; name: string; role_group: string | null; account_kinds: string[] | null; permissions: string[] }>(
    `select r.code, r.name, r.role_group, r.account_kinds,
            coalesce((select array_agg(rp.permission_code order by rp.permission_code) from iam.role_permission rp
                       where rp.role_code = r.code and iam.role_permission_live_at(rp.added_at, rp.removed_at, clock_timestamp())), '{}') as permissions
       from iam.role r order by r.code`,
  );
  const permissions = await db.query<{ code: string; domain: string; effect: string; description: string }>('select code, domain, effect, description from iam.permission order by code');
  return {
    roles: roles.rows.map((r) => ({ code: r.code, name: r.name, group: r.role_group ?? '', accountKinds: r.account_kinds ?? [], permissions: r.permissions })),
    permissions: permissions.rows,
    requests: await requestViews(app, db),
  };
}

// ---------------------------------------------------------------------------------------------
// Delegations

interface DelegationRow {
  id: string;
  delegator_person: string;
  delegate_person: string;
  scope_site: string | null;
  scope_area: string | null;
  scope_product: string | null;
  markets: DelegationView['markets'];
  meanings: string[];
  from_us: string;
  to_us: string;
  sop_ref: string;
  reason: string;
  status: DelegationView['status'];
  live: boolean;
  requested_by_person: string;
  requested_us: string;
  decided_by_person: string | null;
  decided_us: string | null;
  decision_reason: string | null;
  revoked_by_person: string | null;
  revoked_us: string | null;
  revocation_reason: string | null;
}

/** The delegations `viewer` may see: every one when `all`, otherwise those the person delegated, received or requested. */
export async function delegationViews(app: AppContext, db: Db, opts: { delegationId?: string; all: boolean; viewer: string }): Promise<DelegationView[]> {
  const { rows } = await db.query<DelegationRow>(
    `select d.id, d.delegator_person, d.delegate_person, d.scope_site, d.scope_area, d.scope_product, d.markets, d.meanings,
            ${usOf('d.valid_from')} as from_us, ${usOf('d.valid_to')} as to_us, d.sop_ref, d.reason, d.status,
            (d.status = 'APPROVED' and d.revoked_at is null and clock_timestamp() >= d.valid_from and clock_timestamp() < d.valid_to) as live,
            d.requested_by_person, ${usOf('d.requested_at')} as requested_us,
            d.decided_by_person, case when d.decided_at is null then null else ${usOf('d.decided_at')} end as decided_us, d.decision_reason,
            d.revoked_by_person, case when d.revoked_at is null then null else ${usOf('d.revoked_at')} end as revoked_us, d.revocation_reason
       from iam.delegation d
      where ($1::uuid is null or d.id = $1::uuid)
        and ($2::boolean or $3::uuid in (d.delegator_person, d.delegate_person, d.requested_by_person))
      order by (d.status = 'REQUESTED') desc, d.requested_at desc, d.id
      limit 1000`,
    [opts.delegationId ?? null, opts.all, opts.viewer],
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.delegator_person, r.delegate_person, r.requested_by_person, r.decided_by_person, r.revoked_by_person]));
  return rows.map((r) => ({
    delegationId: r.id,
    delegator: personRef(people, r.delegator_person, 'DELEGATOR'),
    delegate: personRef(people, r.delegate_person, 'DELEGATE'),
    scope: { site: r.scope_site, area: r.scope_area, product: r.scope_product },
    markets: r.markets,
    meanings: r.meanings,
    validFrom: app.formatInstant(r.from_us),
    validTo: app.formatInstant(r.to_us),
    sopRef: r.sop_ref,
    reason: r.reason,
    status: r.status,
    live: r.live,
    requestedBy: personRef(people, r.requested_by_person, 'DELEGATOR'),
    requestedAt: app.formatInstant(r.requested_us),
    decidedBy: ref(people, r.decided_by_person),
    decidedAt: at(app, r.decided_us),
    decisionReason: r.decision_reason,
    revokedBy: ref(people, r.revoked_by_person),
    revokedAt: at(app, r.revoked_us),
    revocationReason: r.revocation_reason,
  }));
}

/** The delegable signature meanings: the latest version of each e-signature type, active and delegable. */
export async function delegableMeanings(db: Db): Promise<{ code: string; title: string }[]> {
  const { rows } = await db.query<{ code: string; title: string }>(
    `select code, title from (select distinct on (code) code, title, status, delegable from esig.meaning_type order by code, version desc) m
      where m.status = 'ACTIVE' and m.delegable order by code`,
  );
  return rows;
}

/** Whether `role` holds IAM.DELEGATION_APPROVE now (which delegations the read shows; the database decides every act). */
export async function roleApprovesDelegations(db: Db, role: string | null): Promise<boolean> {
  if (role === null) return false;
  const { rows } = await db.query<{ ok: boolean }>(
    `select exists (select 1 from iam.role_permission rp where rp.role_code = $1 and rp.permission_code = 'IAM.DELEGATION_APPROVE'
                     and iam.role_permission_live_at(rp.added_at, rp.removed_at, clock_timestamp())) as ok`,
    [role],
  );
  return rows[0]?.ok === true;
}

/** The person behind a user ID, or null. */
export async function personOfLogin(db: Db, loginName: string): Promise<string | null> {
  const { rows } = await db.query<{ person_id: string }>('select person_id from iam.account where login_name = $1', [loginName]);
  return rows[0]?.person_id ?? null;
}

// ---------------------------------------------------------------------------------------------
// The US electronic-signature certification

export async function certificationViews(app: AppContext, db: Db, certificationId?: string): Promise<UsEsigCertificationView[]> {
  const { rows } = await db.query<{ id: string; legal_entity: string; letter_ref: string; submitted_on: string; ack: string | null; by: string; us: string }>(
    `select c.id, c.legal_entity, c.letter_ref, to_char(c.submitted_on, 'YYYY-MM-DD') as submitted_on, c.fda_acknowledgement_ref as ack,
            c.recorded_by_person as by, ${usOf('c.recorded_at')} as us
       from iam.us_esig_certification c
      where ($1::uuid is null or c.id = $1::uuid)
      order by c.recorded_at desc, c.id limit 500`,
    [certificationId ?? null],
  );
  const people = await peopleOf(db, rows.map((r) => r.by));
  return rows.map((r) => ({
    certificationId: r.id,
    legalEntity: r.legal_entity,
    letterRef: r.letter_ref,
    submittedOn: r.submitted_on,
    agencyAcknowledgementRef: r.ack,
    recordedBy: personRef(people, r.by, 'PROCESS_OWNER'),
    recordedAt: app.formatInstant(r.us),
  }));
}

/** The kernel's own status of a legal entity (iam.us_esig_certification_status): a letter on file, and whether the policy blocks. */
export async function certificationStatus(db: Db, legalEntity: string): Promise<{ legalEntity: string; onFile: boolean; blocking: boolean; mode: 'BLOCK' | 'FLAG' }> {
  const { rows } = await db.query<{ v: { on_file: boolean; blocking: boolean; mode: 'BLOCK' | 'FLAG' } }>('select iam.us_esig_certification_status($1) as v', [legalEntity]);
  const v = rows[0]?.v;
  return { legalEntity, onFile: v?.on_file === true, blocking: v?.blocking === true, mode: v?.mode === 'FLAG' ? 'FLAG' : 'BLOCK' };
}
