/**
 * The TEST, NOT GMP watermark and the installation stamp (DI-05): outputs of non-GMP functions carry a
 * visible watermark, and nothing from a non-GMP installation is taken into GMP records.
 */
import { describe, expect, it } from 'vitest';
import { assertGmpOrigin, type InstallationStamp } from '../../src/sandbox/installation.ts';
import { NON_GMP_PURPOSES, WATERMARK_TEXT, isStamped, stampJson, stampText, watermarkFor, type WatermarkSubject } from '../../src/sandbox/watermark.ts';

describe('TEST, NOT GMP watermark', () => {
  it('[DI-05] catalog: simulation output carries the TEST, NOT GMP watermark', () => {
    const report = { mbrVersionHash: 'a'.repeat(64), paths: 12, coverage: { guards: '100%' } };
    const stamped = stampJson(report, watermarkFor('SIMULATION'));
    expect(Object.keys(stamped)[0]).toBe('watermark');
    expect(stamped).toEqual({ watermark: { text: 'TEST, NOT GMP', source: 'SIMULATION', notice: 'Simulation output; not a GMP record.', control: 'DI-05' }, ...report });
    const text = stampText('path 1: PASS\npath 2: PASS', watermarkFor('SIMULATION'));
    const lines = text.trimEnd().split('\n');
    expect(lines[0]).toBe('*** TEST, NOT GMP *** Simulation output; not a GMP record.');
    expect(lines[lines.length - 1]).toBe(lines[0]);
    expect(isStamped(text)).toBe(true);
  });

  it('[DI-05] output of the sandbox installation and of every non-GMP function is watermarked; GMP output is not', () => {
    expect(WATERMARK_TEXT).toBe('TEST, NOT GMP');
    for (const subject of ['SANDBOX', ...NON_GMP_PURPOSES] as WatermarkSubject[]) {
      const w = watermarkFor(subject);
      expect(w?.text, subject).toBe('TEST, NOT GMP');
      expect(w?.source).toBe(subject);
      expect(w?.notice).toMatch(/not a GMP record\.$/);
    }
    expect(watermarkFor('GMP')).toBeNull();
    expect(stampText('batch record', null)).toBe('batch record');
    expect(isStamped('batch record')).toBe(false);
    expect(stampJson({ a: 1 }, null)).toEqual({ a: 1 });
    expect(() => watermarkFor('PLANNING' as WatermarkSubject)).toThrow(/EBMR-SBX-014/);
    expect(() => stampJson({ watermark: 'x' }, watermarkFor('SANDBOX'))).toThrow(/EBMR-SBX-014/);
  });

  it('[DI-05][INV-18] a non-GMP record is never taken into GMP: only a GMP installation stamp passes', () => {
    const gmp: InstallationStamp = { installationKind: 'GMP', watermark: null };
    const sandbox: InstallationStamp = { installationKind: 'SANDBOX', watermark: 'TEST, NOT GMP' };
    expect(() => assertGmpOrigin(gmp, 'True-copy bundle')).not.toThrow();
    expect(() => assertGmpOrigin(sandbox, 'True-copy bundle')).toThrow(
      'True-copy bundle comes from a SANDBOX installation, not a GMP one; sandbox, training and simulation output is never taken into GMP records (DI-05, INV-18). [EBMR-SBX-013]',
    );
    expect(() => assertGmpOrigin(undefined, 'Lot-transfer package')).toThrow(/unknown installation.*EBMR-SBX-013/);
    // A stamp that claims GMP but carries a watermark is inconsistent and refused as well.
    expect(() => assertGmpOrigin({ installationKind: 'GMP', watermark: 'TEST, NOT GMP' }, 'Export')).toThrow(/EBMR-SBX-013/);
  });
});
