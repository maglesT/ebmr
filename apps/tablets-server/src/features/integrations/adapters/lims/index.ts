/**
 * The LIMS adapter (Phase 6 slice 6a, builder B; D-P6a-4: LIMS-lite stays the stand-in): lims.sample_result to
 * site.receive_lims_sample_result (site services 0926). No mirror data class (D-P6a-B-6). Runs on the worker framework (../framework.ts).
 */
import { LIMS } from '@ebmr/integration-sdk/adapter';
import type { FeedAdapterSpec } from '../framework.ts';

export const LIMS_ADAPTER: FeedAdapterSpec = {
  system: 'LIMS',
  prefix: 'lims',
  receive: { 'lims.sample_result': 'site.receive_lims_sample_result' },
  mirrorClasses: [],
  contract: LIMS,
};
