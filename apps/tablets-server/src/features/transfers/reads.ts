/**
 * The reads of the transfers namespace (Phase 6 slice 6i; contract ns/transfers.ts; kernel 1220, site services 0980,
 * 0981). Every value is the database's: the installation identity and peers, the outbound packages with their stored
 * payload and seal, the receipts with the carried content, the rule resolutions re-resolved at this site and the hold
 * time left at database time, and the installation alarms.
 */
import type pg from 'pg';
import type {
  InstallationAlarmView,
  InstallationIdentityView,
  PeerInstallationView,
  TransferPackageFileView,
  TransferPackageView,
  TransferReceiptSummaryView,
  TransferReceiptView,
} from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';
import type { InstallationKey } from './keys.ts';

type Db = Pick<pg.Pool, 'query'>;

const notFound = (code: string, what: string) =>
  refusal(404, { code, kind: 'INVALID_INPUT', whatHappened: `There is no such ${what}.`, whatYouCanDo: [`Open the ${what} from its list.`], controls: ['DI-31'] });

export async function identity(db: Db, key: InstallationKey | null): Promise<InstallationIdentityView | null> {
  const { rows } = await db.query<{ code: string; site: string; edition: 'TABLETS' | 'INJECTABLES'; fp: string; version: number; pk: string }>(
    `select i.installation_code as code, i.site_code as site, i.edition, i.key_fingerprint as fp, i.version, encode(i.public_key, 'base64') as pk
       from platform.installation_identity i order by i.version desc limit 1`);
  const r = rows[0];
  if (!r) return null;
  return { installationCode: r.code, siteCode: r.site, edition: r.edition, keyFingerprint: r.fp, keyVersion: r.version, serverHoldsKey: key?.publicKey === r.pk && key.installationCode === r.code };
}

interface PeerRow {
  id: string;
  installation_code: string;
  site_code: string;
  edition: 'TABLETS' | 'INJECTABLES';
  base_url: string;
  key_fingerprint: string;
  state: PeerInstallationView['state'];
  proposed_by_person: string;
  proposed_us: string;
  approved_by_person: string | null;
  approved_us: string | null;
}

export async function peers(app: AppContext, db: Db, id?: string): Promise<PeerInstallationView[]> {
  const { rows } = await db.query<PeerRow>(
    `select p.id, p.installation_code, p.site_code, p.edition, p.base_url, p.key_fingerprint, platform.peer_installation_state(p.id) as state,
            p.proposed_by_person, ${usOf('p.proposed_at')} as proposed_us, a.approved_by_person, case when a.peer_id is null then null else ${usOf('a.approved_at')} end as approved_us
       from platform.peer_installation p left join platform.peer_installation_approval a on a.peer_id = p.id
      where $1::uuid is null or p.id = $1::uuid
      order by p.installation_code, p.proposed_at desc`, [id ?? null]);
  const people = await peopleOf(db, rows.flatMap((r) => [r.proposed_by_person, r.approved_by_person]));
  return rows.map((r) => ({
    peerId: r.id,
    installationCode: r.installation_code,
    siteCode: r.site_code,
    edition: r.edition,
    baseUrl: r.base_url,
    keyFingerprint: r.key_fingerprint,
    state: r.state,
    proposedBy: personRef(people, r.proposed_by_person, 'SYSTEM_ADMINISTRATOR'),
    proposedAt: app.formatInstant(r.proposed_us),
    approvedBy: r.approved_by_person ? personRef(people, r.approved_by_person, 'QA') : null,
    approvedAt: r.approved_us ? app.formatInstant(r.approved_us) : null,
  }));
}

interface PackageRow {
  id: string;
  package_no: string;
  lot_id: string;
  lot_code: string;
  material_code: string;
  material_name: string;
  destination_installation: string;
  quantity: string;
  unit: string;
  status: string;
  hold_us: string;
  hold_basis: TransferPackageView['holdBasis'];
  rules: number;
  sealed: boolean;
  prepared_by_person: string;
  prepared_us: string;
}

export async function packages(app: AppContext, db: Db, id?: string): Promise<TransferPackageView[]> {
  const { rows } = await db.query<PackageRow>(
    `select p.id, p.package_no, p.lot_id, l.lot_code, l.material_code, l.material_name, p.destination_installation, p.quantity::text as quantity, p.unit,
            p.payload::jsonb -> 'status' ->> 'state' as status, p.payload::jsonb -> 'hold' ->> 'untilUs' as hold_us, p.payload::jsonb -> 'hold' ->> 'basis' as hold_basis,
            jsonb_array_length(p.payload::jsonb -> 'ruleResolutions') as rules, exists (select 1 from site.transfer_package_seal s where s.package_id = p.id) as sealed,
            p.prepared_by_person, ${usOf('p.prepared_at')} as prepared_us
       from site.transfer_package p join site.material_lot l on l.id = p.lot_id
      where $1::uuid is null or p.id = $1::uuid
      order by p.prepared_at desc, p.id limit 200`, [id ?? null]);
  const people = await peopleOf(db, rows.map((r) => r.prepared_by_person));
  return rows.map((r) => ({
    packageId: r.id,
    packageNo: r.package_no,
    lotId: r.lot_id,
    lotCode: r.lot_code,
    materialCode: r.material_code,
    materialName: r.material_name,
    destination: r.destination_installation,
    quantity: r.quantity,
    unit: r.unit,
    status: r.status,
    holdUntil: app.formatInstant(r.hold_us),
    holdBasis: r.hold_basis,
    ruleCount: r.rules,
    sealed: r.sealed,
    preparedBy: personRef(people, r.prepared_by_person, 'WAREHOUSE_LABELLING'),
    preparedAt: app.formatInstant(r.prepared_us),
  }));
}

export async function packageFile(db: Db, id: string): Promise<TransferPackageFileView> {
  const { rows } = await db.query<{ id: string; package_no: string; payload: string; seal: string }>(
    'select p.id, p.package_no, p.payload, s.seal from site.transfer_package p join site.transfer_package_seal s on s.package_id = p.id where p.id = $1', [id]);
  const r = rows[0];
  if (!r) throw notFound('EBMR-XFR-017', 'sealed transfer package');
  return { packageId: r.id, packageNo: r.package_no, fileName: `XFR-${r.package_no.replace(/[^A-Z0-9-]/g, '-')}.json`, payload: r.payload, seal: r.seal };
}

interface ReceiptRow {
  id: string;
  package_id: string;
  package_no: string;
  origin_installation: string;
  origin_lot_code: string;
  origin_state: string;
  lot_id: string;
  lot_code: string;
  lot_state: string;
  material_code: string;
  material_name: string;
  quantity: string;
  unit: string;
  hold_us: string;
  hold_left: string;
  state: TransferReceiptSummaryView['state'];
  received_by_person: string;
  received_us: string;
  decision: { decision: 'ACCEPTED' | 'REFUSED'; reason: string | null; person: string; us: string; signature_id: string } | null;
}

const RECEIPTS = `select r.id, r.package_id, r.package_no, r.origin_installation, r.origin_lot_code, r.origin_state, r.lot_id, l.lot_code, (select s.state from platform.aggregate_state s where s.aggregate_type = 'material_lot' and s.aggregate_id = l.id) as lot_state,
                         l.material_code, l.material_name, l.received_quantity::text as quantity, l.unit, ${usOf('r.hold_until')} as hold_us,
                         floor(extract(epoch from site.transfer_hold_remaining(r.id)))::bigint::text as hold_left, site.transfer_receipt_state(r.id) as state,
                         r.received_by_person, ${usOf('r.received_at')} as received_us,
                         (select jsonb_build_object('decision', a.decision, 'reason', a.reason, 'person', a.decided_by_person, 'us', ${usOf('a.decided_at')}, 'signature_id', a.signature_id)
                            from site.transfer_acceptance a where a.receipt_id = r.id) as decision
                    from site.transfer_receipt r join site.material_lot l on l.id = r.lot_id`;

async function receiptSummaries(app: AppContext, db: Db, rows: ReceiptRow[]): Promise<TransferReceiptSummaryView[]> {
  const people = await peopleOf(db, rows.flatMap((r) => [r.received_by_person, r.decision?.person]));
  return rows.map((r) => ({
    receiptId: r.id,
    packageId: r.package_id,
    packageNo: r.package_no,
    origin: r.origin_installation,
    originLotCode: r.origin_lot_code,
    originState: r.origin_state,
    lotId: r.lot_id,
    lotCode: r.lot_code,
    lotState: r.lot_state,
    materialCode: r.material_code,
    materialName: r.material_name,
    quantity: r.quantity,
    unit: r.unit,
    holdUntil: app.formatInstant(r.hold_us),
    holdRemainingSeconds: r.hold_left,
    state: r.state,
    receivedBy: personRef(people, r.received_by_person, 'WAREHOUSE_LABELLING'),
    receivedAt: app.formatInstant(r.received_us),
    decision: r.decision
      ? { decision: r.decision.decision, reason: r.decision.reason, by: personRef(people, r.decision.person, 'QA'), at: app.formatInstant(r.decision.us), signatureId: r.decision.signature_id }
      : null,
  }));
}

export async function receipts(app: AppContext, db: Db): Promise<TransferReceiptSummaryView[]> {
  const { rows } = await db.query<ReceiptRow>(`${RECEIPTS} order by r.received_at desc, r.id limit 200`);
  return receiptSummaries(app, db, rows);
}

interface Carried {
  status?: { decision?: { event?: string; route?: string | null; decidedAtUs?: string | null } | null };
  coa?: { testCode: string; methodReference: string; result: string; unit: string; lowerLimit: string | null; upperLimit: string | null; verdict: 'PASS' | 'FAIL' }[];
  genealogy?: { asOfUs?: string; nodes?: { kind: string; id: string }[] };
}

export async function receipt(app: AppContext, db: Db, id: string): Promise<TransferReceiptView> {
  const { rows } = await db.query<ReceiptRow & { payload: string; payload_sha256: string; markets: string[] }>(
    `select s.*, r.payload, r.payload_sha256, r.markets from (${RECEIPTS} where r.id = $1) s join site.transfer_receipt r on r.id = s.id`, [id]);
  const r = rows[0];
  if (!r) throw notFound('EBMR-XFR-030', 'transfer receipt');
  const [summary] = await receiptSummaries(app, db, [r]);
  const carried = JSON.parse(r.payload) as Carried;
  const rules = (await db.query<{ key: string; method: string; carried: string; local: string | null; resolved: string | null; winner: TransferReceiptView['rules'][number]['winner'] }>(
    `select key, method, carried_value::text as carried, local_value::text as local, resolved_value::text as resolved, winner
       from site.transfer_rule_resolution where receipt_id = $1 order by key collate "C"`, [id])).rows;
  const d = carried.status?.decision ?? null;
  // The origin's node views are quoted as the package carries them (its ids are the origin's).
  const genealogy = (carried.genealogy?.nodes ?? []) as unknown as { kind: string; id: string; label: string; code: string | null; name: string | null; sub_kind: string | null; state: string | null }[];
  return {
    ...summary!,
    originDecision: d?.event ? { event: d.event, route: d.route ?? null, decidedAt: d.decidedAtUs ? app.formatInstant(d.decidedAtUs) : null } : null,
    coa: (carried.coa ?? []).map((c) => ({ testCode: c.testCode, methodReference: c.methodReference, result: c.result, unit: c.unit, lowerLimit: c.lowerLimit ?? null, upperLimit: c.upperLimit ?? null, verdict: c.verdict })),
    markets: r.markets,
    rules,
    genealogyAsOf: carried.genealogy?.asOfUs ? app.formatInstant(carried.genealogy.asOfUs) : null,
    genealogy: genealogy.map((n) => ({ kind: n.kind as 'LOT', id: n.id, label: n.label, code: n.code, name: n.name, subKind: n.sub_kind, state: n.state })),
    payloadSha256: r.payload_sha256,
  };
}

interface AlarmRow {
  id: string;
  kind: InstallationAlarmView['kind'];
  severity: InstallationAlarmView['severity'];
  path: InstallationAlarmView['path'];
  peer_code: string | null;
  reason: string | null;
  raised_us: string;
  ack: { person: string; role: string; us: string; note: string } | null;
}

export async function alarms(app: AppContext, db: Db, id?: string): Promise<InstallationAlarmView[]> {
  const { rows } = await db.query<AlarmRow>(
    `select a.id, a.kind, a.severity, a.path, a.peer_code, coalesce(a.details ->> 'reason', a.details ->> 'detail') as reason, ${usOf('a.raised_at')} as raised_us,
            (select jsonb_build_object('person', k.acknowledged_by, 'role', k.acknowledged_role, 'us', ${usOf('k.acknowledged_at')}, 'note', k.note)
               from platform.installation_alarm_ack k where k.alarm_id = a.id) as ack
       from platform.installation_alarm a where $1::uuid is null or a.id = $1::uuid
      order by a.raised_at desc, a.id limit 200`, [id ?? null]);
  const people = await peopleOf(db, rows.map((r) => r.ack?.person));
  return rows.map((r) => ({
    alarmId: r.id,
    kind: r.kind,
    severity: r.severity,
    path: r.path,
    peer: r.peer_code,
    reason: r.reason,
    raisedAt: app.formatInstant(r.raised_us),
    acknowledgement: r.ack ? { by: personRef(people, r.ack.person, r.ack.role), at: app.formatInstant(r.ack.us), note: r.ack.note } : null,
  }));
}
