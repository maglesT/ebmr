/**
 * New master record from a template (module C2): the form appears only with the templates, so what the author
 * types never replaces the template's product with blank fields (product name and strength come from the
 * template until the author edits them).
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { example } from '@ebmr/api-contract/examples';
import type { FetchLike } from '@ebmr/api-contract';
import { setTransport } from '../../src/api/client.ts';
import { createFixtureFetch } from '../../src/api/fixture-fetch.ts';
import { NewFromTemplate } from '../../src/features/designer/NewFromTemplate.tsx';
import { renderRouted } from './support.tsx';

const TEMPLATE = {
  templateId: 'dc-mini',
  title: 'Paracetamol 500 mg tablets, direct compression (mini)',
  description: 'Two stages',
  product: { code: 'PCM500', name: 'Paracetamol tablets', strength: '500 mg' },
  batchSizes: [
    { quantity: '60.000', unit: 'kg' },
    { quantity: '30.000', unit: 'kg' },
  ],
  markets: ['IN'],
  steps: 14,
};

describe('new master record from a template', () => {
  it('[PR-01] the form waits for the templates; the product code typed then keeps the template\'s product name and strength', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fixtures = createFixtureFetch({ 'designer.templates': { templates: [TEMPLATE] } }, { installation: 'GMP' });
    const slow: FetchLike = async (url, init) => {
      await gate;
      return fixtures(url, init);
    };
    setTransport(slow);
    renderRouted(() => <NewFromTemplate />);
    expect(await screen.findByText('Loading the templates…')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Product code' })).toBeNull();
    release();
    const code = await screen.findByRole('textbox', { name: 'Product code' });
    await userEvent.clear(code);
    await userEvent.type(code, 'PCM500-X');
    const value = (name: string): string | null => screen.getByRole('textbox', { name }).getAttribute('value');
    await waitFor(() => expect(value('Product name')).toBe('Paracetamol tablets'));
    expect(value('Strength')).toBe('500 mg');
  });

  it('[PR-01] the approved batch sizes start as the template\'s (the first is its bill of materials\' reference) and are sent as shown, until the author edits them (lead TODO T6)', async () => {
    expect(routes.designer.templates.response.safeParse({ templates: [TEMPLATE] }).success).toBe(true);
    const created: unknown[] = [];
    setTransport(
      createFixtureFetch(
        {
          'designer.templates': { templates: [TEMPLATE] },
          'designer.createFamily': ({ body }: { body: unknown }) => {
            created.push(body);
            return { status: 422, body: { refusal: { code: 'X', kind: 'INVALID_INPUT', whatHappened: 'Stopped here by the test.', why: '', controls: [], whatYouCanDo: [], whoCanHelp: [] }, correlationId: 'c', retryable: false } };
          },
        },
        { installation: 'GMP' },
      ),
    );
    renderRouted(() => <NewFromTemplate />);
    const first = await screen.findByRole('textbox', { name: 'Batch size 1' });
    expect(first.getAttribute('value')).toBe('60.000');
    expect(screen.getByRole('textbox', { name: 'Batch size 2' }).getAttribute('value')).toBe('30.000');
    await userEvent.click(screen.getByRole('button', { name: 'Create the family and its draft' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect((created[0] as { batchSizes: unknown }).batchSizes).toEqual([
      { quantity: '60.000', unit: 'kg' },
      { quantity: '30.000', unit: 'kg' },
    ]);
    // The author's own sizes replace the template's.
    await userEvent.click(screen.getByRole('button', { name: 'Remove batch size 2' }));
    await userEvent.clear(first);
    await userEvent.type(first, '120.000');
    await userEvent.click(screen.getByRole('button', { name: 'Create the family and its draft' }));
    await waitFor(() => expect(created).toHaveLength(2));
    expect((created[1] as { batchSizes: unknown }).batchSizes).toEqual([{ quantity: '120.000', unit: 'kg' }]);
  });
  it('[PR-01][PR-32] injectables I-1c2 P3: "an injectables packaging master" from the formula asks for the printed material and artwork of LABEL, LEAFLET and CARTON and sends them with the PACKAGING start', async () => {
    const created: unknown[] = [];
    setTransport(
      createFixtureFetch(
        {
          'designer.templates': { templates: [TEMPLATE] },
          'designer.formulaChoice': example('designer-formula-choice'),
          'designer.createFamily': ({ body }: { body: unknown }) => {
            created.push(body);
            return { status: 422, body: { refusal: { code: 'X', kind: 'INVALID_INPUT', whatHappened: 'Stopped here by the test.', why: '', controls: [], whatYouCanDo: [], whoCanHelp: [] }, correlationId: 'c', retryable: false } };
          },
        },
        { installation: 'GMP' },
      ),
    );
    renderRouted(() => <NewFromTemplate />);
    await userEvent.click(await screen.findByRole('radio', { name: /an injectables packaging master/ }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Formula product' }), 'INJ-1');
    await userEvent.type(screen.getByRole('textbox', { name: 'Formula strength' }), '10 mg');
    await userEvent.type(screen.getByRole('textbox', { name: 'Formula batch size (units)' }), '100000');
    await userEvent.click(screen.getByRole('button', { name: 'Choose this product' }));
    await screen.findByTestId('formula-bom');
    const create = screen.getByRole('button', { name: 'Create the family and its draft' });
    // Incomplete until every printed item names its material and artwork.
    expect(create.hasAttribute('disabled') || create.getAttribute('aria-disabled') === 'true' || create.hasAttribute('data-disabled')).toBe(true);
    for (const item of ['LABEL', 'LEAFLET', 'CARTON']) {
      await userEvent.type(screen.getByRole('textbox', { name: `Printed material for ${item}` }), `PM-${item}`);
      await userEvent.type(screen.getByRole('textbox', { name: `Artwork version for ${item}` }), `ART-${item}-1`);
    }
    await userEvent.click(create);
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({
      start: 'PACKAGING',
      printed: ['LABEL', 'LEAFLET', 'CARTON'].map((item) => ({ item, material: `PM-${item}`, artwork: `ART-${item}-1` })),
    });
    expect(routes.designer.createFamily.body?.safeParse(created[0]).success).toBe(true);
  });
});
