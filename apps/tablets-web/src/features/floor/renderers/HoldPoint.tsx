/**
 * G-17@1 QA hold point (module C4): the step card of a hold point shows what QA decides on; the decision is
 * taken with "Decide the hold point" (a signature through the ceremony, QA.FLOOR_APPROVE at the server).
 */
import { st, stEnum } from '../text.ts';
import { EntryList } from './parts.tsx';
import type { RendererProps } from './types.ts';

export function HoldPointRenderer({ view }: RendererProps) {
  return (
    <>
      {view.step.dispositions.length > 0 ? <p>{st('holdPoint.decisions', { list: view.step.dispositions.map((d) => stEnum('disposition', d)).join(', ') })}</p> : null}
      <EntryList entries={view.entries} />
    </>
  );
}
