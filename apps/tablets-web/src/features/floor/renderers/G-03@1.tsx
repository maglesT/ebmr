/** G-03@1 Instruction and acknowledgement (module C4): the instruction as issued (step header) and the acknowledgement entry. */
import { GenericBody } from './Generic.tsx';
import type { RendererProps } from './types.ts';

export function G03Renderer({ view }: RendererProps) {
  return <GenericBody view={view} />;
}
