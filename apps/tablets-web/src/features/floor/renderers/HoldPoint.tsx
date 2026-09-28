/**
 * G-17@1 QA hold point (module C4): the step card of a hold point shows what QA decides on; the decision is
 * taken with "Decide the hold point" (a signature through the ceremony, QA.FLOOR_APPROVE at the server).
 */
import { EntryList } from './parts.tsx';
import type { RendererProps } from './types.ts';

export function HoldPointRenderer({ view }: RendererProps) {
  return (
    <>
      {view.step.dispositions.length > 0 ? <p>Decisions available: {view.step.dispositions.join(', ')}.</p> : null}
      <EntryList entries={view.entries} />
    </>
  );
}
