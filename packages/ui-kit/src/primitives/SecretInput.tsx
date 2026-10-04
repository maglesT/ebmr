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
 *
 * Round 3 (the keyed detection the badge prompt has, for every `noAutofill` field, the kiosk's new-PIN fields
 * included): an insertion counts as typed only when a trusted key brought it. A script's document.execCommand
 * ('insertText') makes an input event the browser marks as trusted, with the type of a typed character but no key before
 * it, so an insertion no trusted key preceded is a fill; and the field keeps the length its typed keys and deletions
 * left (`KEYED`), so text set with no event at all (the value changed by a script) is a fill when it is read. A key
 * that brings text is a printable key without a shortcut modifier (its insertion is one character), or a key a touch
 * keyboard or input method reports without naming it ("Unidentified", "Process"), as tablet keyboards do. Kept per
 * field outside React, and never a character: whether such a key is pending (until its insertion or its release) and a
 * length. What remains: text set silently to exactly the length the typed keys left is not told apart (the field keeps
 * no copy of the secret to compare with), and while a key is held a script's insertion in that moment is taken as its
 * own (one character for a printable key, any text for a touch keyboard's unnamed key).
 */
import { useId, useImperativeHandle, useLayoutEffect, useRef, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type Ref, type RefObject } from 'react';
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
 * count only when trusted: the browser made them from a real key (see `scripted`). The insertions among them count only
 * when a trusted key brought them (`KEYED_INSERT`, round 3); a deletion takes text away and brings none.
 */
const TYPED_INPUT = new Set(['insertText', 'insertCompositionText', 'deleteContentBackward', 'deleteContentForward', 'deleteWordBackward', 'deleteWordForward', 'deleteCompositionText']);

/** The typed input events that insert text: each needs a trusted key before it (round 3). */
const KEYED_INSERT = new Set(['insertText', 'insertCompositionText']);

/**
 * What a `noAutofill` field knows of its typed keys (round 3), per input element and never in React: whether a trusted
 * key that brings text is pending (pressed, its insertion not yet seen), and the length the accepted keys and deletions
 * left in the field. Counts only, never a character.
 */
interface Keyed {
  /**
   * The pending key: ONE for a printable key (its insertion is one character), ANY for a key a touch keyboard or input
   * method does not name (its insertion is what the keyboard composes), false for none. Never the character itself.
   */
  pending: 'ONE' | 'ANY' | false;
  length: number;
}
const KEYED = new WeakMap<HTMLInputElement, Keyed>();

/**
 * What a trusted key brings into the field: one character for a printable key without a shortcut modifier (ONE); what a
 * touch keyboard or an input method composes for a key it sends without naming it (key "Unidentified" or "Process", key
 * code 229: ANY); nothing for any other key (Enter, Backspace, a shortcut: false).
 */
function bringsText(e: KeyboardEvent): Keyed['pending'] {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.key.length === 1) return 'ONE';
  return e.key === 'Unidentified' || e.key === 'Process' ? 'ANY' : false;
}

/** Whether the insertion of input event `n` is the one the pending key brings. */
function broughtBy(pending: Keyed['pending'] | undefined, n: InputEvent): boolean {
  if (pending === 'ANY') return true;
  return pending === 'ONE' && n.data !== null && [...n.data].length === 1;
}

/** Forgets the keys of a field when it is read or cleared: it holds nothing typed any more. */
function resetKeyed(el: HTMLInputElement): void {
  const k = KEYED.get(el);
  if (k) {
    k.pending = false;
    k.length = 0;
  }
}

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
  if (el === null) return false;
  if (el.dataset['filled'] === 'true' || autofilledNow(el)) return true;
  // Round 3: text set with no event changed the length the typed keys left.
  const k = KEYED.get(el);
  return k !== undefined && el.value.length !== k.length;
}

/** Empties a SecretInput without reading it (and forgets that it was filled in). */
export function clearSecret(ref: RefObject<HTMLInputElement | null>): void {
  const el = ref.current;
  if (!el) return;
  el.value = '';
  delete el.dataset['filled'];
  resetKeyed(el);
}

/** Reads the secret typed into a SecretInput and clears the field in the same step (a secret is handed over once). */
export function takeSecret(ref: RefObject<HTMLInputElement | null>): string {
  const el = ref.current;
  if (!el) return '';
  const secret = el.value;
  el.value = '';
  delete el.dataset['filled'];
  resetKeyed(el);
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
  // A kiosk field knows what its typed keys left (round 3): text that appears with no key is a fill.
  useLayoutEffect(() => {
    const el = own.current;
    if (!el || !noAutofill) return;
    KEYED.set(el, { pending: false, length: el.value.length });
    return () => {
      KEYED.delete(el);
    };
  }, [noAutofill]);
  // Anything but a key typed (or deleted) marks the field as filled in until it is read or cleared; a scripted
  // insertText is not a key typed, nor is an insertion no trusted key brought (round 3: document.execCommand).
  const onInput = (e: FormEvent<HTMLInputElement>) => {
    const n = e.nativeEvent;
    const el = e.currentTarget;
    const k = KEYED.get(el);
    const typed = !scripted(n) && typeof InputEvent !== 'undefined' && n instanceof InputEvent && TYPED_INPUT.has(n.inputType);
    const keyed = typed && (!KEYED_INSERT.has(n.inputType) || broughtBy(k?.pending, n));
    if (k) {
      k.pending = false;
      k.length = el.value.length;
    }
    if (!keyed) el.dataset['filled'] = 'true';
  };
  // A trusted key that brings text may bring one insertion; a scripted key is a fill (round 2). Released, it brings none.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const k = KEYED.get(e.currentTarget);
    if (scripted(e.nativeEvent)) {
      e.currentTarget.dataset['filled'] = 'true';
      return;
    }
    if (k) k.pending = bringsText(e.nativeEvent);
  };
  const onKeyUp = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const k = KEYED.get(e.currentTarget);
    if (k) k.pending = false;
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
        {...(noAutofill ? { ...MANAGER_OPT_OUT, onInput, onKeyDown, onKeyUp } : {})}
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
