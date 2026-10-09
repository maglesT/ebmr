/**
 * The body every renderer is built from (module C4): the step's values (computed ones shown only), the entries
 * so far and the entry forms, all from the server's view. The schema-driven fallback is this body alone.
 */
import type { RendererProps } from './types.ts';
import { EntryFormCard, EntryList, FieldEntry, type FormOptions } from './parts.tsx';

export function GenericBody({ view, forms }: RendererProps & { forms?: (kind: string) => FormOptions }) {
  return (
    <>
      {view.fields.map((f) => (
        <FieldEntry key={f.item} field={f} view={view} />
      ))}
      <EntryList entries={view.entries} />
      {view.entryForms.map((form) => (
        <EntryFormCard key={form.kind} form={form} view={view} options={forms?.(form.kind) ?? {}} />
      ))}
    </>
  );
}
