/**
 * Phase 7 slice 7i (P7H-5): the guidance for the EBMR-TAB code family. A database guard of a tablets block (a step entry)
 * raises an EBMR-TAB code too; before, the whole family read "The sign-in could not be completed" as a stale answer, so
 * the floor showed a step refusal as a failed sign-in and advised that the run had changed. Only the session-binding
 * refusals keep that guidance; every other EBMR-TAB code is a plain refusal whose `why` is the database's own message.
 */
import { describe, expect, it } from 'vitest';
import { GuidanceCatalogue, PLATFORM_GUIDANCE } from '../../src/platform/http/guidance.ts';
import { SESSION_GUIDANCE } from '../../src/features/session/guidance.ts';

const catalogue = new GuidanceCatalogue();
catalogue.register('platform', PLATFORM_GUIDANCE);
catalogue.register('session', SESSION_GUIDANCE);

describe('EBMR-TAB guidance (slice 7i, P7H-5)', () => {
  it('a block guard\'s refusal (EBMR-TAB-302, -381, -850) is a refusal, not a failed sign-in or a stale run', () => {
    for (const code of ['EBMR-TAB-302', 'EBMR-TAB-381', 'EBMR-TAB-850']) {
      const g = catalogue.lookup(code);
      expect(g, code).toMatchObject({ status: 422, kind: 'NOT_ALLOWED' });
      expect(g?.whatHappened, code).not.toMatch(/sign-in/i);
    }
  });

  it('the session-binding refusals still read as a sign-in that did not complete', () => {
    for (const code of ['EBMR-TAB-010', 'EBMR-TAB-011', 'EBMR-TAB-012', 'EBMR-TAB-014', 'EBMR-TAB-016', 'EBMR-TAB-021']) {
      expect(catalogue.lookup(code), code).toMatchObject({ status: 409, kind: 'STALE', whatHappened: 'The sign-in could not be completed.' });
    }
    expect(catalogue.lookup('EBMR-TAB-013')?.whatHappened).toBe('You do not hold that role now.');
  });
});
