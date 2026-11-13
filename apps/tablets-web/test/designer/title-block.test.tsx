/**
 * Owner retest of 13 November 2026, item 9a: the approved master's title block said Prepared, Checked and Approved "not
 * signed" although all three signatures existed (the cells were fixed text). The block now shows each valid life-cycle
 * signature of the version (signer and time), read from the e-signature register; "not signed" only where none is.
 */
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ManifestationView } from '@ebmr/api-contract';
import { example } from '@ebmr/api-contract/examples';
import { TitleBlockSignatures } from '../../src/features/designer/components/DocumentView.tsx';
import { fixtureVersion, installFixtures, renderRouted, VERSION_ID } from './support.tsx';

afterEach(() => cleanup());

const sig = (meaning: string, name: string, text: string, valid = true): ManifestationView => ({
  ...example('manifestation'),
  meaning,
  valid,
  aggregateType: 'mbr_version',
  aggregateId: VERSION_ID,
  signer: { ...example('manifestation').signer, legalName: name },
  signedAt: { us: '1790580603000000', text },
});

function renderBlock(state: string): void {
  const version = fixtureVersion({ state: state as never });
  renderRouted(() => (
    <table>
      <tbody>
        <TitleBlockSignatures version={version} />
      </tbody>
    </table>
  ));
}

describe('the title block of a master version (owner retest item 9a)', () => {
  it('[PR-02] an approved version shows who prepared, checked and approved it, from its valid signatures', async () => {
    const asked: Record<string, string>[] = [];
    installFixtures({
      'esig.signatures': ({ query }: { query: Record<string, string> }) => {
        asked.push(query);
        return {
          signatures: [
            sig('PREPARED', 'Asha Rao', '10-NOV-2026 10:00:00 +05:30 (Asia/Kolkata)'),
            sig('CHECKED', 'Old Checker', '10-NOV-2026 11:00:00 +05:30 (Asia/Kolkata)', false),
            sig('CHECKED', 'Vikram Shah', '11-NOV-2026 09:00:00 +05:30 (Asia/Kolkata)'),
            sig('APPROVED', 'Meera Iyer', '12-NOV-2026 16:30:00 +05:30 (Asia/Kolkata)'),
            sig('REGULATORY_CONFIRMED', 'Rahul Menon', '12-NOV-2026 12:00:00 +05:30 (Asia/Kolkata)'),
          ],
        };
      },
    });
    renderBlock('APPROVED');
    await waitFor(() => expect(screen.getByTestId('title-block-APPROVED').textContent).toBe('Meera Iyer, 12-NOV-2026 16:30:00 +05:30 (Asia/Kolkata)'));
    expect(screen.getByTestId('title-block-PREPARED').textContent).toBe('Asha Rao, 10-NOV-2026 10:00:00 +05:30 (Asia/Kolkata)');
    expect(screen.getByTestId('title-block-CHECKED').textContent).toBe('Vikram Shah, 11-NOV-2026 09:00:00 +05:30 (Asia/Kolkata)');
    expect(asked).toEqual([{ aggregateType: 'mbr_version', aggregateId: VERSION_ID }]);
  });

  it('[PR-02] a version checked but not approved shows the approval as not signed; a draft asks for no signature', async () => {
    installFixtures({ 'esig.signatures': { signatures: [sig('PREPARED', 'Asha Rao', 'p'), sig('CHECKED', 'Vikram Shah', 'c')] } });
    renderBlock('CHECKED');
    await waitFor(() => expect(screen.getByTestId('title-block-CHECKED').textContent).toBe('Vikram Shah, c'));
    expect(screen.getByTestId('title-block-APPROVED').textContent).toBe('not signed');
    cleanup();
    installFixtures({});
    renderBlock('DRAFT');
    await screen.findByTestId('title-block-PREPARED');
    expect(['PREPARED', 'CHECKED', 'APPROVED'].map((m) => screen.getByTestId(`title-block-${m}`).textContent)).toEqual(['not signed', 'not signed', 'not signed']);
  });
});
