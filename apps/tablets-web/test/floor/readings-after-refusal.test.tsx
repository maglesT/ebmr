/**
 * Captured scale readings after a refused weighing (Phase 2 exit review F59; DI-32, PR-19, DI-28).
 *
 * A reading stays used only when the command that names it commits (tab.reading_use is written in the command's
 * transaction): an engine refusal is committed, so the readings it names are spent, and the server says which
 * (details.readingsUsed). A refusal given before the command runs (a badge or PIN not accepted, a locked session), or
 * thrown while the intent is resolved (an unknown lot, a reading that cannot be claimed), rolls back and spends nothing:
 * the form keeps the captures, so the operator, whose container is now full, sends the same weighing again. A claim
 * refusal naming one reading (too old, already used...) drops only that one. Tare and gross from different scales or in
 * different units are said before anything is sent, and a captured reading shows its age before the server's maximum.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReadingView } from '@ebmr/api-contract';
import { ATTRIBUTION, envelope, fakeScaleSlot, fakeTap, reading, renderFloor, RUN_ID, stepFixtures, stepPath, stepVariant, type Answer } from './support.tsx';

const commandPath = `/api/test-runs/${RUN_ID}/commands`;
const TARE_ID = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e01';
const GROSS_ID = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e02';
const g07 = stepVariant('step-g07-weighing', (v) => {
  v.entryForms[0]!.fields = v.entryForms[0]!.fields.filter((f) => f.name !== 'bomLine');
  v.entryForms[0]!.fields.unshift({ name: 'bomLine', label: 'Material (BOM line)', type: 'enum', unit: null, options: [{ value: 'BOM-API', label: 'Paracetamol (BOM-API)' }], required: true, description: 'The BOM line' });
});
const ok = { status: 200, body: { accepted: true, version: 8, step: null } };

async function weighAndSave(opts: { answers: Answer[]; tare?: ReadingView; gross?: ReadingView; session?: { attribution: 'TAP_PIN' }; tap?: ReturnType<typeof fakeTap> }) {
  const slot = fakeScaleSlot({ TARE: opts.tare ?? reading('TARE', TARE_ID, '1.250'), GROSS: opts.gross ?? reading('GROSS', GROSS_ID, '26.250') });
  const answers = [...opts.answers];
  const ui = renderFloor(stepPath('p-disp-api@'), {
    scaleSlot: slot,
    fixtures: stepFixtures(g07),
    ...(opts.session ? { session: opts.session } : {}),
    ...(opts.tap ? { tap: opts.tap } : {}),
    intercept: (r) => (r.path === commandPath ? (answers.shift() ?? ok) : undefined),
  });
  const form = await screen.findByTestId('form-CONTAINER_WEIGHING');
  await userEvent.type(within(form).getByRole('textbox', { name: 'Lot' }), 'TEST-L26-0101{Enter}');
  await userEvent.click(within(form).getByRole('radio', { name: 'Paracetamol (BOM-API)' }));
  await userEvent.click(within(form).getByRole('button', { name: /^Capture tare on / }));
  await userEvent.click(within(form).getByRole('button', { name: /^Capture gross on / }));
  return { ui, form };
}

const save = (form: HTMLElement) => userEvent.click(within(form).getByRole('button', { name: 'Save: Weigh one container' }));
const kept = (form: HTMLElement) => ({ tare: within(form).queryByTestId('reading-TARE') !== null, gross: within(form).queryByTestId('reading-GROSS') !== null });
const readingsOf = (body: Record<string, unknown> | undefined) => {
  const entry = (body?.['intent'] as { entry: Record<string, unknown> }).entry;
  return { tare: entry['tareReadingId'], gross: entry['grossReadingId'] };
};

describe('captured readings after a refused weighing (F59)', () => {
  it('[DI-32][PR-19] a badge not accepted (401 EBMR-IAM-140, refused before the command): both readings stay, and the resend names the same readings', async () => {
    const { ui, form } = await weighAndSave({ answers: [{ status: 401, body: envelope('AUTH_FAILED', 'EBMR-IAM-140', { whatHappened: 'The badge was not accepted.' }, true) }] });
    await save(form);
    expect(await within(form).findByText('The badge was not accepted.')).toBeTruthy();
    expect(kept(form)).toEqual({ tare: true, gross: true });
    await save(form);
    await waitFor(() => expect(ui.commands()).toHaveLength(2));
    expect(readingsOf(ui.commands()[1]?.body)).toEqual({ tare: TARE_ID, gross: GROSS_ID });
  });

  it('[DI-32][PR-19] a PIN typo on a TAP_PIN kiosk (401 EBMR-IAM-140): the unused tare and gross stay for the resend', async () => {
    const tap = fakeTap();
    tap.requestTap.mockImplementation(() => Promise.resolve({ ...ATTRIBUTION, pin: '9999' }));
    const { form } = await weighAndSave({
      session: { attribution: 'TAP_PIN' },
      tap,
      answers: [{ status: 401, body: envelope('AUTH_FAILED', 'EBMR-IAM-140', { whatHappened: 'The badge or PIN was not accepted.' }, true) }],
    });
    await save(form);
    expect(await within(form).findByText('The badge or PIN was not accepted.')).toBeTruthy();
    expect(kept(form)).toEqual({ tare: true, gross: true });
  });

  it('[DI-32][PR-18] an unknown lot (422 EBMR-EXE-072, rolled back): the unused tare and gross stay while the lot is scanned again', async () => {
    const { form } = await weighAndSave({ answers: [{ status: 422, body: envelope('NOT_ALLOWED', 'EBMR-EXE-072', { whatHappened: 'Lot TEST-L26-0101 is not known on this installation. Nothing was saved.' }) }] });
    await save(form);
    expect(await within(form).findByText('Lot TEST-L26-0101 is not known on this installation. Nothing was saved.')).toBeTruthy();
    expect(kept(form)).toEqual({ tare: true, gross: true });
  });

  it('[DI-28][DI-32] a tare too old to use (422 EBMR-DEV-104 naming it, rolled back): only the tare goes; the unused gross stays', async () => {
    const why = `DI-28: reading ${TARE_ID} is too old to use (older than 120.0 s, or its capture time is not known); take a new reading`;
    const { form } = await weighAndSave({ answers: [{ status: 422, body: envelope('NOT_ALLOWED', 'EBMR-DEV-104', { whatHappened: 'The system refused this action.', why }) }] });
    await save(form);
    expect(await within(form).findByText('The system refused this action.')).toBeTruthy();
    expect(kept(form)).toEqual({ tare: false, gross: true });
  });

  it('[DI-32][PR-19] an engine refusal the server committed with the claims (details.readingsUsed): both readings are spent and go', async () => {
    const { form } = await weighAndSave({
      answers: [{ status: 422, body: envelope('NOT_ALLOWED', 'G07-LOT-STATUS', { whatHappened: 'Lot TEST-L26-0101 is in quarantine.', details: { readingsUsed: `${TARE_ID},${GROSS_ID}` } }) }],
    });
    await save(form);
    expect(await within(form).findByText('Lot TEST-L26-0101 is in quarantine.')).toBeTruthy();
    expect(kept(form)).toEqual({ tare: false, gross: false });
  });

  it('[DI-30][PR-19] tare and gross from different scales are said before anything is sent; Save stays disabled', async () => {
    const gross: ReadingView = { ...reading('GROSS', GROSS_ID, '26.250'), deviceCode: 'TEST-BAL-03' };
    const { ui, form } = await weighAndSave({ answers: [], gross });
    expect(within(form).getByRole('alert').textContent).toBe('The tare was taken on TEST-BAL-01 and the gross on TEST-BAL-03: capture both on the same scale.');
    expect(within(form).getByRole('button', { name: 'Save: Weigh one container' }).hasAttribute('disabled')).toBe(true);
    expect(ui.commands()).toHaveLength(0);
  });

  it('[DI-30][PR-19] tare and gross in different units are said before anything is sent; Save stays disabled', async () => {
    const gross: ReadingView = { ...reading('GROSS', GROSS_ID, '26250'), unit: 'g' };
    const { ui, form } = await weighAndSave({ answers: [], gross });
    expect(within(form).getByRole('alert').textContent).toBe('The tare is in kg and the gross in g: capture both on the same scale, in the same unit.');
    expect(within(form).getByRole('button', { name: 'Save: Weigh one container' }).hasAttribute('disabled')).toBe(true);
    expect(ui.commands()).toHaveLength(0);
  });
});

describe('the age of a captured reading (F59)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The display clock anchored so that the server's time now is the tare's recorded time plus `ageS` seconds. */
  async function anchoredAt(ageS: number) {
    const tare = reading('TARE', TARE_ID, '1.250');
    const { anchorServerTime } = await import('../../src/app/clock.ts');
    act(() => anchorServerTime((BigInt(tare.recordedAt.us) + BigInt(ageS) * 1_000_000n).toString()));
    return tare;
  }

  it('[DI-28][DI-32] a fresh capture says how long it can still be used', async () => {
    const tare = await anchoredAt(10);
    const { form } = await weighAndSave({ answers: [], tare, gross: { ...tare, readingId: GROSS_ID, purpose: 'GROSS', value: '26.250' } });
    expect(within(form).getByTestId('reading-TARE').textContent).toContain('Taken 10 s ago; usable for at most 120 s after it was taken.');
  });

  it('[DI-28][DI-32] a capture near the maximum age warns before the save; past it, it says to capture again', async () => {
    const tare = await anchoredAt(95);
    const { form } = await weighAndSave({ answers: [], tare, gross: { ...tare, readingId: GROSS_ID, purpose: 'GROSS', value: '26.250' } });
    expect(within(form).getByTestId('reading-TARE').textContent).toContain('Taken 95 s ago: save within 25 s, or this reading becomes too old to use.');
    await anchoredAt(130);
    await waitFor(() => expect(within(form).getByTestId('reading-TARE').textContent).toContain('Taken 130 s ago: too old to use. Capture it again.'), { timeout: 3000 });
  });
});
