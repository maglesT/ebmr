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
 * 1.1.0 and later: the run with its output weighings (the one in kg added with 1.2.0, the ones in g and kg{wet} and the
 * output step signed performed added with 1.3.0); 1.1.0's is commit 4d703ec's answer to it, 1.2.0's commit 26968b5's
 * (both to the run as it stood at 1.3.0).
 * 1.3.0 and later: the run with the output step verified and the end step holding a critical value typed by hand
 * without the printout its MBR names, then checked as a later review and as a witness (added with 1.4.0); 1.3.0's is
 * commit 979e747's answer to it (1.3.0 accepts the later review and then refuses the witness on the completed step;
 * its answer to the run as it stood at 1.3.0 was 1e2831962f34bd26363cca76624319fb5b1fb73813a122cf416087cc4df0cba0).
 * 1.4.0 and later: the run with three parallel steps after the end step (added with 1.5.0): a value typed by hand
 * without its printout checked six minutes after the act (a witness, then a later review), and a step the MBR declares
 * WITNESSED checked after another step started (the same). 1.4.0's is commit 4df68b0's answer to it (1.4.0 accepts both
 * late witnesses, the first with WITNESS_LATE, the second as if on time, and refuses both later reviews on the completed
 * steps; its answer to the run as it stood at 1.4.0 was e2d1b23079a62456482b39628efb3b01e7ada2bf1b0dabf0cb27d993b77e735c).
 * 1.5.0 and later: the run with a fourth parallel step handed over by its performer and taken over by another, then an
 * invalidation without and with its assignable cause and an abort without and with its checklist (added with 1.6.0).
 * 1.5.0's is commit ce3ece8's answer to it (the last commit before the slice 2 change paths changed the engine's output:
 * 1.5.0 accepts a hand-over and a take-over as commands that do nothing, lets the outgoing performer sign, accepts the
 * invalidation without a cause and the abort without a checklist; its answer to the run as it stood at 1.5.0 was
 * a21aca586a8adbb099f936141ff44eacd51e27c34969e7d6b5c2af3930fae3ef).
 */
const RELEASED: Readonly<Record<string, string>> = {
  '1.0.0': 'b2ddd06e58a7779e0ffab4c8231db99d004475ca710dc40b056010ed30767ad2',
  '1.1.0': '75105cf1f74cd13cb35b3cf5fbcad65e356714b57e02feba254a4578db7ce64d',
  '1.2.0': '0d824c01c642c0e25597401e1434993a3b826b0cf51c01108300f0b4e5b0cfe9',
  '1.3.0': '34e37c7e7ab4852ad42334d5c372bf424fcf46d80524e43e59f324a4c56923d3',
  '1.4.0': 'bf2aa3e7849c405fa48059eb5b5e23d9093dbc8aba219df8c1244a9734837363',
  '1.5.0': 'eea923e3d57237ba9f84585835d1df1b37a2f2a0150152c09183ae67ccca68a1',
  '1.6.0': 'b3851a555d82e4badfce19d628a866fb3e8efd76f8975891b0b6746d41423132',
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
    // 1.3.0: the weighing in g counts at its resolution (in the hashes); the one in kg{wet} is refused (G22-UNIT).
    // 1.4.0: the end step holds a critical value typed by hand without the printout its MBR names: a later review
    // (VERIFIED) is refused, the witness accepted (lead TODO T12).
    // 1.5.0: once no witness is possible (the window passed; the run moved on) a witness is refused and the later review
    // accepted, raising WITNESS_LATE for QA (T12.LATE).
    // 1.6.0: a step handed over and taken over; the outgoing performer's PERFORMED is refused (L-07); an invalidation
    // without its assignable cause and an abort without its checklist are refused.
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
      'RECORD_ENTRY:ACCEPTED',
      'RECORD_ENTRY:G22-UNIT',
      'SIGN_PERFORMED:ACCEPTED',
      'VERIFY:ACCEPTED',
      'START_STEP:ACCEPTED',
      'RECORD_DATA:ACCEPTED',
      'SIGN_PERFORMED:ACCEPTED',
      'VERIFY:ENG-SIGNATURE-MEANING',
      'VERIFY:ACCEPTED',
      'SWEEP:ACCEPTED',
      'START_STEP:ACCEPTED',
      'RECORD_DATA:ACCEPTED',
      'SIGN_PERFORMED:ACCEPTED',
      'VERIFY:ENG-SIGNATURE-MEANING',
      'VERIFY:ACCEPTED',
      'START_STEP:ACCEPTED',
      'SIGN_PERFORMED:ACCEPTED',
      'START_STEP:ACCEPTED',
      'VERIFY:ENG-SIGNATURE-MEANING',
      'VERIFY:ACCEPTED',
      'SWEEP:ACCEPTED',
      'START_STEP:ACCEPTED',
      'RECORD_DATA:ACCEPTED',
      'HAND_OVER_STEP:ACCEPTED',
      'TAKE_OVER_STEP:ACCEPTED',
      'SIGN_PERFORMED:ENG-HANDED-OVER',
      'SIGN_PERFORMED:ACCEPTED',
      'VERIFY:ACCEPTED',
      'INVALIDATE_RESULT:ENG-INVALIDATE-INVESTIGATION',
      'INVALIDATE_RESULT:ACCEPTED',
      'ABORT_BATCH:ENG-ABORT-CHECKLIST',
      'ABORT_BATCH:ACCEPTED',
    ]);
  });

  it('[DI-10][DI-34] a batch stored under engine 1.0.0, 1.1.0, 1.2.0, 1.3.0, 1.4.0 or 1.5.0 is never run or replayed by this engine (EBMR-EXE-061)', () => {
    expect(ENGINE_VERSION).not.toBe('1.0.0');
    const def = fingerprintDefinition();
    const batch = (engineVersion: string): BatchExecutionRecord =>
      ({ installation: def.installation, contentHash: def.contentHash, engineVersion, registryFingerprint: def.registry.fingerprint(), policyHash: policyHash(def.policy) }) as BatchExecutionRecord;
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
    expect(refusal('1.2.0')).toBe('EBMR-EXE-061');
    expect(refusal('1.3.0')).toBe('EBMR-EXE-061');
    expect(refusal('1.4.0')).toBe('EBMR-EXE-061');
    expect(refusal('1.5.0')).toBe('EBMR-EXE-061');
    expect(refusal(ENGINE_VERSION)).toBe('fits');
  });
});
