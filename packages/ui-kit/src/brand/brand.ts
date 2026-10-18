/**
 * The product's identity (decision 0020): Batchwright by Medhanta, edition Tablets or Injectables. This is what the
 * screens show as the product and its maker (the sign-in page, the header, the about page). It never goes on a GMP
 * record: a batch record, true copy, label, report or certificate carries the manufacturer's own name and site
 * (decision 0020 point 3; D-P7-11: no "Batchwright" version line in v1.0). Code names (packages, schemas, the `ebmr`
 * prefix) do not change.
 */
export type Edition = 'TABLETS' | 'INJECTABLES';

export const PRODUCT = {
  name: 'Batchwright',
  maker: 'Medhanta',
  makerFull: 'Medhanta Digipartner',
  tagline: 'Every batch, proven',
} as const;

const EDITION_WORD: Readonly<Record<Edition, string>> = { TABLETS: 'Tablets', INJECTABLES: 'Injectables' };

/** "Batchwright Tablets" or "Batchwright Injectables". */
export function productTitle(edition: Edition): string {
  return `${PRODUCT.name} ${EDITION_WORD[edition]}`;
}

/** The edition's word as the lockup's badge shows it in sentence case ("Tablets"). */
export function editionWord(edition: Edition): string {
  return EDITION_WORD[edition];
}
