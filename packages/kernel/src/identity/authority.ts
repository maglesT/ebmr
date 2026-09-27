/**
 * Authority checks at the moment of action (DI-17, DI-18, DI-21, INV-26).
 *
 * The database decides (iam.evaluate_authority / iam.require_permission) and stores every
 * evaluation. A refused command rolls back, which would also roll back the stored refusal, so
 * withGuardedCommand logs the refusal again in its own transaction: "a failed check blocks the
 * action and is logged".
 */
import type pg from 'pg';
import { withCommand, type ActorContext } from '../db/command.ts';
import { ebmrCode, errorDetail, IdentityError } from './errors.ts';

type Queryable = pg.Pool | pg.PoolClient;

/** Scope of an action: site, area (room) and product; an empty scope means installation-wide. */
export interface Scope {
  site?: string;
  area?: string;
  product?: string;
}

export interface AuthorityQuery {
  personId: string;
  accountId: string;
  permission: string;
  scope?: Scope;
  /** ISO instant; default: now (database clock). */
  at?: string;
  /** Restrict to one role, e.g. the role named in the actor context. */
  roleCode?: string;
}

export interface AuthorityDecision {
  evaluationId: string;
  allowed: boolean;
  reasons: string[];
  roleCode: string | null;
  grantId: string | null;
  at: string;
}

export async function evaluateAuthority(db: Queryable, q: AuthorityQuery): Promise<AuthorityDecision> {
  const { rows } = await db.query<{ r: { evaluation_id: string; allowed: boolean; reasons: string[]; role_code: string | null; grant_id: string | null; at: string } }>(
    'select iam.evaluate_authority($1, $2, $3, $4::jsonb, $5::timestamptz, $6) as r',
    [q.personId, q.accountId, q.permission, JSON.stringify(q.scope ?? {}), q.at ?? null, q.roleCode ?? null],
  );
  const r = rows[0]?.r;
  if (!r) throw new IdentityError('EBMR-IAM-040', 'no authority evaluation was returned');
  return { evaluationId: r.evaluation_id, allowed: r.allowed, reasons: r.reasons, roleCode: r.role_code, grantId: r.grant_id, at: r.at };
}

/** Inside a command: refuse unless the actor, in its declared role, holds the permission in scope now. */
export async function requirePermission(client: pg.PoolClient, permission: string, scope: Scope = {}): Promise<void> {
  await client.query('select iam.require_permission($1, $2::jsonb)', [permission, JSON.stringify(scope)]);
}

async function logRefusal(pool: pg.Pool, error: unknown): Promise<void> {
  const code = ebmrCode(error);
  const d = errorDetail(error);
  if (!d) return;
  try {
    if (code === 'EBMR-IAM-040') {
      await pool.query('select iam.evaluate_authority($1, $2, $3, $4::jsonb, null, $5)', [
        d['person_id'],
        d['account_id'],
        d['permission'],
        JSON.stringify(d['scope'] ?? {}),
        d['role_code'] ?? null,
      ]);
    } else if (code === 'EBMR-IAM-041') {
      await pool.query('select iam.evaluate_segregation($1, $2, $3::uuid[], $4)', [d['rule'], d['person_id'], d['excluded'], d['subject'] ?? null]);
    }
  } catch {
    // Logging must never hide the original refusal.
  }
}

/**
 * withCommand plus refusal logging: when the database refuses on authority (EBMR-IAM-040) or
 * segregation (EBMR-IAM-041), the refusal is stored again outside the rolled-back command.
 */
export async function withGuardedCommand<T>(pool: pg.Pool, ctx: ActorContext, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  try {
    return await withCommand(pool, ctx, work);
  } catch (error) {
    const code = ebmrCode(error);
    if (code === 'EBMR-IAM-040' || code === 'EBMR-IAM-041') await logRefusal(pool, error);
    throw error;
  }
}

/** Check before acting, with the decision stored and committed whatever the outcome. */
export async function authorize(pool: pg.Pool, ctx: ActorContext, permission: string, scope: Scope = {}): Promise<AuthorityDecision> {
  const decision = await evaluateAuthority(pool, { personId: ctx.personId, accountId: ctx.accountId, permission, scope, roleCode: ctx.roleCode });
  if (!decision.allowed) {
    throw new IdentityError('EBMR-IAM-040', `${ctx.roleCode} lacks ${permission}: ${decision.reasons.join(', ')} (evaluation ${decision.evaluationId})`);
  }
  return decision;
}
