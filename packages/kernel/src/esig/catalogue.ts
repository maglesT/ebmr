/**
 * The signature-meaning catalogue (DI-35), e-signature policy values (DI-38 relaxation, witness
 * window, MFA at signing) and seal-key administration. The database enforces every rule; these
 * wrappers run inside a command (withCommand) so the actor is known.
 */
import type pg from 'pg';
import type { SealAlgorithm } from './keys.ts';

type Db = pg.Pool | pg.PoolClient;

export type MeaningCategory =
  | 'MASTER_RECORD' | 'BATCH_RECORD' | 'EXECUTION' | 'VERIFICATION' | 'EXCEPTION' | 'LOGBOOK' | 'LABORATORY' | 'REVIEW' | 'RELEASE' | 'RECORDS';
export type RoleClass = 'PERFORMER' | 'VERIFIER' | 'WITNESS' | 'SUPERVISOR' | 'AUTHORISER' | 'APPROVER' | 'REVIEWER' | 'RELEASE';
export type Reauthentication = 'ALL_COMPONENTS' | 'SESSION_RELAXABLE';

export interface MeaningType {
  code: string;
  version: number;
  origin: 'VENDOR' | 'CUSTOMER';
  isMinimum: boolean;
  status: 'ACTIVE' | 'RETIRED';
  category: MeaningCategory;
  roleClass: RoleClass;
  title: string;
  meaningText: string;
  permissions: string[];
  independentOf: string[];
  excludesPerformers: boolean;
  excludesInvolved: boolean;
  witness: boolean;
  reauth: Reauthentication;
  delegable: boolean;
  sources: string;
}

interface MeaningRow {
  code: string; version: number; origin: 'VENDOR' | 'CUSTOMER'; is_minimum: boolean; status: 'ACTIVE' | 'RETIRED'; category: MeaningCategory;
  role_class: RoleClass; title: string; meaning_text: string; permissions: string[]; independent_of: string[]; excludes_performers: boolean;
  excludes_involved: boolean; witness: boolean; reauth: Reauthentication; delegable: boolean; sources: string;
}

const toMeaning = (r: MeaningRow): MeaningType => ({
  code: r.code, version: r.version, origin: r.origin, isMinimum: r.is_minimum, status: r.status, category: r.category, roleClass: r.role_class,
  title: r.title, meaningText: r.meaning_text, permissions: r.permissions, independentOf: r.independent_of, excludesPerformers: r.excludes_performers,
  excludesInvolved: r.excludes_involved, witness: r.witness, reauth: r.reauth, delegable: r.delegable, sources: r.sources,
});

/** The newest version of every signature type. */
export async function listMeanings(db: Db): Promise<MeaningType[]> {
  const { rows } = await db.query<MeaningRow>('select * from esig.meaning_catalogue order by code');
  return rows.map(toMeaning);
}

export interface CustomerMeaningDefinition {
  title: string;
  meaningText: string;
  category: MeaningCategory;
  roleClass: RoleClass;
  permissions: string[];
  independentOf?: string[];
  /** Default true: nobody who performed, entered or corrected the record signs it. */
  excludesPerformers?: boolean;
  excludesInvolved?: boolean;
  witness?: boolean;
  reauth?: Reauthentication;
  delegable?: boolean;
  sources?: string;
}

/** A customer signature point (quality unit; the minimum set cannot be removed). */
export async function addMeaningType(client: pg.PoolClient, code: string, def: CustomerMeaningDefinition, reason: string): Promise<void> {
  await client.query('select esig.add_meaning_type($1, $2::jsonb, $3)', [
    code,
    JSON.stringify({
      title: def.title, meaning_text: def.meaningText, category: def.category, role_class: def.roleClass, permissions: def.permissions,
      independent_of: def.independentOf ?? [], excludes_performers: def.excludesPerformers ?? true, excludes_involved: def.excludesInvolved ?? false,
      witness: def.witness ?? false, reauth: def.reauth ?? 'ALL_COMPONENTS', delegable: def.delegable ?? false,
      ...(def.sources ? { sources: def.sources } : {}),
    }),
    reason,
  ]);
}

export interface MeaningChanges {
  permissions?: string[];
  independentOf?: string[];
  reauth?: Reauthentication;
  excludesPerformers?: boolean;
  excludesInvolved?: boolean;
  witness?: boolean;
  delegable?: boolean;
  title?: string;
  meaningText?: string;
}

/** A new version of a type (who may sign it, tightened rules). Returns the new version number. */
export async function configureMeaningType(client: pg.PoolClient, code: string, changes: MeaningChanges, reason: string): Promise<number> {
  const c: Record<string, unknown> = {};
  if (changes.permissions) c['permissions'] = changes.permissions;
  if (changes.independentOf) c['independent_of'] = changes.independentOf;
  if (changes.reauth) c['reauth'] = changes.reauth;
  if (changes.excludesPerformers !== undefined) c['excludes_performers'] = changes.excludesPerformers;
  if (changes.excludesInvolved !== undefined) c['excludes_involved'] = changes.excludesInvolved;
  if (changes.witness !== undefined) c['witness'] = changes.witness;
  if (changes.delegable !== undefined) c['delegable'] = changes.delegable;
  if (changes.title) c['title'] = changes.title;
  if (changes.meaningText) c['meaning_text'] = changes.meaningText;
  const { rows } = await client.query<{ v: number }>('select esig.configure_meaning_type($1, $2::jsonb, $3) as v', [code, JSON.stringify(c), reason]);
  return rows[0]?.v ?? 0;
}

/** Retires a customer type; a minimum type is refused (EBMR-ESIG-022). */
export async function retireMeaningType(client: pg.PoolClient, code: string, reason: string): Promise<void> {
  await client.query('select esig.retire_meaning_type($1, $2)', [code, reason]);
}

export type EsigPolicyKey =
  | 'esig.challenge_validity_seconds' | 'esig.session_relaxation' | 'esig.witness_window_seconds' | 'esig.mfa_at_signing' | 'esig.india_dsc';

/** Quality-unit change of an e-signature policy value, with a reason and a change-control reference. */
export async function setEsigPolicy(client: pg.PoolClient, key: EsigPolicyKey, value: string, reason: string, changeRef: string): Promise<void> {
  await client.query('select esig.set_policy($1, $2, $3, $4)', [key, value, reason, changeRef]);
}

export async function esigPolicyValue(db: Db, key: EsigPolicyKey): Promise<string> {
  const { rows } = await db.query<{ v: string }>('select esig.policy_text($1) as v', [key]);
  return rows[0]?.v ?? '';
}

/** Registers a seal key's ID, algorithm and (Ed25519) public key; SYSTEM.CONFIGURE. */
export async function registerSealKey(client: pg.PoolClient, key: { keyId: string; algorithm: SealAlgorithm; publicKeyPem?: string }, description: string): Promise<void> {
  await client.query('select esig.register_seal_key($1, $2, $3, $4)', [key.keyId, key.algorithm, key.publicKeyPem ?? null, description]);
}

/** Retires a seal key: no new seals; old seals stay verifiable with the archived key. */
export async function retireSealKey(client: pg.PoolClient, keyId: string, reason: string): Promise<void> {
  await client.query('select esig.retire_seal_key($1, $2)', [keyId, reason]);
}
