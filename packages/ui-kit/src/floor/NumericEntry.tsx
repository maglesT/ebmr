/**
 * NumericEntry (module C4): the DecimalField with the floor keypad, a fixed unit, the echo before commit
 * ("You entered 12.503 kg") and the limit tiers beside the input. The value is text end to end (never a
 * JavaScript number) and is never pre-filled: the target is shown as information only. No verdict is shown
 * here; the server's limit evaluation appears with the recorded value after commit (DI-28).
 */
import type { ReactNode } from 'react';
import { DecimalField } from '../primitives/DecimalField.tsx';
import { fcls } from './classes.ts';
import { Keypad } from './Keypad.tsx';
import { LimitDisplay, type LimitViewData } from './LimitDisplay.tsx';
import { ft } from './messages.ts';

export interface NumericTarget {
  value: string;
  unit: string;
  source: string;
}

export interface NumericEntryProps {
  label: string;
  unit: string;
  /** The typed text; start from '' (never pre-filled). */
  value: string;
  onChange: (value: string) => void;
  maxDecimals?: number;
  allowNegative?: boolean;
  target?: NumericTarget | null;
  limits?: readonly LimitViewData[];
  description?: string;
  /** A problem from the server for this value (e.g. a refusal), shown under the field. */
  errorMessage?: string;
  isDisabled?: boolean;
  /** Show the on-screen keypad (default true; kiosks are used with gloves). */
  keypad?: boolean;
  /** Extra content under the input (e.g. the save button). */
  children?: ReactNode;
  name?: string;
}

export function NumericEntry({ label, unit, value, onChange, maxDecimals, allowNegative, target, limits, description, errorMessage, isDisabled, keypad = true, children, name }: NumericEntryProps) {
  const rules = { ...(maxDecimals !== undefined ? { maxDecimals } : {}), ...(allowNegative !== undefined ? { allowNegative } : {}) };
  return (
    <div className={fcls('numeric')} data-testid={`numeric-${name ?? label}`}>
      <div className={fcls('numericInput')}>
        <DecimalField
          label={label}
          unit={unit}
          value={value}
          onChange={onChange}
          {...rules}
          {...(name ? { name } : {})}
          {...(description ? { description } : {})}
          {...(errorMessage ? { errorMessage } : {})}
          {...(isDisabled !== undefined ? { isDisabled } : {})}
        />
        {keypad ? <Keypad label={label} value={value} onChange={onChange} {...rules} {...(isDisabled !== undefined ? { isDisabled } : {})} /> : null}
        {children}
      </div>
      <div className={fcls('numericSide')}>
        {target ? (
          <p className={fcls('target')}>
            {ft('numeric.target', { value: target.value, unit: target.unit })} <span className={fcls('muted')}>{ft('numeric.targetSource', { source: target.source })}</span>
          </p>
        ) : null}
        <LimitDisplay limits={limits ?? []} unit={unit} />
        <p className={fcls('muted')}>{ft('numeric.noVerdictYet')}</p>
      </div>
    </div>
  );
}
