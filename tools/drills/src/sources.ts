/** The migrations of a Tablets database in the order the set-up applies them (test-kit editionMigrationSources). */
import { fileURLToPath } from 'node:url';
import type { MigrationSource } from '@ebmr/kernel';
import { editionMigrationSources } from '@ebmr/test-kit';

export const TABLETS_SQL = fileURLToPath(new URL('../../../apps/tablets-server/sql', import.meta.url));

export function tabletsMigrationSources(): MigrationSource[] {
  return editionMigrationSources([{ namespace: 'tablets', directory: TABLETS_SQL }]);
}
