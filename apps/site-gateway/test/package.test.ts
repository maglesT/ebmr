import { describe, expect, it } from 'vitest';
import { PACKAGE } from '../src/index.ts';

describe('@ebmr/site-gateway', () => {
  it('[meta] exposes its package identity', () => {
    expect(PACKAGE.name).toBe('@ebmr/site-gateway');
    expect(PACKAGE.version).toBe('0.1.0');
  });
});
