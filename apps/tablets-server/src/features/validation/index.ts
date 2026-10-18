/**
 * Feature `validation` (Phase 7 slice 7g, work package WP1; GMP): binds contract namespace `validation` (validation
 * summaries, evaluation packs, records acts, interface descriptions). Empty scaffold: WP1 adds the handlers and
 * registers its signable actions (VALIDATION_SUMMARY_APPROVE, EVALUATION_PACK_APPROVE, RECORDS_ACT).
 */
import { routes } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { bindRoutes } from '../../platform/http/bind.ts';

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  bindRoutes(scope, app, routes.validation, {});
  return Promise.resolve();
}
