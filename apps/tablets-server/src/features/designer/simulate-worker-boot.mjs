// Bootstrap of the designer's simulation worker (module C2). The server runs from TypeScript source in Phase 2
// (`node --import tsx`, or Vitest in tests); loader hooks registered in the parent do not reach a worker's entry, so
// this plain module loads the TypeScript worker through tsx's scoped import. A built server bundle replaces this.
import { workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';

await tsImport(workerData.entry, import.meta.url);
