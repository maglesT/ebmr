/**
 * The restore procedure from the operations screen (Phase 7 slice 7g, work package 2; decision 0025; controls DI-45,
 * DI-18, DI-37; INV-08, INV-27; kernel 0600, 0720; tablets 1525). After a restore, a copy or a failover the server is
 * started on the restored database, and the procedure the kernel defines (packages/kernel/src/continuity/restore.ts) is
 * run by people on screens instead of by a tool:
 *  1. the system administrator secures the identifiers (continuity.secure_identifiers, CONTINUITY.RESTORE_OPERATE): every
 *     protected sequence moves past the external ledger's high-water marks and its login names are reserved, before
 *     anything else is written to the audit trail;
 *  2. records the restore event (continuity.record_restore_event) with the change record and the persons who approve it;
 *     the database compares the ledger's anchors with the restored chains itself (the screen cannot choose what is
 *     discarded) and the event is copied to the ledger;
 *  3. each named approver approves it with their own RESTORE_APPROVED signature (signable RESTORE_APPROVE: never the
 *     operator, never an administrator; continuity.approve_restore_event);
 *  4. the administrator completes it (continuity.after_restore): every protected source moves past the ledger, number
 *     issue resumes under the new incarnation, and the completion is copied to the ledger.
 * The high-water marks, login names and anchors always come from the server's own external ledger
 * (EBMR_NUMBER_LEDGER_FILE: DEMO-ONLY file; write-once storage in production), never from the request. These are
 * ordinary session routes: they are not answered during the maintenance of a demo load or reset
 * (platform/operations.ts MAINTENANCE_OPEN_PATHS stays as it is).
 *
 * The application role selects no restore event (tablets 0450, GOVERNANCE class): the screen reads them through
 * tab.restore_overview for the session behind the request, in a role that operates or approves a restore.
 */
import type pg from 'pg';
import { continuity, type ActorContext } from '@ebmr/kernel';
import type { RestoreEventView, RestoreMoveView, RestoreView, SignableAction } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { withActorCommand, withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { refusal } from '../../platform/http/refusal.ts';
import type { SignableActionHandler, SignableContext } from '../../platform/ports.ts';
import { contentOf, type EsigSignableContext } from '../esig/content.ts';
import { dbActHandler, refusedOutcome } from '../esig/db-acts.ts';

export const RESTORE_REASON = 'RESTORE_PROCEDURE';

/** The external ledger of this installation, or null when none is configured. */
export function restoreLedger(app: AppContext): continuity.ExternalLedger | null {
  return app.config.numberLedgerFile ? new continuity.FileLedger(app.config.numberLedgerFile, { database: app.config.database }) : null;
}

export function restoreProblem(app: AppContext): string | null {
  return app.config.numberLedgerFile
    ? null
    : 'No external continuity ledger is configured on this server (EBMR_NUMBER_LEDGER_FILE): the restore procedure moves every identifier past the marks the ledger holds, so it does not run without it.';
}

const notConfigured = (why: string) =>
  refusal(503, {
    code: 'RESTORE_NOT_CONFIGURED',
    kind: 'NOT_ENABLED',
    whatHappened: 'Nothing was done: this server does not hold the external continuity ledger.',
    why,
    controls: ['DI-45'],
    whatYouCanDo: ['Ask the system administrator to configure the external ledger of this installation.'],
    whoCanHelp: ['The system administrator'],
  });

/**
 * The ledger, or the refusal: a person without CONTINUITY.RESTORE_OPERATE is refused for that first (the database's own
 * check), so the server's configuration is told only to those who run the procedure.
 */
async function ledgerOrRefuse(app: AppContext, actor: ActorContext): Promise<continuity.ExternalLedger> {
  const ledger = restoreLedger(app);
  if (ledger) return ledger;
  await withActorCommand(app.pools.app, actor, (c) => c.query("select iam.require_permission('CONTINUITY.RESTORE_OPERATE', '{}'::jsonb)"));
  throw notConfigured(restoreProblem(app) ?? '');
}

interface EventRow {
  restoreEventId: string;
  eventKind: RestoreEventView['eventKind'];
  backupId: string | null;
  backupTakenAtUs: string | null;
  restorePointUs: string | null;
  performedAtUs: string;
  reason: string;
  changeReference: string;
  operatorPersonId: string;
  operator: string;
  approvers: { personId: string; legalName: string; approvedAtUs: string | null }[];
  status: RestoreEventView['status'];
  contentHash: string;
  discardedAnchorIds: string[];
  affectedChainKeys: string[];
  anchorComparison: { anchorId: string; status: 'MATCH' | 'DISCARDABLE' | 'UNEXPLAINED'; problems: string[] }[];
  recordedAtUs: string;
  completedAtUs: string | null;
  moves: RestoreMoveView[];
}

interface OverviewRow {
  incarnation: string;
  identifiersSecured: boolean;
  events: EventRow[];
  approverCandidates: { personId: string; legalName: string }[];
}

function eventView(app: AppContext, e: EventRow): RestoreEventView {
  const at = (us: string | null) => (us === null ? null : app.formatInstant(us));
  return {
    restoreEventId: e.restoreEventId,
    eventKind: e.eventKind,
    backupId: e.backupId,
    backupTakenAt: at(e.backupTakenAtUs),
    restorePoint: at(e.restorePointUs),
    performedAt: app.formatInstant(e.performedAtUs),
    reason: e.reason,
    changeReference: e.changeReference,
    operatorPersonId: e.operatorPersonId,
    operator: e.operator,
    approvers: e.approvers.map((a) => ({ personId: a.personId, legalName: a.legalName, approvedAt: at(a.approvedAtUs) })),
    status: e.status,
    contentHash: e.contentHash,
    discardedAnchorIds: e.discardedAnchorIds,
    affectedChainKeys: e.affectedChainKeys,
    anchorComparison: e.anchorComparison.map((c) => ({ anchorId: String(c.anchorId), status: c.status, problems: c.problems })),
    recordedAt: app.formatInstant(e.recordedAtUs),
    completedAt: at(e.completedAtUs),
    moves: e.moves,
  };
}

export async function restoreView(app: AppContext, tokenHash: string): Promise<RestoreView> {
  const { rows } = await app.pools.app.query<{ r: OverviewRow }>('select tab.restore_overview($1) as r', [tokenHash]);
  const r = rows[0]?.r;
  if (!r) throw new Error('tab.restore_overview returned nothing');
  const problem = restoreProblem(app);
  return {
    configured: problem === null,
    problem,
    incarnation: r.incarnation,
    identifiersSecured: r.identifiersSecured,
    events: r.events.map((e) => eventView(app, e)),
    approverCandidates: r.approverCandidates,
  };
}

export async function oneEvent(app: AppContext, tokenHash: string, restoreEventId: string): Promise<RestoreEventView> {
  const e = (await restoreView(app, tokenHash)).events.find((x) => x.restoreEventId === restoreEventId);
  if (!e) {
    throw refusal(404, { code: 'EBMR-API-NOT-FOUND', kind: 'STALE', whatHappened: 'The restore event was not found.', why: `No restore event ${restoreEventId}.`, whatYouCanDo: ['Reload the restore screen.'] });
  }
  return e;
}

/** The ledger's high-water marks and login names, as the database functions take them. */
async function externalMarks(ledger: continuity.ExternalLedger): Promise<{ highWater: string; loginNames: string }> {
  const marks = await continuity.ledgerHighWater(ledger);
  return {
    highWater: JSON.stringify([...marks.entries()].map(([sequence_key, value]) => ({ sequence_key, value: value.toString() }))),
    loginNames: JSON.stringify(await continuity.ledgerLoginNames(ledger)),
  };
}

interface MoveRow {
  sequence_key: string;
  source_kind: 'PG_SEQUENCE' | 'COUNTER';
  value_before: string;
  external_value: string | null;
  value_after: string;
}
const moveView = (r: MoveRow): RestoreMoveView => ({ sequenceKey: r.sequence_key, sourceKind: r.source_kind, valueBefore: r.value_before, externalValue: r.external_value, valueAfter: r.value_after });
const MOVES = 'sequence_key, source_kind, value_before::text, external_value::text, value_after::text';

interface Idem {
  idempotencyKey: string | null;
  requestHash: string;
}

/** Step 1 (header): the moves made (none when this incarnation is bound or secured already). */
export async function secureIdentifiers(app: AppContext, actor: ActorContext, idem: Idem): Promise<RestoreMoveView[]> {
  const marks = await externalMarks(await ledgerOrRefuse(app, actor));
  const { result } = await withIdempotentActorCommand(app.pools.app, actor, idem.idempotencyKey ?? '', idem.requestHash, async (c) => {
    const { rows } = await c.query<MoveRow>(`select ${MOVES} from continuity.secure_identifiers($1::jsonb, $2::jsonb, $3)`, [marks.highWater, marks.loginNames, '1000000']);
    return rows.map(moveView);
  });
  return result;
}

export interface RestoreEventInput {
  eventKind: RestoreEventView['eventKind'];
  backupId?: string | undefined;
  backupTakenAt?: string | undefined;
  restorePoint?: string | undefined;
  performedAt: string;
  reason: string;
  changeReference: string;
  approverPersonIds: string[];
}

/** Step 2 (header): the recorded event's id; the event is copied to the ledger once recorded (not again on a resend). */
export async function recordRestoreEvent(app: AppContext, actor: ActorContext, tokenHash: string, body: RestoreEventInput, idem: Idem): Promise<RestoreEventView> {
  const ledger = await ledgerOrRefuse(app, actor);
  const anchors = JSON.stringify(await continuity.ledgerAnchors(ledger));
  const event = {
    event_kind: body.eventKind,
    backup_id: body.backupId ?? null,
    backup_taken_at: body.backupTakenAt ?? null,
    restore_point: body.restorePoint ?? null,
    performed_at: body.performedAt,
    reason: body.reason,
    change_reference: body.changeReference,
    approver_person_ids: body.approverPersonIds,
  };
  const { result: id, replayed } = await withIdempotentActorCommand(app.pools.app, actor, idem.idempotencyKey ?? '', idem.requestHash, async (c: pg.PoolClient) => {
    const { rows } = await c.query<{ id: string }>('select continuity.record_restore_event($1::jsonb, $2::jsonb)::text as id', [JSON.stringify(event), anchors]);
    return rows[0]?.id ?? '';
  });
  const view = await oneEvent(app, tokenHash, id);
  if (!replayed) {
    await ledger.append({ type: 'RESTORE_EVENT', database: ledger.database, restoreEventId: id, eventKind: body.eventKind, contentHashHex: view.contentHash, discardedAnchorIds: view.discardedAnchorIds });
  }
  return view;
}

/** Step 4 (header): the moves of the completion; copied to the ledger once (not again on a resend). */
export async function completeRestore(app: AppContext, actor: ActorContext, tokenHash: string, restoreEventId: string, idem: Idem): Promise<{ event: RestoreEventView; moves: RestoreMoveView[] }> {
  const ledger = await ledgerOrRefuse(app, actor);
  const marks = await externalMarks(ledger);
  const { result: moves, replayed } = await withIdempotentActorCommand(app.pools.app, actor, idem.idempotencyKey ?? '', idem.requestHash, async (c) => {
    const { rows } = await c.query<MoveRow>(`select ${MOVES} from continuity.after_restore($1, $2::jsonb, $3, $4::jsonb)`, [restoreEventId, marks.highWater, '1000000', marks.loginNames]);
    return rows.map(moveView);
  });
  if (!replayed) {
    await ledger.append({
      type: 'RESTORE_COMPLETED',
      database: ledger.database,
      restoreEventId,
      bumps: moves.map((m) => ({ sequenceKey: m.sequenceKey, sourceKind: m.sourceKind, valueBefore: m.valueBefore, externalValue: m.externalValue, valueAfter: m.valueAfter })),
    });
  }
  return { event: await oneEvent(app, tokenHash, restoreEventId), moves };
}

type RestoreApprove = Extract<SignableAction, { kind: 'RESTORE_APPROVE' }>;

/**
 * Step 3 (header): a named approver's RESTORE_APPROVED signature of the event as recorded (restore_event <id>, state
 * RECORDED), and continuity.approve_restore_event with it in the same command: the database refuses an administrator
 * (DI-18), the operator, a person not named as approver and a second approval by the same person; a refusal signs nothing.
 */
export function restoreApproveHandler(app: AppContext): SignableActionHandler<RestoreApprove> {
  const base = restoreApproveBase(app);
  // A restore event is a GOVERNANCE-class record (tablets 0450): its content is read for the signer's own session
  // (tab.content_for_signing: a role that operates or approves restores, and that may sign RESTORE_APPROVED), never
  // through the record path the other signed acts use (tab.record_content_for_signing, RECORD class only).
  const sessionContent = async (client: pg.PoolClient, ctx: SignableContext, a: RestoreApprove) => {
    const tokenHash = (ctx as Partial<EsigSignableContext>).tokenHash ?? '';
    const { rows } = await client.query<{ r: Record<string, unknown> }>("select tab.content_for_signing($1, 'restore_event', $2, 'RESTORE_APPROVED') as r", [tokenHash, a.restoreEventId]);
    return contentOf('restore_event', a.restoreEventId, rows[0]?.r ?? {});
  };
  return {
    ...base,
    async prepareForChallenge(client, ctx, a) {
      const c = await sessionContent(client, ctx, a);
      return { contentVersion: c.contentVersion ?? '0', contentHash: c.contentHash ?? '', changed: false };
    },
    async dryRun(client, ctx, a) {
      const c = await sessionContent(client, ctx, a);
      if (!c.exists || !c.contentHash || !c.contentVersion) {
        return refusedOutcome(404, 'EBMR-API-NO-RECORD', 'The record to be signed was not found. Nothing was signed.', `restore_event ${a.restoreEventId} does not exist.`, ['DI-37'], ['Reload the screen.']);
      }
      return { accepted: true, contentHash: c.contentHash, contentVersion: c.contentVersion };
    },
  };
}

function restoreApproveBase(app: AppContext): SignableActionHandler<RestoreApprove> {
  return dbActHandler<RestoreApprove>(app, {
    kind: 'RESTORE_APPROVE',
    aggregateTypes: ['restore_event'],
    target: (a) => ({ aggregateType: 'restore_event', aggregateId: a.restoreEventId, meaning: 'RESTORE_APPROVED', expectedState: 'RECORDED' }),
    async apply(client, _ctx, a, signatureId) {
      await client.query('select continuity.approve_restore_event($1, $2)', [a.restoreEventId, signatureId]);
      return { restoreEventId: a.restoreEventId };
    },
  });
}
