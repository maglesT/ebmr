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
 * it, so an insertion no trusted key preceded is a fill. A key that brings text is a printable key without a shortcut
 * modifier (its insertion is one character), or a key a touch keyboard or input method reports without naming it
 * ("Unidentified", "Process"), as tablet keyboards do.
 *
 * Round 4 (the lane verifier's real-browser probes): round 3 kept the length of the field, but took it back from the
 * field's text at every input event and let any deletion through without a key, so text set with no event stopped
 * showing once one real key, one Backspace or a script's document.execCommand('delete') followed it ('73190' set
 * silently and a typed '4' sent '731904' as a new PIN). Now the field never takes its count from the text it holds
 * (`KEYED`): it adds what an accepted key brought (one character, or what a touch keyboard composed) and takes away what
 * an accepted deletion removed, each in place of the selection the key went down on. A deletion counts only when a
 * trusted key brought it too (Backspace or Delete, a word with a modifier, or a touch keyboard's unnamed key), and only
 * as much as that key may remove (one character, the selection, or for a word or a touch keyboard at most what lies on
 * the caret's side); a deletion no such key preceded is a fill. Every trusted key first compares the field's length with
 * the count, so text set with no event before the key is a fill at once; the count is compared again whenever the field
 * is read. Kept per field outside React, and never a character: the pending key's kind and the selection it went down
 * on, and a count. What remains: text set silently to exactly the count is not told apart (the field keeps no copy of
 * the secret to compare with), and while a key is held a script's change in that moment is taken as the key's own if it
 * leaves the field as long as that key would have (one character in or out for a printable key or Backspace, the span
 * the key may remove for a word or a touch keyboard).
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
 * The input events a person typing (or a keyboard-wedge reader) makes; any other change counts as filled in. They count
 * only when trusted: the browser made them from a real key (see `scripted`), and only when a trusted key brought them
 * (round 3 for insertions, round 4 for deletions too: document.execCommand('delete') makes a trusted deletion with no key).
 */
const TYPED_INPUT = new Set(['insertText', 'insertCompositionText', 'deleteContentBackward', 'deleteContentForward', 'deleteWordBackward', 'deleteWordForward', 'deleteCompositionText']);

/** The typed input events that insert text. */
const KEYED_INSERT = new Set(['insertText', 'insertCompositionText']);

/** The typed deletions that take text after the caret (the others take it before). */
const FORWARD = new Set(['deleteContentForward', 'deleteWordForward']);

/**
 * A trusted key that may change the field, until its change is seen or it is released: what it may do and the selection
 * it went down on (an insertion replaces the selection, a deletion removes it). ONE: a printable key, which inserts one
 * character; ANY: a key a touch keyboard or input method sends without naming it, which inserts what the keyboard
 * composes or deletes; DELETE: Backspace or Delete, one character or the selection; WORD: Backspace or Delete with a
 * modifier, a word. Never the character itself.
 */
interface PendingKey {
  kind: 'ONE' | 'ANY' | 'DELETE' | 'WORD';
  start: number;
  end: number;
}

/**
 * What a `noAutofill` field knows of its typed keys (rounds 3 and 4), per input element and never in React: the pending
 * key, the count of characters the accepted keys left in the field (added by their insertions, taken away by their
 * deletions, never read back from the field's text), and how much of that count the current composition of an input
 * method holds (its next update replaces it). Counts only, never a character.
 */
interface Keyed {
  pending: PendingKey | null;
  length: number;
  composed: number;
}
const KEYED = new WeakMap<HTMLInputElement, Keyed>();

/**
 * What a trusted key may change in field `el` (rounds 3 and 4), with the selection it goes down on: ONE for a printable
 * key without a shortcut modifier; ANY for a key a touch keyboard or an input method sends without naming it (key
 * "Unidentified" or "Process", key code 229); DELETE for Backspace or Delete, WORD for either with a modifier (a word);
 * null for any other key (Enter, Tab, a shortcut).
 */
function keyChange(e: KeyboardEvent, el: HTMLInputElement): PendingKey | null {
  const start = el.selectionStart ?? el.value.length;
  const end = Math.max(start, el.selectionEnd ?? start);
  const modified = e.ctrlKey || e.metaKey || e.altKey;
  if (e.key === 'Backspace' || e.key === 'Delete') return { kind: modified ? 'WORD' : 'DELETE', start, end };
  if (modified) return null;
  if ([...e.key].length === 1) return { kind: 'ONE', start, end };
  return e.key === 'Unidentified' || e.key === 'Process' ? { kind: 'ANY', start, end } : null;
}

/**
 * Accepts the typed input event `n` of field `el` against the pending key and moves the count by what the key brought or
 * removed (round 4): true when a trusted key brought this change and the field is now as long as the count says; false
 * (a fill) otherwise. The count is never set from the field's text: an insertion adds the characters of its own data in
 * place of the selection (or of the composition it updates); a deletion takes away the selection, else one character
 * for Backspace or Delete, else what a word deletion or a touch keyboard took on the caret's side, no more.
 */
function acceptKeyed(k: Keyed, n: InputEvent, el: HTMLInputElement): boolean {
  const p = k.pending;
  if (p === null) return false;
  const selected = p.end - p.start;
  if (KEYED_INSERT.has(n.inputType)) {
    if (p.kind === 'DELETE' || p.kind === 'WORD') return false;
    const brought = n.data === null ? 0 : [...n.data].length;
    if (brought === 0 || (p.kind === 'ONE' && brought !== 1)) return false;
    const replaced = n.inputType === 'insertCompositionText' && k.composed > 0 ? k.composed : selected;
    k.length += brought - replaced;
    k.composed = n.inputType === 'insertCompositionText' ? brought : 0;
    return el.value.length === k.length;
  }
  if (p.kind === 'ONE') return false;
  const before = k.length;
  const removed = before - el.value.length;
  const most =
    n.inputType === 'deleteCompositionText' ? k.composed : selected > 0 ? selected : p.kind === 'DELETE' ? 1 : FORWARD.has(n.inputType) ? before - p.end : p.start;
  const exact = n.inputType === 'deleteCompositionText' || selected > 0 || p.kind === 'DELETE';
  if (removed < 1 || removed > most || (exact && removed !== most)) return false;
  k.length = before - removed;
  k.composed = 0;
  return true;
}

/** Forgets the keys of a field when it is read or cleared: it holds nothing typed any more. */
function resetKeyed(el: HTMLInputElement): void {
  const k = KEYED.get(el);
  if (k) {
    k.pending = null;
    k.length = 0;
    k.composed = 0;
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
  // Rounds 3 and 4: text set with no event left the field otherwise than the typed keys' count says.
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
  // A kiosk field knows what its typed keys left (rounds 3 and 4): nothing when it appears, whatever it then holds.
  useLayoutEffect(() => {
    const el = own.current;
    if (!el || !noAutofill) return;
    KEYED.set(el, { pending: null, length: 0, composed: 0 });
    return () => {
      KEYED.delete(el);
    };
  }, [noAutofill]);
  // Anything but a change a trusted key brought marks the field as filled in until it is read or cleared: a scripted
  // event, an insertion or a deletion no trusted key preceded (document.execCommand), or one beyond what its key may do.
  const onInput = (e: FormEvent<HTMLInputElement>) => {
    const n = e.nativeEvent;
    const el = e.currentTarget;
    const k = KEYED.get(el);
    const typed = !scripted(n) && typeof InputEvent !== 'undefined' && n instanceof InputEvent && TYPED_INPUT.has(n.inputType);
    const keyed = typed && k !== undefined && acceptKeyed(k, n, el);
    if (k) k.pending = null;
    if (!keyed) el.dataset['filled'] = 'true';
  };
  // A scripted key is a fill (round 2). A trusted key first finds the field as long as the count says, else text was set
  // with no event before it (round 4); then it may make one change. Released, it makes none.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    const k = KEYED.get(el);
    if (scripted(e.nativeEvent)) {
      el.dataset['filled'] = 'true';
      return;
    }
    if (!k) return;
    if (el.value.length !== k.length) el.dataset['filled'] = 'true';
    k.pending = keyChange(e.nativeEvent, el);
  };
  const onKeyUp = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const k = KEYED.get(e.currentTarget);
    if (k) k.pending = null;
  };
  // An input method's composition ends: its next update starts a new one.
  const onCompositionEnd = (e: { currentTarget: HTMLInputElement }) => {
    const k = KEYED.get(e.currentTarget);
    if (k) k.composed = 0;
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
        {...(noAutofill ? { ...MANAGER_OPT_OUT, onInput, onKeyDown, onKeyUp, onCompositionEnd } : {})}
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
