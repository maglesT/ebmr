import { describe, expect, it } from 'vitest';
import { PACKAGE } from '../src/index.ts';

describe('@ebmr/tablets-server', () => {
  it('[meta] exposes its package identity', () => {
    expect(PACKAGE.name).toBe('@ebmr/tablets-server');
    expect(PACKAGE.version).toBe('1.0.0-rc.1');
  });
});
