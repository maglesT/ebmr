/**
 * ChoiceGroup (module C4): one choice from a short list as large pressable options (glove-sized). Nothing is
 * pre-selected: the person chooses.
 */
import { Label, Radio, RadioGroup, Text } from 'react-aria-components';
import { cls } from '../primitives/classes.ts';
import { fcls } from './classes.ts';

export interface ChoiceOption {
  value: string;
  label: string;
}

export interface ChoiceGroupProps {
  label: string;
  options: readonly ChoiceOption[];
  value: string | null;
  onChange: (value: string) => void;
  description?: string;
  isDisabled?: boolean;
}

export function ChoiceGroup({ label, options, value, onChange, description, isDisabled }: ChoiceGroupProps) {
  return (
    <RadioGroup className={cls('field')} orientation="horizontal" value={value} onChange={onChange} isDisabled={isDisabled ?? false} isRequired>
      <Label className={cls('label')}>{label}</Label>
      <div className={fcls('answers')}>
        {options.map((o) => (
          <Radio key={o.value} value={o.value} className={fcls('answer')}>
            {o.label}
          </Radio>
        ))}
      </div>
      {description ? (
        <Text slot="description" className={cls('description')}>
          {description}
        </Text>
      ) : null}
    </RadioGroup>
  );
}
