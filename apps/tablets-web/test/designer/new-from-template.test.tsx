/**
 * New master record from a template (module C2): the form appears only with the templates, so what the author
 * types never replaces the template's product with blank fields (product name and strength come from the
 * template until the author edits them).
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { FetchLike } from '@ebmr/api-contract';
import { setTransport } from '../../src/api/client.ts';
import { createFixtureFetch } from '../../src/api/fixture-fetch.ts';
import { NewFromTemplate } from '../../src/features/designer/NewFromTemplate.tsx';
import { renderRouted } from './support.tsx';

const TEMPLATE = { templateId: 'dc-mini', title: 'Paracetamol 500 mg tablets, direct compression (mini)', description: 'Two stages', product: { code: 'PCM500', name: 'Paracetamol tablets', strength: '500 mg' }, markets: ['IN'], steps: 14 };

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
});
