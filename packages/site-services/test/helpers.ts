/**
 * Site-services tests use the same single actor helper and harness as the kernel continuity tests.
 */
import type { ActorContext } from '../../kernel/src/db/command.ts';
import type { Scope } from '../../kernel/src/identity/authority.ts';
import { seedActor } from '../../kernel/test/identity/seed.ts';
import type { TestDatabase } from '../../kernel/test/support/db.ts';

export {
  backupTestDatabase,
  dbTime,
  restoreCopy,
  tempDir,
  tempLedger,
  testActor,
} from '../../kernel/test/continuity/helpers.ts';
export { createTestDatabase, type TestDatabase } from '../../kernel/test/support/db.ts';

/**
 * A person holding `roleCode` through a grant limited to `scope` (site and/or product), with a session
 * on a personal device at the seed site (SITE-1). For authority tests in the site and product scope
 * of batch numbers (DI-17).
 */
export function scopedTestActor(db: TestDatabase, roleCode: string, scope: Scope): Promise<ActorContext> {
  return seedActor(db, { roleCode, scope, acknowledgeEsig: false });
}
