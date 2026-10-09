/**
 * G-10@1 Clearance checklist (module C4; SANDBOX_ONLY until Phase 3, decision D3): every item answered
 * CONFIRMED, NOT CONFIRMED or NOT APPLICABLE (nothing pre-selected), and the previous batch. NOT CONFIRMED
 * raises a blocking exception at the server; an independent checker verifies (LINE_CLEARANCE_VERIFIED).
 */
import { GenericBody } from './Generic.tsx';
import type { RendererProps } from './types.ts';

export function G10Renderer({ view }: RendererProps) {
  return <GenericBody view={view} />;
}
