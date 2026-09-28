// Bootstrap of the designer's simulation worker (module C2). The server runs from TypeScript source in Phase 2
// (`node --import tsx`, or Vitest in tests); loader hooks registered in the parent do not reach a worker's entry, so
// this plain module loads the TypeScript worker through tsx's scoped import (resolved from the repository root's
// tsx until the server is bundled). No fallback: without tsx the simulation fails with this error, never silently.
import { workerData } from 'node:worker_threads';

let tsImport;
try {
  ({ tsImport } = await import('tsx/esm/api'));
} catch (error) {
  throw new Error(
    `The simulation worker cannot start: the TypeScript loader tsx/esm/api could not be loaded (${error instanceof Error ? error.message : String(error)}). Install tsx for the server or run the bundled server.`,
  );
}
await tsImport(workerData.entry, import.meta.url);
