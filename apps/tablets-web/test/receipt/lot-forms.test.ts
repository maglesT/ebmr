/**
 * Slice 7u (R10 #16; owner demo of 25 October 2026): the finished lot's page offered the starting-material forms (assay
 * basis, artwork version, identity test). A lot is offered only the forms its material kind takes.
 */
import { describe, expect, it } from 'vitest';
import { lotForms } from '../../src/features/quality/LotPage.tsx';

describe('the forms a lot is offered by its material kind (R10 #16)', () => {
  it('[IN-24][PR-17] a finished lot takes no identity test, assay or artwork; a starting material takes its own', () => {
    expect(lotForms('FINISHED')).toEqual({ identity: false, assay: false, artwork: false, retest: false });
    expect(lotForms('INTERMEDIATE')).toEqual({ identity: false, assay: false, artwork: false, retest: true });
    expect(lotForms('API')).toEqual({ identity: true, assay: true, artwork: false, retest: true });
    expect(lotForms('EXCIPIENT')).toMatchObject({ identity: true, assay: true, artwork: false });
    expect(lotForms('PRINTED_PACKAGING')).toEqual({ identity: true, assay: false, artwork: true, retest: true });
    expect(lotForms('PRIMARY_PACKAGING')).toEqual({ identity: true, assay: false, artwork: false, retest: true });
  });
});
