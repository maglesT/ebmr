/**
 * Validation pack generators: URS, risk assessment, specifications, trace matrix, IQ/OQ/PQ, summary, release notes.
 *
 * The evidence bundle (slice 7-0) and the pack generators (slice 7c); see docs/handbook/modules/validation-kit.md.
 */
import { PACKAGE as KernelPackage } from '@ebmr/kernel';

export const PACKAGE = { name: '@ebmr/validation-kit', version: '0.1.0' } as const;

/** Exact versions of the shared packages this module was built against (ADR 0015). */
export const BUILT_AGAINST = [KernelPackage] as const;

/** The evidence bundle v1 (Phase 7 slice 7-0; docs/build-plan/phase-7/slice-7-0-interfaces.md section 1). */
export type * from './bundle/types.ts';
export { BUNDLE_SCHEMA, BUNDLE_SORT_KEYS, BUNDLE_VERSION, BundleError, type BundleErrorCode, bundleSha256, canonicalJson, compareText, parseBundle } from './bundle/validate.ts';

/** The validation pack generators (Phase 7 slice 7c): bundle in, documents out (Markdown and HTML), with a manifest. */
export { generatePack, packDocuments, PACK_ARTEFACTS, type Manifest, type ManifestEntry, type Pack, type PackArtefact, type PackFile } from './pack/pack.ts';
export { escapeHtml, renderHtml, renderMarkdown, type Block, type Doc, type Footer } from './pack/doc.ts';
export { assessRisk, DATABASE_TEST_RULE, HIGH_RISK_FUNCTIONS, isDatabaseTest, listedTests, RISK_RULES, urOf, verdicts, type Level, type RiskAssessment, type Verdict } from './pack/facts.ts';
export { criticalLimitEvidence, traceMatrix, type LimitEvidence } from './pack/trace.ts';
export { IQ_CHECKS, type IqCheck } from './pack/qualification.ts';
export { aiInventory, controlDelta, PackError, smfParagraphText } from './pack/release.ts';
export { ARCHITECTURE_BOUNDARIES, mermaidStateChart } from './pack/specs.ts';
