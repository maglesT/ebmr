/**
 * The engine version names the engine's output (ADR 0010; DI-10, DI-34, INV-19). A batch pins ENGINE_VERSION at issue
 * and replay compares every stored row with what the engine answers now, so an engine whose output changed under the
 * same version would make every batch stored before the change look tampered with. Each released version records the
 * fingerprint of its output for one fixed run (fingerprint.ts); the engine must answer exactly the fingerprint of its
 * own version, and a batch stored under another version is refused, never replayed (EBMR-EXE-061).
 *
 * When this test fails because the engine's output changed on purpose: give ENGINE_VERSION a new number, add its
 * fingerprint below (keep the earlier ones) and list the change in the note on ENGINE_VERSION (types.ts).
 */
import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION } from '../../src/engine/types.ts';
import { assertDefinitionFits, policyHash } from '../../src/execution/run.ts';
import { ExecutionStoreError, type BatchExecutionRecord } from '../../src/execution/store.ts';
import { engineFingerprint, fingerprintDefinition } from './fingerprint.ts';

/**
 * The fingerprint of each released engine version (fingerprint.ts; the state's own version stamp left out).
 * 1.0.0: commit b5b7d40 (Phase 2 before the round that made time facts SYSTEM's and step meanings exact), recorded with
 * the run as it then stood (no output weighing; 1.1.0 answered that run with d8cc7822...).
 * 1.1.0 and later: the run with its output weighing (added with 1.2.0); 1.1.0's is commit 4d703ec's answer to it.
 */
const RELEASED: Readonly<Record<string, string>> = {
  '1.0.0': 'b2ddd06e58a7779e0ffab4c8231db99d004475ca710dc40b056010ed30767ad2',
  '1.1.0': 'eeac109534b9d2c86f9d40fc3732c11c3d5b9fa68a8c24141cd55e62d08fa2fc',
  '1.2.0': '597ecb19f6dc7b2f408020b1758e2ef1f7f6db2df09764bc75e37fc205079eb7',
};

describe('the engine version names its output (ADR 0010)', () => {
  it('[DI-10][DI-34][INV-19] the engine answers the fixed run exactly as recorded for ENGINE_VERSION: a change of output needs a new version', () => {
    const { hash, rows } = engineFingerprint();
    const summary = rows.map((r) => `${r.seq} ${r.what}: ${r.answer}`).join('; ');
    expect(RELEASED[ENGINE_VERSION], `ENGINE_VERSION ${ENGINE_VERSION} has no recorded fingerprint`).toBeDefined();
    expect(hash, `engine ${ENGINE_VERSION} answers the fixed run differently from its recorded output (${summary})`).toBe(RELEASED[ENGINE_VERSION]);
  });

  it('[DI-10][DI-34] released versions answer differently from each other, and the engine answers the run as it now reads', () => {
    expect(new Set(Object.values(RELEASED)).size).toBe(Object.keys(RELEASED).length);
    const { rows } = engineFingerprint();
    // 1.1.0: a witness in place of a step's check, and the generic meanings on a block with its own, are refused.
    // 1.2.0: the output weighing is accepted as before; its net keeps the resolution (in the hashes, not the answers).
    expect(rows.map((r) => `${r.what}:${r.answer}`)).toEqual([
      'ISSUE:ACCEPTED',
      'START_STEP:ACCEPTED',
      'SWEEP:ACCEPTED',
      'RAISE_EXCEPTION:ACCEPTED',
      'RAISE_EXCEPTION:ACCEPTED',
      'PREPARE DISPOSITION_EXCEPTION:ACCEPTED',
      'SIGN_PERFORMED:ACCEPTED',
      'VERIFY:ENG-SIGNATURE-MEANING',
      'VERIFY:ACCEPTED',
      'START_STEP:ACCEPTED',
      'RECORD_ENTRY:ACCEPTED',
      'RECORD_ENTRY:ACCEPTED',
      'PREPARE SIGN_PERFORMED:ACCEPTED',
      'SIGN_PERFORMED:ENG-SIGNATURE-MEANING',
      'SIGN_PERFORMED:ACCEPTED',
      'VERIFY:ENG-SIGNATURE-MEANING',
      'VERIFY:ACCEPTED',
      'START_STEP:ACCEPTED',
      'RECORD_ENTRY:ACCEPTED',
      'SWEEP:ACCEPTED',
    ]);
  });

  it('[DI-10][DI-34] a batch stored under engine 1.0.0 or 1.1.0 is never run or replayed by this engine (EBMR-EXE-061)', () => {
    expect(ENGINE_VERSION).not.toBe('1.0.0');
    const def = fingerprintDefinition();
    const batch = (engineVersion: string): BatchExecutionRecord =>
      ({ contentHash: def.contentHash, engineVersion, registryFingerprint: def.registry.fingerprint(), policyHash: policyHash(def.policy) }) as BatchExecutionRecord;
    const refusal = (engineVersion: string): string => {
      try {
        assertDefinitionFits(def, { batch: batch(engineVersion) });
        return 'fits';
      } catch (e) {
        return e instanceof ExecutionStoreError ? e.code : String(e);
      }
    };
    expect(refusal('1.0.0')).toBe('EBMR-EXE-061');
    expect(refusal('1.1.0')).toBe('EBMR-EXE-061');
    expect(refusal(ENGINE_VERSION)).toBe('fits');
  });
});
