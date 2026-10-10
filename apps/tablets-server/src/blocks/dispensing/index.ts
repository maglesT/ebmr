/**
 * The Tablets edition's dispensing blocks (Phase 3 slice 3b, builder A): TB-01@1, potency/assay/LOD-adjusted dispensing
 * with a compensating excipient. Each block version is listed with the validator catalogue's descriptor of its type.
 */
import type { blocks, flow } from '@ebmr/recipe-core/pure';
import { TB01 } from '../tb-01.ts';

export const DISPENSING_BLOCK_VERSIONS: readonly blocks.BlockVersion[] = [TB01];

/** What the validator knows of the types: TB-01 is a dispensing and calculation step, significant by nature (PR-14, PR-20). */
export const DISPENSING_BLOCK_DESCRIPTORS: readonly flow.BlockDescriptor[] = [
  {
    type: 'TB-01',
    versions: ['1'],
    edition: 'tablets',
    title: TB01.title,
    roles: ['DISPENSING', 'CALCULATION'],
    significant: true,
    phase: { allowed: true },
    requiresSystem: false,
  },
];

export { TB01 };
