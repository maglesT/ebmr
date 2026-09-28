import type { Ref } from 'react';
import { FieldError, Input, Label, Text, TextField } from 'react-aria-components';
import { cls } from './classes.ts';

export interface FieldProps {
  label: string;
  name: string;
  type?: 'text' | 'password' | 'search';
  /** Controlled value (never for secrets: those stay uncontrolled, read through inputRef and cleared after use). */
  value?: string;
  onChange?: (value: string) => void;
  inputRef?: Ref<HTMLInputElement>;
  description?: string;
  errorMessage?: string;
  isRequired?: boolean;
  isDisabled?: boolean;
  autoComplete?: string;
  autoFocus?: boolean;
  inputMode?: 'text' | 'numeric' | 'decimal';
}

/** A labelled text input. Secrets: pass inputRef and no value, so the secret never enters React state. */
export function Field({ label, name, type = 'text', value, onChange, inputRef, description, errorMessage, isRequired, isDisabled, autoComplete, autoFocus, inputMode }: FieldProps) {
  return (
    <TextField
      className={cls('field')}
      name={name}
      type={type}
      {...(value !== undefined ? { value } : {})}
      {...(onChange ? { onChange } : {})}
      isRequired={isRequired ?? false}
      isDisabled={isDisabled ?? false}
      isInvalid={errorMessage !== undefined}
      {...(autoComplete ? { autoComplete } : {})}
      {...(autoFocus ? { autoFocus } : {})}
    >
      <Label className={cls('label')}>{label}</Label>
      <Input className={cls('input')} ref={inputRef} {...(inputMode ? { inputMode } : {})} />
      {description ? (
        <Text slot="description" className={cls('description')}>
          {description}
        </Text>
      ) : null}
      <FieldError className={cls('error')}>{errorMessage}</FieldError>
    </TextField>
  );
}
