/**
 * Scheduled platform invariants on the tablets edition databases, GMP and sandbox: on a correct installation the
 * kernel's invariant queries return no rows for the Phase 2 schemas as well as for the kernel's own.
 *  - INV-27: every id sequence whose values leave the database is registered as protected (kernel 0900,
 *    recipe-core 0220, tablets 0260), so the restore procedure moves it past every value already handed out;
 *  - INV-16 / DI-27: platform.time_model_violations() finds nothing, and the recorded_at of every audited tablets
 *    table is registered with platform.enforce_db_time (forced to the database clock, even against owner-level
 *    code); a scale reading's recorded_us is derived from the forced recorded_at, in the row and in the answer.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gatewayActor } from '../../src/features/devices/listener.ts';
import { withActorCommand } from '../../src/platform/db/commands.ts';
import { enrol, fakeGateway } from '../devices/support.ts';
import { startServer, type TestServer } from '../support/harness.ts';

const KINDS = ['GMP', 'SANDBOX'] as const;
type Kind = (typeof KINDS)[number];
const servers = new Map<Kind, TestServer>();

function serverOf(kind: Kind): TestServer {
  const s = servers.get(kind);
  if (!s) throw new Error(`no ${kind} server`);
  return s;
}

beforeAll(async () => {
  for (const kind of KINDS) servers.set(kind, await startServer(kind));
});

afterAll(async () => {
  await Promise.all([...servers.values()].map((s) => s.close()));
});

/** The Phase 2 identifiers that leave the database, with the sequence each one is drawn from. */
const PHASE2_PROTECTED = [
  { sequence_key: 'recipe.batch_execution.batch_number', identifier_kind: 'BATCH_NUMBER', owner_module: 'recipe-core', seq: 'recipe.test_batch_number_seq' },
  { sequence_key: 'recipe.execution_disposition_proposal.id', identifier_kind: 'OTHER', owner_module: 'recipe-core', seq: 'recipe.execution_disposition_proposal_id_seq' },
  { sequence_key: 'recipe.mbr_version_log.id', identifier_kind: 'OTHER', owner_module: 'recipe-core', seq: 'recipe.mbr_version_log_id_seq' },
  { sequence_key: 'tab.attribution_method.id', identifier_kind: 'OTHER', owner_module: 'tablets-server', seq: 'tab.attribution_method_id_seq' },
  { sequence_key: 'tab.device_alarm.id', identifier_kind: 'OTHER', owner_module: 'tablets-server', seq: 'tab.device_alarm_id_seq' },
];

/** The audited tablets tables whose recorded_at is the time of the event. */
const TABLETS_RECORDED_AT = ['tab.designer_justification', 'tab.device_reading', 'tab.reference_document', 'tab.reference_document_retirement'];

for (const kind of KINDS) {
  describe(`${kind} tablets installation`, () => {
    it(`[INV-27] the scheduled invariant query finds no unprotected id sequence on a ${kind} installation; the recipe-core and tablets identifiers are registered`, async () => {
      const { admin } = serverOf(kind).db;
      const unprotected = async () => (await admin.query<{ sequence_name: string }>('select sequence_name from continuity.unprotected_sequences()')).rows.map((r) => r.sequence_name);
      expect(await unprotected()).toEqual([]);
      const { rows } = await admin.query<{ sequence_key: string; identifier_kind: string; owner_module: string; seq: string }>(
        `select sequence_key, identifier_kind, owner_module, pg_sequence::text as seq from continuity.protected_sequence
          where owner_module in ('recipe-core', 'tablets-server') order by 1`,
      );
      expect(rows).toEqual(expect.arrayContaining(PHASE2_PROTECTED));
      // The query sees the tablets schema on this installation: a sequence nobody registered is reported.
      await admin.query('create sequence tab.inv27_probe_seq');
      try {
        expect(await unprotected()).toEqual(['tab.inv27_probe_seq']);
      } finally {
        await admin.query('drop sequence tab.inv27_probe_seq');
      }
      expect(await unprotected()).toEqual([]);
    });

    it(`[DI-27][INV-16] the time-model invariant query returns no rows on a ${kind} installation; the recorded_at of every audited tablets table is forced to the database clock`, async () => {
      const { admin } = serverOf(kind).db;
      const violations = async () =>
        (await admin.query<{ table_name: string; column_name: string; problem: string }>('select table_name, column_name, problem from platform.time_model_violations()')).rows;
      expect(await violations()).toEqual([]);
      // Registered, not merely defaulted: no audited tablets table has a recorded_at outside platform.enforce_db_time.
      const { rows: unregistered } = await admin.query<{ table_name: string }>(
        `select a.table_name::text as table_name from kernel.audited_table a
           join pg_catalog.pg_attribute x on x.attrelid = a.table_name and x.attname = 'recorded_at' and not x.attisdropped
          where a.table_name::text like 'tab.%'
            and not exists (select 1 from platform.db_time_column c where c.table_name = a.table_name and c.column_name = 'recorded_at')
          order by 1`,
      );
      expect(unregistered).toEqual([]);
      const { rows: registered } = await admin.query<{ table_name: string }>(
        "select table_name::text as table_name from platform.db_time_column where table_name::text like 'tab.%' and column_name = 'recorded_at' order by 1",
      );
      expect(registered.map((r) => r.table_name)).toEqual(expect.arrayContaining(TABLETS_RECORDED_AT));
      // recorded_us is derived after the forcing trigger: the only BEFORE INSERT triggers of a reading, in firing order.
      const { rows: triggers } = await admin.query<{ tgname: string }>(
        `select tgname from pg_catalog.pg_trigger
          where tgrelid = 'tab.device_reading'::regclass and not tgisinternal and tgenabled in ('O', 'A') and tgtype & 2 = 2 and tgtype & 4 = 4
          order by tgname`,
      );
      expect(triggers.map((t) => t.tgname)).toEqual(['a0_db_time_tab_device_reading', 'a1_recorded_us']);
      // A disabled forcing trigger on a tablets table is reported by the same query.
      await admin.query('alter table tab.device_reading disable trigger a0_db_time_tab_device_reading');
      try {
        expect(await violations()).toEqual([{ table_name: 'tab.device_reading', column_name: 'recorded_at', problem: 'forcing trigger missing or disabled' }]);
      } finally {
        await admin.query('alter table tab.device_reading enable trigger a0_db_time_tab_device_reading');
      }
      expect(await violations()).toEqual([]);
    });
  });
}

describe('scale readings (sandbox)', () => {
  it('[DI-27][INV-16] a reading is recorded at the database time of its ingestion; its recorded_us is that recorded_at, in the row and in the ingestion answer', async () => {
    const server = serverOf('SANDBOX');
    const { admin } = server.db;
    await enrol(server);
    const gw = await fakeGateway(server);
    try {
      const clock = async () => (await admin.query<{ t: string }>('select clock_timestamp()::text as t')).rows[0]?.t;
      /** The stored reading, and whether it was recorded between two database clock readings. */
      const reading = async (id: string, from: string | undefined, to: string | undefined) =>
        (
          await admin.query<{ recorded_us: string; derived_us: string; in_window: boolean }>(
            `select recorded_us::text as recorded_us, platform.epoch_micros(recorded_at)::text as derived_us,
                    recorded_at between $2::timestamptz and $3::timestamptz as in_window
               from tab.device_reading where id = $1`,
            [id, from, to],
          )
        ).rows[0];

      // Through the gateway listener.
      const beforeA = await clock();
      const a = gw.next();
      const res = await gw.uplink([{ reading: a }]);
      const afterA = await clock();
      expect(res.status).toBe(200);
      expect(res.body.results.map((x) => x.outcome)).toEqual(['INGESTED']);
      const rowA = await reading(a.readingId, beforeA, afterA);
      expect(rowA?.in_window).toBe(true);
      expect(rowA?.recorded_us).toBe(rowA?.derived_us);

      // A direct call answers with the stored recorded_us, not a clock reading of its own.
      const { rows } = await server.db.app.query<{ r: Record<string, unknown> | null }>('select tab.resolve_gateway_session($1) as r', [
        createHash('sha256').update(gw.token).digest('hex'),
      ]);
      const s = rows[0]?.r;
      if (!s) throw new Error('the fake gateway session did not resolve');
      const actor = gatewayActor(
        {
          tokenHash: '',
          sessionId: String(s['session_id']),
          personId: String(s['person_id']),
          accountId: String(s['account_id']),
          deviceId: String(s['device_id']),
          legalName: String(s['legal_name']),
          state: 'ACTIVE',
          chainId: String(s['chain_id']),
          gatewayCode: 'TEST-GW-01',
          publicKeySpki: '',
          roles: ['SERVICE_ACCOUNT'],
        },
        server.config.siteZone,
        randomUUID(),
      );
      const b = gw.next();
      const beforeB = await clock();
      const answer = await withActorCommand(server.db.app, actor, async (c) =>
        (await c.query<{ r: { outcome: string; recordedUs: string } }>('select tab.ingest_reading($1::jsonb, 0) as r', [JSON.stringify(b)])).rows[0]?.r,
      );
      const afterB = await clock();
      expect(answer?.outcome).toBe('INGESTED');
      const rowB = await reading(b.readingId, beforeB, afterB);
      expect(rowB?.in_window).toBe(true);
      expect(rowB?.recorded_us).toBe(rowB?.derived_us);
      expect(answer?.recordedUs).toBe(rowB?.recorded_us);
    } finally {
      await gw.close();
    }
  });
});
