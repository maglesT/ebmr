/**
 * API edition plan A0: the contract writes the editions out (it imports no recipe-core code at run time, so the browser
 * bundle stays as it was under the strict CSP); this test keeps the list equal to recipe-core's flow.EDITIONS.
 */
import { describe, expect, it } from 'vitest';
import { flow } from '@ebmr/recipe-core/pure';
import { routes } from '../src/index.ts';

describe('the editions the contract accepts (API plan A0)', () => {
  it('[PR-01] createFamily takes exactly the editions of recipe-core flow.EDITIONS, the substance edition among them', () => {
    const body = routes.designer.createFamily.body as unknown as { shape: { edition: { unwrap: () => { options: string[] } } } };
    expect([...body.shape.edition.unwrap().options]).toEqual([...flow.EDITIONS]);
  });
});
