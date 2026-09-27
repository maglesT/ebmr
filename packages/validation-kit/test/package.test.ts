import { describe, expect, it } from 'vitest';
import { PACKAGE } from '../src/index.ts';

describe('@ebmr/validation-kit', () => {
  it('[meta] exposes its package identity', () => {
    expect(PACKAGE.name).toBe('@ebmr/validation-kit');
    expect(PACKAGE.version).toBe('0.1.0');
  });
});
