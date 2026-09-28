/**
 * PinPad (module C1; plan section 9, floor density: 72 px keys): the PIN is kept in a ref, never in React state,
 * props or storage; only the number of digits is shown. OK hands the PIN to the caller once and clears it at once.
 * Digits, Backspace and Enter also work from a keyboard while the pad has focus.
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '../primitives/Button.tsx';
import { icls } from './classes.ts';

export interface PinPadProps {
  /** Accessible name of the pad, e.g. "Enter your PIN". */
  label?: string;
  onSubmit: (pin: string) => void;
  disabled?: boolean;
  maxLength?: number;
  minLength?: number;
}

export function PinPad({ label = 'Enter your PIN', onSubmit, disabled = false, maxLength = 12, minLength = 4 }: PinPadProps) {
  const pin = useRef('');
  const [length, setLength] = useState(0);
  const press = (d: string) => {
    if (disabled || pin.current.length >= maxLength) return;
    pin.current += d;
    setLength(pin.current.length);
  };
  const clear = () => {
    pin.current = '';
    setLength(0);
  };
  const back = () => {
    pin.current = pin.current.slice(0, -1);
    setLength(pin.current.length);
  };
  const ok = () => {
    if (disabled || pin.current.length < minLength) return;
    const value = pin.current;
    clear();
    onSubmit(value);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (/^[0-9]$/.test(e.key)) {
      press(e.key);
      e.preventDefault();
    } else if (e.key === 'Backspace') {
      back();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      ok();
      e.preventDefault();
    }
  };
  return (
    <div role="group" aria-label={label} onKeyDown={onKeyDown} className={icls('stack')}>
      <div className={icls('dots')} aria-live="polite" aria-label={`${length} digits entered`}>
        {'•'.repeat(length)}
      </div>
      <div className={icls('keypad')}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <Button key={d} className={icls('key')} onPress={() => press(d)} isDisabled={disabled}>
            {d}
          </Button>
        ))}
        <Button className={icls('key')} onPress={clear} isDisabled={disabled} aria-label="Clear">
          C
        </Button>
        <Button className={icls('key')} onPress={() => press('0')} isDisabled={disabled}>
          0
        </Button>
        <Button className={icls('key')} variant="primary" onPress={ok} isDisabled={disabled || length < minLength} aria-label="OK">
          OK
        </Button>
      </div>
    </div>
  );
}
