/** G-08@1 Identification and charge-in (module C4): each dispensed container label is scanned; the server accepts only this batch's containers, once each. */
import { GenericBody } from './Generic.tsx';
import type { RendererProps } from './types.ts';

export function G08Renderer({ view }: RendererProps) {
  return <GenericBody view={view} />;
}
