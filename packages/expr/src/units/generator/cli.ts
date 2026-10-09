/**
 * Writes the generated unit table. Run from the repository root:
 *   npx tsx packages/expr/src/units/generator/cli.ts
 * Then commit packages/expr/src/units/unit-table.generated.ts (the unit-table test compares it with
 * a fresh generation).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateUnitTableSource } from './generate-unit-table.ts';

const target = fileURLToPath(new URL('../unit-table.generated.ts', import.meta.url));
writeFileSync(target, generateUnitTableSource(), 'utf8');
console.log(`wrote ${target}`);
