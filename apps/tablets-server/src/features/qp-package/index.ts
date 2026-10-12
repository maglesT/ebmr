/**
 * Feature `qp-package` (Phase 4 slice 4b, GMP): the EU QP batch package of a finished lot and the QP's read-only,
 * time-boxed access to it (contract ns/qp-shipping.ts; kernel 1160; DI-41, DI-14). The rules are the database's: the
 * package hash is computed here and again by records.register_qp_package, which checks every section and true copy;
 * QA issues the package with the signable action QP_PACKAGE_ACT (TRUE_COPY_VERIFIED on qp_package <id>); the QP's reads
 * go through records.qp_reader_packages and records.read_qp_package (QP_PACKAGE.READ, a live access to the lot,
 * read permissions only; every read logged).
 */
import { routes, type LotQpView, type QpAccessView, type QpPackageView, type QpSectionView, type SignableAction } from '@ebmr/api-contract';
import { commands, records, toDbContext, type ActorContext } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { withActorCommand, withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { HttpRefusal, refusal } from '../../platform/http/refusal.ts';
import type { SignableActionHandler, SignableActionRegistry } from '../../platform/ports.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';
import { dbActHandler } from '../esig/db-acts.ts';
import { assembleProblems, buildPackageParts, lotFacts, registerPackage } from './assemble.ts';

type Db = Pick<pg.Pool, 'query'>;
type QpPackageAct = Extract<SignableAction, { kind: 'QP_PACKAGE_ACT' }>;

const noLot = (lotId: string) =>
  refusal(404, { code: 'EBMR-API-NO-LOT', kind: 'INVALID_INPUT', whatHappened: 'This finished lot was not found.', why: `${lotId} is no finished lot.`, whatYouCanDo: ['Reload the lot list.'] });

/** QP_PACKAGE_ACT ISSUE: QA's TRUE_COPY_VERIFIED over the assembled package, then records.issue_qp_package. */
export function qpPackageActHandler(app: AppContext): SignableActionHandler<QpPackageAct> {
  return dbActHandler<QpPackageAct>(app, {
    kind: 'QP_PACKAGE_ACT',
    aggregateTypes: ['qp_package'],
    target: (a) => ({ aggregateType: 'qp_package', aggregateId: a.packageId, meaning: 'TRUE_COPY_VERIFIED', expectedState: 'ASSEMBLED' }),
    async apply(client, _ctx, a, signatureId) {
      await records.issueQpPackage(client, a.packageId, signatureId);
      return { act: a.act, packageId: a.packageId };
    },
  });
}

interface PackageRow {
  id: string;
  subject_id: string;
  subject_label: string;
  package_sha256: string;
  content_bytes: string;
  sections: records.QpSection[];
  assembled_by_person: string;
  assembled_us: string;
  issued_by: string | null;
  issued_us: string | null;
  signature_id: string | null;
}

async function packages(app: AppContext, db: Db, where: string, param: string): Promise<QpPackageView[]> {
  const { rows } = await db.query<PackageRow>(
    `select p.id, p.subject_id, p.subject_label, p.package_sha256, p.content_bytes::text as content_bytes, p.sections, p.assembled_by_person,
            ${usOf('p.recorded_at')} as assembled_us, i.person_id as issued_by, case when i.package_id is null then null else ${usOf('i.recorded_at')} end as issued_us,
            i.signature_id
       from records.qp_package p left join records.qp_package_issue i on i.package_id = p.id
      where p.subject_type = 'material_lot' and ${where} = $1 order by p.recorded_at desc, p.id`,
    [param],
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.assembled_by_person, r.issued_by]));
  return rows.map((r) => ({
    packageId: r.id,
    lotId: r.subject_id,
    label: r.subject_label,
    state: r.issued_by ? 'ISSUED' : 'ASSEMBLED',
    packageSha256: r.package_sha256,
    contentBytes: Number(r.content_bytes),
    sections: r.sections.map((s): QpSectionView => ({ name: s.name, role: s.role, kind: s.kind, title: s.title, chainKey: s.kind === 'TRUE_COPY' ? s.chainKey : null, sha256: s.sha256, bytes: s.bytes })),
    assembledBy: personRef(people, r.assembled_by_person, 'QA_REVIEWER'),
    assembledAt: app.formatInstant(r.assembled_us),
    issuedBy: r.issued_by ? personRef(people, r.issued_by, 'QA_REVIEWER') : null,
    issuedAt: r.issued_us ? app.formatInstant(r.issued_us) : null,
    signatureId: r.signature_id,
  }));
}

async function accesses(app: AppContext, db: Db, where: string, param: string): Promise<QpAccessView[]> {
  const { rows } = await db.query<{
    id: string; subject_id: string; account_id: string; person_id: string; from_us: string; to_us: string; reason: string; granted_by_person: string; state: QpAccessView['state']; reads: number;
  }>(
    `select a.id, a.subject_id, a.account_id, a.person_id, ${usOf('a.valid_from')} as from_us, ${usOf('a.valid_to')} as to_us, a.reason, a.granted_by_person,
            case when exists (select 1 from records.qp_access_revocation r where r.access_id = a.id) then 'REVOKED'
                 when clock_timestamp() >= a.valid_to then 'EXPIRED' else 'LIVE' end as state,
            (select count(*)::int from records.qp_access_read x where x.access_id = a.id) as reads
       from records.qp_access a where a.subject_type = 'material_lot' and ${where} = $1 order by a.recorded_at desc, a.id`,
    [param],
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.person_id, r.granted_by_person]));
  return rows.map((r) => ({
    accessId: r.id, lotId: r.subject_id, qp: personRef(people, r.person_id, 'EU_QP_READER'), accountId: r.account_id,
    validFrom: app.formatInstant(r.from_us), validTo: app.formatInstant(r.to_us), reason: r.reason, grantedBy: personRef(people, r.granted_by_person, 'QA_REVIEWER'),
    state: r.state, reads: r.reads,
  }));
}

async function lotView(app: AppContext, db: Db, lotId: string): Promise<LotQpView> {
  const f = await lotFacts(db, lotId);
  if (!f) throw noLot(lotId);
  return { lotId, assembleProblems: assembleProblems(f), packages: await packages(app, db, 'p.subject_id', lotId), accesses: await accesses(app, db, 'a.subject_id', lotId) };
}

/** A read that needs the QP's actor context (records.qp_reader_*): the database's refusal answers as a kernel error. */
async function asReader<T>(pool: pg.Pool, who: ActorContext, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  try {
    return await withActorCommand(pool, who, work);
  } catch (error) {
    throw commands.asKernelError(error);
  }
}

/** One read-only REPEATABLE READ command of the actor: every query sees one snapshot. */
async function inSnapshot<T>(pool: pg.Pool, who: ActorContext, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin isolation level repeatable read');
    await client.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(who))]);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    if (error instanceof HttpRefusal) throw error;
    throw commands.asKernelError(error);
  } finally {
    client.release();
  }
}

async function one<T>(list: Promise<T[]>, what: string): Promise<T> {
  const x = (await list)[0];
  if (!x) throw new Error(`${what} was not found after it was recorded`);
  return x;
}

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.installation !== 'GMP') return;
  registry.register(qpPackageActHandler(app));
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  bindRoutes(scope, app, routes.qpPackage, {
    lot: async ({ params, requireSession }) => {
      requireSession();
      return lotView(app, pool, params.lotId);
    },
    assemble: async ({ params, actor, idempotencyKey, requestHash }) => {
      // Review 4b-3: the facts and every section from one snapshot (REPEATABLE READ, the assembling person's command);
      // the registration that follows is checked again by the database (records.register_qp_package).
      const built = await inSnapshot(pool, actor(), async (c) => {
        const f = await lotFacts(c, params.lotId);
        if (!f) throw noLot(params.lotId);
        const problems = assembleProblems(f);
        if (problems.length > 0) {
          throw refusal(409, { code: 'EBMR-API-QP-PACKAGE', kind: 'NOT_ALLOWED', whatHappened: 'The QP batch package cannot be assembled now. Nothing was recorded.', why: problems.join('; '), controls: ['DI-41'], whatYouCanDo: ['Assemble it after the manufacturer release, for a lot with EU in its market set.'] });
        }
        return { f, parts: await buildPackageParts(c, f) };
      });
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => (await registerPackage(c, built.f, built.parts)).packageId);
      return one(packages(app, pool, 'p.id::text', out.result), 'the package');
    },
    grantAccess: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        const { rows } = await c.query<{ id: string }>(
          "select records.grant_qp_access($1, $2, to_timestamp($3::numeric / 1000000), $4) as id",
          [params.packageId, body.accountId, body.validToUs, body.reason],
        );
        return rows[0]?.id ?? '';
      });
      return one(accesses(app, pool, 'a.id::text', out.result), 'the access');
    },
    revokeAccess: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await records.revokeQpAccess(c, params.accessId, body.reason);
        return null;
      });
      return one(accesses(app, pool, 'a.id::text', params.accessId), 'the access');
    },
    readerPackages: async ({ actor }) => {
      const list = await asReader(pool, actor(), (c) => records.qpReaderPackages(c));
      const us = await pool.query<{ i: string; u: string; v: string }>(
        `select x ->> 'packageId' as i, ${usOf("(x ->> 'issuedAt')::timestamptz")} as u, ${usOf("(x ->> 'accessValidTo')::timestamptz")} as v from jsonb_array_elements($1::jsonb) x`,
        [JSON.stringify(list)],
      );
      const byId = new Map(us.rows.map((r) => [r.i, r]));
      return {
        packages: list.map((p) => ({
          packageId: p.packageId, lotId: p.subjectId, label: p.subjectLabel, packageSha256: p.packageSha256, contentBytes: Number(p.contentBytes),
          issuedAt: app.formatInstant(byId.get(p.packageId)?.u ?? '0'), accessValidTo: app.formatInstant(byId.get(p.packageId)?.v ?? '0'),
        })),
      };
    },
    readerFile: async ({ params, actor }) => asReader(pool, actor(), (c) => records.readQpPackage(c, params.packageId)),
  });
  return Promise.resolve();
}
