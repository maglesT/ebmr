/**
 * The `deviceRegistry` reads (Phase 7 slice 7g-1, decision 0025; contract ns/device-registry.ts): terminals with their
 * hardening attestation, gateway keys, device bindings behind them, and integration adapters with the OPC UA feed
 * binding of slice 7a. Only public material is read (key fingerprints, never a private key).
 */
import type { AdapterView, BoundDeviceView, DeviceRegistryView, GatewayKeyView, TerminalView } from '@ebmr/api-contract';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';
import { notFound } from './people.ts';

type Db = Pick<pg.Pool, 'query'>;

export const DEVICE_REASON = 'DEVICE_ADMINISTRATION';
/** The source systems an adapter is registered for (iam.integration_adapter, kernel 1180). */
export const SOURCE_SYSTEMS = ['ERP_WMS', 'QMS', 'LIMS', 'LMS', 'CMMS', 'EMS', 'OPCUA', 'L3'] as const;

interface TerminalRow {
  id: string;
  code: string;
  device_class: TerminalView['deviceClass'];
  site_code: string;
  room_code: string | null;
  line_code: string | null;
  status: TerminalView['status'];
  status_reason: string | null;
  key_fingerprint: string;
  description: string;
  registered_by_person: string;
  registered_us: string;
  hardening: { id: string; result: string; method: string; evidence_ref: string; until_us: string | null; by: string } | null;
}

export async function terminalViews(app: AppContext, db: Db, deviceId?: string): Promise<TerminalView[]> {
  const { rows } = await db.query<TerminalRow>(
    `select d.id, d.code, d.device_class, d.site_code, d.room_code, d.line_code, d.status, d.status_reason, d.key_fingerprint, d.description,
            d.registered_by_person, ${usOf('d.registered_at')} as registered_us,
            (select jsonb_build_object('id', h.id, 'result', h.result, 'method', h.method, 'evidence_ref', h.evidence_ref,
                                       'until_us', case when h.valid_until is null then null else ${usOf('h.valid_until')} end, 'by', h.attested_by_person_id)
               from continuity.device_hardening_attestation h
              where h.device_id = d.id and not exists (select 1 from continuity.device_hardening_revocation r where r.attestation_id = h.id)
              order by h.recorded_at desc limit 1) as hardening
       from iam.device d
      where ($1::uuid is null or d.id = $1::uuid)
      order by d.device_class, d.code limit 2000`,
    [deviceId ?? null],
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.registered_by_person, r.hardening?.by]));
  return rows.map((r) => ({
    deviceId: r.id,
    code: r.code,
    deviceClass: r.device_class,
    siteCode: r.site_code,
    roomCode: r.room_code,
    lineCode: r.line_code,
    status: r.status,
    statusReason: r.status_reason,
    fingerprint: r.key_fingerprint,
    description: r.description,
    registeredBy: personRef(people, r.registered_by_person, 'SYSTEM_ADMINISTRATOR'),
    registeredAt: app.formatInstant(r.registered_us),
    hardening: r.hardening
      ? {
          attestationId: r.hardening.id,
          result: r.hardening.result,
          method: r.hardening.method,
          evidenceRef: r.hardening.evidence_ref,
          validUntil: r.hardening.until_us === null ? null : app.formatInstant(r.hardening.until_us),
          attestedBy: personRef(people, r.hardening.by, 'SYSTEM_ADMINISTRATOR'),
        }
      : null,
    hardeningRequired: r.device_class === 'SHARED' || r.device_class === 'GRADE_A_B',
  }));
}

export async function oneTerminal(app: AppContext, db: Db, deviceId: string): Promise<TerminalView> {
  const [v] = await terminalViews(app, db, deviceId);
  if (!v) throw notFound('terminal');
  return v;
}

export async function gatewayKeyViews(app: AppContext, db: Db, keyId?: string): Promise<GatewayKeyView[]> {
  const { rows } = await db.query<{ id: string; gateway_code: string; login_name: string; key_fingerprint: string; status: string; by: string; us: string; revoked_us: string | null; revoked_reason: string | null }>(
    `select k.id, k.gateway_code, a.login_name, k.key_fingerprint, k.status, k.enrolled_by_person as by, ${usOf('k.enrolled_at')} as us,
            case when k.revoked_at is null then null else ${usOf('k.revoked_at')} end as revoked_us, k.revoked_reason
       from tab.gateway_key k join iam.account a on a.id = k.account_id
      where ($1::uuid is null or k.id = $1::uuid)
      order by k.gateway_code, k.enrolled_at desc limit 500`,
    [keyId ?? null],
  );
  const people = await peopleOf(db, rows.map((r) => r.by));
  return rows.map((r) => ({
    keyId: r.id,
    gatewayCode: r.gateway_code,
    loginName: r.login_name,
    fingerprint: r.key_fingerprint,
    status: r.status,
    enrolledBy: personRef(people, r.by, 'SYSTEM_ADMINISTRATOR'),
    enrolledAt: app.formatInstant(r.us),
    revokedAt: r.revoked_us === null ? null : app.formatInstant(r.revoked_us),
    revokedReason: r.revoked_reason,
  }));
}

export async function bindingViews(app: AppContext, db: Db, binding?: { kind: BoundDeviceView['kind']; id: string }): Promise<BoundDeviceView[]> {
  const { rows } = await db.query<{ id: string; kind: BoundDeviceView['kind']; device_code: string; gateway_code: string; key_id: string; serial: string; detail: string; by: string; us: string; ended_us: string | null; ended_reason: string | null }>(
    `select * from (
       select b.id, 'BALANCE' as kind, b.device_code, k.gateway_code, k.id as key_id, b.expected_serial as serial, b.unit || ', resolution ' || b.resolution as detail,
              b.bound_by_person as by, ${usOf('b.bound_at')} as us, case when b.ended_at is null then null else ${usOf('b.ended_at')} end as ended_us, b.ended_reason, b.bound_at
         from tab.gateway_instrument b join tab.gateway_key k on k.id = b.gateway_key_id
       union all
       select b.id, 'PRINT', b.device_code, k.gateway_code, k.id, b.serial, b.kind, b.bound_by_person, ${usOf('b.bound_at')},
              case when b.ended_at is null then null else ${usOf('b.ended_at')} end, b.ended_reason, b.bound_at
         from tab.print_device b join tab.gateway_key k on k.id = b.gateway_key_id
       union all
       select b.id, 'PROCESS', b.device_code, k.gateway_code, k.id, b.serial, b.equipment_kind, b.bound_by_person, ${usOf('b.bound_at')},
              case when b.ended_at is null then null else ${usOf('b.ended_at')} end, b.ended_reason, b.bound_at
         from tab.process_device b join tab.gateway_key k on k.id = b.gateway_key_id
     ) x
     where ($1::text is null or (x.kind = $1::text and x.id = $2::uuid))
     order by (x.ended_us is null) desc, x.device_code, x.bound_at desc limit 2000`,
    [binding?.kind ?? null, binding?.id ?? null],
  );
  const people = await peopleOf(db, rows.map((r) => r.by));
  return rows.map((r) => ({
    bindingId: r.id,
    kind: r.kind,
    deviceCode: r.device_code,
    gatewayCode: r.gateway_code,
    gatewayKeyId: r.key_id,
    serial: r.serial,
    detail: r.detail,
    boundBy: personRef(people, r.by, 'SYSTEM_ADMINISTRATOR'),
    boundAt: app.formatInstant(r.us),
    endedAt: r.ended_us === null ? null : app.formatInstant(r.ended_us),
    endedReason: r.ended_reason,
  }));
}

export async function adapterViews(app: AppContext, db: Db, code?: string): Promise<AdapterView[]> {
  const { rows } = await db.query<{ id: string; code: string; source_system: string; login_name: string; device_code: string; status: string; description: string; by: string; us: string; feed: { id: string; gateway: string; by: string; us: string } | null }>(
    `select i.id, i.code, i.source_system, a.login_name, d.code as device_code, i.status, i.description, i.registered_by_person as by, ${usOf('i.registered_at')} as us,
            (select jsonb_build_object('id', b.id, 'gateway', b.gateway_code, 'by', b.bound_by_person, 'us', ${usOf('b.bound_at')})
               from tab.gateway_feed_binding b where b.adapter_id = i.id and b.ended_at is null) as feed
       from iam.integration_adapter i join iam.account a on a.id = i.account_id join iam.device d on d.id = i.device_id
      where ($1::text is null or i.code = $1::text)
      order by i.code limit 500`,
    [code ?? null],
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.by, r.feed?.by]));
  return rows.map((r) => ({
    adapterId: r.id,
    code: r.code,
    sourceSystem: r.source_system,
    loginName: r.login_name,
    deviceCode: r.device_code,
    status: r.status,
    description: r.description,
    registeredBy: personRef(people, r.by, 'SYSTEM_ADMINISTRATOR'),
    registeredAt: app.formatInstant(r.us),
    feed: r.feed ? { bindingId: r.feed.id, gatewayCode: r.feed.gateway, boundBy: personRef(people, r.feed.by, 'SYSTEM_ADMINISTRATOR'), boundAt: app.formatInstant(r.feed.us) } : null,
  }));
}

export async function oneAdapter(app: AppContext, db: Db, code: string): Promise<AdapterView> {
  const [v] = await adapterViews(app, db, code);
  if (!v) throw notFound('adapter');
  return v;
}

export async function registryView(app: AppContext, db: Db, siteCode: string | null): Promise<DeviceRegistryView> {
  const accounts = await db.query<{ id: string; login_name: string; status: string }>(
    "select id, login_name, status from iam.account where kind = 'INTEGRATION' and status <> 'DISABLED' order by login_name",
  );
  return {
    siteCode,
    terminals: await terminalViews(app, db),
    gatewayKeys: await gatewayKeyViews(app, db),
    bindings: await bindingViews(app, db),
    adapters: await adapterViews(app, db),
    integrationAccounts: accounts.rows.map((r) => ({ accountId: r.id, loginName: r.login_name, status: r.status })),
    sourceSystems: [...SOURCE_SYSTEMS],
  };
}
