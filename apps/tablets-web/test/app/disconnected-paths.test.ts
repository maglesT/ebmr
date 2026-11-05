/**
 * Declutter D3 (lead audit of D2): the web app's switched-off screens come from the contract's one list of disconnected
 * namespaces (plan section 3), plus a short web-only list of screens that only leave the home. And the home's work
 * cards never lead to a switched-off screen.
 *
 * Control: DI-17.
 */
import { describe, expect, it } from 'vitest';
import { DISCONNECTED_NAMESPACES } from '@ebmr/api-contract';
import { DISCONNECTED_PATHS, NAMESPACE_SCREENS, screenOff, WEB_ONLY_OFF_PATHS } from '../../src/app/disconnected.tsx';

describe('[DI-17] the switched-off screens follow the contract\'s list (declutter D3)', () => {
  it('[DI-17] every namespace the contract disconnects is mapped to its screens, and nothing else is', () => {
    expect(Object.keys(NAMESPACE_SCREENS).sort()).toEqual([...DISCONNECTED_NAMESPACES].sort());
  });

  it('[DI-17] the switched-off paths are the mapped screens and the web-only ones, each once', () => {
    const mapped = Object.values(NAMESPACE_SCREENS).flat();
    expect([...DISCONNECTED_PATHS].sort()).toEqual([...mapped, ...WEB_ONLY_OFF_PATHS].sort());
    expect(new Set(DISCONNECTED_PATHS).size).toBe(DISCONNECTED_PATHS.length);
  });

  it('[DI-17] the home\'s work cards and the records their lists open are never switched off, on the platform or with the switch', () => {
    const paths = ['/work/my-batches', '/work/to-sign', '/work/to-review', '/work/to-release', '/runs/R-1/steps/S-1', '/review/B-1', '/release/L-1'];
    for (const p of paths) expect(screenOff(p, true, true), p).toBe(false);
    // The check itself still switches screens off.
    expect(screenOff('/release/suspended', true, false)).toBe(true);
    expect(screenOff('/capa/C-1', true, false)).toBe(true);
  });
});
