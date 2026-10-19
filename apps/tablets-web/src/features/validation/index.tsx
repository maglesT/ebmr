/**
 * Web feature `validation` (Phase 7 slice 7g-3, work package WP1; GMP; decision 0025: every act has a screen): the
 * validation screens (system description, validation summary, evidence bundle and validation pack, IQ), the full export
 * and the periodic evaluation pack, the records register (record types, retention, holds and disposal, data-integrity
 * investigations), and the signature catalogue and seal keys. Every value, right and refusal is the server's and the
 * database's (contract ns/validation.ts, ns/esig.ts).
 */
import { createRoute, type AnyRootRoute, type AnyRoute, type RouteComponent } from '@tanstack/react-router';
import type { HomeTile } from '../../app/feature.ts';
import { MeaningTypesPage, SealKeysPage } from './CataloguePages.tsx';
import { EvaluationPacksPage, FullExportPage } from './ExportPages.tsx';
import { DiInvestigationsPage, RecordTypesPage, RetentionPage } from './RecordsRegisterPages.tsx';
import { EvidencePage, IqPage, SystemDescriptionPage, ValidationHubPage, ValidationSummaryPage } from './ValidationPages.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  const page = (path: string, component: RouteComponent) => createRoute({ getParentRoute: () => root, path, component });
  return [
    page('/validation', ValidationHubPage),
    page('/validation/system-description', SystemDescriptionPage),
    page('/validation/summary', ValidationSummaryPage),
    page('/validation/evidence', EvidencePage),
    page('/validation/iq', IqPage),
    page('/validation/full-export', FullExportPage),
    page('/validation/evaluation-packs', EvaluationPacksPage),
    page('/validation/record-types', RecordTypesPage),
    page('/validation/retention', RetentionPage),
    page('/validation/di-investigations', DiInvestigationsPage),
    page('/validation/meaning-types', MeaningTypesPage),
    page('/validation/seal-keys', SealKeysPage),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  {
    id: 'validation',
    title: 'Validation and records',
    description: 'The validation summary and system description, the evidence bundle, validation pack and IQ, the full export and periodic evaluation, the records register and the signature catalogue.',
    to: '/validation',
    installations: ['GMP'],
    available: true,
  },
];
