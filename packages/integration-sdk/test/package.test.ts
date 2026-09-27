import { describe, expect, it } from 'vitest';
import { PACKAGE } from '../src/index.ts';

describe('@ebmr/integration-sdk', () => {
  it('[meta] exposes its package identity', () => {
    expect(PACKAGE.name).toBe('@ebmr/integration-sdk');
    expect(PACKAGE.version).toBe('0.1.0');
  });
});
