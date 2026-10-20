/**
 * Decision D-P7R-18 (gap F1): the home screen hides the tiles whose screen the session's role cannot use. Display only:
 * the server stays the authority (DI-17). The table it uses (app/tile-access.ts) is tested against the code and the
 * server's reviewed route-by-role matrix, so it can neither miss a tile nor hide one a role may use.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allRoutes, routes } from '@ebmr/api-contract';
import { WEB_FEATURES } from '../../src/app/features.ts';
import { READ_REFUSED, TILE_READS, tileOffered } from '../../src/app/tile-access.ts';

const MATRIX = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tablets-server', 'test', 'security', 'fixtures', 'route-role-matrix.json');
interface Matrix {
  roles: Record<'GMP' | 'SANDBOX', string[]>;
  matrix: Record<'GMP' | 'SANDBOX', Record<string, string>>;
}

const tiles = WEB_FEATURES.flatMap(([, f]) => f.homeTiles ?? []);

describe('home tiles by role (D-P7R-18, F1)', () => {
  it('[DI-17] every home tile names the read its screen opens with (or none), and each read is a GET route of the contract', () => {
    expect(tiles.map((t) => t.id).filter((id) => !(id in TILE_READS)), 'tiles missing from TILE_READS').toEqual([]);
    expect(Object.keys(TILE_READS).filter((id) => !tiles.some((t) => t.id === id)), 'TILE_READS entries without a tile').toEqual([]);
    const gets = new Set(allRoutes(routes).filter((r) => r.method === 'GET').map((r) => r.id));
    expect(Object.values(TILE_READS).filter((r): r is string => r !== null && !gets.has(r)), 'not a GET route').toEqual([]);
  });

  it('[DI-17] the roles a tile is hidden from are exactly the roles the reviewed route-by-role matrix records as refused that read (its F cells)', () => {
    const m = JSON.parse(readFileSync(MATRIX, 'utf8')) as Matrix;
    const reads = [...new Set(Object.values(TILE_READS).filter((r): r is string => r !== null))].sort();
    for (const inst of ['GMP', 'SANDBOX'] as const) {
      const expected: Record<string, string[]> = {};
      for (const read of reads) {
        const cells = m.matrix[inst][read];
        if (cells === undefined) continue;
        const refused = [...cells].flatMap((c, i) => (c === 'F' ? [m.roles[inst][i] ?? ''] : []));
        if (refused.length > 0) expected[read] = refused;
      }
      expect(READ_REFUSED[inst], `${inst}: regenerate READ_REFUSED in app/tile-access.ts from the matrix`).toEqual(expected);
    }
  });

  it('[DI-17] a role sees the tiles of its work and not the others; an unknown role or a session without a role sees every tile', () => {
    expect(tileOffered('review', 'GMP', 'QA_REVIEWER')).toBe(true);
    expect(tileOffered('planning', 'GMP', 'BATCH_ISSUER')).toBe(true);
    expect(tileOffered('planning', 'GMP', 'OPERATOR')).toBe(false);
    expect(tileOffered('analytics', 'GMP', 'OPERATOR')).toBe(false);
    expect(tileOffered('admin-people', 'GMP', 'QA_REVIEWER')).toBe(false);
    expect(tileOffered('admin-people', 'GMP', 'SYSTEM_ADMINISTRATOR')).toBe(true);
    // The EU importer's QP reads only the QP packages of the lot an access names.
    expect(tileOffered('qp', 'GMP', 'EU_QP_READER')).toBe(true);
    expect(tileOffered('review', 'GMP', 'EU_QP_READER')).toBe(false);
    expect(tileOffered('review', 'GMP', 'SOME_NEW_ROLE')).toBe(true);
    expect(tileOffered('admin-people', 'GMP', null)).toBe(true);
    // A tile whose screen opens with no read a role can be refused is always shown.
    expect(tileOffered('runs', 'SANDBOX', 'OPERATOR')).toBe(true);
    // Each role keeps at least one tile.
    const m = JSON.parse(readFileSync(MATRIX, 'utf8')) as Matrix;
    for (const role of m.roles.GMP) expect(tiles.filter((t) => t.installations.includes('GMP') && tileOffered(t.id, 'GMP', role)).length, role).toBeGreaterThan(0);
  });
});
