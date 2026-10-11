/**
 * Master data screens (Phase 3 slice 6): the formula library, the composition only with FORMULA.READ, a version
 * approved through the ceremony, a new version written per unit; ERP masters read only; plant definitions; and
 * "Choose a product" in the designer's create flow.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { EXAMPLES, example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { COMPOSITION_REFUSED } from '../../src/features/master-data/FormulaPage.tsx';
import { refusal, renderOffice } from './support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const formula = example('master-data-formula');
const formulaPath = `/master-data/formulas/${formula.formula.formulaId}`;
const draft = example('master-data-add-formula-version');

describe('formulas', () => {
  it('the composition is shown with the batch quantities the database computed', async () => {
    renderOffice(formulaPath, { role: 'QA_REVIEWER' });
    const table = await screen.findByTestId('composition');
    const first = formula.versions[0]?.lines?.[0];
    expect(table.textContent).toContain(`${first?.batchQuantity ?? 'x'} kg`);
    expect(screen.queryByText(COMPOSITION_REFUSED)).toBeNull();
  });

  it('a reader without FORMULA.READ sees the identity and the plain refusal, never the composition', async () => {
    renderOffice(formulaPath, { role: 'OPERATOR', fixtures: { 'masterData.formula': EXAMPLES['master-data-formula-no-read'].data } });
    expect(await screen.findByText(COMPOSITION_REFUSED)).toBeTruthy();
    expect(screen.queryByTestId('composition')).toBeNull();
    expect(screen.queryByTestId('new-formula-version')).toBeNull();
  });

  it('a DRAFT version is approved by a second person through the ceremony (MASTER_DATA_APPROVE); an operator is not offered it', async () => {
    const withDraft = { ...formula, versions: [draft, ...formula.versions] };
    const ui = renderOffice(formulaPath, { role: 'QA_REVIEWER', fixtures: { 'masterData.formula': withDraft } });
    const card = await screen.findByTestId('formula-version-2');
    await userEvent.click(within(card).getByRole('button', { name: 'Approve version 2' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'MASTER_DATA_APPROVE', masterKind: 'FORMULA', versionId: draft.versionId });
    cleanup();
    renderOffice(formulaPath, { role: 'OPERATOR', fixtures: { 'masterData.formula': withDraft } });
    const again = await screen.findByTestId('formula-version-2');
    expect(within(again).queryByRole('button', { name: /Approve/ })).toBeNull();
  });

  it('a new version is written per unit (no batch quantity typed) and a refusal is shown with the server\'s words', async () => {
    const ui = renderOffice(formulaPath, { role: 'MASTER_DATA_STEWARD', fixtures: { 'masterData.addFormulaVersion': refusal('EBMR-FORM-010', 'Only one compensating excipient per formula.') } });
    const form = await screen.findByTestId('new-formula-version');
    expect(within(form).queryByRole('textbox', { name: /batch quantity/i })).toBeNull();
    await userEvent.type(within(form).getByRole('textbox', { name: 'Line id' }), 'api');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Material code' }), 'API-GBT');
    await userEvent.click(within(form).getByRole('radio', { name: 'ACTIVE' }));
    await userEvent.click(within(form).getByRole('radio', { name: 'PER_UNIT' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Quantity' }), '500');
    const yesNo = within(form).getAllByRole('radio', { name: 'No' });
    for (const r of yesNo) await userEvent.click(r);
    await userEvent.type(within(form).getByRole('textbox', { name: 'Reason for the new version' }), 'Coating level changed');
    await userEvent.click(within(form).getByRole('button', { name: 'Write the draft version' }));
    await waitFor(() => expect(ui.posts(`/api/master-data/formulas/${formula.formula.formulaId}/versions`)).toHaveLength(1));
    expect(ui.posts(`/api/master-data/formulas/${formula.formula.formulaId}/versions`)[0]?.body).toEqual({
      changeReason: 'Coating level changed',
      lines: [{ lineId: 'api', materialCode: 'API-GBT', role: 'ACTIVE', basis: 'PER_UNIT', quantity: '500', potencyAdjusted: false, compensating: false }],
    });
    expect(await screen.findByText('Only one compensating excipient per formula.')).toBeTruthy();
  });
});

describe('ERP masters and plant definitions', () => {
  it('the ERP products and materials are read only', async () => {
    renderOffice('/master-data/erp');
    const products = await screen.findByTestId('erp-products');
    await waitFor(() => expect(within(products).getAllByRole('row').length).toBeGreaterThan(1));
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('plant areas are listed and a definition is sent as the contract takes it; a steward only', async () => {
    const ui = renderOffice('/master-data/plant', { role: 'MASTER_DATA_STEWARD' });
    const panel = await screen.findByTestId('plant-areas');
    const area = example('plant-areas').areas[0];
    await waitFor(() => expect(panel.textContent).toContain(area?.code ?? 'x'));
    const form = within(panel).getByTestId('form-Define: Areas');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Code' }), 'GRAN-2');
    await userEvent.click(within(form).getByRole('radio', { name: 'ROOM' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Name' }), 'Granulation room 2');
    await userEvent.click(within(form).getByRole('button', { name: 'Define' }));
    await waitFor(() => expect(ui.posts('/api/master-data/plant/areas')).toHaveLength(1));
    expect(ui.posts('/api/master-data/plant/areas')[0]?.body).toEqual({ code: 'GRAN-2', kind: 'ROOM', name: 'Granulation room 2' });
    cleanup();
    renderOffice('/master-data/plant', { role: 'OPERATOR' });
    await screen.findByTestId('plant-areas');
    expect(screen.queryByTestId('form-Define: Areas')).toBeNull();
  });
});

describe('"Choose a product" in the designer\'s create flow', () => {
  it('shows the approved formula\'s BOM with computed quantities (read only) and fills the product', async () => {
    const ui = renderOffice('/mbr/new', { role: 'MBR_AUTHOR' });
    const panel = await screen.findByTestId('choose-product');
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Formula product' }), 'GBT01');
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Formula strength' }), '500 mg');
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Formula batch size (tablets)' }), '200000');
    await userEvent.click(within(panel).getByRole('button', { name: 'Choose this product' }));
    const bom = await within(panel).findByTestId('formula-bom');
    const choice = example('designer-formula-choice');
    expect(ui.requests.find((r) => r.path === '/api/designer/formula-choice')?.query).toEqual({ product: 'GBT01', strength: '500 mg', batchSize: '200000' });
    expect(bom.textContent).toContain(`${choice.bom[0]?.batchQuantity ?? 'x'} kg`);
    expect(within(bom).queryByRole('textbox')).toBeNull();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Product code' }).value).toBe('GBT01');
  });

  it('a refusal (no FORMULA.READ, no approved version) is shown with the server\'s words', async () => {
    renderOffice('/mbr/new', { role: 'MBR_AUTHOR', fixtures: { 'designer.formulaChoice': refusal('EBMR-FORM-003', 'No approved formula for GBT01 250 mg.') } });
    const panel = await screen.findByTestId('choose-product');
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Formula product' }), 'GBT01');
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Formula strength' }), '250 mg');
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Formula batch size (tablets)' }), '100000');
    await userEvent.click(within(panel).getByRole('button', { name: 'Choose this product' }));
    expect(await within(panel).findByText('No approved formula for GBT01 250 mg.')).toBeTruthy();
    expect(within(panel).queryByTestId('formula-bom')).toBeNull();
  });
});
