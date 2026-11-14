/** The pull-request gate's SQL mutation check (decision 0032): a change may not add a surviving mutant. */
import { describe, expect, it } from 'vitest';
import { mutationKey, newSurvivors } from '../src/new-survivors.ts';

type R = Parameters<typeof newSurvivors>[0][number] & { line: number };
const m = (status: R['status'], original = 'a > b', line = 10, fn = 'recipe.f'): R => ({ function: fn, operator: 'RELATIONAL', original, replacement: 'a >= b', status, line });

describe('new survivors against the base', () => {
  it('[meta] a survivor the base also had, or had reviewed equivalent, is old debt; one more than the base had, or of a new function, is new', () => {
    // Same mutation at another line (the migration re-created the function): old.
    expect(newSurvivors([m('SURVIVED', 'a > b', 40)], [m('SURVIVED', 'a > b', 10)])).toEqual([]);
    expect(newSurvivors([m('SURVIVED')], [m('EQUIVALENT')])).toEqual([]);
    // Killed at the base, surviving now: new.
    expect(newSurvivors([m('SURVIVED')], [m('KILLED')])).toHaveLength(1);
    // Counted: two equal survivors at the head need two at the base.
    expect(newSurvivors([m('SURVIVED', 'a > b', 1), m('SURVIVED', 'a > b', 2)], [m('SURVIVED')])).toHaveLength(1);
    // Another function, operator, original or replacement is another mutation.
    expect(newSurvivors([m('SURVIVED', 'a > b', 10, 'recipe.g')], [m('SURVIVED')])).toHaveLength(1);
    expect(newSurvivors([m('SURVIVED', 'c > d')], [m('SURVIVED')])).toHaveLength(1);
    // No base (a new function): every survivor is new; killed, timed-out and invalid mutants never are.
    expect(newSurvivors([m('SURVIVED'), m('KILLED'), m('TIMEOUT'), m('INVALID'), m('EQUIVALENT')], [])).toHaveLength(1);
    expect(mutationKey(m('SURVIVED', 'x', 1))).toBe(mutationKey(m('KILLED', 'x', 99)));
  });
});
