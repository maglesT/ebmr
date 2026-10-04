/**
 * SecretInput (plan section 6 step 3; DI-38, DI-19, D7; review P1 and CN2): the labelled input for passwords, PINs
 * typed on a keyboard and badge UIDs from a keyboard-wedge reader.
 *
 * It renders a plain native masked <input> with no `value` and no `defaultValue` and keeps nothing in React: no
 * state, no props, no context. The caller reads the secret through `inputRef` when it is sent and clears the field
 * at once (`takeSecret` does both). A react-aria TextField is never used for a secret: it always keeps the typed text
 * in its own state and renders the input as a controlled one, so React writes the secret into the value attribute
 * and back into the field on every render after a "clear". When the input unmounts, whatever is left in it is wiped.
 *
 * A kiosk field no password manager may fill (`noAutofill`: the badge field, where only a reader's tap counts, and a
 * kiosk PIN; Phase 2 exit follow-up BADGE-AUTOFILL, DI-14, DI-19, DI-38): browsers ignore autocomplete="off" on a
 * masked field, so a browser or password manager could fill a saved secret into it and the kiosk would send it as a
 * badge UID or a PIN. Such a field is marked as a one-time code with the opt-out attributes of the common password
 * managers, so that they neither offer nor save it, and it records any text that reached it otherwise than typed key
 * by key (filled in by a browser or a password manager, pasted, dropped, or set by a script): `wasFilled` tells the
 * caller, which then sends nothing. Attributes alone are advice a manager may ignore; the refusal does not depend on
 * them. A key counts only when the browser made it (a trusted event): a manager or extension that "types" the secret
 * by dispatching key and input events one character at a time fills the field (BADGE-AUTOFILL round 2).
 */
import { useId, useImperativeHandle, useLayoutEffect, useRef, type FormEvent, type Ref, type RefObject } from 'react';
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
  /**
   * A kiosk field no browser or password manager may fill or save (the badge field, a kiosk PIN): see the header.
   * Overrides `autoComplete`.
   */
  noAutofill?: boolean;
}

/**
 * The input events a person typing (or a keyboard-wedge reader) makes; any other insertion counts as filled in. They
 * count only when trusted: the browser made them from a real key (see `scripted`).
 */
const TYPED_INPUT = new Set(['insertText', 'insertCompositionText', 'deleteContentBackward', 'deleteContentForward', 'deleteWordBackward', 'deleteWordForward', 'deleteCompositionText']);

/** The attributes the common password managers read as "leave this field alone" (1Password, LastPass, Bitwarden, Dashlane). */
const MANAGER_OPT_OUT = { 'data-1p-ignore': 'true', 'data-lpignore': 'true', 'data-bwignore': 'true', 'data-form-type': 'other' } as const;

function autofilledNow(el: HTMLInputElement): boolean {
  for (const selector of [':autofill', ':-webkit-autofill']) {
    try {
      if (el.matches(selector)) return true;
    } catch {
      // A browser that does not know the selector has not autofilled through it.
    }
  }
  return false;
}

/**
 * Whether an event was dispatched by a script (a password manager or extension "typing" a saved secret key by key, a
 * page script) rather than made by the browser from a real key or a keyboard-wedge reader (BADGE-AUTOFILL round 2).
 * The browser marks every event it makes itself as trusted and every dispatched one as not; an environment that does
 * not say (a test DOM) is read as trusted. A key injected at the operating-system level (auto-type) is trusted and is
 * read as a key.
 */
export function scripted(event: Event): boolean {
  return event.isTrusted === false;
}

/** Marks a `noAutofill` SecretInput as filled in until it is read or cleared (a scripted key reached it). */
export function markFilled(ref: RefObject<HTMLInputElement | null>): void {
  const el = ref.current;
  if (el) el.dataset['filled'] = 'true';
}

/**
 * Whether text reached a `noAutofill` SecretInput otherwise than typed key by key since it was last read or cleared
 * (filled in by the browser or a password manager, pasted, dropped, set by a script). Read it before `takeSecret`.
 */
export function wasFilled(ref: RefObject<HTMLInputElement | null>): boolean {
  const el = ref.current;
  return el !== null && (el.dataset['filled'] === 'true' || autofilledNow(el));
}

/** Empties a SecretInput without reading it (and forgets that it was filled in). */
export function clearSecret(ref: RefObject<HTMLInputElement | null>): void {
  const el = ref.current;
  if (!el) return;
  el.value = '';
  delete el.dataset['filled'];
}

/** Reads the secret typed into a SecretInput and clears the field in the same step (a secret is handed over once). */
export function takeSecret(ref: RefObject<HTMLInputElement | null>): string {
  const el = ref.current;
  if (!el) return '';
  const secret = el.value;
  el.value = '';
  delete el.dataset['filled'];
  return secret;
}

export function SecretInput({ label, name, inputRef, description, errorMessage, isRequired = false, isDisabled = false, autoComplete = 'off', autoFocus = false, inputMode, maxLength, noAutofill = false }: SecretInputProps) {
  const id = useId();
  const own = useRef<HTMLInputElement>(null);
  useImperativeHandle(inputRef, () => own.current as HTMLInputElement, []);
  useLayoutEffect(() => {
    const el = own.current;
    return () => {
      if (el) el.value = '';
    };
  }, []);
  // Anything but a key typed (or deleted) marks the field as filled in until it is read or cleared; a scripted
  // insertText is not a key typed.
  const onInput = (e: FormEvent<HTMLInputElement>) => {
    const n = e.nativeEvent;
    if (scripted(n) || !(typeof InputEvent !== 'undefined' && n instanceof InputEvent && TYPED_INPUT.has(n.inputType))) e.currentTarget.dataset['filled'] = 'true';
  };
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
        autoComplete={noAutofill ? 'one-time-code' : autoComplete}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        required={isRequired}
        disabled={isDisabled}
        autoFocus={autoFocus}
        {...(inputMode ? { inputMode } : {})}
        {...(maxLength !== undefined ? { maxLength } : {})}
        {...(noAutofill ? { ...MANAGER_OPT_OUT, onInput } : {})}
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
