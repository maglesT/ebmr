/**
 * G-22@1 Output containers (module C4): each container's tare and gross from the scale (reading ids) or, with
 * the scale offline, typed by hand on the two-person path. The container id and the net are the server's.
 */
import { ScaleStatus } from './G-07@1.tsx';
import { GenericBody } from './Generic.tsx';
import type { RendererProps } from './types.ts';

export function G22Renderer({ view }: RendererProps) {
  return (
    <>
      <p>
        <ScaleStatus view={view} />
      </p>
      <GenericBody view={view} forms={() => ({ weighing: true, required: ['intermediate'] })} />
    </>
  );
}
