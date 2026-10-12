/**
 * The fixed list of feature modules (plan section 3). Owners: meta and session C0; access, esig and audit C1;
 * designer C2 (GMP); execution C3 and devices C5 on both installations since Phase 3 slice 2b (test packages and test
 * batches stay sandbox-only, the GMP batch issue GMP-only, by the contract's route installations; each installation has its
 * own gateways and scales). A module replaces only its own index.ts. Phase 3 slice 6: planning, master-data
 * (formulation library) and plant on GMP; the GMP batch family `/api/batches/*` is bound by execution (D-S6-1). Phase 4
 * slice 1: review on GMP.
 */
import * as access from './access/index.ts';
import * as audit from './audit/index.ts';
import * as designer from './designer/index.ts';
import * as devices from './devices/index.ts';
import * as esig from './esig/index.ts';
import * as execution from './execution/index.ts';
import * as masterData from './master-data/index.ts';
import * as meta from './meta/index.ts';
import * as planning from './planning/index.ts';
import * as plant from './plant/index.ts';
import * as quality from './quality/index.ts';
import * as review from './review/index.ts';
import * as session from './session/index.ts';
import type { FeatureEntry, FeatureModule } from './types.ts';

export const FEATURES: readonly FeatureEntry[] = [
  { name: 'meta', installations: ['GMP', 'SANDBOX'], module: meta satisfies FeatureModule },
  { name: 'session', installations: ['GMP', 'SANDBOX'], module: session satisfies FeatureModule },
  { name: 'access', installations: ['GMP', 'SANDBOX'], module: access satisfies FeatureModule },
  { name: 'esig', installations: ['GMP', 'SANDBOX'], module: esig satisfies FeatureModule },
  { name: 'audit', installations: ['GMP', 'SANDBOX'], module: audit satisfies FeatureModule },
  { name: 'designer', installations: ['GMP'], module: designer satisfies FeatureModule },
  { name: 'execution', installations: ['GMP', 'SANDBOX'], module: execution satisfies FeatureModule },
  { name: 'devices', installations: ['GMP', 'SANDBOX'], module: devices satisfies FeatureModule },
  { name: 'quality', installations: ['GMP'], module: quality satisfies FeatureModule },
  { name: 'planning', installations: ['GMP'], module: planning satisfies FeatureModule },
  { name: 'master-data', installations: ['GMP'], module: masterData satisfies FeatureModule },
  { name: 'plant', installations: ['GMP'], module: plant satisfies FeatureModule },
  { name: 'review', installations: ['GMP'], module: review satisfies FeatureModule },
];

export type { FeatureEntry, FeatureModule, FeatureSeedContext } from './types.ts';
