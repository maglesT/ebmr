/** The fixed list of web features (module C0). Owners: session C0; access and audit C1; designer C2; floor C4; devices C5. */
import * as access from '../features/access/index.tsx';
import * as audit from '../features/audit/index.tsx';
import * as designer from '../features/designer/index.tsx';
import * as devices from '../features/devices/index.tsx';
import * as floor from '../features/floor/index.tsx';
import * as session from '../features/session/index.tsx';
import type { WebFeature } from './feature.ts';

export const WEB_FEATURES: readonly (readonly [string, WebFeature])[] = [
  ['session', session satisfies WebFeature],
  ['access', access satisfies WebFeature],
  ['audit', audit satisfies WebFeature],
  ['designer', designer satisfies WebFeature],
  ['floor', floor satisfies WebFeature],
  ['devices', devices satisfies WebFeature],
];
