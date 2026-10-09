/**
 * The shipped dc-mini template and its copy among the shared recipe fixtures are the same file, byte for byte. The
 * web's document completeness test (apps/tablets-web/test/designer/document-complete.test.tsx) walks the copy, since
 * apps never import each other; this test keeps that walk on what the server ships.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SHIPPED = new URL('../../src/features/designer/templates/dc-mini.mbr.json', import.meta.url);
const COPY = new URL('../../../../packages/recipe-core/test/fixtures/dc-mini.mbr.json', import.meta.url);

describe('the dc-mini template fixture', () => {
  it('[meta] the copy the web completeness test walks is the shipped template, byte for byte', () => {
    expect(readFileSync(COPY).equals(readFileSync(SHIPPED))).toBe(true);
  });
});
