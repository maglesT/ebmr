/**
 * G-09@1 Equipment status, manual attestation (module C4; SANDBOX_ONLY until Phase 3, decision D3): the
 * equipment, its status label by scan and YES/NO checks. Any NO raises a blocking exception at the server.
 */
import { GenericBody } from './Generic.tsx';
import type { RendererProps } from './types.ts';

export function G09Renderer({ view }: RendererProps) {
  return <GenericBody view={view} forms={() => ({ scan: ['labelId'] })} />;
}
