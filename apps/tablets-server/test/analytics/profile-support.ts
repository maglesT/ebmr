/**
 * Test support of slice 6A-6: the synthetic history's 21 press-force curves (test-kit analyticsHistory: 20 normal and
 * one abnormal) as GMP batch records whose compression step ran on one press and sent its native series.
 *
 * TEST FIXTURE: the batch records, the press, its uses and step bindings, the series chunks, the finished lots and
 * their release decisions are rows written as the database owner with triggers off (session_replication_role replica),
 * as the 6A-1 support's fixtureBatch is: the floor, the OPC UA adapter and the release are proven by their own tests
 * (recipe-core plant-alarms-series.test.ts, the release tests); here only the profile's reading of them is under test.
 */
import { randomUUID } from 'node:crypto';
import { analyticsHistory } from '@ebmr/test-kit';
import type { TestServer } from '../support/harness.ts';
import { fixtureBatch } from './support.ts';

export const PROFILE_STEP = 'compression';
export const PROFILE_TAG = 'force.main_kN';

export interface ProfileBatch {
  id: string;
  number: string;
  abnormal: boolean;
  /** The samples as stored in the press's chunk (DI-32: what the overlay must repeat). */
  samples: { sourceTime: string; serverTime: null; raw: string; value: string | null; status: string }[];
  chunkId: string;
}

async function asOwner(server: Pick<TestServer, 'db'>, statements: { text: string; values?: unknown[] }[]): Promise<void> {
  const c = await server.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    for (const s of statements) await c.query(s.text, s.values ?? []);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

/**
 * The 21 press curves of the synthetic history as GMP batches on one press (each batch on its own history day, so the
 * press's uses never overlap), every batch released; `deviationOn` lists the batch numbers (1-based) with a linked
 * deviation, which may then not be reference batches.
 */
export async function seedPressHistory(server: Pick<TestServer, 'db'>, opts: { deviationOn?: number[]; prefix?: string } = {}): Promise<{ press: string; batches: ProfileBatch[] }> {
  const h = analyticsHistory();
  const prefix = opts.prefix ?? randomUUID().slice(0, 4).toUpperCase();
  const press = `PRS-${prefix}`;
  const pressId = randomUUID();
  await asOwner(server, [{
    text: `insert into plant.equipment (id, code, name, class_code, kind, recorded_by) values ($1, $2, 'Tablet press (profile fixture)', 'TABLET_PRESS', 'PROCESS', gen_random_uuid())`,
    values: [pressId, press],
  }]);
  const batches: ProfileBatch[] = [];
  let previousUse: string | null = null;
  for (const [i, curve] of h.pressCurves.entries()) {
    const n = i + 1;
    const number = `GBP-${prefix}-${String(n).padStart(2, '0')}`;
    const id = await fixtureBatch(server, number);
    const samples = curve.samples.map((s) => ({
      sourceTime: (BigInt(Date.parse(s.source_time)) * 1000n).toString(), serverTime: null, raw: s.raw_text, value: s.status === 'BAD' ? null : s.raw_text,
      status: s.status === 'BAD' ? '0x80000000' : s.status === 'UNCERTAIN' ? '0x40000000' : '0x00000000',
    }));
    const first = BigInt(samples[0]!.sourceTime);
    const last = BigInt(samples[samples.length - 1]!.sourceTime);
    const useId = randomUUID();
    const chunkId = randomUUID();
    const lotId = randomUUID();
    await asOwner(server, [
      {
        text: `insert into plant.equipment_use (id, equipment_id, previous_use_id, batch_id, batch_ref, product_code, planned_end, cleaning_id, started_by, started_at)
               values ($1, $2, $7, $3, $4, 'EXZ-250', to_timestamp($6::numeric / 1000000) + interval '1 day', gen_random_uuid(), gen_random_uuid(), to_timestamp($5::numeric / 1000000))`,
        values: [useId, pressId, id, number, (first - 60_000_000n).toString(), (last + 60_000_000n).toString(), previousUse],
      },
      {
        text: `insert into plant.equipment_use_end (use_id, equipment_id, started_at, ended_by, ended_at, clean_hold_crossed, calibration_crossed, campaign_crossed, overran_plan)
               values ($1, $2, to_timestamp($3::numeric / 1000000), gen_random_uuid(), to_timestamp($4::numeric / 1000000), false, false, false, false)`,
        values: [useId, pressId, (first - 60_000_000n).toString(), (last + 60_000_000n).toString()],
      },
      {
        text: `insert into plant.step_equipment (batch_id, step, equipment_id, use_id, person_id, account_id, correlation_id, bound_at)
               values ($1, $2, $3, $4, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), to_timestamp($5::numeric / 1000000))`,
        values: [id, PROFILE_STEP, pressId, useId, (first - 30_000_000n).toString()],
      },
      {
        text: `insert into plant.series (id, source, subject_kind, equipment_id, tag, unit, chunk_no, from_us, to_us, sample_count, samples, chunk_hash, inbound_message_id)
               values ($1, 'OPCUA', 'EQUIPMENT', $2, $3, 'kN', $4, $5, $6, $7, $8::jsonb, repeat('c', 64), gen_random_uuid())`,
        values: [chunkId, pressId, PROFILE_TAG, n, first.toString(), last.toString(), samples.length, JSON.stringify(samples)],
      },
      {
        text: `insert into site.finished_lot (lot_id, batch_id, batch_number, edition, product_code, strength, markets, posted_by_person, posted_by_account)
               values ($1, $2, $3, 'TABLETS', 'EXZ-250', '250 mg', '{IN}', gen_random_uuid(), gen_random_uuid())`,
        values: [lotId, id, number],
      },
      {
        text: `insert into recipe.manufacturer_release_decision (lot_id, decision, signature_id, epoch, checklist, checklist_hash, content_hash, person_id, account_id, role_code, correlation_id)
               values ($1, 'RELEASED', gen_random_uuid(), repeat('a', 64), '{}', repeat('b', 64), 'fixture', gen_random_uuid(), gen_random_uuid(), 'AUTHORISED_PERSON', gen_random_uuid())`,
        values: [lotId],
      },
      ...((opts.deviationOn ?? []).includes(n) ? [{
        text: `with d as (
                 insert into site.deviation (id, ref, site_code, ref_year, ref_serial, kind, title, classification, risk_rationale, raised_by_person, raised_by_account, correlation_id)
                 values (gen_random_uuid(), $2, 'SITE-1', 2026, $3, 'DEVIATION', 'Press force sag', 'MINOR', 'fixture: a press force sag on compression', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())
                 returning id)
               insert into site.deviation_link (deviation_id, subject_kind, subject_id, subject_ref, batch_id, batch_number, edition, linked_by_person, linked_by_account)
               select d.id, 'BATCH', $1, $4, $1, $4, 'TABLETS', gen_random_uuid(), gen_random_uuid() from d`,
        values: [id, `DEV-SITE-1-2026-${String(10000 + n).padStart(5, '0')}`, 10000 + n, number],
      }] : []),
    ]);
    previousUse = useId;
    batches.push({ id, number, abnormal: curve.abnormal, samples, chunkId });
  }
  return { press, batches };
}
