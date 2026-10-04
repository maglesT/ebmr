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
import { createRef } from 'react';
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
