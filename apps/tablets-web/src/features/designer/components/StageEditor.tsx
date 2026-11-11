/**
 * Section 5, the stages (Phase 7 slice 7j, R4; D-7j-8): the author adds a stage (its name and room; it starts with the
 * room clearance and the equipment status check), renames it, binds its rooms, adds a yield step at its end and names
 * the formula lines of its theoretical quantity (owner retest N-3), adds and removes its equipment by class
 * (the classes the document-management stand-in registers; the master pins the class it chooses), moves it up or down
 * and removes it. Each change is one undoable operation; the validator and the simulation judge the result as for any
 * other content.
 */
import { useState } from 'react';
import { routes } from '@ebmr/api-contract';
import { flow, type library } from '@ebmr/recipe-core/pure';
import { Button } from '@ebmr/ui-kit';
import { useApiQuery } from '../../../api/hooks.ts';
import { dcls } from '../classes.ts';
import { libraryDefinitionOf, newStage, type Content, type Op } from '../model/ops.ts';
import type { PaletteItem } from '../model/types.ts';
import { CommitText, Select } from './common.tsx';
import { libraryStepId } from './LibraryBlocks.tsx';

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

/**
 * Owner retest N-3: a stage's own yield. "Add a yield step" appends an approved yield or reconciliation library block at
 * the end of the stage; for each library step of the stage with a batch-size input (the theoretical quantity), the author
 * ticks the formula lines whose scaled sum it is, needed where the batch size (e.g. in tablets) does not convert to its
 * unit. Nothing is ticked for the author: the validator names the step until the firm chooses (LIB-USE-INPUT-LINES).
 */
function StageYield({ content, stage, dispatch }: { content: Content; stage: flow.StageNode; dispatch: (op: Op) => boolean }) {
  const q = useApiQuery(routes.library.list, { query: { state: 'APPROVED', edition: content.header.edition } });
  const [chosen, setChosen] = useState('');
  const yields = (q.data?.blocks ?? []).filter((b) => ((b.definition as unknown as library.BlockDefinition).roles ?? []).includes('YIELD_RECONCILIATION'));
  const steps: flow.PhaseNode[] = [];
  flow.walk(stage.body, (n) => {
    if (n.kind === 'phase') steps.push(n);
  });
  const withSize = steps.flatMap((p) => {
    const def = libraryDefinitionOf(content, p);
    return (def?.inputs ?? []).filter((i) => i.kind === 'BATCH_SIZE').map((i) => ({ step: p, input: i }));
  });
  const add = (): void => {
    const b = yields.find((x) => x.blockId === chosen);
    if (!b || stage.body.kind !== 'sequence') return;
    const ids = new Set<string>();
    flow.walk(content.procedure.body, (n) => {
      ids.add(n.id);
    });
    if (dispatch({ kind: 'ADD_LIBRARY_BLOCK', sequenceId: stage.body.id, index: stage.body.children.length, stepId: libraryStepId(content, b.code, (id) => ids.has(id)), definition: b.definition as unknown as library.BlockDefinition })) setChosen('');
  };
  return (
    <div className={dcls('stack')} data-testid={`stage-yield-${stage.id}`}>
      {stage.purpose === 'MATERIAL' && stage.body.kind === 'sequence' ? (
        <div className={dcls('inline')}>
          <Select
            label={`Yield step for ${stage.name}`}
            value={chosen}
            options={[{ value: '', label: '— choose an approved yield block —' }, ...yields.map((b) => ({ value: b.blockId, label: `${b.code} v${String(b.version)}: ${b.title}` }))]}
            onChange={setChosen}
          />
          <Button onPress={add} isDisabled={chosen === ''}>
            Add a yield step to {stage.name}
          </Button>
        </div>
      ) : null}
      {withSize.map(({ step, input }) => {
        const picked = ((step.config as { inputLines?: Record<string, string[]> }).inputLines ?? {})[input.id] ?? [];
        const set = (lines: string[]): void => {
          dispatch({ kind: 'SET_INPUT_LINES', stepId: step.id, inputId: input.id, lines });
        };
        return (
          <fieldset key={`${step.id}:${input.id}`} className={dcls('fieldset')} data-testid={`input-lines-${step.id}-${input.id}`}>
            <legend className={dcls('legend')}>{`${input.label} of ${step.name} (${input.unit}): the sum of these formula lines`}</legend>
            <p className={dcls('small')}>{`Needed when the batch size does not convert to ${input.unit}; leave all unticked to use the batch size.`}</p>
            {content.bom.map((b) => (
              <label key={b.id} className={dcls('inline')}>
                <input
                  type="checkbox"
                  aria-label={`${step.name}: ${b.id}`}
                  checked={picked.includes(b.id)}
                  onChange={(e) => set(e.target.checked ? [...picked, b.id] : picked.filter((x) => x !== b.id))}
                />{' '}
                {`${b.id} ${b.material} (${b.quantity.value} ${b.quantity.unit})`}
              </label>
            ))}
          </fieldset>
        );
      })}
    </div>
  );
}

export function StageEditor({ content, stage, first, last, earlier, dispatch }: { content: Content; stage: flow.StageNode; first: boolean; last: boolean; earlier: readonly flow.StageNode[]; dispatch: (op: Op) => boolean }) {
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
      {earlier.length > 0 ? (
        <Select
          label={`Clearance of ${stage.name}`}
          value={stage.clearanceFrom ?? ''}
          options={[{ value: '', label: 'Its own clearance step' }, ...earlier.map((e) => ({ value: e.id, label: `Continues the clearance of ${e.name} (same room or line)` }))]}
          onChange={(clearanceFrom) => dispatch({ kind: 'UPDATE_STAGE', stageId: stage.id, patch: { clearanceFrom } })}
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
      <StageYield content={content} stage={stage} dispatch={dispatch} />
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
