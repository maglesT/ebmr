/**
 * R3.9 (hosted-demo trials, October 2026): rooms and units stayed in use after their stage was signed off, and the next
 * batch could not start until someone found and ended each use. The stage sign-off now lists the rooms the batch still
 * uses for the stage and the process units it still uses, each with its "End the use" act (the person's own command, a
 * fresh badge tap on a kiosk; the database ends it and starts the unit's dirty-hold clock). An instrument booking ends
 * by itself at its planned end and is listed for information only. GMP batches only (the plant acts are GMP's).
 */
import { routes } from '@ebmr/api-contract';
import { Button, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../../api/hooks.ts';
import { ActResult, useCommand } from '../../../app/acts.tsx';
import { wcls } from '../classes.ts';
import { isGmpFloor } from '../family.ts';

const READ = [routes.batches.stepPlant.id];

export function StageInUse({ batchId, stepKey, stageKey }: { batchId: string; stepKey: string; stageKey: string }) {
  const gmp = isGmpFloor();
  const q = useApiQuery(routes.batches.stepPlant, { params: { batchId, stepKey } }, { enabled: gmp });
  const endArea = useCommand(routes.plant.endAreaOccupancy, READ, 'ending the use of the room');
  const endUnit = useCommand(routes.plant.endEquipmentUse, READ, 'ending the use of the unit');
  if (!gmp || !q.data) return null;
  const stage = stageKey.split('@')[0] ?? stageKey;
  const rooms = q.data.occupancies.filter((o) => o.stage === stage);
  const units = q.data.uses;
  const busy = endArea.busy || endUnit.busy;
  return (
    <section aria-label="Still in use" data-testid="stage-in-use">
      <h3 className={wcls('formTitle')}>Still in use by the batch</h3>
      {rooms.length === 0 && units.length === 0 ? <p className={wcls('muted')}>No room or unit is in use by the batch for this stage.</p> : null}
      <ul className={wcls('entries')}>
        {rooms.map((o) => (
          <li key={o.occupancyId} data-testid={`in-use-${o.areaCode}`}>
            <StatusChip tone="warning" label={`${o.areaCode} in use`} /> since {o.startedAt.text}{' '}
            <Button isDisabled={busy} onPress={() => void endArea.run({ params: { occupancyId: o.occupancyId }, body: {} })}>
              {`End the use of ${o.areaCode}`}
            </Button>
          </li>
        ))}
        {units.map((u) => (
          <li key={u.useId} data-testid={`in-use-${u.equipmentCode}`}>
            <StatusChip tone="warning" label={`${u.equipmentCode} ${u.kind === 'PROCESS' ? 'in use' : `booked until ${u.plannedEnd.text}`}`} />{' '}
            {u.kind === 'PROCESS' ? (
              <Button isDisabled={busy} onPress={() => void endUnit.run({ params: { useId: u.useId }, body: {} })}>
                {`End the use of ${u.equipmentCode}`}
              </Button>
            ) : (
              <span className={wcls('muted')}>The booking ends at its planned end.</span>
            )}
          </li>
        ))}
      </ul>
      <ActResult error={endArea.error ?? endUnit.error} />
    </section>
  );
}
