/**
 * Shared set-up of GMP batch tests: the ERP production order a GMP issue names (slice 5a, D-S5-4).
 */
import type { SeededActor } from '../../../kernel/test/identity/seed.ts';
import type { TestDatabase } from '../../../kernel/test/support/db.ts';
import type { MbrContent } from '../../src/flow/model.ts';

/** The ERP order for a batch of `content` at batch size `batchSize` (none until the ERP stub exists). */
export function gmpOrderFor(db: TestDatabase, erp: SeededActor, content: MbrContent, batchSize: string): Promise<string | undefined> {
  void [db, erp, content, batchSize];
  return Promise.resolve(undefined);
}
