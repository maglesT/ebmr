import type { Ref } from 'react';
import { FieldError, Input, Label, Text, TextField } from 'react-aria-components';
import { cls } from './classes.ts';
import { SecretInput } from './SecretInput.tsx';

interface FieldCommon {
  label: string;
  name: string;
  inputRef?: Ref<HTMLInputElement>;
  description?: string;
  errorMessage?: string;
  isRequired?: boolean;
  isDisabled?: boolean;
  autoFocus?: boolean;
}

/** A text or search input (react-aria TextField): controlled through value/onChange, or read through inputRef. */
export interface TextFieldProps extends FieldCommon {
  type?: 'text' | 'search';
  value?: string;
  onChange?: (value: string) => void;
  autoComplete?: string;
  inputMode?: 'text' | 'numeric' | 'decimal';
}

/**
 * A secret (password, keyboard PIN, badge UID): rendered by SecretInput, never by a react-aria TextField, so the
 * secret never enters React state or the value attribute. It has no value or onChange: the caller reads it through
 * inputRef when it is sent and clears the field at once.
 */
export interface SecretFieldProps extends FieldCommon {
  type: 'password';
  value?: never;
  onChange?: never;
  inputRef: Ref<HTMLInputElement>;
  autoComplete?: 'off' | 'new-password';
  inputMode?: 'text' | 'numeric';
  maxLength?: number;
}

export type FieldProps = TextFieldProps | SecretFieldProps;

/** A labelled input. Secrets (type 'password') go to SecretInput: uncontrolled, native, never in React state. */
export function Field(props: FieldProps) {
  if (props.type === 'password') {
    const { label, name, inputRef, description, errorMessage, isRequired, isDisabled, autoComplete, autoFocus, inputMode, maxLength } = props;
    return (
      <SecretInput
        label={label}
        name={name}
        inputRef={inputRef}
        {...(description !== undefined ? { description } : {})}
        {...(errorMessage !== undefined ? { errorMessage } : {})}
        {...(isRequired !== undefined ? { isRequired } : {})}
        {...(isDisabled !== undefined ? { isDisabled } : {})}
        {...(autoComplete !== undefined ? { autoComplete } : {})}
        {...(autoFocus !== undefined ? { autoFocus } : {})}
        {...(inputMode !== undefined ? { inputMode } : {})}
        {...(maxLength !== undefined ? { maxLength } : {})}
      />
    );
  }
  const { label, name, type = 'text', value, onChange, inputRef, description, errorMessage, isRequired, isDisabled, autoComplete, autoFocus, inputMode } = props;
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
