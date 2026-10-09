/**
 * The schema-driven fallback renderer (module C4): used for executable block versions without a dedicated
 * renderer. Inputs follow the server's FieldView and EntryFormView; entries are checked against the contract's
 * strict ClientEntry, so the fallback can send only what the contract allows.
 */
import { GenericBody } from './Generic.tsx';
import type { RendererProps } from './types.ts';

export function FallbackRenderer({ view }: RendererProps) {
  return <GenericBody view={view} />;
}
