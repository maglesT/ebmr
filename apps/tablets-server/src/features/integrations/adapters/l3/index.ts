/**
 * The serialisation L3 adapter (Phase 6 slice 6c; PR-42, D-P6c-1, D-P6c-12): l3.aggregation and l3.decommission_task to
 * tab.receive_l3_message (tablets 1231), which applies an aggregation of serialised packs into a shipper of the pool's
 * packaging order and each state of a decommissioning task; its heartbeat keeps the L3_SERIAL_STATUS mirror fresh, which
 * the release gate reads (tab.l3_release_problem: an OPEN task, or a stale mirror in MIRROR mode, keeps
 * E.RECONCILIATION_SERIAL red). Runs on the worker framework (../framework.ts); the simulator is apps/simulators'
 * serialisation L3/L4 simulator (feed under /l3/v1).
 */
import { L3, L3_MIRROR_CLASS } from '@ebmr/integration-sdk/adapter';
import type { FeedAdapterSpec } from '../framework.ts';

export const L3_ADAPTER: FeedAdapterSpec = {
  system: 'L3',
  prefix: 'l3',
  receive: { 'l3.aggregation': 'tab.receive_l3_message', 'l3.decommission_task': 'tab.receive_l3_message' },
  mirrorClasses: [L3_MIRROR_CLASS],
  contract: L3,
};
