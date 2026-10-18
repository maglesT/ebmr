/**
 * The `people` routes (Phase 7 slice 7g-1, decision 0025; contract ns/people.ts): people, identity checks, accounts,
 * credentials, badges, role grants, recertification and break-glass windows. Each act is the kernel's own `iam.*`
 * function (packages/kernel/src/identity/admin.ts), run as the person's command; the database decides every rule
 * (who may, segregation of duties, identity verified first, nobody administers themselves). The reads are the
 * administration roles' (route-level gate; the database's rights stay the enforcement point for every act).
 *
 * Secrets: a credential is issued by `identity.issueInitialSecret`, which stores only the argon2id verifier; the
 * plaintext is in this process's memory for the one answer and is never logged, stored or read back. The issuing route
 * is not idempotent (an idempotent command keeps its answer). A badge UID is passed to `iam.issue_badge` (which keeps a
 * peppered hash) and is not idempotent either, so no request hash over it is kept.
 */
import type { BreakGlassWindowView, GrantView, PersonRef, PersonView, RecertificationDueView } from '@ebmr/api-contract';
import { commands, identity, type ActorContext } from '@ebmr/kernel';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { withActorCommand } from '../../platform/db/commands.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';

type Db = Pick<pg.Pool, 'query'>;
type People = Awaited<ReturnType<typeof peopleOf>>;

/** The roles that read the administration screens (the acts are the database's to allow or refuse). */
export const ADMIN_READERS = ['SYSTEM_ADMINISTRATOR', 'PROCESS_OWNER', 'BREAK_GLASS_ADMIN'] as const;
export const ACCESS_REASON = 'ACCESS_ADMINISTRATION';

export const notFound = (what: string) =>
  refusal(404, { code: 'EBMR-API-NOT-FOUND', kind: 'STALE', whatHappened: `The ${what} was not found.`, why: `No such ${what}.`, whatYouCanDo: ['Reload the list.'] });

const ref = (people: People, id: string | null | undefined, role = ''): PersonRef | null => (id ? personRef(people, id, role) : null);

// ---------------------------------------------------------------------------------------------
// People and accounts

interface PersonRow {
  id: string;
  kind: PersonView['kind'];
  legal_name: string;
  employee_ref: string | null;
  status: PersonView['status'];
  created_us: string;
  verifications: { id: string; purpose: string; method: string; document_type: string; by: string; us: string }[];
  accounts: {
    id: string;
    login_name: string;
    kind: PersonView['accounts'][number]['kind'];
    is_generic: boolean;
    is_break_glass: boolean;
    status: PersonView['accounts'][number]['status'];
    status_reason: string | null;
    locked: boolean;
    credentials: { id: string; kind: 'PASSWORD' | 'PIN' | 'SERVICE_KEY'; origin: string; must_change: boolean; status: string; issued_us: string; expires_us: string | null }[];
    badges: { id: string; label: string; technology: string; status: PersonView['accounts'][number]['badges'][number]['status']; issued_us: string; test: { kind: string; result: 'PASS' | 'FAIL'; us: string } | null }[];
    roles: string[];
  }[];
}

const PERSON_SQL = `
  select p.id, p.kind, p.legal_name, p.employee_ref, p.status, ${usOf('p.created_at')} as created_us,
         coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'purpose', v.purpose, 'method', v.method, 'document_type', v.document_type,
                                                       'by', v.verified_by_person, 'us', ${usOf('v.occurred_at')}) order by v.recorded_at desc)
                     from iam.identity_verification v where v.person_id = p.id), '[]'::jsonb) as verifications,
         coalesce((select jsonb_agg(jsonb_build_object(
                     'id', a.id, 'login_name', a.login_name, 'kind', a.kind, 'is_generic', a.is_generic, 'is_break_glass', a.is_break_glass,
                     'status', a.status, 'status_reason', a.status_reason, 'locked', iam.account_locked(a.id),
                     'credentials', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'origin', c.origin, 'must_change', c.must_change,
                                                 'status', c.status, 'issued_us', ${usOf('c.issued_at')},
                                                 'expires_us', case when c.expires_at is null then null else ${usOf('c.expires_at')} end) order by c.issued_at desc)
                                               from iam.credential c where c.account_id = a.id and c.status = 'ACTIVE'), '[]'::jsonb),
                     'badges', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'label', b.label, 'technology', b.technology, 'status', b.status,
                                                 'issued_us', ${usOf('b.issued_at')},
                                                 'test', (select jsonb_build_object('kind', t.kind, 'result', t.result, 'us', ${usOf('t.recorded_at')})
                                                            from iam.badge_test t where t.badge_id = b.id order by t.recorded_at desc limit 1)) order by b.issued_at desc)
                                          from iam.badge b where b.account_id = a.id), '[]'::jsonb),
                     'roles', coalesce((select jsonb_agg(g.role_code order by g.role_code) from iam.role_grant g
                                         where g.account_id = a.id and iam.grant_is_live(g.status, g.valid_to, g.revoked_at)), '[]'::jsonb)
                   ) order by a.login_name) from iam.account a where a.person_id = p.id), '[]'::jsonb) as accounts
    from iam.person p`;

export async function personViews(app: AppContext, db: Db, personId?: string): Promise<PersonView[]> {
  const { rows } = await db.query<PersonRow>(`${PERSON_SQL} where ($1::uuid is null or p.id = $1::uuid) order by p.legal_name, p.id limit 2000`, [personId ?? null]);
  const people = await peopleOf(db, rows.flatMap((r) => r.verifications.map((v) => v.by)));
  return rows.map((r) => ({
    personId: r.id,
    kind: r.kind,
    legalName: r.legal_name,
    employeeRef: r.employee_ref,
    status: r.status,
    createdAt: app.formatInstant(r.created_us),
    verifications: r.verifications.map((v) => ({
      verificationId: v.id,
      purpose: v.purpose,
      method: v.method,
      documentType: v.document_type,
      verifiedBy: personRef(people, v.by, 'SYSTEM_ADMINISTRATOR'),
      occurredAt: app.formatInstant(v.us),
    })),
    accounts: r.accounts.map((a) => ({
      accountId: a.id,
      loginName: a.login_name,
      kind: a.kind,
      generic: a.is_generic,
      breakGlass: a.is_break_glass,
      status: a.status,
      statusReason: a.status_reason,
      locked: a.locked,
      credentials: a.credentials.map((c) => ({
        credentialId: c.id,
        kind: c.kind,
        origin: c.origin,
        mustChange: c.must_change,
        status: c.status,
        issuedAt: app.formatInstant(c.issued_us),
        expiresAt: c.expires_us === null ? null : app.formatInstant(c.expires_us),
      })),
      badges: a.badges.map((b) => ({
        badgeId: b.id,
        label: b.label,
        technology: b.technology,
        status: b.status,
        issuedAt: app.formatInstant(b.issued_us),
        lastTest: b.test ? { kind: b.test.kind, result: b.test.result, at: app.formatInstant(b.test.us) } : null,
      })),
      roles: a.roles,
    })),
  }));
}

export async function onePerson(app: AppContext, db: Db, personId: string): Promise<PersonView> {
  const [v] = await personViews(app, db, personId);
  if (!v) throw notFound('person');
  return v;
}

/** The person an account, a badge or a grant belongs to. */
export async function personOf(db: Db, table: 'account' | 'badge', id: string): Promise<string> {
  const { rows } = await db.query<{ person_id: string }>(`select person_id from iam.${table} where id = $1`, [id]);
  const p = rows[0]?.person_id;
  if (!p) throw notFound(table);
  return p;
}

export async function badgeTechnologies(db: Db): Promise<string[]> {
  return (await db.query<{ code: string }>('select code from iam.badge_technology order by code')).rows.map((r) => r.code);
}

export async function siteCodeOf(db: Db): Promise<string | null> {
  const { rows } = await db.query<{ site: string | null }>("select coalesce((select site_code from iam.device where device_class = 'PERSONAL' order by registered_at limit 1), (select site_code from iam.device order by registered_at limit 1)) as site");
  return rows[0]?.site ?? null;
}

// ---------------------------------------------------------------------------------------------
// Grants

interface GrantRow {
  id: string;
  account_id: string;
  login_name: string;
  person_id: string;
  role_code: string;
  role_name: string;
  scope_site: string | null;
  scope_area: string | null;
  scope_product: string | null;
  from_us: string | null;
  to_us: string | null;
  reason: string;
  status: GrantView['status'];
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

export async function grantViews(app: AppContext, db: Db, grantId?: string): Promise<GrantView[]> {
  const { rows } = await db.query<GrantRow>(
    `select g.id, g.account_id, a.login_name, g.person_id, g.role_code, r.name as role_name, g.scope_site, g.scope_area, g.scope_product,
            case when g.valid_from is null then null else ${usOf('g.valid_from')} end as from_us,
            case when g.valid_to is null then null else ${usOf('g.valid_to')} end as to_us,
            g.reason, g.status, iam.grant_is_live(g.status, g.valid_to, g.revoked_at) as live,
            g.requested_by_person, ${usOf('g.requested_at')} as requested_us,
            g.decided_by_person, case when g.decided_at is null then null else ${usOf('g.decided_at')} end as decided_us, g.decision_reason,
            g.revoked_by_person, case when g.revoked_at is null then null else ${usOf('g.revoked_at')} end as revoked_us, g.revocation_reason
       from iam.role_grant g join iam.account a on a.id = g.account_id join iam.role r on r.code = g.role_code
      where ($1::uuid is null or g.id = $1::uuid)
      order by (g.status = 'REQUESTED') desc, g.requested_at desc, g.id
      limit 2000`,
    [grantId ?? null],
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.person_id, r.requested_by_person, r.decided_by_person, r.revoked_by_person]));
  return rows.map((r) => ({
    grantId: r.id,
    accountId: r.account_id,
    loginName: r.login_name,
    grantee: personRef(people, r.person_id, r.role_code),
    roleCode: r.role_code,
    roleName: r.role_name,
    scope: { site: r.scope_site, area: r.scope_area, product: r.scope_product },
    validFrom: r.from_us === null ? null : app.formatInstant(r.from_us),
    validTo: r.to_us === null ? null : app.formatInstant(r.to_us),
    reason: r.reason,
    status: r.status,
    live: r.live,
    requestedBy: personRef(people, r.requested_by_person, 'SYSTEM_ADMINISTRATOR'),
    requestedAt: app.formatInstant(r.requested_us),
    decidedBy: ref(people, r.decided_by_person),
    decidedAt: r.decided_us === null ? null : app.formatInstant(r.decided_us),
    decisionReason: r.decision_reason,
    revokedBy: ref(people, r.revoked_by_person),
    revokedAt: r.revoked_us === null ? null : app.formatInstant(r.revoked_us),
    revocationReason: r.revocation_reason,
  }));
}

export async function oneGrant(app: AppContext, db: Db, grantId: string): Promise<GrantView> {
  const [v] = await grantViews(app, db, grantId);
  if (!v) throw notFound('role grant');
  return v;
}

export async function roleOptions(db: Db): Promise<{ code: string; name: string; group: string; accountKinds: string[] }[]> {
  const { rows } = await db.query<{ code: string; name: string; role_group: string | null; account_kinds: string[] | null }>('select code, name, role_group, account_kinds from iam.role order by code');
  return rows.map((r) => ({ code: r.code, name: r.name, group: r.role_group ?? '', accountKinds: r.account_kinds ?? [] }));
}

// ---------------------------------------------------------------------------------------------
// Recertification

export async function recertificationViews(app: AppContext, db: Db): Promise<{ due: RecertificationDueView[]; recent: { recertificationId: string; accountId: string; loginName: string; reviewer: PersonRef; outcome: 'CONFIRMED' | 'REVOKED'; comment: string; grantsReviewed: number; recordedAt: ReturnType<AppContext['formatInstant']> }[] }> {
  const due = await db.query<{ account_id: string; login_name: string; person_id: string; last_us: string | null; due_us: string; overdue: boolean; roles: string[] }>(
    `select d.account_id, d.login_name, d.person_id, case when d.last_recertified_at is null then null else ${usOf('d.last_recertified_at')} end as last_us,
            ${usOf('d.due_at')} as due_us, d.overdue,
            coalesce((select array_agg(g.role_code order by g.role_code) from iam.role_grant g
                       where g.account_id = d.account_id and iam.grant_is_live(g.status, g.valid_to, g.revoked_at)), '{}') as roles
       from iam.recertification_due() d
      order by d.due_at, d.login_name limit 2000`,
  );
  const recent = await db.query<{ id: string; account_id: string; login_name: string; reviewer_person: string; outcome: 'CONFIRMED' | 'REVOKED'; comment: string; n: number; us: string }>(
    `select r.id, r.account_id, a.login_name, r.reviewer_person, r.outcome, r.comment, coalesce(cardinality(r.grants_reviewed), 0) as n, ${usOf('r.recorded_at')} as us
       from iam.access_recertification r join iam.account a on a.id = r.account_id
      order by r.recorded_at desc limit 50`,
  );
  const people = await peopleOf(db, [...due.rows.map((r) => r.person_id), ...recent.rows.map((r) => r.reviewer_person)]);
  return {
    due: due.rows.map((r) => ({
      accountId: r.account_id,
      loginName: r.login_name,
      person: personRef(people, r.person_id, ''),
      lastRecertifiedAt: r.last_us === null ? null : app.formatInstant(r.last_us),
      dueAt: app.formatInstant(r.due_us),
      overdue: r.overdue,
      roles: r.roles,
    })),
    recent: recent.rows.map((r) => ({
      recertificationId: r.id,
      accountId: r.account_id,
      loginName: r.login_name,
      reviewer: personRef(people, r.reviewer_person, 'PROCESS_OWNER'),
      outcome: r.outcome,
      comment: r.comment,
      grantsReviewed: Number(r.n),
      recordedAt: app.formatInstant(r.us),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Break-glass windows

interface WindowRow {
  id: string;
  account_id: string;
  login_name: string;
  person_id: string;
  reason: string;
  valid_minutes: number;
  requested_by_person: string;
  requested_us: string;
  approved_by_person: string | null;
  approved_us: string | null;
  to_us: string | null;
  open: boolean;
  reviewed_by_person: string | null;
  reviewed_us: string | null;
  review_outcome: 'NO_FINDINGS' | 'FINDINGS_RAISED' | null;
  review_comment: string | null;
}

export async function windowViews(app: AppContext, db: Db, windowId?: string): Promise<BreakGlassWindowView[]> {
  const { rows } = await db.query<WindowRow>(
    `select w.id, w.account_id, a.login_name, a.person_id, w.reason, w.valid_minutes, w.requested_by_person, ${usOf('w.requested_at')} as requested_us,
            w.approved_by_person, case when w.approved_at is null then null else ${usOf('w.approved_at')} end as approved_us,
            case when w.valid_to is null then null else ${usOf('w.valid_to')} end as to_us,
            (w.approved_at is not null and w.valid_to > clock_timestamp()) as open,
            w.reviewed_by_person, case when w.reviewed_at is null then null else ${usOf('w.reviewed_at')} end as reviewed_us, w.review_outcome, w.review_comment
       from iam.break_glass_window w join iam.account a on a.id = w.account_id
      where ($1::uuid is null or w.id = $1::uuid)
      order by w.requested_at desc, w.id limit 500`,
    [windowId ?? null],
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.person_id, r.requested_by_person, r.approved_by_person, r.reviewed_by_person]));
  return rows.map((r) => ({
    windowId: r.id,
    accountId: r.account_id,
    loginName: r.login_name,
    holder: personRef(people, r.person_id, 'BREAK_GLASS_ADMIN'),
    reason: r.reason,
    minutes: r.valid_minutes,
    requestedBy: personRef(people, r.requested_by_person, 'SYSTEM_ADMINISTRATOR'),
    requestedAt: app.formatInstant(r.requested_us),
    approvedBy: ref(people, r.approved_by_person, 'PROCESS_OWNER'),
    approvedAt: r.approved_us === null ? null : app.formatInstant(r.approved_us),
    validTo: r.to_us === null ? null : app.formatInstant(r.to_us),
    state: r.reviewed_us !== null ? 'REVIEWED' : r.approved_us === null ? 'REQUESTED' : r.open ? 'OPEN' : 'ENDED',
    review:
      r.reviewed_us !== null && r.reviewed_by_person && r.review_outcome
        ? { by: personRef(people, r.reviewed_by_person, 'PROCESS_OWNER'), at: app.formatInstant(r.reviewed_us), outcome: r.review_outcome, comment: r.review_comment ?? '' }
        : null,
  }));
}

export async function oneWindow(app: AppContext, db: Db, windowId: string): Promise<BreakGlassWindowView> {
  const [v] = await windowViews(app, db, windowId);
  if (!v) throw notFound('break-glass window');
  return v;
}

// ---------------------------------------------------------------------------------------------
// Acts

/** Issues an initial or reset secret: the plaintext goes to the answer only (never stored, logged or replayed). */
export async function issueSecret(pool: pg.Pool, who: ActorContext, accountId: string, kind: 'PASSWORD' | 'PIN' | 'SERVICE_KEY'): Promise<{ credentialId: string; secret: string }> {
  try {
    return await withActorCommand(pool, who, (c) => identity.issueInitialSecret(c, accountId, kind));
  } catch (error) {
    throw commands.asKernelError(error);
  }
}
