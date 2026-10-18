/**
 * GMP records keep the manufacturer's identity (decision 0020 point 3; D-P7-11): a batch record, true copy, label,
 * report or certificate never carries the vendor's name or logo. Every such output is made by the database and the
 * server code below (the record heads, the PDF/A-3 true copies and their metadata, label and report rendering, the
 * certificates and seeds the golden batches run on), so none of it may name Batchwright or Medhanta: the brand lives in
 * the screens only (packages/ui-kit/src/brand, apps/tablets-web). The golden batches check their own records and true
 * copies (apps/tablets-server/test/golden, "no vendor name" tests).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../..', import.meta.url));

/** The code that makes GMP records, true copies, labels, reports and certificates. */
const RECORD_CODE = [
  'packages/kernel/src',
  'packages/kernel/sql',
  'packages/site-services/src',
  'packages/site-services/sql',
  'packages/recipe-core/src',
  'packages/recipe-core/sql',
  'packages/test-kit/src',
  'apps/tablets-server/src',
  'apps/tablets-server/sql',
];

/** Files that name the product but make no record, each with its reason. */
const NOT_RECORDS: Readonly<Record<string, string>> = {
  'apps/tablets-server/src/cli/openapi.ts': 'the API description for integrators (its title), not a record',
};

const VENDOR = /batchwright|medhanta/i;

function walk(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (name === 'node_modules') return [];
    return statSync(join(root, rel)).isDirectory() ? walk(rel) : [rel];
  });
}

describe('GMP records keep the manufacturer\'s identity (decision 0020)', () => {
  it('no code that makes a batch record, true copy, label, report or certificate names Batchwright or Medhanta', () => {
    const files = RECORD_CODE.flatMap(walk).filter((f) => /\.(ts|tsx|sql|json|txt|html)$/.test(f));
    expect(files.length).toBeGreaterThan(500);
    const hits = files
      .filter((f) => !(f in NOT_RECORDS))
      .flatMap((f) =>
        readFileSync(join(root, f), 'utf8')
          .split('\n')
          .flatMap((line, i) => (VENDOR.test(line) ? [`${relative(root, join(root, f))}:${String(i + 1)}: ${line.trim()}`] : [])),
      );
    expect(hits).toEqual([]);
  });

  it('each file excused from the check exists and still has a reason to be', () => {
    for (const f of Object.keys(NOT_RECORDS)) expect(VENDOR.test(readFileSync(join(root, f), 'utf8')), f).toBe(true);
  });
});
