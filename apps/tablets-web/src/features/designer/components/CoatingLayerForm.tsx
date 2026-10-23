/**
 * "Add a coating layer" (Phase 7 slice 7o, R4 and R8 C3; D-7o-2): beside the selected step, one more coat of the same
 * tablets: its name, coating type, suspension type, target, minimum and maximum weight gain, the validated range of the
 * tablets' mean weight before the coat and the loop's iterations. One undoable operation (model/coating-layer.ts); the
 * validator and the simulation judge the result as for any other content.
 */
import { useState } from 'react';
import { Button } from '@ebmr/ui-kit';
import { dcls } from '../classes.ts';
import { layerProblem, type CoatingLayer } from '../model/coating-layer.ts';
import type { Op } from '../model/ops.ts';
import { Select } from './common.tsx';

const TYPES = [
  { value: 'FC', label: 'Film coat (FC)' },
  { value: 'FC_F', label: 'Functional film, e.g. enteric (FC_F)' },
  { value: 'SC', label: 'Sugar coat (SC)' },
];
const SOLUTIONS = [
  { value: 'FILM_COAT', label: 'Film-coating suspension' },
  { value: 'ENTERIC', label: 'Enteric suspension' },
  { value: 'SUGAR', label: 'Sugar syrup' },
];

function Text({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label>
      {label} <input aria-label={label} className={dcls('select')} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function CoatingLayerForm({ stepId, stepName, dispatch }: { stepId: string; stepName: string; dispatch: (op: Op) => boolean | void }) {
  const [name, setName] = useState('');
  const [coatingType, setType] = useState<CoatingLayer['coatingType']>('FC');
  const [solutionType, setSolution] = useState<CoatingLayer['solutionType']>('FILM_COAT');
  const [targetGain, setTarget] = useState('');
  const [minGain, setMin] = useState('');
  const [maxGain, setMax] = useState('');
  const [coreLow, setCoreLow] = useState('');
  const [coreHigh, setCoreHigh] = useState('');
  const [iterations, setIterations] = useState('3');
  const [place, setPlace] = useState<'BEFORE' | 'AFTER'>('AFTER');
  const layer: CoatingLayer = {
    name, coatingType, solutionType, targetGain: targetGain.trim(), maxGain: maxGain.trim(), coreLow: coreLow.trim(), coreHigh: coreHigh.trim(),
    maxIterations: /^\d{1,2}$/.test(iterations.trim()) ? Number.parseInt(iterations.trim(), 10) : 0,
    ...(minGain.trim() !== '' ? { minGain: minGain.trim() } : {}),
  };
  const problem = layerProblem(layer);
  const add = (): void => {
    if (problem) return;
    if (dispatch({ kind: 'ADD_COATING_LAYER', stepId, place, layer }) !== false) {
      setName('');
      setTarget('');
      setMin('');
      setMax('');
      setCoreLow('');
      setCoreHigh('');
    }
  };
  return (
    <fieldset className={dcls('fieldset')} data-testid="add-coating-layer">
      <legend className={dcls('legend')}>Add a coating layer</legend>
      <p className={dcls('small')}>
        One more coat of the same tablets: its own suspension, its own core sample and its own coating loop to its own weight gain. The layer copies the
        settings of the master&apos;s coating step when it has one.
      </p>
      <Text label="Layer name" value={name} onChange={setName} />
      <Select label="Coating type" value={coatingType} options={TYPES} onChange={(v) => setType(v as CoatingLayer['coatingType'])} />
      <Select label="Suspension" value={solutionType} options={SOLUTIONS} onChange={(v) => setSolution(v as CoatingLayer['solutionType'])} />
      <Text label="Target weight gain (%)" value={targetGain} onChange={setTarget} />
      <Text label="Minimum weight gain (%, a functional film)" value={minGain} onChange={setMin} />
      <Text label="Maximum weight gain (%)" value={maxGain} onChange={setMax} />
      <Text label="Lowest mean tablet weight before the coat (mg)" value={coreLow} onChange={setCoreLow} />
      <Text label="Highest mean tablet weight before the coat (mg)" value={coreHigh} onChange={setCoreHigh} />
      <Text label="Coating iterations allowed (1 to 20)" value={iterations} onChange={setIterations} />
      <Select label="Where" value={place} options={[{ value: 'AFTER', label: `After ${stepName}` }, { value: 'BEFORE', label: `Before ${stepName}` }]} onChange={(v) => setPlace(v as 'BEFORE' | 'AFTER')} />
      {problem && name !== '' ? <p className={dcls('small')}>{problem}</p> : null}
      <Button onPress={add} isDisabled={problem !== null}>
        Add the coating layer
      </Button>
    </fieldset>
  );
}
