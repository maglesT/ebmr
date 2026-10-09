/**
 * The fixed list of feature modules (plan section 3). Owners: meta and session C0; access, esig and audit C1;
 * designer C2 (GMP); execution C3 (sandbox); devices C5 (sandbox). A module replaces only its own index.ts.
 */
import * as access from './access/index.ts';
import * as audit from './audit/index.ts';
import * as designer from './designer/index.ts';
import * as devices from './devices/index.ts';
import * as esig from './esig/index.ts';
import * as execution from './execution/index.ts';
import * as meta from './meta/index.ts';
import * as session from './session/index.ts';
import type { FeatureEntry, FeatureModule } from './types.ts';

export const FEATURES: readonly FeatureEntry[] = [
  { name: 'meta', installations: ['GMP', 'SANDBOX'], module: meta satisfies FeatureModule },
  { name: 'session', installations: ['GMP', 'SANDBOX'], module: session satisfies FeatureModule },
  { name: 'access', installations: ['GMP', 'SANDBOX'], module: access satisfies FeatureModule },
  { name: 'esig', installations: ['GMP', 'SANDBOX'], module: esig satisfies FeatureModule },
  { name: 'audit', installations: ['GMP', 'SANDBOX'], module: audit satisfies FeatureModule },
  { name: 'designer', installations: ['GMP'], module: designer satisfies FeatureModule },
  { name: 'execution', installations: ['SANDBOX'], module: execution satisfies FeatureModule },
  { name: 'devices', installations: ['SANDBOX'], module: devices satisfies FeatureModule },
];

export type { FeatureEntry, FeatureModule, FeatureSeedContext } from './types.ts';
