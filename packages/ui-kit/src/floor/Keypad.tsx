/**
 * Keypad (module C4): a glove-sized on-screen keypad (72 px keys at floor density) that edits a decimal as text.
 * Every key goes through the same `acceptTyping` rule as the DecimalField, so the keypad can never produce a
 * number, an exponent or more characters than a decimal may hold.
 */
import { acceptTyping, type DecimalRules } from '../primitives/DecimalField.tsx';
import { Button } from '../primitives/Button.tsx';
import { fcls } from './classes.ts';
import { ft } from './messages.ts';

export interface KeypadProps extends DecimalRules {
  /** What the keypad types into (names the key group for screen readers). */
  label: string;
  value: string;
  onChange: (value: string) => void;
  isDisabled?: boolean;
}

const DIGITS = ['7', '8', '9', '4', '5', '6', '1', '2', '3'] as const;

export function Keypad({ label, value, onChange, isDisabled, maxDecimals, allowNegative }: KeypadProps) {
  const rules: DecimalRules = { ...(maxDecimals !== undefined ? { maxDecimals } : {}), ...(allowNegative !== undefined ? { allowNegative } : {}) };
  const type = (ch: string) => onChange(acceptTyping(value, value + ch, rules));
  const backspace = () => onChange(value.slice(0, -1));
  const toggleMinus = () => onChange(value.startsWith('-') ? value.slice(1) : acceptTyping(value, `-${value}`, rules));
  const pointAllowed = maxDecimals !== 0;
  const disabled = isDisabled ?? false;
  return (
    <div role="group" aria-label={ft('keypad.label', { label })} className={fcls('keypad')}>
      {DIGITS.map((d) => (
        <Button key={d} className={fcls('key')} onPress={() => type(d)} isDisabled={disabled}>
          {d}
        </Button>
      ))}
      <Button className={fcls('key')} onPress={() => type('.')} isDisabled={disabled || !pointAllowed} aria-label={ft('keypad.point')}>
        .
      </Button>
      <Button className={fcls('key')} onPress={() => type('0')} isDisabled={disabled}>
        0
      </Button>
      <Button className={fcls('key')} onPress={backspace} isDisabled={disabled || value === ''} aria-label={ft('keypad.backspace')}>
        ⌫
      </Button>
      {allowNegative ? (
        <Button className={fcls('key')} onPress={toggleMinus} isDisabled={disabled} aria-label={ft('keypad.minus')}>
          −
        </Button>
      ) : null}
      <Button className={fcls('key')} onPress={() => onChange('')} isDisabled={disabled || value === ''} aria-label={ft('keypad.clear')}>
        C
      </Button>
    </div>
  );
}
