/**
 * The upgrade drill's release label becomes a command-line value of the drill tool (review P7G-4): only letters, digits
 * and . _ + - are accepted, never a leading dash (it would read as an option), at most 200 characters.
 */
import { describe, expect, it } from 'vitest';
import { routes } from '../src/index.ts';

const body = (fromRelease: string) => ({ reason: 'release candidate upgrade check', sourceDatabase: 'ebmr_release_v09', fromRelease });
const accepts = (fromRelease: string): boolean => routes.operations.runUpgradeDrill.body!.safeParse(body(fromRelease)).success;

describe('the upgrade drill release label (P7G-4)', () => {
  it('[DI-17] a release label is accepted; an option-like, spaced, empty or overlong label is refused at validation', () => {
    for (const ok of ['v0.9', '1.4.0-rc.2', '2026.10+build.7', 'this-release', '_x', 'a'.repeat(200)]) expect(accepts(ok), ok).toBe(true);
    for (const bad of ['--admin-url=postgres://x', '-v', '', 'this release', 'v1;rm -rf /', 'v1\n--report-dir', 'a'.repeat(201), '$(id)']) {
      expect(accepts(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
