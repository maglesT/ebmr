/**
 * The reads of slice 7g, work package 2 (decision 0025) for the administration screens: security alerts with their
 * acknowledgement and escalation (DI-19), the qualification matrix (types and requirements, kernel 0130), and the device
 * configuration (the per-entry attribution of each kiosk class, decision D8; the OPC UA endpoint identities, recipe-core
 * 0961; the plant unit of each process device, tablets 0870). Every act behind them is the database's own function.
 */
import type pg from 'pg';
import type { DeviceConfigurationView, OpcuaEndpointView, QualificationRequirementView, QualificationsView, QualificationTypeView, SecurityAlertView } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';
import { notFound, roleOptions } from './people.ts';

type Db = Pick<pg.Pool, 'query'>;

/** The roles that read the qualification matrix: the administration readers and the training coordinator. */
export const QUALIFICATION_READERS = ['SYSTEM_ADMINISTRATOR', 'PROCESS_OWNER', 'BREAK_GLASS_ADMIN', 'TRAINING_COORDINATOR'] as const;
/** The roles that read the security alerts: the administration readers and QA on the shop floor (IAM.ALERT_ACKNOWLEDGE). */
export const ALERT_READERS = ['SYSTEM_ADMINISTRATOR', 'PROCESS_OWNER', 'BREAK_GLASS_ADMIN', 'QA_SHOP_FLOOR'] as const;

export async function alertViews(app: AppContext, db: Db, alertId?: string): Promise<SecurityAlertView[]> {
  const { rows } = await db.query<{ id: string; kind: string; severity: SecurityAlertView['severity']; login: string | null; person_id: string | null; device: string | null; details: unknown; us: string; escalated: boolean; ack: { by: string; comment: string | null; us: string } | null }>(
    `select a.id, a.kind, a.severity, ac.login_name as login, coalesce(a.person_id, ac.person_id) as person_id, d.code as device, a.details, ${usOf('a.raised_at')} as us,
            exists (select 1 from iam.security_alert_action x where x.alert_id = a.id and x.action = 'ESCALATED') as escalated,
            (select jsonb_build_object('by', x.by_person, 'comment', x.comment, 'us', ${usOf('x.recorded_at')})
               from iam.security_alert_action x where x.alert_id = a.id and x.action = 'ACKNOWLEDGED') as ack
       from iam.security_alert a left join iam.account ac on ac.id = a.account_id left join iam.device d on d.id = a.device_id
      where $1::uuid is null or a.id = $1::uuid
      order by (exists (select 1 from iam.security_alert_action x where x.alert_id = a.id and x.action = 'ACKNOWLEDGED')), a.raised_at desc, a.id
      limit 200`,
    [alertId ?? null],
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.person_id, r.ack?.by]));
  return rows.map((r) => ({
    alertId: r.id,
    kind: r.kind,
    severity: r.severity,
    loginName: r.login,
    person: r.person_id ? personRef(people, r.person_id, 'PERSON') : null,
    deviceCode: r.device,
    details: JSON.stringify(r.details ?? {}),
    raisedAt: app.formatInstant(r.us),
    escalated: r.escalated,
    acknowledgement: r.ack ? { by: personRef(people, r.ack.by, 'SECURITY'), comment: r.ack.comment ?? '', at: app.formatInstant(r.ack.us) } : null,
  }));
}

export async function oneAlert(app: AppContext, db: Db, alertId: string): Promise<SecurityAlertView> {
  const [v] = await alertViews(app, db, alertId);
  if (!v) throw notFound('security alert');
  return v;
}

export async function qualificationTypes(db: Db, code?: string): Promise<QualificationTypeView[]> {
  const { rows } = await db.query<QualificationTypeView>(
    'select code, name, description from iam.qualification_type where $1::text is null or code = $1::text order by code limit 1000',
    [code ?? null],
  );
  return rows;
}

export async function requirementViews(app: AppContext, db: Db, requirementId?: string): Promise<QualificationRequirementView[]> {
  const { rows } = await db.query<{ id: string; q: string; role: string | null; perm: string | null; site: string | null; area: string | null; product: string | null; reason: string; from_us: string; to_us: string | null; by: string }>(
    `select r.id, r.qualification_code as q, r.role_code as role, r.permission_code as perm, r.scope_site as site, r.scope_area as area, r.scope_product as product,
            r.reason, ${usOf('r.effective_from')} as from_us, case when r.effective_to is null then null else ${usOf('r.effective_to')} end as to_us, r.created_by_person as by
       from iam.qualification_requirement r
      where $1::uuid is null or r.id = $1::uuid
      order by (r.effective_to is null) desc, r.qualification_code, r.effective_from desc limit 2000`,
    [requirementId ?? null],
  );
  const people = await peopleOf(db, rows.map((r) => r.by));
  return rows.map((r) => ({
    requirementId: r.id,
    qualificationCode: r.q,
    roleCode: r.role,
    permissionCode: r.perm,
    scope: { site: r.site, area: r.area, product: r.product },
    reason: r.reason,
    effectiveFrom: app.formatInstant(r.from_us),
    effectiveTo: r.to_us === null ? null : app.formatInstant(r.to_us),
    createdBy: personRef(people, r.by, 'TRAINING_COORDINATOR'),
  }));
}

export async function oneRequirement(app: AppContext, db: Db, requirementId: string): Promise<QualificationRequirementView> {
  const [v] = await requirementViews(app, db, requirementId);
  if (!v) throw notFound('qualification requirement');
  return v;
}

export async function qualificationsView(app: AppContext, db: Db): Promise<QualificationsView> {
  const perms = await db.query<{ code: string }>('select code from iam.permission order by code');
  return { types: await qualificationTypes(db), requirements: await requirementViews(app, db), roles: await roleOptions(db), permissions: perms.rows.map((r) => r.code) };
}

export async function opcuaEndpointViews(app: AppContext, db: Db, deviceCode?: string): Promise<OpcuaEndpointView[]> {
  const { rows } = await db.query<{ device_code: string; version: number; status: 'ENROLLED' | 'RETIRED'; endpoint_url: string; security_policy: string; thumbprint: string; units: string[]; reason: string; by: string; us: string }>(
    `select e.device_code, e.version, e.status, e.endpoint_url, e.security_policy, e.certificate_thumbprint as thumbprint,
            array(select q.code from plant.opcua_endpoint_unit u join plant.equipment q on q.id = u.equipment_id
                   where u.endpoint_id = (select x.id from plant.opcua_endpoint x where x.device_id = e.device_id and x.status = 'ENROLLED' and x.version <= e.version order by x.version desc limit 1)
                   order by q.code) as units,
            e.reason, e.recorded_by_person as by, ${usOf('e.recorded_at')} as us
       from plant.opcua_endpoint_current e
      where $1::text is null or e.device_code = $1::text
      order by e.device_code limit 500`,
    [deviceCode ?? null],
  );
  const people = await peopleOf(db, rows.map((r) => r.by));
  return rows.map((r) => ({
    deviceCode: r.device_code,
    version: r.version,
    status: r.status,
    endpointUrl: r.endpoint_url,
    securityPolicy: r.security_policy,
    certificateThumbprint: r.thumbprint,
    equipmentCodes: r.units,
    reason: r.reason,
    recordedBy: personRef(people, r.by, 'SYSTEM_ADMINISTRATOR'),
    recordedAt: app.formatInstant(r.us),
  }));
}

export async function oneOpcuaEndpoint(app: AppContext, db: Db, deviceCode: string): Promise<OpcuaEndpointView> {
  const [v] = await opcuaEndpointViews(app, db, deviceCode);
  if (!v) throw notFound('OPC UA endpoint');
  return v;
}

export async function deviceConfigurationView(app: AppContext, db: Db): Promise<DeviceConfigurationView> {
  const methods = await db.query<{ shared: string; grade: string }>("select tab.attribution_method_for('SHARED') as shared, tab.attribution_method_for('GRADE_A_B') as grade");
  const m = methods.rows[0];
  const method = (v: string | undefined): 'TAP' | 'TAP_PIN' => (v === 'TAP_PIN' ? 'TAP_PIN' : 'TAP');
  const units = await db.query<{ id: string; device_code: string; equipment: string | null }>(
    `select b.id, b.device_code, (select q.code from tab.process_device_unit u join plant.equipment q on q.id = u.equipment_id where u.process_device_id = b.id) as equipment
       from tab.process_device b where b.ended_at is null order by b.device_code limit 500`,
  );
  return {
    attribution: [
      { deviceClass: 'SHARED', method: method(m?.shared) },
      { deviceClass: 'GRADE_A_B', method: method(m?.grade) },
    ],
    opcuaEndpoints: await opcuaEndpointViews(app, db),
    processDeviceUnits: units.rows.map((r) => ({ bindingId: r.id, deviceCode: r.device_code, equipmentCode: r.equipment })),
  };
}
