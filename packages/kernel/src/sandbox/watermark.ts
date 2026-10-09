/**
 * The TEST, NOT GMP watermark (DI-05: outputs of non-GMP functions carry a visible NOT-GMP mark;
 * build outline 6.5). Every rendering and export helper asks watermarkFor() and applies the result:
 * - with the installation kind, for anything produced from a sandbox database (screens, printouts,
 *   exports, true-copy bundles): SANDBOX -> watermark, GMP -> none;
 * - with a non-GMP purpose, for output that is never a GMP record even when produced next to a GMP
 *   database (the designer's automated simulation, analytics): always a watermark.
 * The text equals sandbox.watermark() in the database.
 */
import type { InstallationKind } from './installation.ts';

export const WATERMARK_TEXT = 'TEST, NOT GMP';

/** Non-GMP functions (DI-05): they share the sandbox store, except SIMULATION and ANALYTICS, which write nothing. */
export type NonGmpPurpose = 'SANDBOX_TEST_RUN' | 'TRAINING' | 'SIMULATION' | 'ANALYTICS';
export const NON_GMP_PURPOSES: readonly NonGmpPurpose[] = ['SANDBOX_TEST_RUN', 'TRAINING', 'SIMULATION', 'ANALYTICS'];

export type WatermarkSubject = InstallationKind | NonGmpPurpose;

export interface Watermark {
  text: typeof WATERMARK_TEXT;
  /** What produced the output: the sandbox installation or a named non-GMP function. */
  source: Exclude<WatermarkSubject, 'GMP'>;
  /** One sentence for footers, banners and export headers. */
  notice: string;
  control: 'DI-05';
}

const NOTICES: Readonly<Record<Exclude<WatermarkSubject, 'GMP'>, string>> = {
  SANDBOX: 'Produced in the sandbox (test, training and simulation store); not a GMP record.',
  SANDBOX_TEST_RUN: 'Sandbox test run of an MBR version; not a GMP record.',
  TRAINING: 'Training exercise; not a GMP record.',
  SIMULATION: 'Simulation output; not a GMP record.',
  ANALYTICS: 'Analytics output; not a GMP record.',
};

/** The watermark for output of this installation kind or non-GMP purpose; null only for GMP. */
export function watermarkFor(subject: WatermarkSubject): Watermark | null {
  if (subject === 'GMP') return null;
  const notice = NOTICES[subject];
  if (notice === undefined) throw new Error(`Unknown watermark subject ${String(subject)} (DI-05). [EBMR-SBX-014]`);
  return { text: WATERMARK_TEXT, source: subject, notice, control: 'DI-05' };
}

/** Plain text and CSV-like exports: a banner line first and last, so a page or excerpt keeps one. */
export function stampText(text: string, watermark: Watermark | null): string {
  if (!watermark) return text;
  const banner = `*** ${watermark.text} *** ${watermark.notice}`;
  return `${banner}\n${text}${text.endsWith('\n') ? '' : '\n'}${banner}\n`;
}

/** JSON exports and reports: the watermark as the first property. */
export function stampJson<T extends object>(value: T, watermark: Watermark | null): T | ({ watermark: Watermark } & T) {
  if (!watermark) return value;
  if ('watermark' in value) throw new Error('The value already has a watermark property; it cannot be stamped twice (DI-05). [EBMR-SBX-014]');
  return { watermark, ...value };
}

/** True when a text export carries the watermark (for checks on outbound files). */
export function isStamped(text: string): boolean {
  return text.includes(`*** ${WATERMARK_TEXT} ***`);
}
