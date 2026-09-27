import { describe, expect, it } from 'vitest';
import { PACKAGE } from '../src/index.ts';

describe('@ebmr/ui-kit', () => {
  it('[meta] exposes its package identity', () => {
    expect(PACKAGE.name).toBe('@ebmr/ui-kit');
    expect(PACKAGE.version).toBe('0.1.0');
  });
});
