// Vitest configuration of the load driver (slice 7d; tools/load/src/cli.ts runs it with --config tools/load/src/vitest.load.config.ts): the one run file, never picked up
// by the suite's projects (its name is not *.test.ts). It builds its own database on EBMR_PG_ADMIN_URL's cluster.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tools/load/src/reference-site.load.ts'],
    environment: 'node',
    testTimeout: 48 * 3_600_000,
    hookTimeout: 3_600_000,
    fileParallelism: false,
  },
});
