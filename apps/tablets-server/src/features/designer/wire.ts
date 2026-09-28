/**
 * Types of the designer's views, inferred from the frozen contract's schemas (the contract exports some of them
 * as schemas only).
 */
import type { z } from 'zod';
import type {
  EvidenceView as EvidenceViewSchema,
  FamilyView as FamilyViewSchema,
  JustificationView as JustificationViewSchema,
  PaletteBlock as PaletteBlockSchema,
  ReferenceDocumentView as ReferenceDocumentViewSchema,
  TemplateView as TemplateViewSchema,
} from '@ebmr/api-contract';

export type EvidenceView = z.infer<typeof EvidenceViewSchema>;
export type FamilyView = z.infer<typeof FamilyViewSchema>;
export type JustificationView = z.infer<typeof JustificationViewSchema>;
export type PaletteBlock = z.infer<typeof PaletteBlockSchema>;
export type ReferenceDocumentView = z.infer<typeof ReferenceDocumentViewSchema>;
export type TemplateView = z.infer<typeof TemplateViewSchema>;
