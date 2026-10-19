/**
 * The signature catalogue and the record-seal keys from a screen (Phase 7 slice 7g-3, work package WP1; decision 0025;
 * kernel 0210, 0220, 1195). A customer signature point (esig.add_meaning_type) and a new version of a meaning type
 * (esig.configure_meaning_type) are configuration of area ESIG_MEANING: the database writes them only under an approved
 * change record covering it (EBMR-CFG-001 to -004), which this module puts in the command's actor context, and only for
 * a person holding MBR.APPROVE who is no administrator. A seal key is retired by a person holding SYSTEM.CONFIGURE
 * (esig.retire_seal_key), with the reason and the change record it is done under in the command's context.
 */
import type pg from 'pg';
import type { RouteBody, RouteResponse, routes } from '@ebmr/api-contract';
import type { ActorContext } from '@ebmr/kernel';
import type { AppContext } from '../../platform/context.ts';
import { withActorCommand } from '../../platform/db/commands.ts';
import { refusal } from '../../platform/http/refusal.ts';

type Db = pg.Pool | pg.PoolClient;
type MeaningTypeView = RouteResponse<typeof routes.esig.addMeaningType>;
type MeaningTypeChanges = RouteBody<typeof routes.esig.configureMeaningType>['changes'];
type SealKeyView = RouteResponse<typeof routes.esig.sealKeys>['sealKeys'][number];
const us = (col: string): string => `(extract(epoch from ${col}) * 1000000)::bigint::text`;

interface MeaningRow {
  code: string; version: string; origin: 'VENDOR' | 'CUSTOMER'; status: 'ACTIVE' | 'RETIRED'; category: string; role_class: string; title: string; meaning_text: string;
  permissions: string[]; independent_of: string[]; excludes_performers: boolean; excludes_involved: boolean; witness: boolean; reauth: 'ALL_COMPONENTS' | 'SESSION_RELAXABLE';
  delegable: boolean; us: string;
}

export async function meaningTypes(app: AppContext, db: Db, code?: string): Promise<MeaningTypeView[]> {
  const { rows } = await db.query<MeaningRow>(
    `select distinct on (m.code) m.code, m.version::text, m.origin, m.status, m.category, m.role_class, m.title, m.meaning_text, m.permissions, m.independent_of,
            m.excludes_performers, m.excludes_involved, m.witness, m.reauth, m.delegable, ${us('m.recorded_at')} as us
       from esig.meaning_type m where ($1::text is null or m.code = $1)
      order by m.code, m.version desc`,
    [code ?? null],
  );
  return rows.map((r) => ({
    code: r.code, version: r.version, origin: r.origin, status: r.status, category: r.category, roleClass: r.role_class, title: r.title, meaningText: r.meaning_text,
    permissions: r.permissions, independentOf: r.independent_of, excludesPerformers: r.excludes_performers, excludesInvolved: r.excludes_involved, witness: r.witness,
    reauth: r.reauth, delegable: r.delegable, definedAt: app.formatInstant(r.us),
  }));
}

/** The database's keys for what the screen sends (snake case; members left out are left out). */
function definitionJson(c: MeaningTypeChanges): Record<string, unknown> {
  const map: Record<keyof MeaningTypeChanges, string> = {
    category: 'category', roleClass: 'role_class', title: 'title', meaningText: 'meaning_text', permissions: 'permissions', independentOf: 'independent_of',
    excludesPerformers: 'excludes_performers', excludesInvolved: 'excludes_involved', witness: 'witness', reauth: 'reauth', delegable: 'delegable', status: 'status',
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c) as [keyof MeaningTypeChanges, unknown][]) if (v !== undefined) out[map[k]] = v;
  return out;
}

const notFound = (code: string) =>
  refusal(404, { code: 'NOT_FOUND', kind: 'NOT_ALLOWED', whatHappened: `Meaning type ${code} was not found.`, why: 'It is not in the signature catalogue.', controls: ['DI-36'], whatYouCanDo: ['Reload the list.'] });

export async function addMeaningType(app: AppContext, actor: ActorContext, body: RouteBody<typeof routes.esig.addMeaningType>): Promise<MeaningTypeView> {
  const ctx = { ...actor, reasonCode: 'ESIG_MEANING', reasonText: body.reason, changeRecord: body.changeRecord };
  await withActorCommand(app.pools.app, ctx, (c) => c.query('select esig.add_meaning_type($1, $2::jsonb, $3)', [body.code, JSON.stringify(definitionJson(body.definition)), body.reason]));
  const [v] = await meaningTypes(app, app.pools.app, body.code);
  if (!v) throw notFound(body.code);
  return v;
}

export async function configureMeaningType(app: AppContext, actor: ActorContext, code: string, body: { changes: MeaningTypeChanges; changeRecord: string; reason: string }): Promise<MeaningTypeView> {
  const ctx = { ...actor, reasonCode: 'ESIG_MEANING', reasonText: body.reason, changeRecord: body.changeRecord };
  await withActorCommand(app.pools.app, ctx, (c) => c.query('select esig.configure_meaning_type($1, $2::jsonb, $3)', [code, JSON.stringify(definitionJson(body.changes)), body.reason]));
  const [v] = await meaningTypes(app, app.pools.app, code);
  if (!v) throw notFound(code);
  return v;
}

export async function sealKeys(app: AppContext, db: Db): Promise<SealKeyView[]> {
  const { rows } = await db.query<{ key_id: string; algorithm: 'HMAC-SHA256' | 'ED25519'; description: string; us: string; reason: string | null; retired_us: string | null }>(
    `select k.key_id, k.algorithm, k.description, ${us('k.recorded_at')} as us, r.reason, ${us('r.recorded_at')} as retired_us
       from esig.seal_key k left join esig.seal_key_retirement r on r.key_id = k.key_id
      order by k.recorded_at, k.key_id collate "C"`,
  );
  return rows.map((r) => ({
    keyId: r.key_id, algorithm: r.algorithm, description: r.description, registeredAt: app.formatInstant(r.us),
    retired: r.reason !== null && r.retired_us !== null ? { reason: r.reason, at: app.formatInstant(r.retired_us) } : null,
  }));
}

export async function retireSealKey(app: AppContext, actor: ActorContext, keyId: string, body: { changeRecord: string; reason: string }): Promise<SealKeyView[]> {
  const ctx = { ...actor, reasonCode: 'SEAL_KEY_RETIRE', reasonText: `${body.reason} (change record ${body.changeRecord})`, changeRecord: body.changeRecord };
  await withActorCommand(app.pools.app, ctx, async (c) => {
    try {
      await c.query('select esig.retire_seal_key($1, $2)', [keyId, body.reason]);
    } catch (e) {
      // The kernel checks SYSTEM.CONFIGURE first; then its keys (foreign key) and the single retirement per key (primary
      // key) refuse an unknown or already retired key. Said in plain words instead of an internal error; nothing is saved.
      const code = (e as { code?: string }).code;
      if (code === '23503') throw refusal(404, { code: 'NOT_FOUND', kind: 'NOT_ALLOWED', whatHappened: `Seal key ${keyId} was not found. Nothing was retired.`, why: 'It is not a record-seal key of this installation.', controls: ['DI-36'], whatYouCanDo: ['Reload the list.'] });
      if (code === '23505') throw refusal(409, { code: 'ALREADY_RETIRED', kind: 'STALE', whatHappened: `Seal key ${keyId} is already retired. Nothing was changed.`, why: 'A key is retired once.', controls: ['DI-36'], whatYouCanDo: ['Reload the list.'] });
      throw e;
    }
  });
  return sealKeys(app, app.pools.app);
}
