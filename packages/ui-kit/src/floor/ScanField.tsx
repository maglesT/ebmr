/**
 * ScanField (module C4): a label scan from a keyboard-wedge reader (1D or 2D code sent as a burst of keys and
 * Enter), or the code typed by hand and confirmed with Enter. The code travels as text only; what it stands
 * for (lot status, expiry, container) is resolved by the server at commit.
 */
import { useState, type KeyboardEvent } from 'react';
import { Input, Label, Text, TextField } from 'react-aria-components';
import { Button } from '../primitives/Button.tsx';
import { cls } from '../primitives/classes.ts';
import { fcls } from './classes.ts';
import { ft } from './messages.ts';

export interface ScanFieldProps {
  label: string;
  /** The confirmed code, or null while waiting for a scan. */
  value: string | null;
  onChange: (code: string | null) => void;
  description?: string;
  isDisabled?: boolean;
  autoFocus?: boolean;
  name?: string;
}

export function ScanField({ label, value, onChange, description, isDisabled, autoFocus, name }: ScanFieldProps) {
  const [text, setText] = useState('');
  const confirm = () => {
    const code = text.trim();
    if (code === '') return;
    setText('');
    onChange(code);
  };
  if (value !== null) {
    return (
      <div className={fcls('scan')} role="group" aria-label={label}>
        <p className={cls('label')}>{label}</p>
        <div className={fcls('scanned')}>
          <span data-testid={`scanned-${name ?? label}`}>{ft('scan.scanned', { code: value })}</span>
          <Button onPress={() => onChange(null)} isDisabled={isDisabled ?? false}>
            {ft('scan.clear')}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <TextField
      className={`${cls('field')} ${fcls('scan')}`}
      value={text}
      onChange={setText}
      isDisabled={isDisabled ?? false}
      {...(autoFocus ? { autoFocus } : {})}
      {...(name ? { name } : {})}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          confirm();
        }
      }}
    >
      <Label className={cls('label')}>{label}</Label>
      <Input className={cls('input')} autoComplete="off" spellCheck={false} />
      <Text slot="description" className={cls('description')}>
        {description ? `${description}. ` : ''}
        {ft('scan.hint')}
      </Text>
    </TextField>
  );
}
