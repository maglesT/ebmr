/**
 * G-07@1 Weighing and dispensing (module C4): the lot by scan (a code; its status, expiry and identity test are
 * the server's), tare and gross captured from the room's scale through the C5 slot (reading ids only), one tap
 * to commit. When the scale is not online, the manual path is offered, clearly marked two-person. The net and
 * the dispensed total are computed by the server (INV-25) and shown only after commit.
 */
import { StatusChip } from '@ebmr/ui-kit';
import { st } from '../text.ts';
import { GenericBody } from './Generic.tsx';
import type { FormOptions } from './parts.tsx';
import type { RendererProps } from './types.ts';

/** The item the weighed containers add up to, when the step has exactly one computed device item. */
export function weighedItem(view: RendererProps['view']): string | null {
  const items = view.fields.filter((f) => f.computed && f.capture === 'DEVICE');
  return items.length === 1 ? (items[0]?.item ?? null) : null;
}

export function ScaleStatus({ view }: RendererProps) {
  const scale = view.run.scale;
  if (!scale) return null;
  return <StatusChip tone={scale.status === 'ONLINE' ? 'ok' : 'error'} label={st('reading.scale', { device: scale.deviceCode, status: scale.status })} />;
}

export function G07Renderer({ view }: RendererProps) {
  const item = weighedItem(view);
  const forms = (kind: string): FormOptions =>
    kind === 'CONTAINER_WEIGHING'
      ? { weighing: true, ...(item && !view.entryForms.some((f) => f.fields.some((x) => x.name === 'item')) ? { fixed: { item } } : {}), required: ['item', 'bomLine', 'lotCode'] }
      : { weighing: true };
  return (
    <>
      <p>
        <ScaleStatus view={view} />
      </p>
      <GenericBody view={view} forms={forms} />
    </>
  );
}
