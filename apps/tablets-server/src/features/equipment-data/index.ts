/**
 * Feature `equipment-data` (Phase 6 slice 6b-0, GMP): native series for the trend viewer, equipment events in the batch
 * context and the original records of simple devices (contract ns/equipment-data.ts; recipe-core 0960; DI-32, DI-49).
 * Read-only: the data arrive through the OPC UA and EMS adapters (plant.receive_series_chunk,
 * plant.receive_equipment_event) and plant.record_device_original. Every value is the database's, as received.
 * Builder A adds the series ingestion worker; builder B the equipment status board (PR-22) and line station (PR-35).
 */
import { routes, SERIES_PAGE_MAX } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { batchSeries, deviceOriginals, equipmentEvents, seriesPage, seriesTags } from './reads.ts';

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  bindRoutes(scope, app, routes.equipmentData, {
    tags: async ({ requireSession }) => {
      requireSession();
      return { tags: await seriesTags(pool) };
    },
    series: async ({ query, requireSession }) => {
      requireSession();
      return seriesPage(app, pool, { ...query, limit: query.limit === undefined ? SERIES_PAGE_MAX : Number.parseInt(query.limit, 10) });
    },
    batchSeries: async ({ params, query, requireSession }) => {
      requireSession();
      return { chunks: await batchSeries(app, pool, params.batchId, query.tag, query.step) };
    },
    events: async ({ query, requireSession }) => {
      requireSession();
      return { events: await equipmentEvents(app, pool, query.equipmentCode, query.batchId) };
    },
    originals: async ({ params, requireSession }) => {
      requireSession();
      return { records: await deviceOriginals(app, pool, params.batchId) };
    },
  });
  return Promise.resolve();
}
