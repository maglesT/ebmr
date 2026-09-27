import { describe, expect, it } from 'vitest';
import { PACKAGE } from '../src/index.ts';

describe('@ebmr/injectables-web', () => {
  it('[meta] exposes its package identity', () => {
    expect(PACKAGE.name).toBe('@ebmr/injectables-web');
    expect(PACKAGE.version).toBe('0.1.0');
  });
});
