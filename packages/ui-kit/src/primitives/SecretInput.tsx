/**
 * SecretInput (plan section 6 step 3; DI-38, DI-19, D7; review P1 and CN2): the labelled input for passwords, PINs
 * typed on a keyboard and badge UIDs from a keyboard-wedge reader.
 *
 * It renders a plain native masked <input> with no `value` and no `defaultValue` and keeps nothing in React: no
 * state, no props, no context. The caller reads the secret through `inputRef` when it is sent and clears the field
 * at once (`takeSecret` does both). A react-aria TextField is never used for a secret: it always keeps the typed text
 * in its own state and renders the input as a controlled one, so React writes the secret into the value attribute
 * and back into the field on every render after a "clear". When the input unmounts, whatever is left in it is wiped.
 */
import { useId, useImperativeHandle, useLayoutEffect, useRef, type Ref, type RefObject } from 'react';
import { cls } from './classes.ts';

export interface SecretInputProps {
  label: string;
  name: string;
  /** How the caller reads (and then clears) the secret; the only way out of the field. */
  inputRef: Ref<HTMLInputElement>;
  description?: string;
  errorMessage?: string;
  isRequired?: boolean;
  isDisabled?: boolean;
  /** 'off' (default) for signing, unlock and badges; 'new-password' only where a new secret is chosen. */
  autoComplete?: 'off' | 'new-password';
  autoFocus?: boolean;
  inputMode?: 'text' | 'numeric';
  /** The most characters the field takes (a new PIN: PIN_MAX_LENGTH). */
  maxLength?: number;
}

/** Reads the secret typed into a SecretInput and clears the field in the same step (a secret is handed over once). */
export function takeSecret(ref: RefObject<HTMLInputElement | null>): string {
  const el = ref.current;
  if (!el) return '';
  const secret = el.value;
  el.value = '';
  return secret;
}

export function SecretInput({ label, name, inputRef, description, errorMessage, isRequired = false, isDisabled = false, autoComplete = 'off', autoFocus = false, inputMode, maxLength }: SecretInputProps) {
  const id = useId();
  const own = useRef<HTMLInputElement>(null);
  useImperativeHandle(inputRef, () => own.current as HTMLInputElement, []);
  useLayoutEffect(() => {
    const el = own.current;
    return () => {
      if (el) el.value = '';
    };
  }, []);
  const describedBy = [description ? `${id}-description` : null, errorMessage !== undefined ? `${id}-error` : null].filter((x) => x !== null).join(' ');
  return (
    <div className={cls('field')} data-secret="true">
      <label className={cls('label')} htmlFor={`${id}-input`}>
        {label}
      </label>
      <input
        ref={own}
        id={`${id}-input`}
        className={cls('input')}
        type="password"
        name={name}
        autoComplete={autoComplete}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        required={isRequired}
        disabled={isDisabled}
        autoFocus={autoFocus}
        {...(inputMode ? { inputMode } : {})}
        {...(maxLength !== undefined ? { maxLength } : {})}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        {...(errorMessage !== undefined ? { 'aria-invalid': true, 'data-invalid': 'true' } : {})}
      />
      {description ? (
        <span id={`${id}-description`} className={cls('description')}>
          {description}
        </span>
      ) : null}
      {errorMessage !== undefined ? (
        <span id={`${id}-error`} className={cls('error')}>
          {errorMessage}
        </span>
      ) : null}
    </div>
  );
}
