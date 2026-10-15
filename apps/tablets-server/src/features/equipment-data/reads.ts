/**
 * The reads of the equipmentData namespace (Phase 6 slice 6b-0; contract ns/equipment-data.ts; recipe-core 0960; DI-32,
 * DI-49): plant.series (native chunks, as received), plant.series_in_context (the chunks of a batch and step by the
 * binding windows), plant.equipment_state_event and plant.device_original.
 */
import type pg from 'pg';
import type { DeviceOriginalView, EquipmentEventView, NativeSampleView, SeriesChunkView } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';

type Db = Pick<pg.Pool, 'query'>;

interface ChunkRow {
  id: string;
  source: SeriesChunkView['source'];
  subject_kind: 'EQUIPMENT' | 'AREA';
  subject_code: string;
  tag: string;
  unit: string;
  chunk_no: string;
  from_us: string;
  to_us: string;
  chunk_hash: string;
  samples: Omit<NativeSampleView, 'quality'>[];
  received_us: string;
}

const chunkSelect = (from: string): string => `
  select x.id, x.source, x.subject_kind, coalesce(e.code, a.code) as subject_code, x.tag, x.unit, x.chunk_no::text as chunk_no, x.from_us::text as from_us,
         x.to_us::text as to_us, x.chunk_hash, x.samples, ${usOf('x.received_at')} as received_us
  from ${from} x left join plant.equipment e on e.id = x.equipment_id left join plant.area a on a.id = x.area_id`;

/** GOOD, UNCERTAIN or BAD from the two severity bits of the status code (as the integration SDK's qualityOfStatus). */
function quality(status: string): NativeSampleView['quality'] {
  const top = status.charAt(2);
  return '0123'.includes(top) ? 'GOOD' : '4567'.includes(top) ? 'UNCERTAIN' : 'BAD';
}

function chunkView(app: AppContext, r: ChunkRow): SeriesChunkView {
  return {
    seriesId: r.id,
    source: r.source,
    subject: { kind: r.subject_kind, code: r.subject_code },
    tag: r.tag,
    unit: r.unit,
    chunkNo: r.chunk_no,
    fromUs: r.from_us,
    toUs: r.to_us,
    chunkHash: r.chunk_hash,
    samples: r.samples.map((s) => ({ sourceTime: s.sourceTime, serverTime: s.serverTime, raw: s.raw, value: s.value, status: s.status, quality: quality(s.status) })),
    receivedAt: app.formatInstant(r.received_us),
  };
}

export async function seriesTags(db: Db): Promise<{ tag: string; subjectKind: 'EQUIPMENT' | 'AREA'; equipmentType: string | null; unit: string; scale: string }[]> {
  const { rows } = await db.query<{ tag: string; subject_kind: 'EQUIPMENT' | 'AREA'; equipment_type: string | null; unit: string; scale: number }>(
    'select tag, subject_kind, equipment_type, unit, scale from plant.series_tag order by subject_kind, equipment_type, tag',
  );
  return rows.map((r) => ({ tag: r.tag, subjectKind: r.subject_kind, equipmentType: r.equipment_type, unit: r.unit, scale: r.scale.toString() }));
}

export async function seriesPage(
  app: AppContext,
  db: Db,
  q: { subjectKind: 'EQUIPMENT' | 'AREA'; subjectCode: string; tag: string; fromUs: string; toUs: string; after?: string | undefined; limit: number },
): Promise<{ chunks: SeriesChunkView[]; nextAfter: string | null }> {
  const { rows } = await db.query<ChunkRow>(
    `${chunkSelect('plant.series')}
     where x.subject_kind = $1 and coalesce(e.code, a.code) = $2 and x.tag = $3 and x.to_us >= $4::bigint and x.from_us < $5::bigint
       and ($6::bigint is null or x.chunk_no > $6::bigint)
     order by x.chunk_no limit $7`,
    [q.subjectKind, q.subjectCode, q.tag, q.fromUs, q.toUs, q.after ?? null, q.limit + 1],
  );
  const page = rows.slice(0, q.limit);
  return { chunks: page.map((r) => chunkView(app, r)), nextAfter: rows.length > q.limit ? (page.at(-1)?.chunk_no ?? null) : null };
}

export async function batchSeries(app: AppContext, db: Db, batchId: string, tag: string, step?: string): Promise<SeriesChunkView[]> {
  const { rows } = await db.query<ChunkRow>(`${chunkSelect('plant.series_in_context($1, $2, $3)')} order by x.from_us`, [batchId, step ?? null, tag]);
  return rows.map((r) => chunkView(app, r));
}

export async function equipmentEvents(app: AppContext, db: Db, equipmentCode?: string, batchId?: string): Promise<EquipmentEventView[]> {
  const { rows } = await db.query<{
    id: string; source: EquipmentEventView['source']; event_id: string; code: string; kind: EquipmentEventView['kind']; state: EquipmentEventView['state'];
    recipe_version: string | null; message: string; occurred_us: string; batch_id: string | null; step: string | null; received_us: string;
  }>(
    `select v.id, v.source, v.event_id, e.code, v.kind, v.state, v.recipe_version, v.message, v.occurred_source_us::text as occurred_us, v.batch_id, v.step,
            ${usOf('v.received_at')} as received_us
     from plant.equipment_state_event v join plant.equipment e on e.id = v.equipment_id
     where ($1::text is null or e.code = $1) and ($2::uuid is null or v.batch_id = $2)
     order by v.occurred_source_us desc limit 500`,
    [equipmentCode ?? null, batchId ?? null],
  );
  return rows.map((r) => ({
    eventId: r.id,
    source: r.source,
    sourceEventId: r.event_id,
    equipmentCode: r.code,
    kind: r.kind,
    state: r.state,
    recipeVersion: r.recipe_version,
    message: r.message,
    occurredAtSource: app.formatInstant(r.occurred_us),
    batchId: r.batch_id,
    step: r.step,
    receivedAt: app.formatInstant(r.received_us),
  }));
}

export async function deviceOriginals(app: AppContext, db: Db, batchId: string): Promise<DeviceOriginalView[]> {
  const { rows } = await db.query<{
    id: string; code: string; capture: DeviceOriginalView['capture']; device_ref: string | null; raw_output: string | null; value: string; unit: string;
    device_us: string | null; ticket_sha256: string | null; ticket_ref: string | null; step: string; entry_ref: string | null; person_id: string; role_code: string | null;
    recorded_us: string;
  }>(
    `select d.id, e.code, d.capture, d.device_ref, d.raw_output, d.value, d.unit, d.device_time_us::text as device_us, d.ticket_sha256, d.ticket_ref, d.step,
            d.entry_ref, d.person_id, d.role_code, ${usOf('d.recorded_at')} as recorded_us
     from plant.device_original d join plant.equipment e on e.id = d.equipment_id
     where d.batch_id = $1 order by d.recorded_at, d.id`,
    [batchId],
  );
  const people = await peopleOf(db, rows.map((r) => r.person_id));
  return rows.map((r) => ({
    recordId: r.id,
    equipmentCode: r.code,
    capture: r.capture,
    deviceRef: r.device_ref,
    rawOutput: r.raw_output,
    value: r.value,
    unit: r.unit,
    deviceTime: r.device_us === null ? null : app.formatInstant(r.device_us),
    ticketSha256: r.ticket_sha256,
    ticketRef: r.ticket_ref,
    step: r.step,
    entryRef: r.entry_ref,
    recordedBy: personRef(people, r.person_id, r.role_code ?? ''),
    recordedAt: app.formatInstant(r.recorded_us),
  }));
}
