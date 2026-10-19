/**
 * The plant configuration acts of slice 7g WP3 (decision 0025; MASTERDATA.CHANGE, never an administrator):
 *  - alarm codes (plant.define_alarm_code, recipe-core 0960; DI-49): a new version per change; an alarm that needs a
 *    deviation is GMP-critical;
 *  - equipment campaigns (plant.open_campaign, plant.close_campaign, recipe-core 0403; IN-26): one open campaign per unit
 *    or room, citing the validation of its cleaning interval; closing states why;
 *  - the maximum age of a utility feed's reading (plant.set_utility_feed_age, recipe-core 0522);
 *  - the line isolations of the blister register (tab.record_line_isolation, tablets 0970; IN-38).
 * The database checks the right and every rule; its refusal is answered in its own words.
 */
import type pg from 'pg';
import type { PlantConfigView, Routes } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import type { Handlers } from '../../platform/http/bind.ts';
import { compact, peopleOf, personRef, usOf } from '../common/people.ts';

type Db = pg.Pool | pg.PoolClient;
const us = (col: string): string => `case when ${col} is null then null else ${usOf(col)} end`;

export async function plantConfigView(app: AppContext, db: Db): Promise<PlantConfigView> {
  const { rows: alarms } = await db.query<{ source: PlantConfigView['alarmCodes'][number]['source']; code: string; version: number; gmp_critical: boolean; deviation_required: boolean; description: string; by: string; at_us: string }>(
    `select a.source, a.code, a.version, a.gmp_critical, a.deviation_required, a.description, a.recorded_by_person as by, ${usOf('a.recorded_at')} as at_us
       from plant.alarm_code a order by a.source, a.code, a.version desc limit 500`,
  );
  const { rows: campaigns } = await db.query<{ id: string; equipment: string | null; area: string | null; product_code: string; max_batches: string; max_days: string; validation_ref: string; opened_by: string; opened_us: string; closed_by: string | null; closed_us: string | null; close_reason: string | null }>(
    `select c.id, e.code as equipment, a.code as area, c.product_code, c.max_batches::text as max_batches, c.max_days::text as max_days, c.validation_ref,
            c.opened_by, ${usOf('c.opened_at')} as opened_us, c.closed_by, ${us('c.closed_at')} as closed_us, c.close_reason
       from plant.campaign_status c left join plant.equipment e on e.id = c.equipment_id left join plant.area a on a.id = c.area_id
      order by c.closed_at is not null, c.opened_at desc limit 200`,
  );
  const { rows: ages } = await db.query<{ class_code: string; minutes: string; by: string; at_us: string }>(
    `select distinct on (f.class_code) f.class_code, (extract(epoch from f.max_age) / 60)::numeric(10, 0)::text as minutes, f.recorded_by as by, ${usOf('f.recorded_at')} as at_us
       from plant.utility_feed_age f order by f.class_code, f.recorded_at desc`,
  );
  const { rows: classes } = await db.query<{ code: string }>("select code from plant.equipment_class where kind = 'UTILITY' order by code");
  const { rows: isolations } = await db.query<{ id: string; area: string; isolated: boolean; reference: string; by: string; at_us: string }>(
    `select i.id, a.code as area, i.isolated, i.reference, i.person_id as by, ${usOf('i.recorded_at')} as at_us
       from tab.line_isolation i join plant.area a on a.id = i.area_id order by i.recorded_at desc limit 200`,
  );
  const { rows: lines } = await db.query<{ code: string }>("select code from plant.area where kind = 'LINE' order by code");
  const people = await peopleOf(db, [...alarms.map((a) => a.by), ...campaigns.flatMap((c) => [c.opened_by, c.closed_by]), ...ages.map((a) => a.by), ...isolations.map((i) => i.by)]);
  const steward = (id: string) => personRef(people, id, 'MASTER_DATA_STEWARD');
  return {
    alarmCodes: alarms.map((a) => ({ source: a.source, code: a.code, version: a.version, gmpCritical: a.gmp_critical, deviationRequired: a.deviation_required, description: a.description, recordedBy: steward(a.by), recordedAt: app.formatInstant(a.at_us) })),
    campaigns: campaigns.map((c) => ({
      campaignId: c.id, equipmentCode: c.equipment, areaCode: c.area, product: c.product_code, maxBatches: c.max_batches, maxDays: c.max_days, validationRef: c.validation_ref,
      openedBy: steward(c.opened_by), openedAt: app.formatInstant(c.opened_us), closedBy: c.closed_by ? steward(c.closed_by) : null, closedAt: c.closed_us ? app.formatInstant(c.closed_us) : null, closeReason: c.close_reason,
    })),
    feedAges: ages.map((a) => ({ classCode: a.class_code, maxAgeMinutes: a.minutes, recordedBy: steward(a.by), recordedAt: app.formatInstant(a.at_us) })),
    utilityClasses: classes.map((c) => c.code),
    lineIsolations: isolations.map((i) => ({ isolationId: i.id, area: i.area, isolated: i.isolated, reference: i.reference, recordedBy: steward(i.by), recordedAt: app.formatInstant(i.at_us) })),
    lines: lines.map((l) => l.code),
  };
}

type PlantRoutes = 'plantConfig' | 'defineAlarmCode' | 'openCampaign' | 'closeCampaign' | 'setUtilityFeedAge' | 'recordLineIsolation';

export function plantHandlers(app: AppContext): Pick<Handlers<Routes['marketConfig']>, PlantRoutes> {
  const pool = app.pools.app;
  const run = async (actor: Parameters<typeof withIdempotentActorCommand>[1], key: string | null, hash: string, sql: string, args: unknown[]): Promise<PlantConfigView> => {
    await withIdempotentActorCommand(pool, actor, key ?? '', hash, async (c) => {
      const { rows } = await c.query<{ r: string | null }>(sql, args);
      return rows[0]?.r ?? null;
    });
    return plantConfigView(app, pool);
  };
  return {
    plantConfig: async ({ requireSession }) => {
      requireSession();
      return plantConfigView(app, pool);
    },
    defineAlarmCode: ({ body, actor, idempotencyKey, requestHash }) =>
      run(actor(), idempotencyKey, requestHash, 'select plant.define_alarm_code($1, $2, $3, $4, $5)::text as r', [body.source, body.code, body.gmpCritical, body.deviationRequired, body.description]),
    openCampaign: ({ body, actor, idempotencyKey, requestHash }) =>
      run(actor(), idempotencyKey, requestHash, 'select plant.open_campaign($1::jsonb)::text as r', [
        JSON.stringify(compact({ equipmentCode: body.equipmentCode, areaCode: body.areaCode, product: body.product, maxBatches: body.maxBatches, maxDays: body.maxDays, validationRef: body.validationRef })),
      ]),
    closeCampaign: ({ params, body, actor, idempotencyKey, requestHash }) =>
      // DI-22: the person's own reason is the command's and the closure's.
      run(actor({ reasonCode: 'CAMPAIGN_CLOSED', reasonText: body.reason }), idempotencyKey, requestHash, 'select null::text as r from (select plant.close_campaign($1, $2)) x', [params.campaignId, body.reason]),
    setUtilityFeedAge: ({ body, actor, idempotencyKey, requestHash }) =>
      run(actor(), idempotencyKey, requestHash, 'select plant.set_utility_feed_age($1, make_interval(mins => $2::integer))::text as r', [body.classCode, body.maxAgeMinutes]),
    recordLineIsolation: ({ body, actor, idempotencyKey, requestHash }) =>
      run(actor(), idempotencyKey, requestHash, 'select tab.record_line_isolation($1, $2, $3)::text as r', [body.area, body.isolated, body.reference]),
  };
}
