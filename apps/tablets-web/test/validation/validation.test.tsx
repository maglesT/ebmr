/**
 * The validation screens (Phase 7 slice 7g-3, WP1) on test answers: the hub, the system description and an interface
 * described under a change record, the validation summary with its problem, document and signed approval, the evidence
 * bundle and the validation pack with their downloads, and the IQ run with its record. Every value is the server's.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { apiState } from '../../src/api/client.ts';
import { at, renderValidation, SHA, SHA2 } from './support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const description = {
  interfaces: [{ adapterCode: 'ERP-1', sourceSystem: 'ERP_WMS', endpointHost: 'erp.plant.example', transport: 'MTLS', signedFeed: false, status: 'DESCRIBED', validFrom: at('1760000000000001') }],
  undescribed: ['QMS-2'],
};

describe('the validation hub and the system description', () => {
  it('the hub links every validation and records screen', async () => {
    renderValidation('/validation');
    const list = await screen.findByTestId('validation-pages');
    for (const name of ['Validation summary', 'System description', 'Evidence bundle and validation pack', 'Installation qualification', 'Full export', 'Periodic evaluation', 'Record types', 'Retention, holds and disposal', 'Data-integrity investigations', 'Signature catalogue', 'Record-seal keys']) {
      expect(within(list).getByRole('link', { name })).toBeTruthy();
    }
  });

  it('[DI-06][DI-09] lists the interfaces and the undescribed adapters; an interface is recorded with its change record and reason', async () => {
    const ui = renderValidation('/validation/system-description', { fixtures: { 'validation.systemDescription': description, 'validation.describeInterface': description } });
    expect((await screen.findByTestId('interface-ERP-1')).textContent).toContain('erp.plant.example over mutual TLS');
    expect(screen.getByTestId('undescribed').textContent).toBe('QMS-2');
    const box = screen.getByTestId('describe-interface');
    const button = within(box).getByRole('button', { name: 'Record the interface' });
    await userEvent.type(within(box).getByRole('textbox', { name: 'Adapter code' }), 'QMS-2');
    await userEvent.selectOptions(within(box).getByRole('combobox', { name: 'Source system' }), 'QMS');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Endpoint host' }), 'qms.plant.example');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Reason' }), 'QMS goes live');
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(box).getByRole('textbox', { name: 'Approved change record (number)' }), 'CR-2026-031');
    await userEvent.click(button);
    await waitFor(() => expect(ui.posts('/api/validation/system-description')).toHaveLength(1));
    expect(ui.posts('/api/validation/system-description')[0]?.body).toEqual({
      adapterCode: 'QMS-2', sourceSystem: 'QMS', endpointHost: 'qms.plant.example', transport: 'MTLS', signedFeed: false, status: 'DESCRIBED', changeRecord: 'CR-2026-031', reason: 'QMS goes live',
    });
  });
});

describe('the validation summary', () => {
  const summary = (over: Record<string, unknown> = {}) => ({
    runningRelease: SHA,
    problem: `EBMR-VAL-001 release ${SHA} has no approved validation summary: GMP batches are not issued on an unvalidated release (DI-03)`,
    document: { title: 'Validation summary', path: 'validation-summary.md', sha256: SHA2, schemaRelease: SHA, markdown: '# Validation summary\n\nAll controls verified.', forRunningRelease: true },
    documentProblem: null,
    approvals: [],
    ...over,
  });

  it('[DI-03][DI-37] shows the problem and the document; QA signs the approval of exactly that release and document', async () => {
    const ui = renderValidation('/validation/summary', { fixtures: { 'validation.summary': summary() } });
    expect((await screen.findByTestId('summary-problem')).textContent).toMatch(/^EBMR-VAL-001 /);
    expect(screen.getByTestId('summary-sha256').textContent).toBe(SHA2);
    expect(screen.getByTestId('summary-document').textContent).toContain('All controls verified.');
    await userEvent.click(screen.getByRole('button', { name: 'Approve the validation summary (signature)' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    const action = { kind: 'VALIDATION_SUMMARY_APPROVE', schemaRelease: SHA, summarySha256: SHA2, title: 'Validation summary' };
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual(action);
    expect(ui.posts('/api/esig/describe')[0]?.body).toEqual({ action });
  });

  it('[DI-03] a document of another release, or one already approved, is not offered for approval', async () => {
    renderValidation('/validation/summary', { fixtures: { 'validation.summary': summary({ document: { ...summary().document, forRunningRelease: false }, documentProblem: 'The shipped bundle is for another release.' }) } });
    expect((await screen.findByTestId('summary-document-problem')).textContent).toContain('another release');
    expect(screen.queryByRole('button', { name: 'Approve the validation summary (signature)' })).toBeNull();
    cleanup();
    renderValidation('/validation/summary', {
      fixtures: { 'validation.summary': summary({ problem: null, approvals: [{ schemaRelease: SHA, summarySha256: SHA2, title: 'Validation summary', approvedBy: 'Divya Menon', approvedAt: at('1760000000000002'), signatureId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e' }] }) },
    });
    expect(await within(await screen.findByTestId('summary-approvals')).findByText(/approved by Divya Menon/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve the validation summary (signature)' })).toBeNull();
  });
});

describe('the evidence bundle, the validation pack and the IQ', () => {
  const evidenceView = {
    configured: true, problem: null, fileName: 'bundle.json', bundleSha256: SHA2,
    release: { product: 'Batchwright Tablets', version: '1.0.0', commit: 'abc1234', schemaRelease: SHA, edition: 'tablets' },
    runningRelease: SHA,
    documents: [{ id: 'urs', title: 'User requirements', status: 'APPROVED_FOR_RELEASE', files: [{ path: 'urs.md', sha256: SHA, bytes: '1200' }] }],
  };

  it('lists the bundle with its SHA-256 and each document of the pack; a document is downloaded as the server hands it over', async () => {
    const ui = renderValidation('/validation/evidence', {
      fixtures: { 'validation.evidence': evidenceView, 'validation.evidenceFile': { path: 'urs.md', mediaType: 'text/markdown', sha256: SHA, content: '# URS' } },
    });
    expect((await screen.findByTestId('bundle-sha256')).textContent).toBe(SHA2);
    const doc = screen.getByTestId('pack-doc-urs');
    await userEvent.click(within(doc).getByRole('button', { name: 'Download urs.md' }));
    await waitFor(() => expect(within(doc).getByRole('link', { name: 'Save urs.md' }).getAttribute('href')).toBe(`data:text/markdown;charset=utf-8,${encodeURIComponent('# URS')}`));
    expect(ui.gets('/api/validation/evidence/file')[0]?.query).toEqual({ path: 'urs.md' });
  });

  it('a server without the bundle says so', async () => {
    renderValidation('/validation/evidence', { fixtures: { 'validation.evidence': { ...evidenceView, configured: false, problem: 'No evidence bundle is configured on this server.', fileName: null, bundleSha256: null, release: null, documents: [] } } });
    expect((await screen.findByTestId('evidence-problem')).textContent).toContain('No evidence bundle');
  });

  it('[DI-03] the IQ is run with a reason; each record shows every check, failed ones with their problems, and is downloaded', async () => {
    const rec = {
      iqId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', passed: false, summary: '1 of 2 IQ checks failed: IQ-01 Schema release', schemaRelease: SHA, bundleSha256: SHA2, recordSha256: SHA,
      checks: [
        { id: 'IQ-01', name: 'Schema release', expected: 'the release', actual: 'other', passed: false, problems: ['the installation runs schema release x'] },
        { id: 'IQ-11', name: 'GMP installation', expected: 'GMP', actual: 'GMP database x', passed: true, problems: [] },
      ],
      by: 'Kavya Iyer', at: at('1760000000000003'),
    };
    const ui = renderValidation('/validation/iq', { fixtures: { 'validation.iqRecords': { records: [rec], configured: true, problem: null }, 'validation.runIq': rec } });
    const shown = await screen.findByTestId(`iq-${rec.iqId}`);
    expect(shown.getAttribute('data-passed')).toBe('false');
    expect(within(shown).getByTestId(`iq-${rec.iqId}-IQ-01`).textContent).toContain('Failed: IQ-01 Schema release (other): the installation runs schema release x');
    const button = screen.getByRole('button', { name: 'Run the IQ checks' });
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.type(screen.getByRole('textbox', { name: 'Reason (recorded)' }), 'after the upgrade');
    await userEvent.click(button);
    await waitFor(() => expect(ui.posts('/api/validation/iq')).toHaveLength(1));
    expect(ui.posts('/api/validation/iq')[0]?.body).toEqual({ reason: 'after the upgrade' });
  });
});
