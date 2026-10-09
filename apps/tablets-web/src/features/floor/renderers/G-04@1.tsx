/**
 * G-04@1 Process parameter record (module C4): one NumericEntry per parameter with its unit, target and limit
 * tiers (tier and source) beside the input; each value is committed on its own with a badge tap, and the
 * server's limit verdict appears only with the recorded value (DI-28, PR-08).
 */
import { GenericBody } from './Generic.tsx';
import type { RendererProps } from './types.ts';

export function G04Renderer({ view }: RendererProps) {
  return <GenericBody view={view} />;
}
