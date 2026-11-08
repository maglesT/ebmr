/**
 * Section 5, the stages (Phase 7 slice 7j, R4; D-7j-8): the author adds a stage (its name and room; it starts with the
 * room clearance and the equipment status check), renames it, binds its rooms, adds and removes its equipment by class
 * (the classes the document-management stand-in registers; the master pins the class it chooses), moves it up or down
 * and removes it. Each change is one undoable operation; the validator and the simulation judge the result as for any
 * other content.
 */
import { useState } from 'react';
import { routes } from '@ebmr/api-contract';
import type { flow } from '@ebmr/recipe-core/pure';
import { Button } from '@ebmr/ui-kit';
import { useApiQuery } from '../../../api/hooks.ts';
import { dcls } from '../classes.ts';
import { newStage, type Content, type Op } from '../model/ops.ts';
import type { PaletteItem } from '../model/types.ts';
import { CommitText, Select } from './common.tsx';

const KINDS: readonly flow.StageEquipment['kind'][] = ['PROCESS', 'INSTRUMENT', 'UTILITY'];

function EquipmentAdder({ stage, dispatch }: { stage: flow.StageNode; dispatch: (op: Op) => boolean }) {
  const docs = useApiQuery(routes.designer.referenceDocuments);
  const classes = (docs.data?.documents ?? []).filter((d) => d.kind === 'EQUIPMENT_CLASS' && d.status === 'EFFECTIVE');
  const [cls, setCls] = useState('');
  const [ref, setRef] = useState('');
  const [kind, setKind] = useState<flow.StageEquipment['kind']>('PROCESS');
  const chosen = classes.find((d) => d.refId === cls);
  const add = (): void => {
    if (!chosen) return;
    const reference: flow.Reference = { id: chosen.code, kind: 'EQUIPMENT_CLASS', code: chosen.code, version: chosen.version, hash: chosen.hash, title: chosen.title };
    if (dispatch({ kind: 'ADD_STAGE_EQUIPMENT', stageId: stage.id, equipment: { ref: ref.trim().toUpperCase(), equipmentClass: chosen.code, kind }, reference })) setRef('');
  };
  return (
    <div className={dcls('inline')} data-testid={`stage-equipment-add-${stage.id}`}>
      <Select label={`Equipment class for ${stage.name}`} value={cls} options={[{ value: '', label: 'Choose a class' }, ...classes.map((d) => ({ value: d.refId, label: `${d.title} (${d.code} v${d.version})` }))]} onChange={setCls} />
      <label>
        Equipment reference{' '}
        <input aria-label={`Equipment reference for ${stage.name}`} className={dcls('select')} value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. RMG" />
      </label>
      <Select label={`Equipment kind for ${stage.name}`} value={kind} options={KINDS.map((k) => ({ value: k, label: k.toLowerCase() }))} onChange={(v) => setKind(v as flow.StageEquipment['kind'])} />
      <Button onPress={add} isDisabled={!chosen || ref.trim() === ''}>
        Add the equipment to {stage.name}
      </Button>
    </div>
  );
}

export function StageEditor({ stage, first, last, dispatch }: { stage: flow.StageNode; first: boolean; last: boolean; dispatch: (op: Op) => boolean }) {
  return (
    <div className={dcls('stack')} data-testid={`stage-editor-${stage.id}`}>
      <CommitText label={`Name of stage ${stage.id}`} value={stage.name} onCommit={(name) => dispatch({ kind: 'UPDATE_STAGE', stageId: stage.id, patch: { name } })} />
      <CommitText label={`Rooms of ${stage.name} (comma separated)`} value={stage.binding.rooms.join(', ')} onCommit={(text) => dispatch({ kind: 'UPDATE_STAGE', stageId: stage.id, patch: { rooms: text.split(',') } })} />
      {stage.purpose === 'MATERIAL' ? (
        <CommitText
          label={`Why ${stage.name} has no yield of its own (leave empty when it ends with a yield step)`}
          value={stage.noYieldReason ?? ''}
          onCommit={(noYieldReason) => dispatch({ kind: 'UPDATE_STAGE', stageId: stage.id, patch: { noYieldReason } })}
        />
      ) : null}
      <ul className={dcls('list')}>
        {stage.binding.equipment.map((e) => (
          <li key={e.ref}>
            {e.ref}: {e.equipmentClass} ({e.kind.toLowerCase()}){' '}
            <Button variant="quiet" onPress={() => dispatch({ kind: 'REMOVE_STAGE_EQUIPMENT', stageId: stage.id, ref: e.ref })}>
              Remove {e.ref} from {stage.name}
            </Button>
          </li>
        ))}
      </ul>
      <EquipmentAdder stage={stage} dispatch={dispatch} />
      <div className={dcls('inline')}>
        <Button onPress={() => dispatch({ kind: 'MOVE_STAGE', stageId: stage.id, direction: -1 })} isDisabled={first}>
          Move {stage.name} up
        </Button>
        <Button onPress={() => dispatch({ kind: 'MOVE_STAGE', stageId: stage.id, direction: 1 })} isDisabled={last}>
          Move {stage.name} down
        </Button>
        <Button onPress={() => dispatch({ kind: 'DELETE_STAGE', stageId: stage.id })} isDisabled={first && last}>
          Remove stage {stage.name}
        </Button>
      </div>
    </div>
  );
}

/** "Add a stage": after the last stage (or a chosen one), with its name and room. */
export function AddStage({ content, stages, palette, dispatch }: { content: Content; stages: readonly flow.StageNode[]; palette: readonly PaletteItem[]; dispatch: (op: Op) => boolean }) {
  const [name, setName] = useState('');
  const [room, setRoom] = useState('');
  const [after, setAfter] = useState('');
  const last = stages[stages.length - 1]?.id ?? '';
  const add = (): void => {
    const stage = newStage(content, palette, name, room.trim().toUpperCase());
    if (dispatch({ kind: 'ADD_STAGE', afterStageId: (after || last) === '' ? null : after || last, stage })) {
      setName('');
      setRoom('');
    }
  };
  return (
    <fieldset className={dcls('fieldset')} data-testid="add-stage">
      <legend className={dcls('legend')}>Add a stage</legend>
      <label>
        Stage name <input aria-label="New stage name" className={dcls('select')} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Room <input aria-label="New stage room" className={dcls('select')} value={room} onChange={(e) => setRoom(e.target.value)} placeholder="e.g. GRAN-1" />
      </label>
      <Select label="Place it after" value={after || last} options={stages.map((s) => ({ value: s.id, label: s.name }))} onChange={setAfter} />
      <Button onPress={add} isDisabled={name.trim() === '' || room.trim() === ''}>
        Add the stage
      </Button>
    </fieldset>
  );
}
