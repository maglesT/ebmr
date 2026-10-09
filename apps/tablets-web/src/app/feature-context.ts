/** The web features, provided by App.tsx, so screens can list them without importing the feature list (no cycles). */
import { createContext, useContext } from 'react';
import type { WebFeature } from './feature.ts';

export const FeaturesContext = createContext<readonly (readonly [string, WebFeature])[]>([]);

export function useFeatures(): readonly (readonly [string, WebFeature])[] {
  return useContext(FeaturesContext);
}
