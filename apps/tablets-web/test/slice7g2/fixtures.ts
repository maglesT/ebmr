/**
 * Fixtures of the Phase 7 slice 7g-2 screens (master records, plant rules, incidents): answers of the routes these
 * screens read, shaped by the contract, for the office harness. Every value is a server's; nothing here is computed.
 */
import type { IncidentView, LabellingSpecimenView, ManifestationView, MarketAuthorisationView, PersonRef } from '@ebmr/api-contract';
import { example } from '@ebmr/api-contract/examples';

export const at = (text: string) => ({ us: '1792300000000000', text });
const person = (legalName: string, loginName: string, role: string): PersonRef => ({ personId: '7a1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e11', legalName, loginName, role });
export const AUTHOR = person('Asha Rao', 'asha.rao', 'MBR_AUTHOR');
export const QA = person('Meera Iyer', 'meera.iyer', 'QA_MBR_APPROVER');
export const REG = person('Rahul Menon', 'rahul.menon', 'REGULATORY_SIGNER');
export const STEWARD = person('Neha Joshi', 'neha.joshi', 'MASTER_DATA_STEWARD');

export const VERSION = example('version-in-verification');

export const prepared = (): ManifestationView => ({ ...example('manifestation'), meaning: 'PREPARED', meaningText: 'Prepared by', signer: AUTHOR, valid: true, aggregateType: 'mbr_version', aggregateId: VERSION.versionId });

export const AUTHORISATION: MarketAuthorisationView = {
  authorisationId: '5b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', versionId: VERSION.versionId, market: 'IN', kind: 'CURRENT', cells: [{ site: 'SITE-1', line: 'L1', batchSize: 'BS-100K' }],
  effectiveFrom: null, effectiveTo: null, regulatoryBasis: 'IN: registration on file', state: 'PROPOSED', proposedBy: QA, proposedAt: at('18-OCT-2026 10:00'),
  regulatoryConfirmedBy: null, qaAuthorisedBy: null, activatedAt: null, withdrawal: null,
};

export const SPECIMEN: LabellingSpecimenView = {
  documentId: '4b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', code: 'SPC-CARTON', version: '1', title: 'Carton specimen', hash: 'a'.repeat(64), effectiveFrom: '2026-01-01', state: 'RECORDED',
  recordedBy: STEWARD, recordedAt: at('17-OCT-2026 09:00'), approvedBy: null, approvedAt: null,
};

export const proposal = (over: Partial<{ proposalId: string; version: string; state: 'PROPOSED' | 'APPROVED' | 'SUPERSEDED'; effect: 'TIGHTENS' | 'LOOSENS' | 'UNCHANGED'; value: boolean }>) => ({
  proposalId: '3b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', version: '1', state: 'PROPOSED' as const, effect: 'LOOSENS' as const, value: true, reason: 'Dedicated penicillin block',
  proposedBy: STEWARD, proposedAt: at('18-OCT-2026 09:00'), approvedBy: null, approvedAt: null, ...over,
});

export const INCIDENT: IncidentView = {
  incidentId: '2b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', reference: 'INC-000042', source: 'SECURITY', incidentType: 'PHISHING_LOGIN', title: 'Suspicious login', status: 'UNDER_INVESTIGATION',
  severity: 'MAJOR', peakSeverity: 'MAJOR', detectedBy: 'USER', raisedBy: QA, recordedAt: at('18-OCT-2026 08:00'),
  certIn: { reportable: true, deadlineAt: at('18-OCT-2026 14:00'), overdue: false, reportedAt: null, reference: null }, links: 1,
  description: 'Repeated failed logins from an unknown terminal.', occurredAt: null, occurredAtTrust: null, investigationStartedAt: at('18-OCT-2026 08:30'), closure: null,
  linkedRecords: [{ aggregateType: 'batch', aggregateId: 'b-1', stepRef: null, linkedAt: at('18-OCT-2026 08:00'), assessment: null }],
  events: [{ event: 'INVESTIGATION_STARTED', severity: null, note: null, by: QA, at: at('18-OCT-2026 08:30') }],
};
