/**
 * Text no record can hold, typed into the designer (review F31, round 2; DI-37, DI-04): U+0000, which PostgreSQL text
 * and jsonb refuse, and a UTF-16 surrogate without its other half, which jsonb refuses and UTF-8 encoding turns into
 * U+FFFD. A browser keeps U+0000 in an input's value (Chromium's insertText does), so an author's text can hold it.
 *
 * Before the fix the edit operation took such text into the content, and the editor hashed that content while it
 * rendered (flow.mbrContentHash, whose canonical JSON refuses such text since F31): the whole screen was replaced by
 * "Something went wrong". Now the edit operation refuses it, naming the field, so the text never enters the content
 * being edited: the editor stays up, the author is told which field to correct, and nothing is validated, kept as a
 * draft or saved with it.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unstorableText } from '@ebmr/expr';
import { DesignerEditor } from '../../src/features/designer/DesignerPage.tsx';
import { draftKey } from '../../src/features/designer/model/draft.ts';
import { finding, fixtureVersion, installFixtures, PALETTE, renderRouted, report, VERSION_ID } from './support.tsx';

let validated: unknown[] = [];

beforeEach(() => {
  window.localStorage.clear();
  validated = [];
  installFixtures({
    'designer.validate': ({ body }: { body: { content: unknown } }) => {
      validated.push(body.content);
      return report([finding({ key: 'GMP-STAGE-CLEARANCE@p-disp-clear', nodeId: 'p-disp-clear', subjectPath: ['procedure', 'S-DISP', 'p-disp-clear'], message: 'Clearance problem' })]);
    },
  });
});
afterEach(() => {
  window.localStorage.clear();
});

/** Every string and member name of `value` that holds text no record can hold. */
function unstorableIn(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      if (unstorableText(v) !== null) out.push(v);
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (unstorableText(k) !== null) out.push(k);
        visit(x);
      }
    }
  };
  visit(value);
  return out;
}

/** Types `text` into a field as the browser leaves it (the input's value holds it) and commits it (blur). */
function enter(field: HTMLElement, text: string): void {
  fireEvent.change(field, { target: { value: text } });
  expect((field as HTMLInputElement).value, 'SETUP: the field holds the text as typed').toBe(text);
  fireEvent.blur(field);
}

async function refusalNaming(field: RegExp, character: RegExp): Promise<string> {
  const banner = await screen.findByText('That change was not made.');
  const text = banner.closest('[role="alert"], [role="status"], section, div')?.textContent ?? '';
  expect(text).toMatch(field);
  expect(text).toMatch(character);
  return text;
}

/** The editor is still the designer, not the error screen. */
function editorIsUp(): void {
  expect(screen.queryByText(/Something went wrong/)).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Title' })).toBeTruthy();
  expect(screen.getByRole('table', { name: 'Procedure' })).toBeTruthy();
}

describe('text no record can hold, typed into the designer (review F31 round 2)', () => {
  it('[DI-37][DI-04] U+0000 in the title: the editor stays up, the title is named, and the text never enters the content, its validation or its draft', async () => {
    renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} />);
    const title = await screen.findByRole('textbox', { name: 'Title' });
    await waitFor(() => expect(validated.length).toBeGreaterThan(0), { timeout: 5000 });
    enter(title, 'Edited\u0000 title');
    const shown = await refusalNaming(/The title/, /U\+0000/);
    expect(shown).not.toContain('\u0000');
    editorIsUp();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).not.toContain('Edited');
    // The author corrects the text in the same field: the change is made and the message goes.
    enter(screen.getByRole('textbox', { name: 'Title' }), 'Edited title');
    expect(await screen.findByText('Unsaved changes')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('That change was not made.')).toBeNull());
    await waitFor(() => expect((validated.at(-1) as { header: { title: string } }).header.title).toBe('Edited title'), { timeout: 5000 });
    expect(validated.flatMap(unstorableIn)).toEqual([]);
    expect(unstorableIn(JSON.parse(window.localStorage.getItem(draftKey(VERSION_ID)) ?? 'null'))).toEqual([]);
  });

  it('[DI-37][DI-04] a lone surrogate in a step name and U+0000 in a hold point name: the editor stays up and names each field; nothing enters the content', async () => {
    renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} />);
    await userEvent.click(await screen.findByRole('row', { name: /Step 1\.1\.1 Dispensing booth clearance/ }));
    const stepName = await screen.findByRole('textbox', { name: 'Step name (as the operator sees it)' });
    enter(stepName, 'Booth \ud800 clearance');
    await refusalNaming(/The step name/, /unpaired surrogate U\+D800/);
    editorIsUp();
    expect(screen.getByRole('row', { name: /Step 1\.1\.1 Dispensing booth clearance/ })).toBeTruthy();
    expect(screen.queryByText('Unsaved changes')).toBeNull();

    await userEvent.click(screen.getByRole('row', { name: /Cores approved for coating/ }));
    const holdName = await screen.findByRole('textbox', { name: 'Name' });
    enter(holdName, 'Cores\u0000 approved');
    await refusalNaming(/The hold point name/, /U\+0000/);
    editorIsUp();
    expect(screen.getByRole('row', { name: /Cores approved for coating/ })).toBeTruthy();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    expect(validated.flatMap(unstorableIn)).toEqual([]);
    expect(window.localStorage.getItem(draftKey(VERSION_ID))).toBeNull();
  });
});
