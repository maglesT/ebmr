/**
 * A badge tap is what the reader types, never what a browser or password manager fills in (Phase 2 exit follow-up
 * BADGE-AUTOFILL; DI-14, DI-19, DI-38; F56 verifier and critic: an autofilled 10-digit value was still sent as a badge
 * UID).
 *
 * The badge field is a masked input, and browsers ignore autocomplete="off" on masked inputs: a saved password or PIN
 * of ten digits reads as a badge UID by the kernel's rule (8 to 64 hexadecimal digits), so the prompt sent it. The kernel
 * refused it as an unknown badge and raised a security alert, and the saved secret had left the browser as an
 * identifier. Now the field asks browsers and the common password managers to leave it alone (a one-time code with
 * their opt-out attributes), and text that did not reach it as the keys of one burst (filled in, whatever the events
 * that came with it, pasted or set by a script) is not sent, even when it reads as a badge UID.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, type RefObject } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BadgePrompt, NOT_A_BADGE, NOT_TAPPED } from '../../src/identity/index.ts';
import { SecretInput, takeSecret, wasFilled } from '../../src/primitives/SecretInput.tsx';

const noop = () => undefined;
const SAVED = '4829137065';

/** Sets the field's value the way the value setter does, bypassing React (as browsers and password managers fill). */
function setNatively(el: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value);
}

/** The ways text reaches a masked field without a reader's keys. */
const FILLS: Record<string, (el: HTMLInputElement) => void> = {
  // Chrome's autofill: the value and a plain input event (no InputEvent) and change.
  'browser autofill (plain input event)': (el) => {
    setNatively(el, SAVED);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  },
  // Firefox's autofill: an InputEvent that replaces the text.
  'browser autofill (insertReplacementText)': (el) => {
    setNatively(el, SAVED);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: SAVED }));
  },
  // A password manager that simulates the keyboard: key events without a key, then the value and an input event.
  'password manager (simulated key events)': (el) => {
    for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { bubbles: true }));
    setNatively(el, SAVED);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  },
  // A script that sets the value and sends no event at all.
  'script without events': (el) => setNatively(el, SAVED),
};

describe('BADGE-AUTOFILL: a badge tap is what the reader types, never what is filled in', () => {
  it('[DI-14][DI-19][DI-38] the badge field asks browsers and password managers to leave it alone: a masked one-time code with the opt-out attributes of 1Password, LastPass, Bitwarden and Dashlane', () => {
    render(<BadgePrompt reason="Tap your badge to sign in." onTap={noop} timeoutSeconds={null} />);
    const field = screen.getByLabelText<HTMLInputElement>('Badge');
    expect({
      type: field.type,
      autocomplete: field.getAttribute('autocomplete'),
      onePassword: field.getAttribute('data-1p-ignore'),
      lastPass: field.getAttribute('data-lpignore'),
      bitwarden: field.getAttribute('data-bwignore'),
      dashlane: field.getAttribute('data-form-type'),
      value: field.getAttribute('value'),
    }).toEqual({ type: 'password', autocomplete: 'one-time-code', onePassword: 'true', lastPass: 'true', bitwarden: 'true', dashlane: 'other', value: null });
  });

  it('[DI-14][DI-19][DI-38] a saved ten-digit secret filled into the badge field, by a browser, a password manager or a script, is not sent on Enter or Continue although it reads as a badge UID: the prompt says it was not tapped and waits', async () => {
    for (const [name, fill] of Object.entries(FILLS)) {
      for (const submit of ['Enter', 'Continue'] as const) {
        const onTap = vi.fn();
        const { unmount } = render(<BadgePrompt reason="Tap your badge to sign in." onTap={onTap} timeoutSeconds={null} />);
        const field = screen.getByLabelText<HTMLInputElement>('Badge');
        field.focus();
        fill(field);
        expect(field.value, `${name}: the fill reached the field`).toBe(SAVED);
        if (submit === 'Enter') await userEvent.keyboard('{Enter}');
        else await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
        expect(onTap, `${name}, ${submit}`).not.toHaveBeenCalled();
        expect(screen.getByText(NOT_TAPPED), `${name}, ${submit}`).toBeTruthy();
        expect(field.value, `${name}, ${submit}: the field is emptied`).toBe('');
        unmount();
      }
    }
  });

  it('[DI-14][DI-38] a badge UID pasted, or filled in and then typed onto, is not sent either; the reader\'s tap after a fill counts, and only its own keys', async () => {
    const onTap = vi.fn();
    render(<BadgePrompt reason="Tap your badge to sign in." onTap={onTap} timeoutSeconds={null} />);
    const field = screen.getByLabelText<HTMLInputElement>('Badge');
    field.focus();
    await userEvent.paste('04A10000000001');
    await userEvent.keyboard('{Enter}');
    expect(onTap).not.toHaveBeenCalled();
    expect(screen.getByText(NOT_TAPPED)).toBeTruthy();
    // Filled in, then one key typed onto it within the burst gap: still not a tap.
    await userEvent.type(field, '0');
    fireEvent.input(field, { target: { value: '04A10000000001' } });
    await userEvent.keyboard('{Enter}');
    expect(onTap).not.toHaveBeenCalled();
    // Filled in, then the reader's burst: the burst's first key empties the field, and the tap is the reader's UID.
    FILLS['browser autofill (plain input event)']?.(field);
    await userEvent.type(field, '04A10000000002{Enter}');
    expect(onTap).toHaveBeenCalledExactlyOnceWith('04A10000000002');
    expect(screen.queryByText(NOT_TAPPED)).toBeNull();
  });

  it('[DI-14][DI-19][DI-38] a password manager or extension that types a saved secret one key at a time (untrusted key and insertText events, as a content script dispatches them) is a fill: nothing is sent, and the reader\'s next burst still counts', async () => {
    // Real keys and a keyboard-wedge reader produce trusted events; an event a script dispatches is not trusted. happy-dom
    // leaves isTrusted undefined (as userEvent's keys are here), so the scripted events say false themselves.
    const untrusted = <E extends Event>(event: E): E => Object.defineProperty(event, 'isTrusted', { value: false });
    const typeAsAScript = (el: HTMLInputElement, text: string) => {
      for (const ch of text) {
        el.dispatchEvent(untrusted(new KeyboardEvent('keydown', { bubbles: true, key: ch })));
        setNatively(el, el.value + ch);
        el.dispatchEvent(untrusted(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch })));
        el.dispatchEvent(untrusted(new KeyboardEvent('keyup', { bubbles: true, key: ch })));
      }
    };
    for (const submit of ['Enter', 'Continue'] as const) {
      const onTap = vi.fn();
      const { unmount } = render(<BadgePrompt reason="Tap your badge to sign in." onTap={onTap} timeoutSeconds={null} />);
      const field = screen.getByLabelText<HTMLInputElement>('Badge');
      field.focus();
      typeAsAScript(field, SAVED);
      expect(field.value, `${submit}: the typed fill reached the field`).toBe(SAVED);
      if (submit === 'Enter') await userEvent.keyboard('{Enter}');
      else await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
      expect(onTap, submit).not.toHaveBeenCalled();
      expect(screen.getByText(NOT_TAPPED), submit).toBeTruthy();
      expect(field.value, `${submit}: the field is emptied`).toBe('');
      // Typed by a script onto the reader's own keys within one burst: still not a tap.
      await userEvent.type(field, '04A1000');
      typeAsAScript(field, '0000001');
      await userEvent.keyboard('{Enter}');
      expect(onTap, `${submit}: the reader's keys with a scripted tail`).not.toHaveBeenCalled();
      // The reader's next burst empties the field and is the tap.
      await userEvent.type(field, '04A10000000002{Enter}');
      expect(onTap, submit).toHaveBeenCalledExactlyOnceWith('04A10000000002');
      unmount();
    }
  });

  it('[DI-14][DI-19][DI-38] a kiosk secret field marks a scripted key-by-key insertion as filled, and a typed one as not', async () => {
    const ref = createRef<HTMLInputElement>();
    render(<SecretInput label="New PIN" name="newSecret" inputRef={ref} noAutofill />);
    const field = screen.getByLabelText<HTMLInputElement>('New PIN');
    await userEvent.type(field, '4829');
    expect(wasFilled(ref), 'typed').toBe(false);
    setNatively(field, `${field.value}1`);
    field.dispatchEvent(Object.defineProperty(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '1' }), 'isTrusted', { value: false }));
    expect(wasFilled(ref), 'a scripted insertText').toBe(true);
    expect(takeSecret(ref)).toBe('48291');
    expect(wasFilled(ref), 'read and cleared').toBe(false);
  });

  it('[DI-14][DI-19][DI-38] BADGE-AUTOFILL round 3: a kiosk secret field marks as filled an insertText no key brought (the trusted event Chromium makes for document.execCommand(\'insertText\')) and a value set with no event at all, also onto typed keys; typed key by key, with deletions, or from a touch keyboard (its unnamed key, Unidentified), it is not', async () => {
    // Chromium marks the input event of document.execCommand('insertText') as trusted, with inputType insertText and no
    // key event before it (the lane verifier's probe in a real browser). happy-dom leaves isTrusted undefined, which the
    // field reads as trusted, as it reads userEvent's keys.
    const execInsertText = (el: HTMLInputElement, text: string) => {
      setNatively(el, el.value + text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    };
    const field = (): { ref: RefObject<HTMLInputElement | null>; el: HTMLInputElement; unmount: () => void } => {
      const ref = createRef<HTMLInputElement>();
      const { unmount } = render(<SecretInput label="New PIN" name="newSecret" inputRef={ref} noAutofill />);
      return { ref, el: screen.getByLabelText<HTMLInputElement>('New PIN'), unmount };
    };
    const seen: Record<string, boolean> = {};
    const check = async (name: string, act: (el: HTMLInputElement) => Promise<void> | void) => {
      const f = field();
      f.el.focus();
      await act(f.el);
      seen[name] = wasFilled(f.ref);
      expect(takeSecret(f.ref).length, `${name}: the text reached the field`).toBeGreaterThan(0);
      expect(wasFilled(f.ref), `${name}: read and cleared`).toBe(false);
      f.unmount();
    };
    await check('execCommand insertText, no key before it', (el) => execInsertText(el, '4829'));
    await check('execCommand insertText, one character at a time', (el) => {
      for (const ch of '4829') execInsertText(el, ch);
    });
    await check('value set with no event', (el) => setNatively(el, '4829'));
    await check('typed, then execCommand insertText onto it', async (el) => {
      await userEvent.type(el, '48');
      execInsertText(el, '29');
    });
    await check('typed, then a value set with no event', async (el) => {
      await userEvent.type(el, '48');
      setNatively(el, '4829');
    });
    await check('a typed key, then an insertion of more than its one character', (el) => {
      fireEvent.keyDown(el, { key: '4' });
      execInsertText(el, '4829');
      fireEvent.keyUp(el, { key: '4' });
    });
    await check('typed key by key', async (el) => {
      await userEvent.type(el, '4829');
    });
    await check('typed, deleted and typed again', async (el) => {
      await userEvent.type(el, '48291{Backspace}{Backspace}35');
    });
    await check('a touch keyboard (trusted key "Unidentified", then its insertText)', (el) => {
      for (const ch of '4829') {
        fireEvent.keyDown(el, { key: 'Unidentified', keyCode: 229 });
        execInsertText(el, ch);
        fireEvent.keyUp(el, { key: 'Unidentified', keyCode: 229 });
      }
    });
    expect(seen).toEqual({
      'execCommand insertText, no key before it': true,
      'execCommand insertText, one character at a time': true,
      'value set with no event': true,
      'typed, then execCommand insertText onto it': true,
      'typed, then a value set with no event': true,
      'a typed key, then an insertion of more than its one character': true,
      'typed key by key': false,
      'typed, deleted and typed again': false,
      'a touch keyboard (trusted key "Unidentified", then its insertText)': false,
    });
  });

  it('[DI-14][DI-19][DI-38] BADGE-AUTOFILL round 4: a kiosk secret field never takes its count back from the text it holds: text set with no event stays a fill after a typed key, a typed Backspace or a deletion no key brought, and a deletion no key brought is a fill itself; typed keys, deletions of a selection or of a word and a touch keyboard\'s deletions are not', async () => {
    // A deletion as document.execCommand('delete') makes it in Chromium: the text shortened and one trusted
    // deleteContentBackward input event, with no key before it.
    const execDelete = (el: HTMLInputElement) => {
      setNatively(el, el.value.slice(0, -1));
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    };
    // A value set by a script with no event; the browser puts the caret at its end.
    const setSilently = (el: HTMLInputElement, value: string) => {
      setNatively(el, value);
      el.setSelectionRange(value.length, value.length);
    };
    // A real key as the browser handles it (userEvent keeps its own copy of the value, which a silent set does not
    // reach): keydown, the change at the selection (its character, or Backspace's deletion), one input event, keyup.
    const press = (el: HTMLInputElement, key: string, init: { ctrlKey?: boolean } = {}) => {
      fireEvent.keyDown(el, { key, ...init });
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      if (key === 'Backspace') {
        const from = start !== end ? start : init.ctrlKey ? 0 : start - 1;
        setNatively(el, el.value.slice(0, from) + el.value.slice(end));
        el.setSelectionRange(from, from);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: init.ctrlKey ? 'deleteWordBackward' : 'deleteContentBackward' }));
      } else {
        setNatively(el, el.value.slice(0, start) + key + el.value.slice(end));
        el.setSelectionRange(start + 1, start + 1);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: key }));
      }
      fireEvent.keyUp(el, { key, ...init });
    };
    const field = (): { ref: RefObject<HTMLInputElement | null>; el: HTMLInputElement; unmount: () => void } => {
      const ref = createRef<HTMLInputElement>();
      const { unmount } = render(<SecretInput label="New PIN" name="newSecret" inputRef={ref} noAutofill />);
      return { ref, el: screen.getByLabelText<HTMLInputElement>('New PIN'), unmount };
    };
    const seen: Record<string, { filled: boolean; value: string }> = {};
    const check = async (name: string, act: (el: HTMLInputElement) => Promise<void> | void) => {
      const f = field();
      f.el.focus();
      await act(f.el);
      seen[name] = { filled: wasFilled(f.ref), value: f.el.value };
      takeSecret(f.ref);
      expect(wasFilled(f.ref), `${name}: read and cleared`).toBe(false);
      f.unmount();
    };
    // The lane verifier's probes (real Chromium and happy-dom alike).
    await check('a value set with no event, then one typed key', async (el) => {
      setNatively(el, '73190');
      await userEvent.type(el, '4');
    });
    await check('a value set with no event, then a typed Backspace', async (el) => {
      setNatively(el, '7319045');
      await userEvent.type(el, '{Backspace}');
    });
    await check('a value set with no event, then a deletion no key brought', (el) => {
      setNatively(el, '7319045');
      execDelete(el);
    });
    await check('typed, a value set with no event, then a typed Backspace and a key', async (el) => {
      await userEvent.type(el, '12');
      setSilently(el, '7319045');
      press(el, 'Backspace');
      press(el, '4');
    });
    await check('typed, then a deletion no key brought', async (el) => {
      await userEvent.type(el, '48291');
      execDelete(el);
    });
    // Typing as people and tablets do.
    await check('typed, a selection replaced by a typed key', async (el) => {
      await userEvent.type(el, '4829');
      el.setSelectionRange(1, 3);
      await userEvent.keyboard('7');
    });
    await check('typed, a selection deleted with Backspace, typed again', async (el) => {
      await userEvent.type(el, '4829');
      el.setSelectionRange(0, 4);
      await userEvent.keyboard('{Backspace}');
      await userEvent.keyboard('31');
    });
    await check('typed, a word deleted with Control+Backspace, typed again', (el) => {
      for (const ch of '4829') press(el, ch);
      press(el, 'Backspace', { ctrlKey: true });
      press(el, '5');
    });
    await check('a touch keyboard: its unnamed keys type and delete', (el) => {
      const touch = (change: () => void) => {
        fireEvent.keyDown(el, { key: 'Unidentified', keyCode: 229 });
        change();
        fireEvent.keyUp(el, { key: 'Unidentified', keyCode: 229 });
      };
      for (const ch of '48291') {
        touch(() => {
          setNatively(el, el.value + ch);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
        });
      }
      touch(() => execDelete(el));
    });
    expect(seen).toEqual({
      'a value set with no event, then one typed key': { filled: true, value: '731904' },
      'a value set with no event, then a typed Backspace': { filled: true, value: '731904' },
      'a value set with no event, then a deletion no key brought': { filled: true, value: '731904' },
      'typed, a value set with no event, then a typed Backspace and a key': { filled: true, value: '7319044' },
      'typed, then a deletion no key brought': { filled: true, value: '4829' },
      'typed, a selection replaced by a typed key': { filled: false, value: '479' },
      'typed, a selection deleted with Backspace, typed again': { filled: false, value: '31' },
      'typed, a word deleted with Control+Backspace, typed again': { filled: false, value: '5' },
      'a touch keyboard: its unnamed keys type and delete': { filled: false, value: '4829' },
    });
  });

  it('[DI-14][DI-19][DI-38] BADGE-AUTOFILL round 4: each check of the count stands on its own: a change no trusted key brought, one beyond what its key may do and text set before a key are each a fill even where the field ends as long as the count says; an input method\'s composition and forward deletions are typed; a field without noAutofill keeps no count', () => {
    // Low-level events, so each case reaches exactly one of the field's checks.
    const keyDown = (el: HTMLInputElement, key: string, init: { ctrlKey?: boolean; trusted?: boolean } = {}) => {
      const e = new KeyboardEvent('keydown', { bubbles: true, key, ctrlKey: init.ctrlKey ?? false });
      if (init.trusted === false) Object.defineProperty(e, 'isTrusted', { value: false });
      el.dispatchEvent(e);
    };
    const keyUp = (el: HTMLInputElement, key: string) => el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key }));
    const change = (el: HTMLInputElement, value: string, inputType: string, data: string | null = null, trusted = true) => {
      setNatively(el, value);
      const e = new InputEvent('input', { bubbles: true, inputType, data });
      if (!trusted) Object.defineProperty(e, 'isTrusted', { value: false });
      el.dispatchEvent(e);
    };
    /** A printable key typed as the browser types it, at the caret. */
    const typeKeys = (el: HTMLInputElement, text: string) => {
      for (const ch of text) {
        keyDown(el, ch);
        change(el, el.value + ch, 'insertText', ch);
        keyUp(el, ch);
      }
    };
    const cases: Record<string, [boolean, (el: HTMLInputElement) => void]> = {
      'typed, then a deletion and an insertion no key brought, back to the typed length': [true, (el) => {
        typeKeys(el, '1234');
        change(el, '123', 'deleteContentBackward');
        change(el, '1239', 'insertText', '9');
      }],
      'typed, a shorter value set with no event, then a touch keyboard\'s deletion': [true, (el) => {
        typeKeys(el, '1234');
        setNatively(el, '999');
        el.setSelectionRange(3, 3);
        keyDown(el, 'Unidentified');
        change(el, '99', 'deleteContentBackward');
        keyUp(el, 'Unidentified');
      }],
      'a key the field did not take, released, then an insertion no key brought': [true, (el) => {
        keyDown(el, '4');
        keyUp(el, '4');
        change(el, '9', 'insertText', '9');
      }],
      'one key, then two insertions before its release': [true, (el) => {
        keyDown(el, '4');
        change(el, '4', 'insertText', '4');
        change(el, '49', 'insertText', '9');
        keyUp(el, '4');
      }],
      'Backspace, then an insertion': [true, (el) => {
        typeKeys(el, '12');
        keyDown(el, 'Backspace');
        change(el, '123', 'insertText', '3');
        keyUp(el, 'Backspace');
      }],
      'Control+Backspace, then an insertion': [true, (el) => {
        typeKeys(el, '12');
        keyDown(el, 'Backspace', { ctrlKey: true });
        change(el, '123', 'insertText', '3');
        keyUp(el, 'Backspace');
      }],
      'a printable key, then a deletion': [true, (el) => {
        typeKeys(el, '123');
        keyDown(el, '4');
        change(el, '12', 'deleteContentBackward');
        keyUp(el, '4');
      }],
      'Backspace taking two characters with no selection': [true, (el) => {
        typeKeys(el, '1234');
        keyDown(el, 'Backspace');
        change(el, '12', 'deleteContentBackward');
        keyUp(el, 'Backspace');
      }],
      'a selection of three deleted with Backspace, one character gone': [true, (el) => {
        typeKeys(el, '1234');
        el.setSelectionRange(1, 4);
        keyDown(el, 'Backspace');
        change(el, '123', 'deleteContentBackward');
        keyUp(el, 'Backspace');
      }],
      'a word deletion taking more than lies before the caret': [true, (el) => {
        typeKeys(el, '1234');
        el.setSelectionRange(2, 2);
        keyDown(el, 'Backspace', { ctrlKey: true });
        change(el, '4', 'deleteWordBackward');
        keyUp(el, 'Backspace');
      }],
      'a word deletion that removed nothing': [true, (el) => {
        typeKeys(el, '12');
        keyDown(el, 'Backspace', { ctrlKey: true });
        change(el, '12', 'deleteWordBackward');
        keyUp(el, 'Backspace');
      }],
      'Delete at the caret (forward)': [false, (el) => {
        typeKeys(el, '1234');
        el.setSelectionRange(0, 0);
        keyDown(el, 'Delete');
        change(el, '234', 'deleteContentForward');
        keyUp(el, 'Delete');
      }],
      'a forward word deletion within what follows the caret': [false, (el) => {
        typeKeys(el, '1234');
        el.setSelectionRange(1, 1);
        keyDown(el, 'Delete', { ctrlKey: true });
        change(el, '1', 'deleteWordForward');
        keyUp(el, 'Delete');
      }],
      'a forward word deletion taking more than follows the caret': [true, (el) => {
        typeKeys(el, '1234');
        el.setSelectionRange(3, 3);
        keyDown(el, 'Delete', { ctrlKey: true });
        change(el, '1', 'deleteWordForward');
        keyUp(el, 'Delete');
      }],
      'an input method composing and committing (keys "Process")': [false, (el) => {
        typeKeys(el, '1');
        for (const [value, data] of [['12', '2'], ['123', '23']] as const) {
          keyDown(el, 'Process');
          change(el, value, 'insertCompositionText', data);
          keyUp(el, 'Process');
        }
        el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '23' }));
        keyDown(el, 'Process');
        change(el, '1234', 'insertCompositionText', '4');
        keyUp(el, 'Process');
      }],
      'an input method removing its composition': [false, (el) => {
        typeKeys(el, '1');
        keyDown(el, 'Process');
        change(el, '123', 'insertCompositionText', '23');
        keyUp(el, 'Process');
        keyDown(el, 'Process');
        change(el, '1', 'deleteCompositionText');
        keyUp(el, 'Process');
      }],
      'an input method removing more than its composition': [true, (el) => {
        typeKeys(el, '12');
        keyDown(el, 'Process');
        change(el, '123', 'insertCompositionText', '3');
        keyUp(el, 'Process');
        keyDown(el, 'Process');
        change(el, '1', 'deleteCompositionText');
        keyUp(el, 'Process');
      }],
      'an input method composing over a selection': [false, (el) => {
        typeKeys(el, '1234');
        el.setSelectionRange(1, 3);
        keyDown(el, 'Process');
        change(el, '154', 'insertCompositionText', '5');
        keyUp(el, 'Process');
      }],
      'an input method composing, then a typed key': [false, (el) => {
        typeKeys(el, '1');
        keyDown(el, 'Process');
        change(el, '123', 'insertCompositionText', '23');
        keyUp(el, 'Process');
        typeKeys(el, '4');
      }],
      'an input method removing part of its composition': [true, (el) => {
        typeKeys(el, '1');
        keyDown(el, 'Process');
        change(el, '123', 'insertCompositionText', '23');
        keyUp(el, 'Process');
        keyDown(el, 'Process');
        change(el, '12', 'deleteCompositionText');
        keyUp(el, 'Process');
      }],
      'a word deletion over a selection of three, one character gone': [true, (el) => {
        typeKeys(el, '1234');
        el.setSelectionRange(1, 4);
        keyDown(el, 'Backspace', { ctrlKey: true });
        change(el, '123', 'deleteWordBackward');
        keyUp(el, 'Backspace');
      }],
      'a scripted key on its own': [true, (el) => {
        keyDown(el, '4', { trusted: false });
      }],
      'an input method key ("Process") typing a digit': [false, (el) => {
        keyDown(el, 'Process');
        change(el, '7', 'insertText', '7');
        keyUp(el, 'Process');
      }],
      'a shortcut (Control+V), then an insertion': [true, (el) => {
        keyDown(el, 'v', { ctrlKey: true });
        change(el, 'v', 'insertText', 'v');
        keyUp(el, 'v');
      }],
      'a key that brings nothing (Shift), then an insertion': [true, (el) => {
        keyDown(el, 'Shift');
        change(el, 'A', 'insertText', 'A');
        keyUp(el, 'Shift');
      }],
      'a key, then an insertion with no data': [true, (el) => {
        keyDown(el, '4');
        change(el, '', 'insertText', null);
        keyUp(el, '4');
      }],
      'a touch keyboard key, then an insertion of empty text': [true, (el) => {
        keyDown(el, 'Unidentified');
        change(el, '', 'insertText', '');
        keyUp(el, 'Unidentified');
      }],
      'a trusted key, then a scripted insertText of its character': [true, (el) => {
        keyDown(el, '4');
        change(el, '4', 'insertText', '4', false);
        keyUp(el, '4');
      }],
      'a scripted key, then a trusted insertText of its character': [true, (el) => {
        keyDown(el, '4', { trusted: false });
        change(el, '4', 'insertText', '4');
        keyUp(el, '4');
      }],
      'a touch keyboard key, then a cut': [true, (el) => {
        typeKeys(el, '12');
        keyDown(el, 'Unidentified');
        change(el, '1', 'deleteByCut');
        keyUp(el, 'Unidentified');
      }],
    };
    const seen: Record<string, boolean> = {};
    const want: Record<string, boolean> = {};
    for (const [name, [filled, act]] of Object.entries(cases)) {
      const ref = createRef<HTMLInputElement>();
      const { unmount } = render(<SecretInput label="New PIN" name="newSecret" inputRef={ref} noAutofill />);
      const el = screen.getByLabelText<HTMLInputElement>('New PIN');
      el.focus();
      act(el);
      seen[name] = wasFilled(ref);
      want[name] = filled;
      unmount();
    }
    expect(seen).toEqual(want);

    // A field without noAutofill (an office password) keeps no count: what is typed or set there is never "filled in",
    // and reading it gives the text. Turned on later, the field starts counting; turned off, it stops.
    const ref = createRef<HTMLInputElement>();
    const r = render(<SecretInput label="Password" name="password" inputRef={ref} />);
    const plain = screen.getByLabelText<HTMLInputElement>('Password');
    setNatively(plain, 'saved-password');
    expect({ filled: wasFilled(ref), secret: takeSecret(ref) }).toEqual({ filled: false, secret: 'saved-password' });
    r.rerender(<SecretInput label="Password" name="password" inputRef={ref} noAutofill />);
    setNatively(plain, '4829');
    expect(wasFilled(ref), 'noAutofill turned on').toBe(true);
    r.rerender(<SecretInput label="Password" name="password" inputRef={ref} />);
    expect({ filled: wasFilled(ref), secret: takeSecret(ref) }, 'noAutofill turned off').toEqual({ filled: false, secret: '4829' });
    r.unmount();
  });

  it('[DI-14][DI-38] keyed text keeps its own answer: a PIN keyed into the field is not a badge, and a reader\'s burst is a tap', async () => {
    const onTap = vi.fn();
    render(<BadgePrompt reason="Tap your badge to sign in." onTap={onTap} timeoutSeconds={null} />);
    const field = screen.getByLabelText<HTMLInputElement>('Badge');
    await userEvent.type(field, '482913{Enter}');
    expect(screen.getByText(NOT_A_BADGE)).toBeTruthy();
    expect(screen.queryByText(NOT_TAPPED)).toBeNull();
    await userEvent.type(field, '04A10000000001{Enter}');
    expect(onTap).toHaveBeenCalledExactlyOnceWith('04A10000000001');
  });
});
